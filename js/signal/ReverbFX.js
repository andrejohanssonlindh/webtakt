/**
 * ReverbFX.js
 * -----------
 * Per-track algorithmic reverb using a ConvolverNode with a synthesized
 * exponential-decay noise impulse response.
 *
 * IR is regenerated whenever decay or pre-delay changes. The wet signal
 * passes through a lowpass damping filter before mixing.
 *
 * Signal chain (internal):
 *   input → dryGain ──────────────────────────────────────→ output
 *   input → convolver → dampFilter → wetGain → output
 *
 * Parameters:
 *   'reverb.decay'       — seconds, 0.1–8.0, default 1.5  (rebuilds IR — track-level only)
 *   'reverb.predelay'    — seconds, 0–0.5,   default 0.02 (rebuilds IR — track-level only)
 *   'reverb.syncMode'    — 'ms' | 'bpm', default 'ms'
 *   'reverb.bpmCount32'  — integer count of 1/32 notes, default 4 (=1/16) (used when syncMode='bpm')
 *   'reverb.damp'        — Hz, 200–20000,    default 8000 (LP on wet signal, LFO/p-lock ok)
 *   'reverb.wet'         — 0–1,              default 0    (LFO/p-lock ok)
 *
 * Public:
 *   .inputNode / .outputNode
 *   connect(dest) / connectInput(src) / disconnect()
 *   setParam(path, value, time)
 *   getParam(path) / getParamList()
 *   resolveAudioParam(path)
 *   setBpm(bpm)          — update BPM for synced pre-delay calculation
 *   toJSON() / fromJSON()
 */

import { count32ToSeconds, divToCount32, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

export class ReverbFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm    = 120;

    this._params = {
      'reverb.decay':      1.5,
      'reverb.predelay':   0.02,
      'reverb.syncMode':   'ms',
      'reverb.bpmCount32': 4,        // 4 × 1/32 = 1/16
      'reverb.damp':       8000,
      'reverb.wet':        0,
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

    this._convolver = context.createConvolver();
    this._convolver.normalize = true;

    this._dampFilter = context.createBiquadFilter();
    this._dampFilter.type = 'lowpass';
    this._dampFilter.frequency.value = this._params['reverb.damp'];
    this._dampFilter.Q.value = 0.5;

    // Wiring
    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._convolver);
    this._convolver.connect(this._dampFilter);
    this._dampFilter.connect(this._wetGain);
    this._dryGain.connect(this.outputNode);
    this._wetGain.connect(this.outputNode);

    this._buildIR();
  }

  /** Build a stereo exponential-decay noise IR. */
  _buildIR() {
    const ctx      = this.context;
    const sr       = ctx.sampleRate;
    const decay    = this._params['reverb.decay'];
    const predelay = this._params['reverb.predelay'];

    const length    = Math.ceil((predelay + decay * 3) * sr);  // 3τ tail
    const preSamp   = Math.ceil(predelay * sr);
    const ir        = ctx.createBuffer(2, length, sr);

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        if (i < preSamp) {
          data[i] = 0;
        } else {
          const t = (i - preSamp) / sr;
          data[i] = (Math.random() * 2 - 1) * Math.exp(-t / decay);
        }
      }
    }
    this._convolver.buffer = ir;
  }

  connect(destinationNode) {
    this.outputNode.connect(destinationNode);
  }

  connectInput(sourceNode) {
    sourceNode.connect(this.inputNode);
  }

  disconnect() {
    this.outputNode.disconnect();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['reverb.wet'] : 0;
    const dry = enabled ? 1 - this._params['reverb.wet'] * 0.5 : 1;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(dry, t, 0.005);
  }

  /** Update BPM and recalculate pre-delay when in BPM sync mode. */
  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['reverb.syncMode'] === 'bpm') {
      this._applyBpmPredelay();
    }
  }

  _applyBpmPredelay() {
    const secs = count32ToSeconds(this._params['reverb.bpmCount32'], this._bpm);
    this._params['reverb.predelay'] = Math.min(secs, 0.5);
    this._buildIR();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'reverb.decay':
        this._buildIR();
        break;
      case 'reverb.predelay':
        if (this._params['reverb.syncMode'] === 'ms') {
          this._buildIR();
        }
        break;
      case 'reverb.syncMode':
        if (value === 'bpm') {
          this._applyBpmPredelay();
        } else {
          this._buildIR();
        }
        break;
      case 'reverb.bpmCount32':
        if (this._params['reverb.syncMode'] === 'bpm') {
          this._applyBpmPredelay();
        }
        break;
      case 'reverb.damp':
        this._dampFilter.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'reverb.wet':
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
      { path: 'reverb.decay',    label: 'Decay',    type: 'number', min: 0.1,  max: 8.0,   default: 1.5,  modulatable: false,                           plockMode: 'js'         },
      // Unified MS/BPM sync knob for pre-delay. Both underlying params rebuild
      // the IR, so neither is modulatable — the knob is track-level in both
      // modes (no p-lock). Underlying params stay listed (hidden) for setParam
      // dispatch / serialisation. See design/sync-knob-rollout.md.
      {
        path: 'reverb.sync', label: 'Pre-dly', type: 'sync',
        modePath: 'reverb.syncMode',
        msPath:   'reverb.predelay',
        bpmPath:  'reverb.bpmCount32',
        bpmMin: 0.25, bpmMax: 32, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'reverb.syncMode',   label: 'Sync',     type: 'enum',   options: ['ms','bpm'], default: 'ms',  modulatable: false, plockMode: 'js', hidden: true },
      { path: 'reverb.predelay',   label: 'Pre-dly',  type: 'number', min: 0,    max: 0.5,   default: 0.02, modulatable: false, plockMode: 'js', hidden: true },
      { path: 'reverb.bpmCount32', label: 'Pre-div',  type: 'number', min: 1,    max: 32,    default: 4,    modulatable: false, plockMode: 'js', hidden: true },
      { path: 'reverb.damp',     label: 'Damp',     type: 'number', min: 200,  max: 20000, default: 8000, modulatable: true, lfoMin: 200, lfoMax: 20000, plockMode: 'audioParam'  },
      { path: 'reverb.wet',      label: 'Wet',      type: 'number', min: 0,    max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'audioParam'  },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'reverb.damp': return this._dampFilter.frequency;
      case 'reverb.wet':  return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() {
    return { params: { ...this._params }, enabled: this.enabled };
  }

  fromJSON(obj) {
    const params = { ...(obj.params ?? {}) };
    // Back-compat: legacy projects stored a 'reverb.bpmDiv' division string.
    if (params['reverb.bpmDiv'] !== undefined && params['reverb.bpmCount32'] === undefined) {
      params['reverb.bpmCount32'] = divToCount32(params['reverb.bpmDiv']);
    }
    delete params['reverb.bpmDiv'];
    Object.entries(params).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
