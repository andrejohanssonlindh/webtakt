/**
 * InputMachine.js
 * ---------------
 * Captures live incoming audio (3.5mm line-in, USB interface, any device the
 * browser exposes via getUserMedia) and feeds it into the normal per-track
 * signal chain, so it can be filtered, p-locked, LFO-modulated, and run through
 * the FX pipeline like any other voice — but without being "programmed" with
 * notes. It is the input mirror of MidiMachine: MidiMachine produces no audio
 * and sends notes out; InputMachine produces continuous real audio and ignores
 * pitch.
 *
 * Source = a MediaStreamAudioSourceNode, structurally identical to
 * NoiseMachine's looping noise source except the samples come from the OS audio
 * input. It feeds `outputGain` (the level control); `connect()` wires
 * outputGain → filter input, exactly like every other machine.
 *
 * GATE (continuous vs. note-gated) — see design/input-machine.md:
 *   - Continuous (default, input.gate = false): input passes through all the
 *     time like a mixer channel. The per-voice amp gate (Envelope.ampGain) must
 *     be held OPEN for this; that is owned by Track._applyInputGate() because
 *     ampGain lives in the slot envelope, not the machine. noteOn/noteOff are
 *     amp no-ops here, and pitch is ignored.
 *   - Gated (input.gate = true): noteOn/noteOff fall back to normal voice
 *     behaviour, so the sequencer/keyboard chop the live input (trance-gate /
 *     gated-reverb). The machine still does nothing per note (no synthesis); the
 *     envelope does the gating, exactly as for any other machine.
 *
 * SINGLETON SOURCE — VoicePool builds 8 slots each with its own machine, but
 * there is only ONE input stream. A module-level, ref-counted manager
 * (_StreamManager) owns the getUserMedia stream + MediaStreamAudioSourceNode per
 * (context, deviceId) and fans it out to every InputMachine instance that asks.
 * disconnect() releases one ref; the stream + its tracks are stopped only when
 * the last InputMachine for that device goes away.
 *
 * getUserMedia constraints are tuned for MUSIC, not voice: echoCancellation,
 * autoGainControl and noiseSuppression are all OFF (they would wreck a guitar /
 * synth / line signal). Requires a secure context (HTTPS or localhost); plain
 * http on a non-local host will reject — surfaced by InputPanel.
 *
 * Parameters:
 *   'output.level' — 0–1 output level (LFO/p-lock assignable)
 *   'input.gate'   — boolean; false = continuous, true = note-gated
 */

import { Machine } from './Machine.js';

/**
 * Ref-counted registry of live input streams keyed by `${ctxId}::${deviceId}`.
 * One MediaStreamAudioSourceNode is shared across every InputMachine asking for
 * the same device on the same context. Web Audio allows one node → many
 * destinations, so fan-out across voice slots is free; only the ref count and
 * teardown need managing.
 */
class _StreamManager {
  constructor() {
    /** key → { stream, sourceNode, refs } */
    this._entries = new Map();
    this._ctxIds  = new WeakMap();
    this._nextId  = 1;
  }

  _ctxId(context) {
    let id = this._ctxIds.get(context);
    if (!id) { id = this._nextId++; this._ctxIds.set(context, id); }
    return id;
  }

  _key(context, deviceId) {
    return `${this._ctxId(context)}::${deviceId ?? 'default'}`;
  }

  /**
   * Acquire (or create) the shared source node for a device. Increments the ref
   * count. Async because getUserMedia is async + permission-gated.
   * @returns {Promise<MediaStreamAudioSourceNode>}
   */
  async acquire(context, deviceId) {
    const key = this._key(context, deviceId);
    const existing = this._entries.get(key);
    if (existing) { existing.refs++; return existing.sourceNode; }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia unavailable (insecure context or unsupported browser)');
    }

    const audio = {
      echoCancellation: false,
      autoGainControl:  false,
      noiseSuppression: false,
      latency:          0,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    const stream     = await navigator.mediaDevices.getUserMedia({ audio });
    const sourceNode = context.createMediaStreamSource(stream);
    this._entries.set(key, { stream, sourceNode, refs: 1 });
    return sourceNode;
  }

  /** Release one ref; stop the stream + tracks when the last ref goes away. */
  release(context, deviceId) {
    const key   = this._key(context, deviceId);
    const entry = this._entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    try { entry.sourceNode.disconnect(); } catch (_) {}
    for (const t of entry.stream.getTracks()) { try { t.stop(); } catch (_) {} }
    this._entries.delete(key);
  }
}

const _streams = new _StreamManager();

