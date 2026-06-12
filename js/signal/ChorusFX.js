/**
 * ChorusFX.js
 * -----------
 * Per-track BBD-style stereo chorus — ported from the PATINA engine
 * (js/patina/patina.js, "BBD-style stereo chorus"). Part of the analogue flow:
 * it is inserted into every track's FX chain but only runs when the track's
 * `analogue` flag is on (Track.setAnalogue → setEnabled), so the digital path is
 * completely unaffected.
 *
 * Why two delay lines + two LFOs: a real bucket-brigade ensemble chorus widens
 * by modulating two short delays at *unrelated* rates (right channel runs at
 * 1.27 × the left). Matched/locked LFOs sound like a single detune; the
 * deliberate beat between unrelated rates is the Solina/Juno "ensemble" shimmer.
 *
 * Signal chain (internal):
 *   input → dryGain ─────────────────────────────────→ output
 *   input → delayL → merger(L) ┐
 *   input → delayR → merger(R) ┴→ wetGain ───────────→ output
 *   lfoL → depthL → delayL.delayTime   (left  modulation)
 *   lfoR → depthR → delayR.delayTime   (right modulation, rate × 1.27)
 *
 * Parameters:
 *   'chorus.mix'   — 0–1 wet level, default 0
 *   'chorus.rate'  — Hz of the left LFO, default 0.55 (right = rate × 1.27)
 *   'chorus.depth' — 0–1 modulation depth, default 0.5
 *
 * Public (matches DelayFX so FXPanel / LFO / p-lock machinery treat it the same):
 *   .inputNode / .outputNode
 *   connect(dest) / connectInput(src) / disconnect()
 *   setEnabled(on)
 *   setParam(path, value, time) / getParam(path) / getParamList()
 *   resolveAudioParam(path)
 *   toJSON() / fromJSON()
 */

// Base delay times (s) and depth scaling, ported verbatim from Patina so the
// voicing is identical. The DelayNode max is sized to hold base + full swing.
const BASE_L  = 0.013;
const BASE_R  = 0.019;
const DEPTH_S = 0.0035;   // seconds of delay-time swing at depth = 1 (left)

export class ChorusFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'chorus.mix':   0,
      'chorus.rate':  0.55,
      'chorus.depth': 0.5,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;   // silent until enabled with mix > 0

    // Two short delay lines (0.06 s max comfortably holds base + swing).
    this._delayL = context.createDelay(0.06);
    this._delayR = context.createDelay(0.06);
    this._delayL.delayTime.value = BASE_L;
    this._delayR.delayTime.value = BASE_R;

    // Two unrelated LFOs modulating the delay times.
    this._lfoL = context.createOscillator();
    this._lfoR = context.createOscillator();
    this._lfoL.type = 'sine';
    this._lfoR.type = 'sine';
    this._lfoL.frequency.value = this._params['chorus.rate'];
    this._lfoR.frequency.value = this._params['chorus.rate'] * 1.27;

    this._depthL = context.createGain();
    this._depthR = context.createGain();
    const depth = this._params['chorus.depth'] * DEPTH_S;
    this._depthL.gain.value = depth;
    this._depthR.gain.value = depth * 0.9;

    this._lfoL.connect(this._depthL).connect(this._delayL.delayTime);
    this._lfoR.connect(this._depthR).connect(this._delayR.delayTime);
    this._lfoL.start();
    this._lfoR.start();

    // Wet path: stereo merge of the two delay lines.
    this._merger = context.createChannelMerger(2);

    // Dry: input → dryGain → output
    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    // Wet: input → delayL/R → merger → wetGain → output
    this.inputNode.connect(this._delayL).connect(this._merger, 0, 0);
    this.inputNode.connect(this._delayR).connect(this._merger, 0, 1);
    this._merger.connect(this._wetGain).connect(this.outputNode);
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

  /**
   * Enable or bypass the chorus without losing the mix param value. When off,
   * the wet path is muted and dry passes at unity — a clean bypass. The Patina
   * mix law (wet = mix × 0.85, dry = 1 − mix × 0.4) is applied when enabled.
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    const t   = this.context.currentTime;
    const mix = this._params['chorus.mix'];
    this._wetGain.gain.setTargetAtTime(this.enabled ? mix * 0.85 : 0, t, 0.05);
    this._dryGain.gain.setTargetAtTime(this.enabled ? 1 - mix * 0.4 : 1, t, 0.05);
  }

  /** @param {string} path @param {number} value @param {number} [time] */
  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'chorus.mix':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value * 0.85, t, 0.05);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.4, t, 0.05);
        }
        break;
      case 'chorus.rate':
        this._lfoL.frequency.setTargetAtTime(value, t, 0.05);
        this._lfoR.frequency.setTargetAtTime(value * 1.27, t, 0.05);
        break;
      case 'chorus.depth': {
        const depth = value * DEPTH_S;
        this._depthL.gain.setTargetAtTime(depth, t, 0.05);
        this._depthR.gain.setTargetAtTime(depth * 0.9, t, 0.05);
        break;
      }
    }
  }

  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'chorus.mix',   label: 'Mix',   type: 'number', min: 0,    max: 1,  default: 0,    modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'chorus.rate',  label: 'Rate',  type: 'number', min: 0.05, max: 6,  default: 0.55, modulatable: true, lfoMin: 0.05, lfoMax: 6,  plockMode: 'audioParam' },
      { path: 'chorus.depth', label: 'Depth', type: 'number', min: 0,    max: 1,  default: 0.5,  modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
    ];
  }

  /**
   * @param {string} path @returns {AudioParam|null}
   * mix/depth back composite scalings (no single AudioParam), so they are
   * JS-driven via setParam; rate is the left LFO frequency (right tracks it).
   */
  resolveAudioParam(path) {
    switch (path) {
      case 'chorus.rate': return this._lfoL.frequency;
      default: return null;
    }
  }

  toJSON() {
    return { params: { ...this._params }, enabled: this.enabled };
  }

  fromJSON(obj) {
    const params = { ...(obj.params ?? {}) };
    Object.entries(params).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
