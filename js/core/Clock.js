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
 *   onStart(fn) / offStart(fn)     — transport-start listeners (fired by start())
 *   onStop(fn)  / offStop(fn)      — transport-stop listeners (fired by stop())
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
    // Lookahead must comfortably exceed the worst main-thread stall, or a phone
    // hiccup (GC, layout, a slow rAF) lets currentTime overrun _nextTickTime and
    // notes schedule late/never → audible gaps. 0.1s was too tight on mobile;
    // 0.25s gives the scheduler slack without perceptibly hurting timing
    // responsiveness (steps are still queued ahead of the audio thread, not
    // played early). Interval stays well below the lookahead.
    this._lookahead    = 0.25;    // seconds to schedule ahead
    this._scheduleInterval = 50;  // ms between scheduler runs
    this._timerID      = null;
    this._callbacks    = new Set();
    // Transport listeners — fired by start()/stop(). Used by MidiEngine to send
    // 0xFA/0xFC without monkey-patching start/stop.
    this._startListeners = new Set();
    this._stopListeners  = new Set();
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

  /** @param {function} fn — called with no args when transport starts */
  onStart(fn)  { this._startListeners.add(fn); }
  /** @param {function} fn */
  offStart(fn) { this._startListeners.delete(fn); }
  /** @param {function} fn — called with no args when transport stops */
  onStop(fn)   { this._stopListeners.add(fn); }
  /** @param {function} fn */
  offStop(fn)  { this._stopListeners.delete(fn); }

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
    this._startListeners.forEach(fn => { try { fn(); } catch (_) {} });
  }

  stop() {
    this.isPlaying  = false;
    this._tickIndex = 0;
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
    this._stopListeners.forEach(fn => { try { fn(); } catch (_) {} });
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
