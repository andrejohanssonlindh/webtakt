/**
 * genRunner.js
 * ------------
 * Headless glue between the pure generators (algos.js) and a track's Step[].
 * Both the GEN panel (on every param change) and the Sequencer (once per bar when
 * gen.regen is on, even while another tab is showing) call runGen() — so the panel
 * is never required to be mounted for live evolution to keep going.
 *
 * The generator is TWO independent layers (see makeDefaultGen):
 *   rhythm — which steps fire: 'off' (detached; leave Step[] alone) | 'manual'
 *            (read the user's hand-placed active steps; re-pitch only those, never
 *            toggle active) | 'all' (every step) | 'euclid' | 'turing' | 'cellular'
 *   pitch  — what note each ACTIVE step plays: 'fixed' | 'scale' | 'markov'
 * Any combination is valid; the pitch layer only ever fills steps the rhythm layer
 * turned on (so e.g. a sparse Euclid groove gets a sparse Markov melody — the walk
 * advances once per active step, not per slot).
 *
 * Evolving layers (turing/cellular) carry their previous state across runs on
 * `track._genState` (NOT persisted — reseeded on load), so a track keeps evolving
 * coherently regardless of which UI is open.
 *
 * runGen mutates step.active + voices[0].{note,velocity}, preserving p-locks /
 * condition / chance on steps that stay active and clearing them on switched-off
 * steps. Returns true if it wrote anything (so the caller can emit stepChanged).
 */

import { snapToScale, SCALE_DEFS } from '../state/Scales.js';
import {
  euclid, turingBits, markovNotes, defaultMarkovTable,
  cellularRow, cellularSeed, mulberry32,
} from './algos.js';

/** The track's scale intervals (falls back to a major scale when chromatic/unknown). */
function scaleIntervals(track) {
  const def = SCALE_DEFS[track.scaleIndex];
  return (def && track.scaleIndex !== 0) ? def.intervals : [0, 2, 4, 5, 7, 9, 11];
}

/** Map a scale-degree index → MIDI note in the track's scale, from gen.baseNote. */
function noteForDegree(track, degree) {
  const ints = scaleIntervals(track);
  const len = ints.length;
  const octave = Math.floor(degree / len);
  const raw = track.gen.baseNote + 12 * octave + ints[((degree % len) + len) % len];
  return Math.max(0, Math.min(127, snapToScale(raw, track.scaleIndex, track.leadNote)));
}

/**
 * Build the rhythm layer → boolean[n] of which steps fire. Advances/derives any
 * evolving runtime state on `st`. `evolve` steps the evolving rhythms forward.
 */
function buildRhythm(track, n, st, evolve) {
  const g = track.gen;
  const hits = new Array(n).fill(false);
  switch (g.rhythm) {
    case 'manual':
      // The rhythm IS the hand-placed pattern — read which steps are already
      // active and re-pitch only those (runGen never toggles active in this mode).
      for (let i = 0; i < n; i++) hits[i] = !!track.sequencer.steps[i]?.active;
      break;
    case 'all':
      hits.fill(true);
      break;
    case 'euclid': {
      const pat = euclid(g.pulses, g.steps, g.rotate);
      for (let i = 0; i < n; i++) hits[i] = !!pat[i % pat.length];
      break;
    }
    case 'turing': {
      const rng = mulberry32(g.seed);
      // Advance the register only when evolving; otherwise re-derive from the
      // same seed so dragging RANDOM doesn't ratchet the pattern away.
      const prev = evolve ? st.prevBits : (st.prevBits ?? null);
      st.prevBits = turingBits(g.tLength, g.randomness, prev, rng);
      for (let i = 0; i < n; i++) hits[i] = !!st.prevBits[i % g.tLength];
      break;
    }
    case 'cellular': {
      st.prevRow = (evolve && Array.isArray(st.prevRow) && st.prevRow.length === n)
        ? cellularRow(st.prevRow, g.rule)
        : cellularSeed(n);
      for (let i = 0; i < n; i++) hits[i] = !!st.prevRow[i];
      break;
    }
  }
  return hits;
}

