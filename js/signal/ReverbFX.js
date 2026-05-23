/**
 * ReverbFX.js
 * -----------
 * Per-track algorithmic reverb using a ConvolverNode with a synthesized
 * exponential-decay noise impulse response.
 *
 * IR is regenerated whenever decay or pre-delay changes. The wet signal
 * passes through a lowpass damping filter before mixing.
 *
 * Signal chain (internal):
 *   input → dryGain ──────────────────────────────────────→ output
 *   input → convolver → dampFilter → wetGain → output
 *
 * Parameters:
 *   'reverb.decay'    — seconds, 0.1–8.0, default 1.5  (rebuilds IR — track-level only)
 *   'reverb.predelay' — seconds, 0–0.1,   default 0    (rebuilds IR — track-level only)
 *   'reverb.damp'     — Hz, 200–20000,    default 8000 (LP on wet signal, LFO/p-lock ok)
 *   'reverb.wet'      — 0–1,              default 0    (LFO/p-lock ok)
 *
 * Public:
 *   .inputNode / .outputNode
 *   connect(dest) / connectInput(src) / disconnect()
 *   setParam(path, value, time)
 *   getParam(path) / getParamList()
 *   resolveAudioParam(path)
 *   toJSON() / fromJSON()
 */

export class ReverbFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'reverb.decay':    1.5,
      'reverb.predelay': 0.02,
      'reverb.damp':     8000,
      'reverb.wet':      0,
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

    this._convolver = context.createConvolver();
    this._convolver.normalize = true;

    this._dampFilter = context.createBiquadFilter();
    this._dampFilter.type = 'lowpass';
    this._dampFilter.frequency.value = this._params['reverb.damp'];
    this._dampFilter.Q.value = 0.5;

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._convolver);
    this._convolver.connect(this._dampFilter);
    this._dampFilter.connect(this._wetGain);
    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);

    this._buildIR();
  }

  /** Build a stereo exponential-decay noise IR. */
  _buildIR() {
    const ctx      = this.context;
    const sr       = ctx.sampleRate;
    const decay    = this._params['reverb.decay'];
    const predelay = this._params['reverb.predelay'];

    const length    = Math.ceil((predelay + decay * 3) * sr);  // 3τ tail
    const preSamp   = Math.ceil(predelay * sr);
    const ir        = ctx.createBuffer(2, length, sr);

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        if (i < preSamp) {
          data[i] = 0;
        } else {
          const t = (i - preSamp) / sr;
          data[i] = (Math.random() * 2 - 1) * Math.exp(-t / decay);
        }
      }
    }
    this._convolver.buffer = ir;
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
    const wet = enabled ? this._params['reverb.wet'] : 0;
    const dry = enabled ? 1 - this._params['reverb.wet'] * 0.5 : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'reverb.decay':
      case 'reverb.predelay':
        this._buildIR();
        break;
      case 'reverb.damp':
        this._dampFilter.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'reverb.wet':
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
      { path: 'reverb.decay',    label: 'Decay',   type: 'number', min: 0.1,  max: 8.0,   default: 1.5,  modulatable: false,                            plockMode: 'js'        },
      { path: 'reverb.predelay', label: 'Pre-dly', type: 'number', min: 0,    max: 0.1,   default: 0.02, modulatable: false,                            plockMode: 'js'        },
      { path: 'reverb.damp',     label: 'Damp',    type: 'number', min: 200,  max: 20000, default: 8000, modulatable: true, lfoMin: 200, lfoMax: 20000,  plockMode: 'audioParam' },
      { path: 'reverb.wet',      label: 'Wet',     type: 'number', min: 0,    max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,      plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'reverb.damp': return this._dampFilter.frequency;
      case 'reverb.wet':  return this._wetGain.gain;
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
