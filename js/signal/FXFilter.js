/**
 * FXFilter.js
 * -----------
 * A standalone, in-line filter block for the FX pipeline — distinct from the
 * per-voice poly `Filter` (js/signal/Filter.js). This one sits POST-SUM in the
 * reorderable FX chain, so it processes the whole track (paraphonic: one cutoff
 * for all voices). Use it to carve the summed signal — e.g. roll off highs after
 * a crusher, or notch a band after reverb.
 *
 * It is fully in-line (no dry/wet — a filter replaces the signal), implemented
 * as a single BiquadFilterNode whose type/cutoff/resonance are settable. Its
 * params live under the `fxfilt.*` namespace so they never collide with the poly
 * filter's `filter.*` / `base.*` paths.
 *
 * Signal chain (internal):  input → biquad → output
 *
 * Parameters:
 *   'fxfilt.type'      — lowpass|highpass|bandpass|notch, default 'lowpass'
 *   'fxfilt.cutoff'    — 20–20000 Hz, default 12000
 *   'fxfilt.resonance' — 0.1–20 (Q),  default 0.7
 *
 * Public: same block interface as the other FX. `setEnabled(false)` bypasses by
 * routing the dry input straight to the output (the biquad is detached), so a
 * disabled filter is sonically transparent.
 */

export class FXFilter {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'fxfilt.type':      'lowpass',
      'fxfilt.cutoff':    12000,
      'fxfilt.resonance': 0.7,
    };

    // A filter has no wet param; "enabled" is the bypass switch. Default off so
    // a freshly-added block is transparent until the user dials it in.
    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._biquad = context.createBiquadFilter();
    this._biquad.type            = this._params['fxfilt.type'];
    this._biquad.frequency.value = this._params['fxfilt.cutoff'];
    this._biquad.Q.value         = this._params['fxfilt.resonance'];

    // Bypass gain: when disabled we pass input → output dry; when enabled we
    // route input → biquad → output and mute the dry path.
    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;        // transparent while disabled
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;

    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    this.inputNode.connect(this._biquad);
    this._biquad.connect(this._wetGain).connect(this.outputNode);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    // Fully wet when enabled (a filter replaces, not blends), dry when bypassed.
    this._wetGain.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.005);
    this._dryGain.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'fxfilt.type':      this._biquad.type = value;                                 break;
      case 'fxfilt.cutoff':    this._biquad.frequency.setTargetAtTime(value, t, 0.005);   break;
      case 'fxfilt.resonance': this._biquad.Q.setTargetAtTime(value, t, 0.005);           break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'fxfilt.type',      label: 'Type', type: 'enum',   options: ['lowpass','highpass','bandpass','notch'], default: 'lowpass', modulatable: false, plockMode: 'js' },
      { path: 'fxfilt.cutoff',    label: 'Cutoff',    type: 'number', min: 20,  max: 20000, default: 12000, modulatable: true, lfoMin: 20, lfoMax: 20000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'fxfilt.resonance', label: 'Res',       type: 'number', min: 0.1, max: 20,    default: 0.7,   modulatable: true, lfoMin: 0.1, lfoMax: 20,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'fxfilt.cutoff':    return this._biquad.frequency;
      case 'fxfilt.resonance': return this._biquad.Q;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
