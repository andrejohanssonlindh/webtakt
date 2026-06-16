/**
 * WidthFX.js
 * ----------
 * Per-track stereo width via mid/side processing. Decodes L/R into Mid (sum) and
 * Side (difference), scales the Side level, then re-encodes. width = 1 is unity;
 * < 1 narrows toward mono (width 0 = mono); > 1 widens (up to 2×). A `mono` makeup
 * is unnecessary — the M/S matrix here is gain-balanced so width 1 is transparent.
 *
 * M/S matrix (per sample):
 *   M = (L + R) / 2      S = (L − R) / 2
 *   L' = M + S·w         R' = M − S·w        (w = width)
 *
 * Built from native nodes (no worklet): a ChannelSplitter feeds two summing
 * gains forming M and S; S is scaled by `width`; a recombine stage rebuilds L/R.
 *
 * Signal chain (internal):
 *   input → splitter ─┬─→ (M = 0.5L + 0.5R) ─┬─→ Lout (M + S·w)
 *                     └─→ (S = 0.5L − 0.5R)·w ┴─→ Rout (M − S·w)
 *
 * Parameters:
 *   'width.amount' — 0..2, default 1 (0 = mono, 1 = unchanged, 2 = extra wide)
 *
 * Public: the standard FX block interface. Bypass snaps width to 1 (transparent).
 */

export class WidthFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = { 'width.amount': 1 };
    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    const split = context.createChannelSplitter(2);
    const merge = context.createChannelMerger(2);
    this._split = split;
    this._merge = merge;

    // Mid = 0.5L + 0.5R  (a single gain summed from both channels)
    this._midL = context.createGain(); this._midL.gain.value = 0.5;
    this._midR = context.createGain(); this._midR.gain.value = 0.5;
    // Side = 0.5L − 0.5R, then × width
    this._sideL = context.createGain(); this._sideL.gain.value =  0.5;
    this._sideR = context.createGain(); this._sideR.gain.value = -0.5;
    this._sideW = context.createGain(); this._sideW.gain.value = 1;   // width scaler

    // Output encode: L' = M + Sw,  R' = M − Sw.
    this._sideToL = context.createGain(); this._sideToL.gain.value =  1;
    this._sideToR = context.createGain(); this._sideToR.gain.value = -1;

    this.inputNode.connect(split);

    // Build M.
    split.connect(this._midL, 0);
    split.connect(this._midR, 1);
    // Build S (pre-width).
    split.connect(this._sideL, 0);
    split.connect(this._sideR, 1);
    // Scale S by width.
    this._sideL.connect(this._sideW);
    this._sideR.connect(this._sideW);
    // Encode L' = M + Sw.
    this._midL.connect(merge, 0, 0);
    this._midR.connect(merge, 0, 0);
    this._sideW.connect(this._sideToL).connect(merge, 0, 0);
    // Encode R' = M − Sw.
    this._midL.connect(merge, 0, 1);
    this._midR.connect(merge, 0, 1);
    this._sideW.connect(this._sideToR).connect(merge, 0, 1);

    merge.connect(this.outputNode);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    this._sideW.gain.setTargetAtTime(enabled ? this._params['width.amount'] : 1, t, 0.01);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    if (path === 'width.amount' && this.enabled) {
      this._sideW.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'width.amount', label: 'Width', type: 'number', min: 0, max: 2, default: 1, modulatable: true, lfoMin: 0, lfoMax: 2, plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    return path === 'width.amount' ? this._sideW.gain : null;
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
