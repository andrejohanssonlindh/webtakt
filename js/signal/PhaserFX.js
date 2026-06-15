/**
 * PhaserFX.js
 * -----------
 * ⚠ PARKED (not in the Add-FX menu). The effect proved too subtle to be useful
 * in practice — even with 6 resonant allpass stages, a wide low-mid sweep, and a
 * true 50/50 dry/wet mix it produced little discernible movement on the project's
 * material. Removed from Track.FX_TYPES / FX_TYPE_LABELS so it can't be added; the
 * class is kept intact for a possible future revisit (would likely need a stronger
 * topology — e.g. more stages, stereo offset, or a proper notch feedback design).
 * Old saves referencing a 'phaser' instance degrade gracefully (the loader skips
 * unknown FX types).
 *
 * Per-track phaser: a cascade of allpass filters whose centre frequencies are
 * swept by a sine LFO, mixed with the dry signal so the moving notches sweep.
 *
 * Signal chain (internal):
 *   input → dryGain ──────────────────────────────────────→ output
 *   input → ap0 → ap1 → … → apN → wetGain ────────────────→ output
 *           (each allpass .frequency driven by lfo × depth, biased to center)
 *
 * The dry path stays at FULL level; `wet` raises the phased copy alongside it
 * (true 50/50 at wet=1). Equal dry+wet is what makes the swept allpass notches
 * cancel deeply — that cancellation is the audible phaser sweep. (An earlier
 * version ducked the dry as wet rose, which shallowed the notches to near-
 * inaudible — it just dipped the level a hair.)
 *
 * Parameters:
 *   'phaser.rate'  — 0.05–8 Hz, default 0.5  (LFO speed)
 *   'phaser.depth' — 0–1,       default 0.6  (sweep width)
 *   'phaser.feedback' — 0–0.9,  default 0.3  (resonance — last stage → first)
 *   'phaser.wet'   — 0–1,       default 0
 *
 * Public: same block interface as the other FX.
 */

const STAGES    = 6;         // allpass stages (more = more notches = stronger effect)
const CENTER_HZ = 700;       // sweep centre (in the rich low-mids)
const SWING_HZ  = 650;       // ± swing at depth 1

export class PhaserFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'phaser.rate':     0.4,
      'phaser.depth':    0.8,
      'phaser.feedback': 0.6,
      'phaser.wet':      0,
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

    // Allpass cascade.
    this._stages = [];
    for (let i = 0; i < STAGES; i++) {
      const ap = context.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = CENTER_HZ;
      // A higher Q sharpens each allpass's phase transition → deeper, more
      // resonant notches when summed with dry (a more obvious phaser).
      ap.Q.value = 3;
      this._stages.push(ap);
    }

    // Feedback: last stage → feedbackGain → first stage input.
    this._feedbackGain = context.createGain();
    this._feedbackGain.gain.value = this._params['phaser.feedback'];

    // LFO → depthGain → every stage frequency. Centre bias is the static
    // frequency.value above; the LFO swings around it.
    this._lfo = context.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = this._params['phaser.rate'];
    this._depthGain = context.createGain();
    this._depthGain.gain.value = SWING_HZ * this._params['phaser.depth'];
    this._lfo.connect(this._depthGain);
    for (const ap of this._stages) this._depthGain.connect(ap.frequency);
    this._lfo.start();

    // Wiring: dry path.
    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    // Wet path: input → ap chain → wetGain → output.
    this.inputNode.connect(this._stages[0]);
    for (let i = 0; i < this._stages.length - 1; i++) {
      this._stages[i].connect(this._stages[i + 1]);
    }
    const last = this._stages[this._stages.length - 1];
    last.connect(this._wetGain).connect(this.outputNode);
    // Feedback loop: last → feedbackGain → first.
    last.connect(this._feedbackGain).connect(this._stages[0]);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    // Bypassed → wet 0 (pure dry); enabled → the current wet mix. _applyMix keeps
    // dry at full either way.
    this._applyMix(enabled ? this._params['phaser.wet'] : 0, this.context.currentTime);
  }

  /**
   * A phaser needs dry and wet at roughly EQUAL level for the moving notches to
   * cancel deeply — that cancellation IS the sound. So the dry path stays near
   * full and the wet rises to full (true 50/50 at wet=1), rather than the dry
   * ducking as wet rises. `wet` is the mix knob 0–1.
   */
  _applyMix(wet, t) {
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'phaser.rate':
        this._lfo.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'phaser.depth':
        this._depthGain.gain.setTargetAtTime(SWING_HZ * value, t, 0.01);
        break;
      case 'phaser.feedback':
        this._feedbackGain.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'phaser.wet':
        if (this.enabled) this._applyMix(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'phaser.rate',     label: 'Rate',     type: 'number', min: 0.05, max: 8,   default: 0.4, modulatable: true, lfoMin: 0.05, lfoMax: 8,   plockMode: 'audioParam' },
      { path: 'phaser.depth',    label: 'Depth',    type: 'number', min: 0,    max: 1,   default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
      { path: 'phaser.feedback', label: 'Feedback', type: 'number', min: 0,    max: 0.9, default: 0.6, modulatable: true, lfoMin: 0,    lfoMax: 0.9, plockMode: 'audioParam' },
      { path: 'phaser.wet',      label: 'Wet',      type: 'number', min: 0,    max: 1,   default: 0,   modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'phaser.rate':     return this._lfo.frequency;
      case 'phaser.depth':    return this._depthGain.gain;
      case 'phaser.feedback': return this._feedbackGain.gain;
      case 'phaser.wet':      return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
