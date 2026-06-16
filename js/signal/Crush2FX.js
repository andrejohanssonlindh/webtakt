/**
 * Crush2FX.js
 * -----------
 * Per-track REAL bitcrusher — the worklet-backed successor to BitcrushFX. Where
 * the original faked sample-rate reduction with a lowpass, this one runs genuine
 * sample-and-hold downsampling and true bit-depth quantisation in an AudioWorklet
 * (bitcrush-processor.js).
 *
 * Dry/wet is done with JS gain nodes (a parallel dry path), NOT inside the
 * worklet — so a disabled/zero-wet block is transparent and, crucially, if the
 * worklet ever fails to construct the dry path still carries full audio (the
 * earlier in-worklet mix meant a dead node silenced the track even when bypassed).
 *
 * Signal chain (internal):
 *   input → dryGain ─────────────────────────────→ output
 *   input → crusher(worklet) → wetGain ──────────→ output   (worklet present)
 *   input → (no wet branch) ─────────────────────→ output   (worklet missing)
 *
 * Parameters:
 *   'crush2.bits'     — 1..16, default 8
 *   'crush2.downsamp' — 1..64 sample-and-hold factor, default 4
 *   'crush2.wet'      — 0..1, default 0
 *
 * Public: the standard FX block interface.
 */

export class Crush2FX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'crush2.bits':     8,
      'crush2.downsamp': 4,
      'crush2.wet':      0,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;

    // Dry path always carries audio (also the fallback if the worklet is missing).
    this.inputNode.connect(this._dryGain).connect(this.outputNode);

    // Wet path: worklet always outputs 100% crush; the wetGain blends it in.
    this._node = null;
    if (!this._buildNode()) {
      // Module not registered yet (block added before AudioEngine's fire-and-forget
      // addModule resolved) — register it ourselves and build the node on resolve.
      context.audioWorklet?.addModule('js/worklets/bitcrush-processor.js')
        .then(() => { if (this._buildNode() && this.enabled) this.setEnabled(true); })
        .catch(err => console.warn('Crush2FX: bitcrush worklet unavailable, passing dry.', err));
    }
  }

  /** Construct + wire the worklet node. Returns true on success. */
  _buildNode() {
    if (this._node) return true;
    const context = this.context;
    try {
      // Match the PROVEN-working worklet pattern (patina-ladder filter,
      // wavetable-sampler): just numberOfInputs/Outputs + an explicit
      // outputChannelCount. The earlier `channelCount:2, channelCountMode:'explicit'`
      // override (and NO outputChannelCount) was the live-silence culprit — it left
      // the node's output channel count unstable so the wet branch produced nothing
      // (you heard only the ducked dry → "slightly quieter, no crush"). The
      // processor already falls back to channel 0 for any missing input channel.
      this._node = new AudioWorkletNode(context, 'bitcrush', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      // A processor that throws emits `processorerror` and then outputs silence for
      // the rest of its life (per spec) — surface it; otherwise it's invisible.
      this._node.onprocessorerror = (e) =>
        console.error('Crush2FX: bitcrush processor errored → silent for life.', e);
      this.inputNode.connect(this._node);
      this._node.connect(this._wetGain).connect(this.outputNode);
      // Worklet runs fully wet; the JS wetGain does the blend.
      this._node.parameters.get('wet').setValueAtTime(1, context.currentTime);
      this._node.parameters.get('bits').setValueAtTime(this._params['crush2.bits'], context.currentTime);
      this._node.parameters.get('downsamp').setValueAtTime(this._params['crush2.downsamp'], context.currentTime);
      return true;
    } catch (_) {
      this._node = null;
      return false;
    }
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  // Audio detach ONLY — must NOT kill the worklet. `_rewireFXChain` calls this on
  // every block whenever the chain changes (including right after addFX), so
  // killing here made the processor return false forever → process() never ran →
  // the wet branch was permanently silent ("no effect, just quieter"). Final
  // teardown lives in destroy().
  disconnect() {
    this.outputNode.disconnect();
  }

  /** Permanent teardown — kill the processor. Only on actual removal (removeFX). */
  destroy() {
    try { this._node?.port.postMessage('kill'); } catch (_) {}
    this.outputNode.disconnect();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled && this._node ? this._params['crush2.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.01);
    this._dryGain.gain.setTargetAtTime(enabled && this._node ? 1 - wet * 0.5 : 1, t, 0.01);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'crush2.bits':     this._node?.parameters.get('bits').setTargetAtTime(value, t, 0.005);     break;
      case 'crush2.downsamp': this._node?.parameters.get('downsamp').setTargetAtTime(value, t, 0.005); break;
      case 'crush2.wet':
        if (this.enabled && this._node) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.01);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.01);
        }
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'crush2.bits',     label: 'Bits',  type: 'number', min: 1, max: 16, default: 8, modulatable: true, lfoMin: 1, lfoMax: 16, plockMode: 'audioParam' },
      { path: 'crush2.downsamp', label: 'Down',  type: 'number', min: 1, max: 64, default: 4, modulatable: true, lfoMin: 1, lfoMax: 64, plockMode: 'audioParam' },
      { path: 'crush2.wet',      label: 'Wet',   type: 'number', min: 0, max: 1,  default: 0, modulatable: true, lfoMin: 0, lfoMax: 1,  plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'crush2.bits':     return this._node?.parameters.get('bits')     ?? null;
      case 'crush2.downsamp': return this._node?.parameters.get('downsamp') ?? null;
      case 'crush2.wet':      return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
