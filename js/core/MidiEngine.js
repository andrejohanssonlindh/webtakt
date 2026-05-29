/**
 * MidiEngine.js
 * -------------
 * Singleton wrapper around the Web MIDI API (navigator.requestMIDIAccess).
 *
 * Responsibilities:
 *   - Request MIDI access and enumerate ports
 *   - Send note on/off, CC, and clock messages to outputs
 *   - Register on Clock tick to send MIDI clock (24 PPQN out)
 *   - Deliver incoming CC/note messages to registered listeners
 *
 * Timing note: MIDI output is NOT sample-accurate. We convert the scheduled
 * AudioContext time to a wall-clock delay via (scheduledTime - ctx.currentTime)
 * and use setTimeout to fire the send at approximately the right moment.
 * For sync and CC use this is acceptable (~1-5ms jitter typical).
 *
 * Public:
 *   init()                          — request MIDI access; returns Promise<boolean>
 *   .available                      — true after successful init
 *   .inputs                         — Map<id, MIDIInput>  (live, refreshed on statechange)
 *   .outputs                        — Map<id, MIDIOutput> (live)
 *   setSyncOutput(outputId|null)    — output that receives MIDI clock/start/stop
 *   onCC(fn)                        — register CC listener: fn(inputId, ch, cc, val)
 *   offCC(fn)                       — unregister
 *   onNoteOn(fn)                    — fn(inputId, ch, note, vel)
 *   offNoteOn(fn)
 *   sendNoteOn(outputId, ch, note, vel, audioTime, audioCtx)
 *   sendNoteOff(outputId, ch, note, audioTime, audioCtx)
 *   sendCC(outputId, ch, cc, val)
 *   connectClock(clock, audioCtx)   — register on Clock; sends 24-PPQN pulses
 *   disconnectClock()
 */

export class MidiEngine {
  constructor() {
    this.available = false;
    this.inputs    = new Map();
    this.outputs   = new Map();

    this._access        = null;
    this._syncOutputId  = null;
    this._ccListeners   = new Set();
    this._noteOnListeners = new Set();
    this._clock         = null;
    this._audioCtx      = null;
    this._clockTickCb   = null;
    // ticksPerBeat on the Clock is 4 (16th notes), so we need 6 MIDI pulses per tick
    // to achieve 24 PPQN (24 / 4 = 6).
    this._midiPulsesPerTick = 6;
  }

  /** @returns {Promise<boolean>} */
  async init() {
    if (!navigator.requestMIDIAccess) {
      console.warn('MidiEngine: Web MIDI API not available in this browser.');
      return false;
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._refreshPorts();
      this._access.onstatechange = () => this._refreshPorts();
      this.available = true;
      return true;
    } catch (e) {
      console.warn('MidiEngine: MIDI access denied.', e);
      return false;
    }
  }

  _refreshPorts() {
    this.inputs.clear();
    this.outputs.clear();
    for (const [id, port] of this._access.inputs)  {
      this.inputs.set(id, port);
      port.onmidimessage = (ev) => this._onMessage(id, ev);
    }
    for (const [id, port] of this._access.outputs) {
      this.outputs.set(id, port);
    }
  }

  _onMessage(inputId, ev) {
    const [status, data1, data2] = ev.data;
    const type = status & 0xf0;
    const ch   = status & 0x0f;  // 0-based
    if (type === 0xb0) {
      for (const fn of this._ccListeners) fn(inputId, ch + 1, data1, data2);
    } else if (type === 0x90 && data2 > 0) {
      for (const fn of this._noteOnListeners) fn(inputId, ch + 1, data1, data2);
    }
  }

  /** @param {string|null} outputId */
  setSyncOutput(outputId) {
    this._syncOutputId = outputId ?? null;
  }

  /** @param {Function} fn */
  onCC(fn)      { this._ccListeners.add(fn); }
  /** @param {Function} fn */
  offCC(fn)     { this._ccListeners.delete(fn); }
  /** @param {Function} fn */
  onNoteOn(fn)  { this._noteOnListeners.add(fn); }
  /** @param {Function} fn */
  offNoteOn(fn) { this._noteOnListeners.delete(fn); }

