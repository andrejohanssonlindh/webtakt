/**
 * AutoPanFX.js
 * ------------
 * Per-track LFO modulation of stereo position (auto-pan) and/or amplitude
 * (tremolo) — one block covering both, with a `shape` knob blending between them.
 * A single sine LFO drives two destinations:
 *   · a StereoPannerNode .pan   (auto-pan)   weighted by (1 − shape)
 *   · a gain .gain              (tremolo)    weighted by shape
 * shape = 0 → pure auto-pan, shape = 1 → pure tremolo, 0.5 → both.
 *
 * Rate is a unified Hz↔BPM sync knob (like ChorusFX), so the movement locks to
 * tempo when you want it to. In-line (no dry/wet) — it IS the signal path.
 *
 * Signal chain (internal):
 *   input → tremGain → panner → output
 *   lfo → panDepth → panner.pan         (pan swing, weighted 1−shape)
 *   lfo → ampDepth → tremGain.gain      (amplitude swing, weighted shape)
 *
 * The tremGain rests at (1 − ampSwing) so the LFO lifts UP toward unity rather
 * than clipping above it — tremolo ducks rather than boosts.
 *
 * Parameters:
 *   'pan.depth' — 0..1, default 0.7  (overall movement amount)
 *   'pan.shape' — 0..1, default 0    (0 = pan, 1 = tremolo)
 *   'pan.rate'  — Hz (sync='hz'), default 2
 *   'pan.syncMode'    — 'hz' | 'bpm', default 'hz'
 *   'pan.bpmCount32'  — 1/32 period count (sync='bpm'), default 16 (= 1/2)
 *
 * Public: the standard FX block interface.
 */

import { count32ToHz, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

const PAN_SWING = 1.0;    // max ±pan at depth 1, shape 0
const AMP_SWING = 0.9;    // max amplitude dip at depth 1, shape 1

export class AutoPanFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'pan.depth':       0.7,
      'pan.shape':       0,
      'pan.rate':        2,
      'pan.syncMode':    'hz',
      'pan.bpmCount32':  16,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    // Tremolo gain (amplitude) → panner (position).
    this._tremGain = context.createGain();
    this._tremGain.gain.value = 1;

    this._panner = context.createStereoPanner();
    this._panner.pan.value = 0;

    // One LFO, two depth taps.
    this._lfo = context.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = this._effectiveRateHz();

    this._panDepth = context.createGain();   // → panner.pan
    this._ampDepth = context.createGain();   // → tremGain.gain
    this._panDepth.gain.value = 0;
    this._ampDepth.gain.value = 0;

    this._lfo.connect(this._panDepth).connect(this._panner.pan);
    this._lfo.connect(this._ampDepth).connect(this._tremGain.gain);
    this._lfo.start();

    this.inputNode.connect(this._tremGain);
    this._tremGain.connect(this._panner);
    this._panner.connect(this.outputNode);

    this._applyDepth(this.context.currentTime);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  _effectiveRateHz() {
    if (this._params['pan.syncMode'] === 'bpm') {
      return count32ToHz(this._params['pan.bpmCount32'], this._bpm);
    }
    return this._params['pan.rate'];
  }

  _applyRate(time) {
    const t = time ?? this.context.currentTime;
    this._lfo.frequency.setTargetAtTime(this._effectiveRateHz(), t, 0.05);
  }

  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['pan.syncMode'] === 'bpm') this._applyRate();
  }

  /**
   * Recompute both depth taps from depth + shape. When bypassed everything goes
   * to zero (LFO still spins, but writes nothing) and the rest position resets:
   * pan centre, gain unity.
   */
  _applyDepth(t) {
    const on    = this.enabled;
    const depth = this._params['pan.depth'];
    const shape = this._params['pan.shape'];
    const panSwing = on ? PAN_SWING * depth * (1 - shape) : 0;
    const ampSwing = on ? AMP_SWING * depth * shape       : 0;

    this._panDepth.gain.setTargetAtTime(panSwing, t, 0.02);
    // LFO is ±1; amplitude rests at (1 − halfSwing) and the LFO swings ±halfSwing
    // so the peak just reaches unity and the trough dips by ampSwing.
    this._ampDepth.gain.setTargetAtTime(ampSwing / 2, t, 0.02);
    this._tremGain.gain.setTargetAtTime(on ? 1 - ampSwing / 2 : 1, t, 0.02);
    if (!on) this._panner.pan.setTargetAtTime(0, t, 0.02);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this._applyDepth(this.context.currentTime);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'pan.depth':
      case 'pan.shape':
        this._applyDepth(t);
        break;
      case 'pan.rate':
      case 'pan.bpmCount32':
      case 'pan.syncMode':
        this._applyRate(t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'pan.depth', label: 'Depth', type: 'number', min: 0, max: 1, default: 0.7, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
      { path: 'pan.shape', label: 'Pan↔Trem', type: 'number', min: 0, max: 1, default: 0, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
      // Unified Hz↔BPM rate knob (same model as ChorusFX). offLabel:'HZ'.
      {
        path: 'pan.sync', label: 'Rate', type: 'sync',
        modePath: 'pan.syncMode',
        msPath:   'pan.rate',
        bpmPath:  'pan.bpmCount32',
        offLabel: 'HZ',
        bpmMin: 0.25, bpmMax: 64, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'pan.syncMode',   label: 'Sync',     type: 'enum',   options: ['hz','bpm'], default: 'hz', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'pan.rate',       label: 'Rate',     type: 'number', min: 0.05, max: 20, default: 2,  modulatable: true, lfoMin: 0.05, lfoMax: 20, plockMode: 'audioParam', hidden: true },
      { path: 'pan.bpmCount32', label: 'Division', type: 'number', min: 1,    max: 64, default: 16, modulatable: true, plockMode: 'js', hidden: true },
    ];
  }

  /**
   * pan.rate maps to the LFO frequency. depth/shape are composite (they scale two
   * taps + a rest offset) so they stay JS-driven via setParam — no single param.
   */
  resolveAudioParam(path) {
    switch (path) {
      case 'pan.rate': return this._lfo.frequency;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
