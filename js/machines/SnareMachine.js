/**
 * SnareMachine.js
 * ---------------
 * Synthesis snare drum. Two-layer design:
 *   1. Persistent tuned oscillator (body / tone)
 *   2. Persistent noise source through persistent HP filter (snap / rattle)
 *
 * Persistent nodes allow LFOs to connect permanently:
 *   _tuneOsc.frequency  — tune
 *   _toneGain.gain      — tone level
 *   _snapGain.gain      — snap level
 *   _noiseHP.frequency  — noise.cutoff
 *   outputGain.gain     — output.level
 *
 * Per-note: only the amp decay GainNodes (_bodyAmp, _noiseAmp) are created
 * each hit to shape the decay envelope.
 *
 * Audio graph:
 *   _tuneOsc → _toneGain → _bodyAmp (per-note) ─┐
 *   _noiseSrc → _noiseHP → _snapGain             │
 *                        → _noiseAmp (per-note) ─┴→ outputGain → [Filter]
 *
 * Parameters:
 *   'tune'         — body oscillator Hz (100–400)
 *   'decay'        — overall decay in seconds (0.05–1.0)
 *   'tone'         — body level (0–1)
 *   'snap'         — noise level (0–1)
 *   'noise.cutoff' — HP filter cutoff Hz (200–8000)
 *   'output.level' — 0–1
 */

import { Machine }                        from './Machine.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class SnareMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'snare';
    this.label = 'Snare';

    this._params = {
      'tune':         200,
      'decay':        0.18,
      'snap':         0.8,
      'tone':         0.4,
      'noise.cutoff': 2000,
      'output.level': 0.85,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // ── Persistent body oscillator ──
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.type = 'triangle';
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.start();

    // Persistent tone level — LFO connects here
    this._toneGain = context.createGain();
    this._toneGain.gain.value = this._params['tone'];
    this._tuneOsc.connect(this._toneGain);

    // ── Persistent noise source (looping) ──
    this._noiseSrc = context.createBufferSource();
    this._noiseSrc.buffer = _getNoiseBuffer(context);
    this._noiseSrc.loop = true;
    this._noiseSrc.start();

    // Persistent HP filter — LFO connects to frequency
    this._noiseHP = context.createBiquadFilter();
    this._noiseHP.type = 'highpass';
    this._noiseHP.frequency.value = this._params['noise.cutoff'];
    this._noiseHP.Q.value = 0.5;
    this._noiseSrc.connect(this._noiseHP);

    // Persistent snap level — LFO connects here
    this._snapGain = context.createGain();
    this._snapGain.gain.value = this._params['snap'];
    this._noiseHP.connect(this._snapGain);

    // Per-note amp nodes (replaced each hit)
    this._bodyAmp = null;
    this._noiseAmp = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const decay    = this._params['decay'];
    const tune     = this._params['tune'];

    // Disconnect old per-note amps
    if (this._bodyAmp)  { try { this._bodyAmp.disconnect();  } catch (_) {} }
    if (this._noiseAmp) { try { this._noiseAmp.disconnect(); } catch (_) {} }

    // Pitch drop on persistent osc
    this._tuneOsc.frequency.setValueAtTime(tune, t);
    this._tuneOsc.frequency.exponentialRampToValueAtTime(
      Math.max(tune * 0.5, 40), t + decay * 0.3
    );

    // Per-note body amp
    this._bodyAmp = this.context.createGain();
    this._bodyAmp.gain.setValueAtTime(velScale, t);
    this._bodyAmp.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._toneGain.connect(this._bodyAmp);
    this._bodyAmp.connect(this.outputGain);

    // Per-note noise amp
    this._noiseAmp = this.context.createGain();
    this._noiseAmp.gain.setValueAtTime(velScale, t);
    this._noiseAmp.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._snapGain.connect(this._noiseAmp);
    this._noiseAmp.connect(this.outputGain);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock)
    const bodyAmp  = this._bodyAmp;
    const noiseAmp = this._noiseAmp;
    const toneGain = this._toneGain;
    const snapGain = this._snapGain;
    scheduleCallback(this.context, t + decay + 0.15, () => {
      try { toneGain.disconnect(bodyAmp);  } catch (_) {}
      try { snapGain.disconnect(noiseAmp); } catch (_) {}
      try { bodyAmp.disconnect();          } catch (_) {}
      try { noiseAmp.disconnect();         } catch (_) {}
    });
  }

  noteOff(time) {}  // Self-enveloping

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    try { this._tuneOsc.stop();   } catch (_) {}
    try { this._noiseSrc.stop();  } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'tune':
        this._tuneOsc.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'tone':
        this._toneGain.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'snap':
        this._snapGain.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'noise.cutoff':
        this._noiseHP.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'tune',         label: 'Tune',      type: 'number', min: 100,  max: 400,  default: 200,  modulatable: true, lfoMin: 100,  lfoMax: 400,  plockMode: 'audioParam' },
      { path: 'decay',        label: 'Decay',     type: 'number', min: 0.05, max: 1.0,  default: 0.18,                                                plockMode: 'js'        },
      { path: 'tone',         label: 'Tone',      type: 'number', min: 0,    max: 1,    default: 0.4,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
      { path: 'snap',         label: 'Snap',      type: 'number', min: 0,    max: 1,    default: 0.8,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
      { path: 'noise.cutoff', label: 'Noise Cut', type: 'number', min: 200,  max: 8000, default: 2000, modulatable: true, lfoMin: 200,  lfoMax: 8000, plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',     type: 'number', min: 0,    max: 1,    default: 0.85, modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'tune':         return this._tuneOsc.frequency;
      case 'tone':         return this._toneGain.gain;
      case 'snap':         return this._snapGain.gain;
      case 'noise.cutoff': return this._noiseHP.frequency;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON() { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