  /**
   * Schedule a note-on at audioTime (AudioContext seconds).
   * @param {string} outputId
   * @param {number} channel   — 1-based
   * @param {number} note      — 0-127
   * @param {number} velocity  — 0-127
   * @param {number} audioTime — AudioContext.currentTime target
   * @param {AudioContext} ctx
   */
  sendNoteOn(outputId, channel, note, velocity, audioTime, ctx) {
    const out = this.outputs.get(outputId);
    if (!out) return;
    const delayMs = Math.max(0, (audioTime - ctx.currentTime) * 1000);
    const status  = 0x90 | ((channel - 1) & 0x0f);
    setTimeout(() => {
      try { out.send([status, note & 0x7f, velocity & 0x7f]); } catch (_) {}
    }, delayMs);
  }

  /**
   * @param {string} outputId
   * @param {number} channel  — 1-based
   * @param {number} note     — 0-127
   * @param {number} audioTime
   * @param {AudioContext} ctx
   */
  sendNoteOff(outputId, channel, note, audioTime, ctx) {
    const out = this.outputs.get(outputId);
    if (!out) return;
    const delayMs = Math.max(0, (audioTime - ctx.currentTime) * 1000);
    const status  = 0x80 | ((channel - 1) & 0x0f);
    setTimeout(() => {
      try { out.send([status, note & 0x7f, 0]); } catch (_) {}
    }, delayMs);
  }

  /**
   * Send CC immediately (no audio-time scheduling).
   * @param {string} outputId
   * @param {number} channel — 1-based
   * @param {number} cc      — 0-127
   * @param {number} value   — 0-127
   */
  sendCC(outputId, channel, cc, value) {
    const out = this.outputs.get(outputId);
    if (!out) return;
    const status = 0xb0 | ((channel - 1) & 0x0f);
    try { out.send([status, cc & 0x7f, value & 0x7f]); } catch (_) {}
  }

  /**
   * Register on a Clock instance to send 24-PPQN MIDI clock.
   * Also hooks Clock start/stop to send 0xFA / 0xFC.
   * @param {import('./Clock.js').Clock} clock
   * @param {AudioContext} audioCtx
   */
  connectClock(clock, audioCtx) {
    if (this._clock) this.disconnectClock();
    this._clock    = clock;
    this._audioCtx = audioCtx;

    this._clockTickCb = (tickIndex, scheduledTime) => {
      const out = this._syncOutputId ? this.outputs.get(this._syncOutputId) : null;
      if (!out) return;
      const delayMs = Math.max(0, (scheduledTime - audioCtx.currentTime) * 1000);
      for (let p = 0; p < this._midiPulsesPerTick; p++) {
        const pulseMs = delayMs + (p / this._midiPulsesPerTick) * (clock._secondsPerTick * 1000);
        setTimeout(() => { try { out.send([0xf8]); } catch (_) {} }, pulseMs);
      }
    };

    clock.register(this._clockTickCb);

    // Patch start/stop to send transport messages
    const origStart = clock.start.bind(clock);
    const origStop  = clock.stop.bind(clock);
    clock.start = () => {
      origStart();
      const out = this._syncOutputId ? this.outputs.get(this._syncOutputId) : null;
      if (out) try { out.send([0xfa]); } catch (_) {}
    };
    clock.stop = () => {
      origStop();
      const out = this._syncOutputId ? this.outputs.get(this._syncOutputId) : null;
      if (out) try { out.send([0xfc]); } catch (_) {}
    };
    this._patchedClock       = clock;
    this._origClockStart     = origStart;
    this._origClockStop      = origStop;
  }

  disconnectClock() {
    if (this._clockTickCb && this._clock) {
      this._clock.unregister(this._clockTickCb);
    }
    // Restore original start/stop if we patched them
    if (this._patchedClock) {
      this._patchedClock.start = this._origClockStart;
      this._patchedClock.stop  = this._origClockStop;
      this._patchedClock = null;
    }
    this._clock        = null;
    this._audioCtx     = null;
    this._clockTickCb  = null;
  }
}
