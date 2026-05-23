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
    this.note      = 60;
    this.velocity  = 100;
    this.length    = 1;       // ticks; 1 = one full step at default resolution
    this.nudge     = 0;
    this.retrigger = null;
    this.condition = Condition.create('always');
    this.chance    = 100;     // percent, 0–100
    this.plocks    = new Map();
  }

  get hasPLocks() {
    return this.plocks.size > 0;
  }

  get hasCondition() {
    return this.condition.type !== 'always' || this.chance < 100;
  }

  setPLock(path, value) { this.plocks.set(path, value); }
  removePLock(path)     { this.plocks.delete(path); }

  toJSON() {
    return {
      index:     this.index,
      active:    this.active,
      note:      this.note,
      velocity:  this.velocity,
      length:    this.length,
      nudge:     this.nudge,
      retrigger: this.retrigger ? { ...this.retrigger } : null,
      condition: Condition.toJSON(this.condition),
      chance:    this.chance,
      plocks:    Object.fromEntries(this.plocks),
    };
  }

  static fromJSON(obj) {
    const step       = new Step(obj.index);
    step.active      = obj.active    ?? false;
    step.note        = obj.note      ?? 60;
    step.velocity    = obj.velocity  ?? 100;
    step.length      = obj.length    ?? 1;
    step.nudge       = obj.nudge     ?? 0;
    step.retrigger   = obj.retrigger ?? null;
    step.condition   = Condition.fromJSON(obj.condition);
    step.chance      = obj.chance    ?? 100;
    step.plocks      = new Map(Object.entries(obj.plocks ?? {}));
    return step;
  }
}
