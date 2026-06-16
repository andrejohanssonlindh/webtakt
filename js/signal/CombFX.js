/**
 * CombFX.js
 * ---------
 * Per-track tuned comb resonator (Karplus-Strong-style). A very short feedback
 * delay line whose length sets a pitch: feeding noise or a transient through it
 * makes it ring at that pitch, so drums become pitched zaps and any source gains
 * a metallic, resonant tail. p-lock the tuning per step and the comb becomes a
 * little melodic voice riding your sequence.
 *
 * delay length = 1 / freq, so `freq` is the resonant pitch in Hz. A lowpass in
 * the feedback path (`damp`) controls how bright/long the ring is (Karplus
 * string-decay). `feedback` sets sustain.
 *
 * Signal chain (internal):
 *   input → dryGain ───────────────────────────────→ output
 *   input → combDelay → dampLP → fbGain → combDelay (loop)
 *         → wetGain ────────────────────────────────→ output
 *
 * Parameters:
 *   'comb.freq'     — resonant pitch Hz, 40..2000, default 220
 *   'comb.feedback' — 0..0.99, default 0.9 (ring sustain)
 *   'comb.damp'     — Hz, 500..16000, default 6000 (feedback lowpass)
 *   'comb.wet'      — 0..1, default 0
 *
 * Public: the standard FX block interface.
 */

const MAX_DELAY = 0.05;   // 50 ms → lowest pitch ≈ 20 Hz; we cap freq at 40

export class CombFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'comb.freq':     220,
      'comb.feedback': 0.8,
      'comb.damp':     6000,
      'comb.wet':      0,
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

    this._delay = context.createDelay(MAX_DELAY);
    this._delay.delayTime.value = 1 / this._params['comb.freq'];

    this._damp = context.createBiquadFilter();
    this._damp.type = 'lowpass';
    this._damp.frequency.value = this._params['comb.damp'];
    this._damp.Q.value = 0.5;

    this._fb = context.createGain();
    this._fb.gain.value = this._clampFb(this._params['comb.feedback']);

    // Makeup attenuation on the wet tap. A comb's resonant peak has gain
    // ~1/(1-fb): at the 0.85 cap that's ~6.7×, so without this the wet blasts out
    // far louder than dry (the "high-pitch yell"). 0.25 keeps the resonance audible
    // but level-matched. Feed the wet from POST-damp so it's the filtered tone.
    this._wetTrim = context.createGain();
    this._wetTrim.gain.value = 0.25;

    // Input attenuator into the loop — keeps the comb from being over-driven.
    this._inTrim = context.createGain();
    this._inTrim.gain.value = 0.5;

    // Loop: delay → damp → fb → delay. Wet tap is the damped (filtered) tone.
    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    this.inputNode.connect(this._inTrim).connect(this._delay);
    this._delay.connect(this._damp);
    this._damp.connect(this._fb).connect(this._delay);
    this._damp.connect(this._wetTrim).connect(this._wetGain).connect(this.outputNode);
  }

  /** Hard-cap feedback below self-oscillation. fb→1 makes the resonant peak gain
   *  blow up (1/(1-fb)) and the ring sustain explode into the piercing "from
   *  nowhere" tone reported above ~0.84. 0.85 keeps a long, musical ring while
   *  bounding the peak comfortably below the runaway region. */
  _clampFb(v) { return Math.max(0, Math.min(0.85, v)); }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['comb.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(enabled ? 1 - wet * 0.5 : 1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'comb.freq': {
        const dt = Math.min(MAX_DELAY, Math.max(1 / 2000, 1 / Math.max(40, value)));
        this._delay.delayTime.setTargetAtTime(dt, t, 0.005);
        break;
      }
      case 'comb.feedback': this._fb.gain.setTargetAtTime(this._clampFb(value), t, 0.005); break;
      case 'comb.damp':     this._damp.frequency.setTargetAtTime(value, t, 0.005);   break;
      case 'comb.wet':
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
      // Pitch is JS-driven: the value is a FREQUENCY but the node param is a
      // delay TIME (= 1/freq), so it must route through setParam, not straight
      // onto an AudioParam. p-lock 'js' + no resolveAudioParam keeps the mapping.
      { path: 'comb.freq',     label: 'Pitch',  type: 'number', min: 40,  max: 2000,  default: 220,  modulatable: true, lfoMin: 40,  lfoMax: 2000,  plockMode: 'js' },
      { path: 'comb.feedback', label: 'Sustain',type: 'number', min: 0,   max: 0.85,  default: 0.8,  modulatable: true, lfoMin: 0,   lfoMax: 0.85,  plockMode: 'audioParam' },
      { path: 'comb.damp',     label: 'Damp',   type: 'number', min: 500, max: 16000, default: 6000, modulatable: true, lfoMin: 500, lfoMax: 16000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'comb.wet',      label: 'Wet',    type: 'number', min: 0,   max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      // comb.freq is JS-driven: its VALUE is a frequency but the node param is a
      // delay TIME (= 1/freq). Returning the raw delayTime here would let an LFO
      // ride it as if it were the frequency (inverted, nonsensical) AND wrongly
      // list it as an LFO target. Mapping lives in setParam; this stays null.
      case 'comb.freq':     return null;
      case 'comb.feedback': return this._fb.gain;
      case 'comb.damp':     return this._damp.frequency;
      case 'comb.wet':      return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
