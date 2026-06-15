/**
 * CompressorFX.js
 * ---------------
 * Per-track dynamics compressor wrapping a DynamicsCompressorNode, with a
 * makeup-gain stage and a dry/wet blend (parallel "New York" compression when
 * wet < 1).
 *
 * Signal chain (internal):
 *   input → dryGain ───────────────────────────────→ output
 *   input → comp → makeupGain → wetGain ───────────→ output
 *
 * Parameters:
 *   'comp.threshold' — -60–0 dB,  default -24
 *   'comp.ratio'     — 1–20,      default 4
 *   'comp.attack'    — 0–0.5 s,   default 0.003
 *   'comp.release'   — 0.01–1 s,  default 0.25
 *   'comp.makeup'    — 0–24 dB,   default 0
 *   'comp.wet'       — 0–1,       default 0
 *
 * Public: same block interface as the other FX.
 */

export class CompressorFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'comp.threshold': -24,
      'comp.ratio':     4,
      'comp.attack':    0.003,
      'comp.release':   0.25,
      'comp.makeup':    0,
      'comp.wet':       0,
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

    this._comp = context.createDynamicsCompressor();
    this._comp.threshold.value = this._params['comp.threshold'];
    this._comp.ratio.value     = this._params['comp.ratio'];
    this._comp.attack.value    = this._params['comp.attack'];
    this._comp.release.value   = this._params['comp.release'];
    this._comp.knee.value      = 6;

    this._makeupGain = context.createGain();
    this._makeupGain.gain.value = this._dbToGain(this._params['comp.makeup']);

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._comp);
    this._comp.connect(this._makeupGain);
    this._makeupGain.connect(this._wetGain);
    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);
  }

  _dbToGain(db) { return Math.pow(10, db / 20); }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    // Compression is a full-replace effect: at wet=1 the dry path drops out.
    const wet = enabled ? this._params['comp.wet'] : 0;
    const dry = enabled ? 1 - this._params['comp.wet'] : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'comp.threshold': this._comp.threshold.setTargetAtTime(value, t, 0.005); break;
      case 'comp.ratio':     this._comp.ratio.setTargetAtTime(value, t, 0.005);     break;
      case 'comp.attack':    this._comp.attack.setTargetAtTime(value, t, 0.005);    break;
      case 'comp.release':   this._comp.release.setTargetAtTime(value, t, 0.005);   break;
      case 'comp.makeup':    this._makeupGain.gain.setTargetAtTime(this._dbToGain(value), t, 0.005); break;
      case 'comp.wet':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.005);
          this._dryGain.gain.setTargetAtTime(1 - value, t, 0.005);
        }
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'comp.threshold', label: 'Thresh',  type: 'number', min: -60, max: 0,   default: -24,   modulatable: true,  lfoMin: -60, lfoMax: 0,   plockMode: 'audioParam' },
      { path: 'comp.ratio',     label: 'Ratio',   type: 'number', min: 1,   max: 20,  default: 4,     modulatable: true,  lfoMin: 1,   lfoMax: 20,  plockMode: 'audioParam' },
      { path: 'comp.attack',    label: 'Attack',  type: 'number', min: 0,   max: 0.5, default: 0.003, modulatable: false,                           plockMode: 'audioParam' },
      { path: 'comp.release',   label: 'Release', type: 'number', min: 0.01,max: 1,   default: 0.25,  modulatable: false,                           plockMode: 'audioParam' },
      { path: 'comp.makeup',    label: 'Makeup',  type: 'number', min: 0,   max: 24,  default: 0,     modulatable: true,  lfoMin: 0,   lfoMax: 24,  plockMode: 'audioParam' },
      { path: 'comp.wet',       label: 'Wet',     type: 'number', min: 0,   max: 1,   default: 0,     modulatable: true,  lfoMin: 0,   lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'comp.threshold': return this._comp.threshold;
      case 'comp.ratio':     return this._comp.ratio;
      case 'comp.attack':    return this._comp.attack;
      case 'comp.release':   return this._comp.release;
      case 'comp.makeup':    return this._makeupGain.gain;
      case 'comp.wet':       return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
