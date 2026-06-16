/**
 * RingModFX.js
 * ------------
 * Per-track ring modulator: multiplies the signal by a carrier oscillator,
 * producing metallic / clangorous sum-and-difference sidebands. At low carrier
 * frequencies it becomes tremolo; up in the audio range it turns pitched
 * material into bell-like, inharmonic timbres.
 *
 * Multiplication in Web Audio = routing the carrier into a GainNode's `.gain`
 * while the signal passes through that gain. A GainNode's gain rests at 0 and the
 * carrier swings it ±1, so the through-signal is multiplied by the carrier.
 *
 * Signal chain (internal):
 *   input → dryGain ───────────────────────────────→ output
 *   input → ringGain → wetGain ────────────────────→ output
 *   carrier(osc) → ringGain.gain   (the multiply)
 *
 * The carrier frequency is a unified Hz↔BPM sync knob (low counts give tremolo
 * locked to tempo; Hz mode reaches full ring-mod range).
 *
 * Parameters:
 *   'ring.freq'  — carrier Hz (sync='hz'), default 220
 *   'ring.wet'   — 0..1 dry/wet, default 0
 *   'ring.syncMode'   — 'hz' | 'bpm', default 'hz'
 *   'ring.bpmCount32' — 1/32 period count (sync='bpm'), default 8 (= 1/4)
 *
 * Public: the standard FX block interface.
 */

import { count32ToHz, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

export class RingModFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'ring.freq':       220,
      'ring.wet':        0,
      'ring.syncMode':   'hz',
      'ring.bpmCount32': 8,
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

    // The multiply: signal through ringGain whose gain is driven by the carrier.
    this._ringGain = context.createGain();
    this._ringGain.gain.value = 0;   // rests at 0; carrier swings it ±1

    this._carrier = context.createOscillator();
    this._carrier.type = 'sine';
    this._carrier.frequency.value = this._effectiveRateHz();
    this._carrier.connect(this._ringGain.gain);
    this._carrier.start();

    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    this.inputNode.connect(this._ringGain).connect(this._wetGain).connect(this.outputNode);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  _effectiveRateHz() {
    if (this._params['ring.syncMode'] === 'bpm') {
      return count32ToHz(this._params['ring.bpmCount32'], this._bpm);
    }
    return this._params['ring.freq'];
  }

  _applyRate(time) {
    const t = time ?? this.context.currentTime;
    this._carrier.frequency.setTargetAtTime(this._effectiveRateHz(), t, 0.02);
  }

  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['ring.syncMode'] === 'bpm') this._applyRate();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['ring.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(enabled ? 1 - wet * 0.5 : 1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'ring.freq':
      case 'ring.bpmCount32':
      case 'ring.syncMode':
        this._applyRate(t);
        break;
      case 'ring.wet':
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
      // Unified Hz↔BPM carrier knob. Hz mode (ring.freq) reaches full ring-mod
      // range; BPM mode (ring.bpmCount32 → count32ToHz) gives tempo-locked tremolo.
      {
        path: 'ring.sync', label: 'Freq', type: 'sync',
        modePath: 'ring.syncMode',
        msPath:   'ring.freq',
        bpmPath:  'ring.bpmCount32',
        offLabel: 'HZ',
        bpmMin: 0.25, bpmMax: 64, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'ring.syncMode',   label: 'Sync',     type: 'enum',   options: ['hz','bpm'], default: 'hz', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'ring.freq',       label: 'Freq',     type: 'number', min: 0.5, max: 4000, default: 220, modulatable: true, lfoMin: 0.5, lfoMax: 4000, lfoUnit: 'cents', plockMode: 'audioParam', hidden: true },
      { path: 'ring.bpmCount32', label: 'Division', type: 'number', min: 1,   max: 64,   default: 8,   modulatable: true, plockMode: 'js', hidden: true },
      { path: 'ring.wet',        label: 'Wet',      type: 'number', min: 0,   max: 1,    default: 0,   modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'ring.freq': return this._carrier.frequency;
      case 'ring.wet':  return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
