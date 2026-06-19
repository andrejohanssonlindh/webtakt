/**
 * LimiterFX.js
 * ------------
 * Per-track brickwall limiter — a fast, high-ratio dynamics stage that catches
 * peaks and sets a ceiling. Distinct from CompressorFX (musical dynamics with a
 * dry/wet blend): a limiter is a safety/loudness tool, always 100% wet, with a
 * fixed-character fast attack and a near-∞ ratio.
 *
 * Built on a DynamicsCompressorNode (ratio 20, ~0 attack, low knee) followed by
 * an output ceiling gain. `threshold` sets where limiting begins; `ceiling` caps
 * the output (in dB ≤ 0); makeup is implicit (drive the threshold down to get
 * louder, the ceiling holds the top).
 *
 * Signal chain (internal):
 *   input → comp → ceilingGain → wetGain ─→ output   (processed)
 *   input → bypassGain ──────────────────→ output   (clean, for OFF state)
 *
 * Parameters:
 *   'lim.threshold' — dB, -40..0, default -6   (limiting onset)
 *   'lim.release'   — s, 0.01..0.5, default 0.1
 *   'lim.ceiling'   — dB, -12..0, default -0.3 (output cap)
 *
 * Public: the standard FX block interface. Bypass must be TRANSPARENT — a
 * DynamicsCompressorNode is NOT unity even at threshold 0 dB (it applies an
 * internal makeup/curve and boosts the level ~+3 dB), so we cannot just
 * neutralise the comp. Instead disabled state routes the dry signal around the
 * comp entirely (bypassGain=1, wetGain=0) and enabled state crossfades to the
 * processed path. See tests/tests/fx_bypass_gain.js for the guarding invariant.
 */

export class LimiterFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'lim.threshold': -6,
      'lim.release':   0.1,
      'lim.ceiling':   -0.3,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._comp = context.createDynamicsCompressor();
    this._comp.ratio.value     = 20;       // brickwall-ish
    this._comp.attack.value    = 0.001;    // fast
    this._comp.release.value   = this._params['lim.release'];
    this._comp.knee.value      = 0;        // hard knee
    this._comp.threshold.value = this._params['lim.threshold'];

    this._ceiling = context.createGain();
    this._ceiling.gain.value = this._dbToGain(this._params['lim.ceiling']);

    // Processed path wet gain (0 when bypassed) and a parallel dry bypass (1 when
    // bypassed). Default = OFF, so wet=0 / bypass=1 → fully transparent.
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;
    this._bypassGain = context.createGain();
    this._bypassGain.gain.value = 1;

    this.inputNode.connect(this._comp);
    this._comp.connect(this._ceiling);
    this._ceiling.connect(this._wetGain).connect(this.outputNode);

    this.inputNode.connect(this._bypassGain).connect(this.outputNode);
  }

  _dbToGain(db) { return Math.pow(10, db / 20); }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    // Crossfade between the clean bypass and the processed path. The comp itself
    // is left at its real params — muting the wet path (not neutralising the comp)
    // is what makes OFF truly transparent.
    this._wetGain.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.01);
    this._bypassGain.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.01);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      // Comp/ceiling run their real params unconditionally; the wet gain mutes
      // the processed path when OFF, so there's no need to neutralise them here.
      case 'lim.threshold': this._comp.threshold.setTargetAtTime(value, t, 0.01);                  break;
      case 'lim.release':   this._comp.release.setTargetAtTime(value, t, 0.01);                    break;
      case 'lim.ceiling':   this._ceiling.gain.setTargetAtTime(this._dbToGain(value), t, 0.01);    break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'lim.threshold', label: 'Thresh',  type: 'number', min: -40,  max: 0,   default: -6,   modulatable: true,  lfoMin: -40, lfoMax: 0, plockMode: 'audioParam' },
      { path: 'lim.release',   label: 'Release', type: 'number', min: 0.01, max: 0.5, default: 0.1,  modulatable: false,                         plockMode: 'audioParam' },
      { path: 'lim.ceiling',   label: 'Ceiling', type: 'number', min: -12,  max: 0,   default: -0.3, modulatable: false,                         plockMode: 'js' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'lim.threshold': return this._comp.threshold;
      case 'lim.release':   return this._comp.release;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