/**
 * Assign a note to each ACTIVE step per the pitch layer. `hits` selects which
 * steps get notes; the Markov walk + scale walk advance once PER ACTIVE STEP, so
 * the melody tracks the rhythm rather than every slot.
 */
function applyPitch(track, hits, notes) {
  const g = track.gen;
  if (g.pitch === 'fixed') {
    for (let i = 0; i < hits.length; i++) if (hits[i]) notes[i] = g.baseNote;
    return;
  }
  if (g.pitch === 'scale') {
    // Gentle scale walk: degree advances once per active step (0,1,2,… up the scale).
    let step = 0;
    for (let i = 0; i < hits.length; i++) if (hits[i]) notes[i] = noteForDegree(track, step++);
    return;
  }
  if (g.pitch === 'markov') {
    const activeCount = hits.reduce((c, h) => c + (h ? 1 : 0), 0);
    if (activeCount === 0) return;
    const walkLen = Math.max(1, Math.min(g.mLength, activeCount));
    const degs = markovNotes(walkLen, g.degrees, defaultMarkovTable(g.degrees), mulberry32(g.seed ^ 0x9e3779b9));
    let k = 0;
    for (let i = 0; i < hits.length; i++) if (hits[i]) notes[i] = noteForDegree(track, degs[k++ % degs.length]);
  }
}

/**
 * Run the track's current GEN layers and write the result into its Step[].
 * @param {Track} track
 * @param {boolean} evolve  advance evolving state (true = step forward a bar)
 * @returns {boolean} wrote anything
 */
export function runGen(track, evolve = false) {
  const g = track.gen;
  if (!g || g.rhythm === 'off') return false;
  const seq = track.sequencer;
  const n = seq.stepCount;
  const st = (track._genState ||= { prevBits: null, prevRow: null });

  const hits  = buildRhythm(track, n, st, evolve);
  const notes = new Array(n).fill(g.baseNote);
  applyPitch(track, hits, notes);

  // MANUAL rhythm: the user owns the pattern — only re-pitch the active steps,
  // never toggle .active or touch p-locks/velocity/length/nudge.
  const manual = g.rhythm === 'manual';

  // Note length for NEWLY-activated steps: inherit the length the user set on the
  // existing pattern rather than each empty slot's stale default of 1. We read the
  // first already-active step's length (the LENGTH knob with no step selected
  // writes the same length to every step, so the first active one is
  // representative). Steps that are already active keep their own length below, so
  // per-step tweaks survive. Falls back to 1 when nothing is active yet.
  const patternLength = seq.steps.find(s => s?.active)?.voices[0]?.length ?? 1;

  for (let i = 0; i < n; i++) {
    const step = seq.steps[i];
    if (!step) continue;
    if (hits[i]) {
      const v0 = step.voices[0];
      if (manual) {
        if (v0) v0.note = notes[i];
      } else {
        // Keep an already-active step's own length; a freshly-activated slot
        // inherits the pattern length (not its leftover default).
        const length = step.active ? (v0?.length ?? patternLength) : patternLength;
        step.active = true;
        step.voices = [{ note: notes[i], velocity: g.velocity, length, nudge: v0?.nudge ?? 0 }];
      }
    } else if (!manual) {
      if (step.active) { step.plocks.clear(); step.chance = 100; }
      step.active = false;
    }
  }

  // Advance seed for evolving layers so each bar differs (turing register / markov walk).
  if (evolve) g.seed = (g.seed + 1) & 0x7fffffff;
  return true;
}

/** Reset a track's runtime evolving state (e.g. length/rule changed). */
export function resetGenState(track) {
  track._genState = { prevBits: null, prevRow: null };
}
