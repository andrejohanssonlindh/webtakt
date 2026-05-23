/**
 * KickSilkMachine.js
 * ------------------
 * Clean, round kick drum. Two-layer design:
 *   1. Persistent sine oscillator with frequency sweep per hit (body)
 *   2. Short white-noise burst via per-note BufferSourceNode (punch)
 *
 * No saturation — pure sine body for a clean, musical, low-key kick.
 *
 * Audio graph:
 *   OscillatorNode (persistent) → _bodyGain (per-note) ─┐
 *   NoiseSource (per-note)      → _punchGain (per-note) ─┴→ outputGain → [Filter]
 *
 * Parameters:
 *   'tune'         — base frequency in Hz (20–200)
 *   'decay'        — body decay time in seconds (0.05–2.0)
 *   'sweep'        — pitch sweep multiplier (1–8)
 *   'punch'        — level of noise transient (0–1)
 *   'punch.decay'  — punch noise decay (0.005–0.08)
 *   'output.level' — 0–1
 */

import { Machine }         from './Machine.js';
import { getNoiseBuffer }  from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.25);

export class KickSilkMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'kick.silk';
    this.label = 'Kick Silk';

    this._params = {
      'tune':         60,
      'decay':        0.45,
      'sweep':        4.0,
      'punch':        0.7,
      'punch.decay':  0.025,
      'output.level': 0.9,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Persistent body oscillator — LFO connects to .frequency directly
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.type = 'sine';
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.start();

    // Per-note nodes (recreated each hit)
    this._bodyGain  = null;
    this._noise     = null;
    this._punchGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const tune     = this._params['tune'];
    const decay    = this._params['decay'];
    const sweep    = this._params['sweep'];
    const punch    = this._params['punch'];
    const pd       = this._params['punch.decay'];

    // Disconnect old bodyGain if still connected
    if (this._bodyGain) {
      try { this._bodyGain.disconnect(); } catch (_) {}
      this._bodyGain = null;
    }

    // ── Pitch sweep on the persistent oscillator ──
    const startFreq = Math.max(tune * sweep, 20);
    this._tuneOsc.frequency.setValueAtTime(startFreq, t);
    this._tuneOsc.frequency.exponentialRampToValueAtTime(Math.max(tune, 20), t + decay * 0.25);

    // ── Per-note body gain (amp envelope) ──
    this._bodyGain = this.context.createGain();
    this._bodyGain.gain.setValueAtTime(velScale, t);
    this._bodyGain.gain.exponentialRampToValueAtTime(0.001, t + decay);

    this._tuneOsc.connect(this._bodyGain);
    this._bodyGain.connect(this.outputGain);

    // Schedule disconnect after decay so we don't leave dangling nodes
    const bodyGainRef = this._bodyGain;
    const tuneOscRef  = this._tuneOsc;
    setTimeout(() => {
      try { tuneOscRef.disconnect(bodyGainRef); } catch (_) {}
      try { bodyGainRef.disconnect(); }           catch (_) {}
    }, (decay + 0.1) * 1000 + (t - this.context.currentTime) * 1000);

    // ── Punch noise burst ──
    if (punch > 0.001) {
      if (this._noise) {
        try { this._noise.stop(); }           catch (_) {}
        try { this._punchGain.disconnect(); } catch (_) {}
      }

      this._noise = this.context.createBufferSource();
      this._noise.buffer = _getNoiseBuffer(this.context);
      this._noise.loop = false;

      this._punchGain = this.context.createGain();
      this._punchGain.gain.setValueAtTime(punch * velScale, t);
      this._punchGain.gain.exponentialRampToValueAtTime(0.001, t + pd);

      this._noise.connect(this._punchGain);
      this._punchGain.connect(this.outputGain);
      this._noise.start(t);
      this._noise.stop(t + pd + 0.005);
    }
  }

  noteOff(time) {
    // Self-enveloping — no-op
  }

  connect(destinationNode) {
    this.outputGain.connect(destinationNode);
  }

  disconnect() {
    try { this._tuneOsc.stop(); } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    if (path === 'tune') {
      this._tuneOsc.frequency.setTargetAtTime(value, t, 0.01);
    }
    if (path === 'output.level') {
      this.outputGain.gain.setValueAtTime(value, t);
    }
  }

  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'tune',         label: 'Tune',        type: 'number', min: 20,    max: 200,  default: 60,    modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam' },
      { path: 'decay',        label: 'Decay',        type: 'number', min: 0.05,  max: 2.0,  default: 0.45,                                              plockMode: 'js'        },
      { path: 'sweep',        label: 'Sweep',        type: 'number', min: 1,     max: 8,    default: 4.0,                                               plockMode: 'js'        },
      { path: 'punch',        label: 'Punch',        type: 'number', min: 0,     max: 1,    default: 0.7,                                               plockMode: 'js'        },
      { path: 'punch.decay',  label: 'Punch Decay',  type: 'number', min: 0.005, max: 0.08, default: 0.025,                                             plockMode: 'js'        },
      { path: 'output.level', label: 'Level',        type: 'number', min: 0,     max: 1,    default: 0.9,   modulatable: true, lfoMin: 0,  lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'tune':         return this._tuneOsc.frequency;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON() {
    return { type: this.type, params: { ...this._params } };
  }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }
}
