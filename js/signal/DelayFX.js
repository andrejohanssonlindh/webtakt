/**
 * DelayFX.js
 * ----------
 * Per-track stereo delay with feedback.
 *
 * Signal chain (internal):
 *   input → dryGain ──────────────────────────→ output
 *   input → delayNode → feedbackGain → delayNode (loop)
 *         → wetGain ──────────────────────────→ output
 *
 * All gain nodes are AudioParams so LFOs can modulate wet/feedback.
 *
 * Parameters:
 *   'delay.time'     — seconds, 0.01–1.0, default 0.375
 *   'delay.feedback' — 0–0.95, default 0.35
 *   'delay.wet'      — 0–1, default 0
 *
 * Public:
 *   .inputNode       — connect source here
 *   .outputNode      — connect to next stage
 *   connect(dest)
 *   connectInput(src)
 *   setParam(path, value, time)
 *   getParam(path)
 *   getParamList()
 *   resolveAudioParam(path) — returns AudioParam or null
 *   toJSON() / fromJSON()
 */

export class DelayFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'delay.time':     0.375,
      'delay.feedback': 0.35,
      'delay.wet':      0,
    };

    this.enabled = false;

    // Input splitter
    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;

    // Output mixer
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    // Dry path
    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;

    // Wet path
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;

    // Delay + feedback loop
    this._delayNode    = context.createDelay(2.0);
    this._delayNode.delayTime.value = this._params['delay.time'];

    this._feedbackGain = context.createGain();
    this._feedbackGain.gain.value = this._params['delay.feedback'];

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._delayNode);

    this._delayNode.connect(this._feedbackGain);
    this._feedbackGain.connect(this._delayNode);   // feedback loop
    this._delayNode.connect(this._wetGain);

    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    this.outputNode.connect(destinationNode);
  }

  /** @param {AudioNode} sourceNode */
  connectInput(sourceNode) {
    sourceNode.connect(this.inputNode);
  }

  disconnect() {
    this.outputNode.disconnect();
  }

  /** Enable or bypass the effect without changing the wet param value. */
  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['delay.wet'] : 0;
    const dry = enabled ? 1 - this._params['delay.wet'] * 0.5 : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  /** @param {string} path @param {number} value @param {number} [time] */
  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'delay.time':
        this._delayNode.delayTime.setTargetAtTime(value, t, 0.01);
        break;
      case 'delay.feedback':
        this._feedbackGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'delay.wet':
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
      { path: 'delay.time',     label: 'Time',     type: 'number', min: 0.01, max: 1.0,  default: 0.375, modulatable: true, lfoMin: 0.01, lfoMax: 1.0,  plockMode: 'audioParam' },
      { path: 'delay.feedback', label: 'Feedback', type: 'number', min: 0,    max: 0.95, default: 0.35,  modulatable: true, lfoMin: 0,    lfoMax: 0.95, plockMode: 'audioParam' },
      { path: 'delay.wet',      label: 'Wet',      type: 'number', min: 0,    max: 1,    default: 0,     modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    ];
  }

  /** @param {string} path @returns {AudioParam|null} */
  resolveAudioParam(path) {
    switch (path) {
      case 'delay.time':     return this._delayNode.delayTime;
      case 'delay.feedback': return this._feedbackGain.gain;
      case 'delay.wet':      return this._wetGain.gain;
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
