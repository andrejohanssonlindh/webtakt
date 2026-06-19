/**
 * Arpeggiator.js
 * --------------
 * Per-track arpeggiator. Intercepts a single note trigger from the Sequencer
 * and fans it out into a timed sequence of individual notes, all scheduled
 * ahead-of-time via AudioContext.currentTime — no setInterval/setTimeout.
 *
 * Owned by Track. Called from Sequencer._fireStep() in place of (or wrapping)
 * the normal voice dispatch.
 *
 * Modes
 * ─────
 *   'chord'  — arp the notes of a chord type (Up / Down / UpDown / Random order)
 *   'manual' — user-defined list of semitone offsets + per-note delay + gate
 *   'random' — random note selection from ±range around root, fully randomised timing
 *   'input'  — LIVE keyboard-driven arp. The notes are whatever keys are currently
 *              held on the keyboard (absolute pitches, not relative to a step). Held
 *              keys drive the arp directly via LiveArp.js (free-running, BPM-synced);
 *              the sequencer does NOT trigger input mode. Reuses the chord-mode
 *              controls (pattern / rate / gate / variance) — there is no chord type,
 *              the held key set IS the chord. When RECORD is on, the held notes are
 *              captured into the sequencer steps (handled by Keyboard.js) so playback
 *              re-fires them through the arp without holding keys.
 *   'input-manual' — LIVE keyboard-driven version of 'manual'. Same per-step list
 *              (semitone offset + per-step rate + gate) as manual mode, but the root
 *              is the live-held key instead of a sequencer step. Step 1 is the held
 *              key; later steps are relative semitone moves. With a chord held, the
 *              step figure runs from each held note in parallel (all at once). Driven
 *              by LiveArp like 'input'; the sequencer does NOT trigger it.
 *   'input-random' — LIVE keyboard-driven version of 'random'. Same generator
 *              (note count + ±range + rate + gate + variance) as random mode, but
 *              each random note is rolled around a live-held key instead of a
 *              sequencer root. Re-rolled every cycle. Driven by LiveArp like 'input';
 *              the sequencer does NOT trigger it.
 *
 * Chord mode: trig length comes from the step voice length (same as a normal note).
 * Manual mode: per-step gate override in ms; 0 = use base step length.
 * Random mode: per-note gate derived from base step length.
 *
 * Variance (chord + random): widens the gap between notes.
 *   variance 0 → all gaps equal
 *   variance 1 → middle notes stretched by up to ±50% of the base gap
 *   Only middle notes (not first/last) are varied to keep the overall cycle length stable.
 *
 * BPM sync: speed can be expressed as ms (absolute) or an integer count of
 *   1/32 notes (the unified sync-knob model — see js/util/BpmSync.js).
 *   When syncMode='bpm', the noteGap is count32ToSeconds(bpmCount32, bpm).
 *   Manual mode: each step has its own syncMode + bpmCount32 or ms value.
 *
 * Parameters (flat object, serialisable)
 * ───────────────────────────────────────
 *   enabled        boolean  false
 *   mode           string   'chord' | 'manual' | 'random' | 'input' | 'input-manual' | 'input-random'
 *
 *   -- chord mode --
 *   chord          string   chord type key (see CHORD_DEFS)
 *   pattern        string   'up' | 'down' | 'updown' | 'random'
 *   syncMode       string   'ms' | 'bpm'
 *   speed          number   gap between notes in ms (syncMode='ms')
 *   bpmCount32     number   integer 1/32 count (syncMode='bpm')
 *   variance       number   0–1, timing jitter on middle notes
 *   gate           number   note-on length in ms (gateSyncMode='ms'); 0 = legato
 *   gateSyncMode   string   'ms' | 'bpm' — gate length sync, independent of rate
 *   gateBpmCount32 number   integer 1/32 count gate length (gateSyncMode='bpm')
 *
 *   -- manual mode --
 *   steps          Array<{semitone, syncMode, speed, bpmCount32, gate}>
 *                  gate: note-on length in ms (0 = inherit from step length)
 *
 *   -- random mode --
 *   noteCount      number   2–8
 *   range          number   semitone range ±N from root (1–24)
 *   syncMode       string   'ms' | 'bpm'
 *   speed          number   base gap ms
 *   bpmCount32     number   integer 1/32 count
 *   variance       number   0–1
 *
 *   -- input mode --
 *   (reuses pattern / syncMode / speed / bpmCount32 / variance / gate; notes come
 *    from live-held keys, supplied at runtime — nothing extra is serialised)
 */

