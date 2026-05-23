/**
 * Clock.js
 * --------
 * Master BPM clock using AudioContext.currentTime for sample-accurate scheduling.
 * Uses a lookahead scheduler pattern — avoids setInterval drift for audio timing.
 *
 * Each Sequencer registers itself via Clock.register(). On each scheduler tick,
 * all registered callbacks receive (tickIndex, scheduledTime) and decide
 * independently whether their step fires.
 *
 * Owns:    tick loop (via setTimeout), current tick index, BPM state
 * Depends: AudioEngine (for AudioContext.currentTime)
 * Used by: Sequencer.js
 *
 * Public:
 *   start()                        — begins playback from tick 0
 *   stop()                         — halts playback, resets tick index
 *   setBPM(bpm)                    — updates tempo (takes effect immediately)
 *   register(callback)             — add a tick listener: fn(tickIndex, scheduledTime)
 *   unregister(callback)           — remove a tick listener
 *   .isPlaying                     — boolean
 *   .bpm                           — current BPM
 *   .ticksPerBeat                  — subdivision resolution (default: 4, i.e. 16th notes)
 */

export class Clock {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} audioEngine
   */
  constructor(audioEngine) {
    this.audio        = audioEngine;
    this.bpm          = 120;
    this.ticksPerBeat = 4;        // 4 ticks per beat = 16th note resolution
    this.isPlaying    = false;

    this._tickIndex    = 0;
    this._nextTickTime = 0;       // scheduled AudioContext time of next tick
    this._lookahead    = 0.1;     // seconds to schedule ahead
    this._scheduleInterval = 25;  // ms between scheduler runs
    this._timerID      = null;
    this._callbacks    = new Set();
  }

  /** Seconds per tick at current BPM and subdivision. */
  get _secondsPerTick() {
    return 60 / (this.bpm * this.ticksPerBeat);
  }

  /** @param {function} callback — fn(tickIndex, scheduledTime) */
  register(callback) {
    this._callbacks.add(callback);
  }

  /** @param {function} callback */
  unregister(callback) {
    this._callbacks.delete(callback);
  }

  /** @param {number} bpm */
  setBPM(bpm) {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying     = true;
    this._tickIndex    = 0;
    this._nextTickTime = this.audio.context.currentTime + 0.05;
    this._schedule();
  }

  stop() {
    this.isPlaying  = false;
    this._tickIndex = 0;
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
  }

  _schedule() {
    // Schedule all ticks that fall within the lookahead window
    while (this._nextTickTime < this.audio.context.currentTime + this._lookahead) {
      const t = this._nextTickTime;
      const i = this._tickIndex;
      this._callbacks.forEach(cb => cb(i, t));
      this._tickIndex++;
      this._nextTickTime += this._secondsPerTick;
    }

    if (this.isPlaying) {
      this._timerID = setTimeout(() => this._schedule(), this._scheduleInterval);
    }
  }
}
