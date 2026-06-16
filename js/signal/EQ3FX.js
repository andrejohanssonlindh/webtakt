/**
 * EQ3FX.js
 * --------
 * Per-track 3-band equaliser: low shelf, mid peaking bell, high shelf. Three
 * BiquadFilterNodes in series, fully in-line (an EQ shapes, it doesn't blend, so
 * there is no dry/wet). Params live under the `eq3.*` namespace.
 *
 * Signal chain (internal):  input → lowShelf → midPeak → highShelf → output
 *
 * Each band is a ±dB gain; the mid band also has a tunable centre frequency and
 * Q. `setEnabled(false)` flattens all three gains to 0 dB (transparent) rather
 * than rerouting — a flat EQ is already a passthrough, so bypass = flat.
 *
 * Parameters:
 *   'eq3.lowGain'  — dB, -18..18, default 0   (low shelf, fixed 250 Hz)
 *   'eq3.midGain'  — dB, -18..18, default 0   (mid bell)
 *   'eq3.midFreq'  — Hz, 200..6000, default 1000
 *   'eq3.midQ'     — 0.3..8, default 1
 *   'eq3.highGain' — dB, -18..18, default 0   (high shelf, fixed 4000 Hz)
 *
 * Public: the standard FX block interface.
 */

const LOW_HZ  = 250;
const HIGH_HZ = 4000;

export class EQ3FX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'eq3.lowGain':  0,
      'eq3.midGain':  0,
      'eq3.midFreq':  1000,
      'eq3.midQ':     1,
      'eq3.highGain': 0,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._low = context.createBiquadFilter();
    this._low.type = 'lowshelf';
    this._low.frequency.value = LOW_HZ;
    this._low.gain.value = 0;

    this._mid = context.createBiquadFilter();
    this._mid.type = 'peaking';
    this._mid.frequency.value = this._params['eq3.midFreq'];
    this._mid.Q.value = this._params['eq3.midQ'];
    this._mid.gain.value = 0;

    this._high = context.createBiquadFilter();
    this._high.type = 'highshelf';
    this._high.frequency.value = HIGH_HZ;
    this._high.gain.value = 0;

    this.inputNode.connect(this._low);
    this._low.connect(this._mid);
    this._mid.connect(this._high);
    this._high.connect(this.outputNode);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    // Bypassed → flat (0 dB on every band). Enabled → the stored gains.
    this._low.gain.setTargetAtTime(enabled ? this._params['eq3.lowGain']  : 0, t, 0.01);
    this._mid.gain.setTargetAtTime(enabled ? this._params['eq3.midGain']  : 0, t, 0.01);
    this._high.gain.setTargetAtTime(enabled ? this._params['eq3.highGain'] : 0, t, 0.01);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'eq3.lowGain':  if (this.enabled) this._low.gain.setTargetAtTime(value, t, 0.01);  break;
      case 'eq3.midGain':  if (this.enabled) this._mid.gain.setTargetAtTime(value, t, 0.01);  break;
      case 'eq3.midFreq':  this._mid.frequency.setTargetAtTime(value, t, 0.01);               break;
      case 'eq3.midQ':     this._mid.Q.setTargetAtTime(value, t, 0.01);                       break;
      case 'eq3.highGain': if (this.enabled) this._high.gain.setTargetAtTime(value, t, 0.01); break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'eq3.lowGain',  label: 'Low',   type: 'number', min: -18, max: 18,   default: 0,    modulatable: true, lfoMin: -18, lfoMax: 18,   plockMode: 'audioParam' },
      { path: 'eq3.midGain',  label: 'Mid',   type: 'number', min: -18, max: 18,   default: 0,    modulatable: true, lfoMin: -18, lfoMax: 18,   plockMode: 'audioParam' },
      { path: 'eq3.midFreq',  label: 'M.Freq',type: 'number', min: 200, max: 6000, default: 1000, modulatable: true, lfoMin: 200, lfoMax: 6000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'eq3.midQ',     label: 'M.Q',   type: 'number', min: 0.3, max: 8,    default: 1,    modulatable: true, lfoMin: 0.3, lfoMax: 8,    plockMode: 'audioParam' },
      { path: 'eq3.highGain', label: 'High',  type: 'number', min: -18, max: 18,   default: 0,    modulatable: true, lfoMin: -18, lfoMax: 18,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'eq3.lowGain':  return this._low.gain;
      case 'eq3.midGain':  return this._mid.gain;
      case 'eq3.midFreq':  return this._mid.frequency;
      case 'eq3.midQ':     return this._mid.Q;
      case 'eq3.highGain': return this._high.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