import { count32ToSeconds, divToCount32 } from '../util/BpmSync.js';
import { snapToScale } from '../state/Scales.js';

export const ARP_CHORD_DEFS = {
  major:  [0,  4,  7, 12],
  minor:  [0,  3,  7, 12],
  dom7:   [0,  4,  7, 10],
  maj7:   [0,  4,  7, 11],
  min7:   [0,  3,  7, 10],
  sus2:   [0,  2,  7, 12],
  sus4:   [0,  5,  7, 12],
  dim:    [0,  3,  6, 12],
  aug:    [0,  4,  8, 12],
  power:  [0,  0,  7, 12],
  octave: [0, 12, 24, 36],
};
export const ARP_CHORD_NAMES = Object.keys(ARP_CHORD_DEFS);
export const ARP_PATTERNS    = ['up', 'down', 'updown', 'random'];

function _makeDefaultStep() {
  return { semitone: 0, syncMode: 'ms', speed: 150, bpmCount32: 4, gate: 100 };
}

export class Arpeggiator {
  constructor() {
    this._bpm = 120;

    // Scale constraint for random modes — kept in sync by the owning Track.
    // 0 = chromatic (no filtering). Only the random/input-random generators snap
    // to it; chord/manual offsets are authored deliberately and pass through.
    this._scaleIndex = 0;
    this._leadNote   = 0;

    this.enabled = false;

    this._params = {
      mode:      'chord',
      // chord
      chord:     'major',
      pattern:   'up',
      syncMode:  'ms',
      speed:     150,
      bpmCount32: 4,   // 4 × 1/32 = 1/8
      variance:  0,
      gate:      0,    // 0 = 90% of gap (legato); >0 = explicit ms (gateSyncMode='ms')
      // Gate length sync (independent of rate sync): in 'bpm' mode the gate is a
      // 1/32 count resolved at fire time, and the ms 'legato at 0' rule no longer
      // applies (a count is always an explicit length).
      gateSyncMode:   'ms',
      gateBpmCount32: 4,   // 4 × 1/32 = 1/8
      // manual
      steps:     [_makeDefaultStep()],
      // random
      noteCount: 4,
      range:     12,
      rGate:     0,    // 0 = 90% of gap; >0 = explicit ms
      // Direction bias for the rolled interval, -1..+1 (0 = symmetric ±range).
      // +1 → only notes higher than the root; -1 → only lower. Intermediate
      // values skew the random window up/down. See _biasedInterval().
      bias:      0,
    };

    // Ping-pong direction tracker for updown pattern
    this._updownDir = 1;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Virtual modulation params (p-lock + LFO targets). These alias the real
   * fields so a single number can be p-locked/LFO'd:
   *   arp.rate     → speed (ms mode) OR bpmCount32 (bpm mode), per current syncMode
   *   arp.gate     → gate
   *   arp.variance → variance
   * Rate modulates "in the current sync mode" (see design/ui.md) — the value the
   * RATE knob shows is exactly what gets p-locked/modulated.
   */
  static MOD_PARAMS = ['arp.rate', 'arp.gate', 'arp.variance'];

  /** Resolve which underlying field 'arp.rate' currently maps to. */
  _rateField() {
    return this._params.syncMode === 'bpm' ? 'bpmCount32' : 'speed';
  }

  /** Resolve which underlying field 'arp.gate' currently maps to. */
  _gateField() {
    return this._params.gateSyncMode === 'bpm' ? 'gateBpmCount32' : 'gate';
  }

  getParam(path) {
    switch (path) {
      case 'arp.rate':     return this._params[this._rateField()];
      case 'arp.gate':     return this._params[this._gateField()];
      case 'arp.variance': return this._params.variance;
      default:             return this._params[path];
    }
  }

  setParam(path, value) {
    switch (path) {
      case 'arp.rate':     this._params[this._rateField()] = value; return;
      case 'arp.gate':     this._params[this._gateField()] = value; return;
      case 'arp.variance': this._params.variance = value;           return;
      case 'steps':        this._params.steps = value;              return;
      default:             this._params[path] = value;
    }
  }

  /**
   * Descriptors for the virtual mod params — bounds depend on current sync mode
   * for rate. Used by Track to expose them to the p-lock UI and LFO routing, and
   * by the LFO depthScale calc (half-range). gate/variance are mode-independent.
   * @returns {Array<{path,label,min,max,modulatable,jsOnly,lfoMin,lfoMax}>}
   */
  modParamDescriptors() {
    const isBpm = this._params.syncMode === 'bpm';
    const rate = isBpm
      ? { path: 'arp.rate', label: 'Rate', min: 1, max: 64,   lfoMin: 1, lfoMax: 64 }
      : { path: 'arp.rate', label: 'Rate', min: 1, max: 2000, lfoMin: 1, lfoMax: 2000 };
    const gateBpm = this._params.gateSyncMode === 'bpm';
    const gate = gateBpm
      ? { path: 'arp.gate', label: 'Gate', min: 1, max: 64,   lfoMin: 1, lfoMax: 64 }
      : { path: 'arp.gate', label: 'Gate', min: 0, max: 2000, lfoMin: 0, lfoMax: 2000 };
    return [
      { ...rate,                                                  modulatable: true, jsOnly: true },
      { ...gate,                                                  modulatable: true, jsOnly: true },
      { path: 'arp.variance', label: 'Variance', min: 0, max: 1, lfoMin: 0, lfoMax: 1,    modulatable: true, jsOnly: true },
    ];
  }

  setBpm(bpm) {
    this._bpm = bpm;
  }

  /**
   * Set the scale constraint used by the random modes. Called by Track whenever
   * its scaleIndex/leadNote change (scaleChanged) so the arp always rolls notes
   * the selected scale allows.
   * @param {number} scaleIndex — index into SCALE_DEFS (0 = chromatic / no filter)
   * @param {number} leadNote   — MIDI root pitch class (0–11)
   */
  setScale(scaleIndex, leadNote) {
    this._scaleIndex = scaleIndex ?? 0;
    this._leadNote   = leadNote   ?? 0;
  }

  /** Snap a rolled random note to the current scale (no-op when chromatic). */
  _snap(note) {
    return snapToScale(note, this._scaleIndex, this._leadNote);
  }

  /**
   * Roll a random semitone interval within ±range, skewed by the `bias` param
   * (-1..+1). The unbiased roll spans the unit window [-1, 1]; bias slides one
   * edge of that window toward the centre so the run leans up or down:
   *   bias  0 → [-1, 1]  symmetric (full ±range)
   *   bias +1 → [ 0, 1]  only notes ≥ the root (higher)
   *   bias -1 → [-1, 0]  only notes ≤ the root (lower)
   * Intermediate values skew proportionally. Returned interval is rounded to a
   * whole semitone and scaled by `range`.
   * @param {number} range  semitone half-range (≥1)
   * @returns {number} signed semitone offset from the root
   */
  _biasedInterval(range) {
    const bias = Math.max(-1, Math.min(1, this._params.bias ?? 0));
    const lo   = bias > 0 ? (bias - 1) : -1;   // +bias lifts the lower edge toward 0
    const hi   = bias < 0 ? (bias + 1) :  1;   // -bias drops the upper edge toward 0
    const u    = lo + Math.random() * (hi - lo);
    let interval = Math.round(u * range);
    // At full bias the run must stay strictly on one side of the root: a rounded
    // 0 would sound the root note, so push it one semitone in the biased direction
    // (clamped to ±range). Partial bias still allows the root (interval 0).
    if (interval === 0) {
      if (bias >=  1) interval =  Math.min(1, range);
      if (bias <= -1) interval = -Math.min(1, range);
    }
    return interval;
  }

  /**
   * True when the current mode is keyboard-driven (LiveArp), i.e. notes come from
   * live-held keys rather than a sequencer step: 'input' or 'input-manual'.
   */
  isLiveInputMode() {
    const m = this._params.mode;
    return m === 'input' || m === 'input-manual' || m === 'input-random';
  }

  /** Add a manual step at the end. */
  addManualStep() {
    this._params.steps.push(_makeDefaultStep());
  }

  /** Remove a manual step by index. Keeps at least one. */
  removeManualStep(index) {
    if (this._params.steps.length <= 1) return;
    this._params.steps.splice(index, 1);
  }

  /**
   * Build the list of { note, startTime, offTime } events from a single step trigger.
   *
   * @param {number} rootNote     MIDI root note (already has tone applied)
   * @param {number} velocity
   * @param {number} triggerTime  AudioContext time of the trigger
   * @param {number} stepOffTime  AudioContext time of note-off from the step length
   * @param {number} stepLengthSec  Duration of the step length in seconds
   * @returns {Array<{note, velocity, time, offTime}>}
   */
  buildEvents(rootNote, velocity, triggerTime, stepOffTime, stepLengthSec) {
    const p = this._params;
    switch (p.mode) {
      case 'chord':  return this._buildChordEvents(rootNote, velocity, triggerTime, stepLengthSec);
      case 'manual': return this._buildManualEvents(rootNote, velocity, triggerTime, stepLengthSec);
      case 'random': return this._buildRandomEvents(rootNote, velocity, triggerTime, stepLengthSec);
      // 'input' / 'input-manual' are keyboard-driven (LiveArp) — steps do not
      // trigger them. A step recorded while in an input mode plays its captured
      // notes as a normal multi-voice step (the arp does not re-fan it).
      default:       return [];
    }
  }

  // ── Chord mode ──────────────────────────────────────────────────────────────

  _buildChordEvents(rootNote, velocity, t0, stepLengthSec) {
    const p         = this._params;
    const intervals = [...(ARP_CHORD_DEFS[p.chord] ?? ARP_CHORD_DEFS.major)];
    const notes     = this._applyPattern(intervals);
    const gapSec    = this._gapSec(p.syncMode, p.speed, p.bpmCount32);
    const gateSec   = this._gateSec(gapSec);

    return this._spaceNotes(notes, rootNote, velocity, t0, gapSec, gateSec, p.variance);
  }

  _applyPattern(intervals) {
    const p = this._params;
    switch (p.pattern) {
      case 'down':   return [...intervals].reverse();
      case 'updown': {
        if (this._updownDir >= 0) {
          this._updownDir = -1;
          return [...intervals];
        } else {
          this._updownDir = 1;
          return [...intervals].reverse();
        }
      }
      case 'random': {
        const arr = [...intervals];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      }
      default: return [...intervals]; // 'up'
    }
  }

  // ── Input mode (live keyboard-driven) ───────────────────────────────────────

  /**
   * Build one arp cycle from a set of live-held ABSOLUTE notes. Used by LiveArp
   * (keyboard-driven scheduling) — the sequencer never calls this. Reuses the
   * chord-mode controls: pattern ordering, rate (gap), gate, variance.
   *
   * Unlike chord/random/manual the input notes are already absolute MIDI values,
   * so they are laid out directly (no rootNote offset).
   *
   * @param {{note:number,velocity:number}[]} held  held notes ascending, each with velocity
   * @param {number}   t0         AudioContext time of the first note
   * @returns {{events: Array<{note,velocity,time,offTime}>, cycleSec: number}}
   *   cycleSec — total duration of the cycle (sum of gaps), so the caller can
   *   schedule the next cycle back-to-back.
   */
  buildInputCycle(held, t0) {
    if (this._params.mode === 'input-manual') {
      return this._buildInputManualCycle(held, t0);
    }
    if (this._params.mode === 'input-random') {
      return this._buildInputRandomCycle(held, t0);
    }

    const p       = this._params;
    const ordered = this._applyPattern(held);  // preserves {note,velocity} objects
    const gapSec  = this._gapSec(p.syncMode, p.speed, p.bpmCount32);
    const gateSec = this._gateSec(gapSec);

    const events   = [];
    let   cursor   = t0;
    for (let i = 0; i < ordered.length; i++) {
      const { note, velocity } = ordered[i];
      const isMiddle = i > 0 && i < ordered.length - 1;
      let effectiveGap = gapSec;
      if (isMiddle && p.variance > 0) {
        effectiveGap += gapSec * p.variance * 0.5 * (Math.random() * 2 - 1);
        effectiveGap  = Math.max(effectiveGap, 0.001);
      }
      events.push({ note: Math.max(0, Math.min(127, note)), velocity, time: cursor, offTime: cursor + gateSec });
      cursor += effectiveGap;
    }

    const cycleSec = ordered.length * gapSec;
    return { events, cycleSec };
  }

  /**
   * Input-manual cycle: the manual step list (semitone offset + per-step rate +
   * gate) played relative to the LIVE-held keys instead of a sequencer root.
   * Step 1's offset (usually 0) is the held key itself; subsequent steps are
   * relative semitone moves, exactly like manual mode. With several keys held the
   * step pattern runs from EACH held note in PARALLEL (all starting together), so
   * a chord arps every tone simultaneously rather than one note at a time.
   *
   * @param {{note:number,velocity:number}[]} held  held notes, each with velocity
   * @param {number} t0  AudioContext time of the first note
   * @returns {{events: Array<{note,velocity,time,offTime}>, cycleSec: number}}
   */
  _buildInputManualCycle(held, t0) {
    const p     = this._params;
    const roots = held.slice().sort((a, b) => a.note - b.note);

    // The cycle always LEADS with the held note(s) themselves — the user doesn't
    // author a "first step" for the root; it's implicitly the key they pressed,
    // lit red on the keyboard (root:true) like a played note. The manual step list
    // then defines the SUBSEQUENT figure, each step a relative semitone move from
    // the held root, queued after the lead note. The lead note's gap is the first
    // step's gap (or a default) so the figure flows on naturally.
    const leadGapSec  = this._gapSec(
      p.steps[0]?.syncMode ?? 'ms', p.steps[0]?.speed ?? 150, p.steps[0]?.bpmCount32 ?? 4);
    const leadGateSec = p.steps[0]?.gate > 0 ? p.steps[0].gate / 1000 : leadGapSec * 0.9;

    // Resolve the manual steps into a timeline once (offset-from-lead + gate),
    // since every held root runs the SAME steps. Each root plays this timeline in
    // PARALLEL (all starting together), so a chord arps every note at once.
    const slots = [];
    let   offset = leadGapSec;   // steps begin after the lead (root) note
    for (const step of p.steps) {
      const gapSec  = this._gapSec(step.syncMode, step.speed, step.bpmCount32);
      // No step length to inherit in live input — gate 0 falls back to legato
      // (90% of this step's own gap), mirroring the chord/input gate rule.
      const gateSec = step.gate > 0 ? step.gate / 1000 : gapSec * 0.9;
      slots.push({ semitone: Math.round(step.semitone), at: offset, gateSec });
      offset += gapSec;
    }

    const events = [];
    for (const { note: rootNote, velocity } of roots) {
      // Lead (root) note — the key as pressed, lit red.
      events.push({ note: rootNote, velocity, time: t0, offTime: t0 + leadGateSec, root: true });
      // Subsequent manual figure, relative to this root.
      for (const slot of slots) {
        const note = Math.max(0, Math.min(127, rootNote + slot.semitone));
        const time = t0 + slot.at;
        events.push({ note, velocity, time, offTime: time + slot.gateSec });
      }
    }

    // One root's figure (lead + steps) defines the cycle length — all roots share it.
    const cycleSec = Math.max(0.001, offset);
    return { events, cycleSec };
  }

  /**
   * Input-random cycle: the random-mode generator (note count + ±range + rate +
   * gate + variance) driven by the LIVE-held keys instead of a sequencer root.
   * Each of the `noteCount` notes picks a random held key as its root and offsets
   * it by a random ±range semitone amount, then the notes are spaced exactly like
   * random mode (equal gap + variance on the middle notes). Re-rolled every cycle,
   * so holding a key (or chord) yields an ever-changing random run around it.
   *
   * @param {{note:number,velocity:number}[]} held  held notes, each with velocity
   * @param {number} t0  AudioContext time of the first note
   * @returns {{events: Array<{note,velocity,time,offTime}>, cycleSec: number}}
   */
  _buildInputRandomCycle(held, t0) {
    const p       = this._params;
    const count   = Math.max(2, Math.min(8, Math.round(p.noteCount)));
    const range   = Math.max(1, Math.round(p.range));
    const gapSec  = this._gapSec(p.syncMode, p.speed, p.bpmCount32);
    const gateSec = this._gateSec(gapSec, p.rGate);

    // The cycle always LEADS with the note(s) the user actually pressed — the
    // input note itself, not a random roll — so a NOTES=4 run on a held C4 is
    // "C4 + 3 random" rather than 4 random notes. The root is flagged `root:true`
    // so the keyboard lights it like the played note (red), and is NOT snapped or
    // offset (it's exactly what was pressed). When a chord is held the whole chord
    // sounds on the first slot, then count-1 random notes roll around the held set.
    const events = [];
    let   cursor = t0;

    // Slot 0 — the held input note(s), played as pressed.
    for (const h of held) {
      events.push({ note: h.note, velocity: h.velocity, time: cursor, offTime: cursor + gateSec, root: true });
    }
    cursor += gapSec;

    // Slots 1..count-1 — random rolls around the held key(s) (green on the keys).
    for (let i = 1; i < count; i++) {
      const root     = held[Math.floor(Math.random() * held.length)];
      const interval = this._biasedInterval(range);
      // Snap the rolled note into the selected scale (no-op when chromatic).
      const note     = Math.max(0, Math.min(127, this._snap(root.note + interval)));

      const isMiddle = i > 0 && i < count - 1;
      let effectiveGap = gapSec;
      if (isMiddle && p.variance > 0) {
        effectiveGap += gapSec * p.variance * 0.5 * (Math.random() * 2 - 1);
        effectiveGap  = Math.max(effectiveGap, 0.001);
      }
      events.push({ note, velocity: root.velocity, time: cursor, offTime: cursor + gateSec });
      cursor += effectiveGap;
    }

    const cycleSec = count * gapSec;
    return { events, cycleSec };
  }

  // ── Manual mode ─────────────────────────────────────────────────────────────

  _buildManualEvents(rootNote, velocity, t0, stepLengthSec) {
    const p      = this._params;
    const events = [];
    let   cursor = t0;

    for (const step of p.steps) {
      const note    = Math.max(0, Math.min(127, rootNote + Math.round(step.semitone)));
      const gapSec  = this._gapSec(step.syncMode, step.speed, step.bpmCount32);
      const gateSec = step.gate > 0 ? step.gate / 1000 : stepLengthSec;
      events.push({ note, velocity, time: cursor, offTime: cursor + gateSec });
      cursor += gapSec;
    }

    return events;
  }

  // ── Random mode ─────────────────────────────────────────────────────────────

  _buildRandomEvents(rootNote, velocity, t0, stepLengthSec) {
    const p       = this._params;
    const count   = Math.max(2, Math.min(8, Math.round(p.noteCount)));
    const range   = Math.max(1, Math.round(p.range));
    const gapSec  = this._gapSec(p.syncMode, p.speed, p.bpmCount32);
    const gateSec = this._gateSec(gapSec, p.rGate);

    const intervals = Array.from({ length: count }, () => this._biasedInterval(range));

    // Random mode snaps each rolled note into the selected scale (no-op when
    // chromatic). Chord/manual modes don't pass `snap` — their offsets are
    // authored deliberately and must play exactly as written.
    return this._spaceNotes(intervals, rootNote, velocity, t0, gapSec, gateSec, p.variance, true);
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  /**
   * Lay out notes with equal spacing + optional variance on middle notes.
   */
  _spaceNotes(intervals, rootNote, velocity, t0, gapSec, noteLenSec, variance, snap = false) {
    const events = [];
    let   cursor = t0;

    for (let i = 0; i < intervals.length; i++) {
      const raw  = snap ? this._snap(rootNote + intervals[i]) : rootNote + intervals[i];
      const note = Math.max(0, Math.min(127, raw));
      const isMiddle = i > 0 && i < intervals.length - 1;
      let effectiveGap = gapSec;
      if (isMiddle && variance > 0) {
        // Shift by up to ±50% of gap * variance
        effectiveGap += gapSec * variance * 0.5 * (Math.random() * 2 - 1);
        effectiveGap = Math.max(effectiveGap, 0.001);
      }
      events.push({ note, velocity, time: cursor, offTime: cursor + noteLenSec });
      cursor += effectiveGap;
    }

    return events;
  }

  _gapSec(syncMode, speedMs, bpmCount32) {
    if (syncMode === 'bpm') {
      return Math.max(0.001, count32ToSeconds(bpmCount32, this._bpm));
    }
    return Math.max(0.001, speedMs / 1000);
  }

  /**
   * Resolve gate (note-on length) to seconds for chord/input/random modes.
   * BPM mode: a 1/32 count, always an explicit length. MS mode: explicit ms, or
   * 0 → legato (90% of the note gap). `gateMs` lets random mode pass its own rGate.
   */
  _gateSec(gapSec, gateMs = this._params.gate) {
    if (this._params.gateSyncMode === 'bpm') {
      return Math.max(0.001, count32ToSeconds(this._params.gateBpmCount32, this._bpm));
    }
    return gateMs > 0 ? gateMs / 1000 : gapSec * 0.9;
  }

  // ── Serialisation ────────────────────────────────────────────────────────────

  toJSON() {
    return {
      enabled: this.enabled,
      params:  { ...this._params, steps: this._params.steps.map(s => ({ ...s })) },
    };
  }

  fromJSON(obj) {
    this.enabled = obj.enabled ?? false;
    if (obj.params) {
      const src = { ...obj.params };
      // Back-compat: legacy projects stored beat-division strings.
      if (src.bpmDiv !== undefined && src.bpmCount32 === undefined) {
        src.bpmCount32 = divToCount32(src.bpmDiv);
      }
      delete src.bpmDiv;
      const steps = (src.steps ?? [_makeDefaultStep()]).map(s => {
        const step = { ..._makeDefaultStep(), ...s };
        if (s.bpmDiv !== undefined && s.bpmCount32 === undefined) {
          step.bpmCount32 = divToCount32(s.bpmDiv);
        }
        delete step.bpmDiv;
        return step;
      });
      Object.assign(this._params, { ...src, steps });
    }
  }
}
