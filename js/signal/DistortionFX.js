/**
 * DistortionFX.js
 * ---------------
 * Per-track waveshaper distortion / saturation. A drive knob pushes the signal
 * into a soft/hard nonlinearity (tanh-style curve whose steepness rises with
 * drive), followed by a tone lowpass to tame fizz, blended dry/wet.
 *
 * Signal chain (internal):
 *   input → dryGain ─────────────────────────────────→ output
 *   input → preGain → shaper → toneLPF → wetGain ─────→ output
 *
 * Parameters:
 *   'dist.drive' — 1–50, default 8     (pre-gain + curve steepness)
 *   'dist.tone'  — 500–18000 Hz, default 8000 (post lowpass)
 *   'dist.wet'   — 0–1, default 0
 *
 * Public: same block interface as the other FX (inputNode/outputNode/connect/
 * connectInput/disconnect/setEnabled/setParam/getParam/getParamList/
 * resolveAudioParam/toJSON/fromJSON).
 */

export class DistortionFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'dist.drive': 8,
      'dist.tone':  8000,
      'dist.wet':   0,
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

    // Pre-gain into the shaper — the audible "drive". A makeup divide on the
    // shaper output keeps level roughly constant as drive rises.
    this._preGain = context.createGain();
    this._preGain.gain.value = 1;

    this._shaper = context.createWaveShaper();
    this._shaper.oversample = '2x';
    this._buildCurve(this._params['dist.drive']);

    this._toneLPF = context.createBiquadFilter();
    this._toneLPF.type = 'lowpass';
    this._toneLPF.Q.value = 0.7071;
    this._toneLPF.frequency.value = this._params['dist.tone'];

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._preGain);
    this._preGain.connect(this._shaper);
    this._shaper.connect(this._toneLPF);
    this._toneLPF.connect(this._wetGain);
    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);
  }

  /**
   * tanh-style soft-clip curve. `drive` scales the input into the nonlinearity:
   * higher drive = more saturation. Normalised by tanh(k) so the curve always
   * spans ±1 (makeup gain), keeping output level stable across drive settings.
   */
  _buildCurve(drive) {
    const k = Math.max(1, Math.min(50, drive));
    const N = 1024;
    const curve = new Float32Array(N);
    const norm = Math.tanh(k);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;     // -1 … 1
      curve[i] = Math.tanh(k * x) / norm;
    }
    this._shaper.curve = curve;
    // Light pre-gain so low drive still bites a touch; curve carries the rest.
    this._preGain.gain.setTargetAtTime(1 + (k - 1) * 0.04, this.context.currentTime, 0.005);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['dist.wet'] : 0;
    const dry = enabled ? 1 - this._params['dist.wet'] * 0.5 : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'dist.drive':
        this._buildCurve(value);
        break;
      case 'dist.tone':
        this._toneLPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'dist.wet':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.005);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.005);
        }
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'dist.drive', label: 'Drive', type: 'number', min: 1,   max: 50,    default: 8,    modulatable: false,                              plockMode: 'js'         },
      { path: 'dist.tone',  label: 'Tone',  type: 'number', min: 500, max: 18000, default: 8000, modulatable: true, lfoMin: 500, lfoMax: 18000, plockMode: 'audioParam' },
      { path: 'dist.wet',   label: 'Wet',   type: 'number', min: 0,   max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'dist.tone': return this._toneLPF.frequency;
      case 'dist.wet':  return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
