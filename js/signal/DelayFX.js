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
 *   'delay.time'     — seconds, 0.01–2.0, default 0.375 (used when syncMode='ms')
 *   'delay.syncMode' — 'ms' | 'bpm', default 'ms'
 *   'delay.bpmDiv'   — beat division string, default '1/4' (used when syncMode='bpm')
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
 *   setBpm(bpm)             — update BPM for synced time calculation
 *   toJSON() / fromJSON()
 */

// Quarter-note multipliers matching LFO.js BPM_DIVISIONS
const DIV_QN = { '1/32':0.125, '1/16':0.25, '1/8':0.5, '1/4':1, '1/2':2, '1/1':4, '2/1':8, '4/1':16 };
export const DELAY_DIVISIONS = ['1/32','1/16','1/8','1/4','1/2','1/1','2/1','4/1'];

function divToSeconds(div, bpm) {
  return (DIV_QN[div] ?? 1) * 60 / bpm;
}

export class DelayFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm    = 120;

    this._params = {
      'delay.time':     0.375,
      'delay.syncMode': 'ms',
      'delay.bpmDiv':   '1/4',
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

  /** Update BPM and recalculate delay time when in BPM sync mode. */
  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['delay.syncMode'] === 'bpm') {
      this._applyBpmTime();
    }
  }

  _applyBpmTime() {
    const secs = divToSeconds(this._params['delay.bpmDiv'], this._bpm);
    const clamped = Math.min(Math.max(secs, 0.001), 2.0);
    this._delayNode.delayTime.setTargetAtTime(clamped, this.context.currentTime, 0.01);
  }

  /** @param {string} path @param {number|string} value @param {number} [time] */
  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'delay.time':
        if (this._params['delay.syncMode'] === 'ms') {
          this._delayNode.delayTime.setTargetAtTime(value, t, 0.01);
        }
        break;
      case 'delay.syncMode':
        if (value === 'bpm') {
          this._applyBpmTime();
        } else {
          this._delayNode.delayTime.setTargetAtTime(this._params['delay.time'], t, 0.01);
        }
        break;
      case 'delay.bpmDiv':
        if (this._params['delay.syncMode'] === 'bpm') {
          this._applyBpmTime();
        }
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
    const isBpm = this._params['delay.syncMode'] === 'bpm';
    return [
      { path: 'delay.syncMode', label: 'Sync',     type: 'enum',   options: ['ms','bpm'],  default: 'ms',  modulatable: false, plockMode: 'js' },
      { path: 'delay.time',     label: 'Time',      type: 'number', min: 0.001, max: 2.0,  default: 0.375, modulatable: true, lfoMin: 0.001, lfoMax: 2.0, plockMode: 'audioParam', hidden: isBpm },
      { path: 'delay.bpmDiv',   label: 'Division',  type: 'enum',   options: DELAY_DIVISIONS, default: '1/4', modulatable: false, plockMode: 'js', hidden: !isBpm },
      { path: 'delay.feedback', label: 'Feedback',  type: 'number', min: 0,    max: 0.95, default: 0.35,  modulatable: true, lfoMin: 0,    lfoMax: 0.95, plockMode: 'audioParam' },
      { path: 'delay.wet',      label: 'Wet',       type: 'number', min: 0,    max: 1,    default: 0,     modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
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
