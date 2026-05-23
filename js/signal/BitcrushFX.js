/**
 * BitcrushFX.js
 * -------------
 * Per-track bitcrusher: reduces bit depth and sample rate.
 *
 * Implemented with a WaveShaperNode (bit depth) in series with a hold-based
 * downsampler (rate reduction via StereoPannerNode-trick is not possible in
 * Web Audio; instead we approximate sample-rate reduction by averaging
 * blocks — we use a ScriptProcessorNode-free approach: a WaveShaper on the
 * bit depth side, and a very short delay + feedback loop approximating
 * sample-and-hold for rate reduction).
 *
 * Practical approach used here:
 *   - Bit depth: WaveShaperNode with a quantisation curve (2^bits steps)
 *   - Rate:      BiquadFilterNode (lowpass) with cutoff = rate * nyquist,
 *                which perceptually mimics downsampling aliasing smear.
 *                True sample-and-hold is not achievable without AudioWorklet.
 *
 * Signal chain (internal):
 *   input → dryGain ─────────────────────────────→ output
 *   input → rateLPF → bitShaper → wetGain → output
 *
 * Parameters:
 *   'crush.bits' — 1–16, default 16 (16 = no crush)
 *   'crush.rate' — 0.01–1.0 (fraction of nyquist for the pre-filter), default 1.0
 *   'crush.wet'  — 0–1, default 0
 *
 * Public:
 *   .inputNode / .outputNode
 *   connect(dest) / connectInput(src) / disconnect()
 *   setParam(path, value, time)
 *   getParam(path) / getParamList()
 *   resolveAudioParam(path)
 *   toJSON() / fromJSON()
 */

export class BitcrushFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'crush.bits': 16,
      'crush.rate': 1.0,
      'crush.wet':  0,
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

    // Rate-reduction pre-filter (lowpass — mimics aliasing onset)
    this._rateLPF = context.createBiquadFilter();
    this._rateLPF.type = 'lowpass';
    this._rateLPF.Q.value = 0.5;
    this._rateLPF.frequency.value = context.sampleRate / 2; // start open

    // Bit-depth waveshaper
    this._bitShaper = context.createWaveShaper();
    this._buildBitCurve(this._params['crush.bits']);

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._rateLPF);
    this._rateLPF.connect(this._bitShaper);
    this._bitShaper.connect(this._wetGain);
    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);
  }

  _buildBitCurve(bits) {
    const steps = Math.pow(2, Math.max(1, Math.min(16, Math.round(bits))));
    const N = 1024;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;  // -1 to +1
      curve[i] = Math.round(x * (steps / 2)) / (steps / 2);
    }
    this._bitShaper.curve = curve;
  }

  connect(destinationNode) {
    this.outputNode.connect(destinationNode);
  }

  connectInput(sourceNode) {
    sourceNode.connect(this.inputNode);
  }

  disconnect() {
    this.outputNode.disconnect();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['crush.wet'] : 0;
    const dry = enabled ? 1 - this._params['crush.wet'] * 0.5 : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'crush.bits':
        this._buildBitCurve(value);
        break;
      case 'crush.rate': {
        // Map 0.01–1.0 → nyquist*0.01 – nyquist
        const nyquist = this.context.sampleRate / 2;
        const freq = Math.max(200, value * nyquist);
        this._rateLPF.frequency.setTargetAtTime(freq, t, 0.005);
        break;
      }
      case 'crush.wet':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.005);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.005);
        }
        break;
    }
  }

  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'crush.bits', label: 'Bits', type: 'number', min: 1,    max: 16,  default: 16,  modulatable: false,                            plockMode: 'js'        },
      { path: 'crush.rate', label: 'Rate', type: 'number', min: 0.01, max: 1.0, default: 1.0, modulatable: true, lfoMin: 0.01, lfoMax: 1.0,  plockMode: 'audioParam' },
      { path: 'crush.wet',  label: 'Wet',  type: 'number', min: 0,    max: 1,   default: 0,   modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'crush.rate': return this._rateLPF.frequency;
      case 'crush.wet':  return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() {
    return { params: { ...this._params }, enabled: this.enabled };
  }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