export class InputMachine extends Machine {
  static SPEC = {
    // Makeup gain applied to the raw input BEFORE the level/chain. Line-in and
    // many mics arrive quiet; this lets you bring a weak source up to a usable
    // level (0–8×, default 2×). Sits source → inputGain → outputGain → filter.
    'input.gain':   { label: 'Gain', type: 'number', min: 0, max: 8, default: 2.0,
                      modulatable: true, lfoMin: 0, lfoMax: 8,
                      target: m => m.inputGain.gain, schedule: 'setValue' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 1.0, ampMaster: true,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
    // Gate mode is a JS-only enum-ish boolean; the actual gate behaviour is
    // owned by Track._applyInputGate (it pins/releases the slot envelope).
    'input.gate':   { label: 'Gate', type: 'boolean', default: false, plockMode: 'js' },
  };

  /** @param {AudioContext} context */
  constructor(context) {
    super(context);
    this.type  = 'input';
    this.label = 'Input';

    this._initSpec();

    // Makeup-gain node: source → inputGain → outputGain → (filter, via connect()).
    this.inputGain = context.createGain();
    this.inputGain.gain.value = this._params['input.gain'];

    // Output level node — the machine's output, wired to the filter by connect().
    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
    this.inputGain.connect(this.outputGain);

    // Metering analyser — tapped POST makeup-gain (so the meter reflects the
    // amplified signal you'll actually hear) but PRE level/gate/filter. Silent
    // parallel branch: it has no onward connection, so it never affects audio.
    // The source feeds inputGain (which feeds the meter) in enableInput().
    this._meter = context.createAnalyser();
    this._meter.fftSize = 1024;
    this._meterBuf = new Float32Array(this._meter.fftSize);
    this.inputGain.connect(this._meter);

    this._deviceId  = null;   // selected input device, or null = system default
    this._source    = null;   // shared MediaStreamAudioSourceNode (or null until enabled)
    this._acquired  = false;  // true once we hold a stream ref (for release on disconnect)
    this._enabling  = false;  // guards concurrent enableInput() calls
    this.lastError  = null;   // surfaced to InputPanel on failure
  }

  /**
   * Request mic/line access and wire the shared source into outputGain. Safe to
   * call repeatedly; re-acquires only when the device changed or no source is
   * held. Returns true on success. On failure, stores the error on .lastError
   * and returns false (no throw — the panel reads .lastError).
   * @returns {Promise<boolean>}
   */
  async enableInput() {
    if (this._enabling) return this._acquired;
    this._enabling = true;
    try {
      // Already holding a source for the current device → nothing to do.
      if (this._acquired && this._source) return true;
      const source = await _streams.acquire(this.context, this._deviceId);
      this._source   = source;
      this._acquired = true;
      this.lastError = null;
      // source → inputGain (makeup) → outputGain → filter; inputGain also feeds
      // the meter. One edge to wire here; the rest is permanent (constructor).
      try { source.connect(this.inputGain); } catch (_) {}
      // A freshly-constructed AudioContext is often 'suspended' until a gesture
      // resumes it — without this, a captured stream produces no sound. Enabling
      // input IS a user gesture, so resume here.
      if (this.context.state === 'suspended') { try { await this.context.resume(); } catch (_) {} }
      return true;
    } catch (err) {
      this.lastError = err;
      this._source   = null;
      this._acquired = false;
      return false;
    } finally {
      this._enabling = false;
    }
  }

  /** Stop capturing: release our stream ref and disconnect the source edge.
   *  After this, .active is false and the panel button reads "Enable Input". */
  disableInput() {
    this._releaseSource();
    this.lastError = null;
  }

  /** True while a live stream is wired in. */
  get active() { return this._acquired && this._source != null; }

  /** Currently selected input device id (null = system default). */
  getDevice() { return this._deviceId; }

  /**
   * Select an input device by id (null = system default). Releases the current
   * stream and re-acquires the new device if input was already enabled.
   * @param {string|null} deviceId
   * @returns {Promise<boolean>} resolves true if (re)enabled successfully
   */
  async setDevice(deviceId) {
    if (deviceId === this._deviceId) return this.active;
    const wasActive = this._acquired;
    this._releaseSource();
    this._deviceId = deviceId ?? null;
    if (wasActive) return this.enableInput();
    return false;
  }

  /** Release our ref on the shared source (disconnects our fan-out edge). */
  _releaseSource() {
    if (this._source) {
      try { this._source.disconnect(this.inputGain); } catch (_) {}
    }
    if (this._acquired) _streams.release(this.context, this._deviceId);
    this._source   = null;
    this._acquired = false;
  }

  /**
   * Current input signal level for metering, measured PRE-level/gate off the raw
   * source. Returns { rms, peak } in 0–1. Reads time-domain samples from the
   * analyser each call (call it from a rAF loop). Returns zeros when no stream.
   * @returns {{rms:number, peak:number}}
   */
  getInputLevel() {
    if (!this.active) return { rms: 0, peak: 0 };
    const buf = this._meterBuf;
    this._meter.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sum / buf.length), peak };
  }

  /** Whether the track should run the input note-gated (true) or continuous (false). */
  get gated() { return !!this._params['input.gate']; }

  // ── Note interface ──────────────────────────────────────────────────────
  // The machine never synthesises per note: in continuous mode the envelope is
  // held open by Track and these are no-ops; in gated mode the envelope (driven
  // by VoiceSlot/Sequencer) does the gating and these stay no-ops too. Pitch is
  // always ignored — there is nothing to retune.
  noteOn(midiNote, velocity, time) {}
  noteOff(time) {}

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this._releaseSource();
    try { this.outputGain.disconnect(); } catch (_) {}
  }

  // Param interface (setParam/getParam/getParamList/resolveAudioParam/toJSON/
  // fromJSON) is derived from `static SPEC` by the Machine base class.

  toJSON() {
    return { ...super.toJSON(), deviceId: this._deviceId };
  }

  fromJSON(obj) {
    super.fromJSON(obj);
    // Restore the device SELECTION only — do NOT auto-enable input on load.
    // getUserMedia needs a fresh user gesture (the panel's enable button), and
    // silently grabbing the mic on project load would be hostile.
    if (obj && 'deviceId' in obj) this._deviceId = obj.deviceId ?? null;
  }
}
