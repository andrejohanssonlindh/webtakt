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
 *   mode           string   'chord' | 'manual' | 'random'
 *
 *   -- chord mode --
 *   chord          string   chord type key (see CHORD_DEFS)
 *   pattern        string   'up' | 'down' | 'updown' | 'random'
 *   syncMode       string   'ms' | 'bpm'
 *   speed          number   gap between notes in ms (syncMode='ms')
 *   bpmCount32     number   integer 1/32 count (syncMode='bpm')
 *   variance       number   0–1, timing jitter on middle notes
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
 */

import { count32ToSeconds, divToCount32 } from '../util/BpmSync.js';

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
      gate:      0,    // 0 = 90% of gap (legato); >0 = explicit ms
      // manual
      steps:     [_makeDefaultStep()],
      // random
      noteCount: 4,
      range:     12,
      rGate:     0,    // 0 = 90% of gap; >0 = explicit ms
    };

    // Ping-pong direction tracker for updown pattern
    this._updownDir = 1;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getParam(path) {
    return this._params[path];
  }

  setParam(path, value) {
    if (path === 'steps') {
      this._params.steps = value;
    } else {
      this._params[path] = value;
    }
  }

  setBpm(bpm) {
    this._bpm = bpm;
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
      default:       return [];
    }
  }

  // ── Chord mode ──────────────────────────────────────────────────────────────

  _buildChordEvents(rootNote, velocity, t0, stepLengthSec) {
    const p         = this._params;
    const intervals = [...(ARP_CHORD_DEFS[p.chord] ?? ARP_CHORD_DEFS.major)];
    const notes     = this._applyPattern(intervals);
    const gapSec    = this._gapSec(p.syncMode, p.speed, p.bpmCount32);
    const gateSec   = p.gate > 0 ? p.gate / 1000 : gapSec * 0.9;

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
    const gateSec = p.rGate > 0 ? p.rGate / 1000 : gapSec * 0.9;

    const intervals = Array.from({ length: count }, () =>
      Math.round((Math.random() * 2 - 1) * range)
    );

    return this._spaceNotes(intervals, rootNote, velocity, t0, gapSec, gateSec, p.variance);
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  /**
   * Lay out notes with equal spacing + optional variance on middle notes.
   */
  _spaceNotes(intervals, rootNote, velocity, t0, gapSec, noteLenSec, variance) {
    const events = [];
    let   cursor = t0;

    for (let i = 0; i < intervals.length; i++) {
      const note = Math.max(0, Math.min(127, rootNote + intervals[i]));
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
