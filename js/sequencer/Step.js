/**
 * Step.js
 * -------
 * Represents a single step in a track's sequencer.
 *
 * Fields:
 *   active    — does this step trigger a note?
 *   note      — MIDI note number (0–127)
 *   velocity  — 0–127
 *   length    — note gate length in ticks (fractional ok, e.g. 0.0625 = 1/16 step)
 *   nudge     — signed tick offset
 *   retrigger — { count, rate } or null
 *   condition — Condition instance (ratio-based)
 *   chance    — 0–100 (percent). Evaluated AFTER condition. 100 = always fires.
 *   plocks    — Map<string, number>
 */

import { Condition } from './Condition.js';

export class Step {
  /** @param {number} index */
  constructor(index) {
    this.index     = index;
    this.active    = false;
    this.voices    = [{ note: 60, velocity: 100, length: 1, nudge: 0 }];
    this.retrigger = null;
    this.condition = Condition.create('always');
    this.chance    = 100;     // percent, 0–100
    this.plocks    = new Map();
  }

  // Convenience accessors so existing callers keep working
  get note()     { return this.voices[0].note; }
  set note(v)    { this.voices[0].note = v; }
  get velocity() { return this.voices[0].velocity; }
  set velocity(v){ this.voices[0].velocity = v; }
  get length()   { return this.voices[0].length; }
  set length(v)  { this.voices[0].length = v; }
  get nudge()    { return this.voices[0].nudge; }
  set nudge(v)   { this.voices[0].nudge = v; }

  get hasPLocks() {
    return this.plocks.size > 0;
  }

  get hasCondition() {
    return this.condition.type !== 'always' || this.chance < 100;
  }

  setPLock(path, value) { this.plocks.set(path, value); }
  removePLock(path)     { this.plocks.delete(path); }

  /** Add a new voice. Returns the new voice object. */
  addVoice(note = 60, velocity = 100, length = 1, nudge = 0) {
    const v = { note, velocity, length, nudge };
    this.voices.push(v);
    return v;
  }

  /** Remove voice by index. Voice 0 can only be removed if there are others. */
  removeVoice(i) {
    if (this.voices.length <= 1) {
      this.active = false;
      return;
    }
    this.voices.splice(i, 1);
  }

  toJSON() {
    return {
      index:     this.index,
      active:    this.active,
      voices:    this.voices.map(v => ({ ...v })),
      retrigger: this.retrigger ? { ...this.retrigger } : null,
      condition: Condition.toJSON(this.condition),
      chance:    this.chance,
      plocks:    Object.fromEntries(this.plocks),
    };
  }

  static fromJSON(obj) {
    const step       = new Step(obj.index);
    step.active      = obj.active    ?? false;
    step.retrigger   = obj.retrigger ?? null;
    step.condition   = Condition.fromJSON(obj.condition);
    step.chance      = obj.chance    ?? 100;
    step.plocks      = new Map(Object.entries(obj.plocks ?? {}));
    // Migrate old single-voice saves
    if (Array.isArray(obj.voices)) {
      step.voices = obj.voices.map(v => ({
        note:     v.note     ?? 60,
        velocity: v.velocity ?? 100,
        length:   v.length   ?? 1,
        nudge:    v.nudge    ?? 0,
      }));
    } else {
      step.voices = [{ note: obj.note ?? 60, velocity: obj.velocity ?? 100, length: obj.length ?? 1, nudge: obj.nudge ?? 0 }];
    }
    return step;
  }
}
