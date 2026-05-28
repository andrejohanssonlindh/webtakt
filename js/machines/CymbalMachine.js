/**
 * CymbalMachine.js
 * ----------------
 * Cymbal / crash / ride synthesizer. Inspired by the 808 cymbal topology:
 * 6 square-wave oscillators at inharmonic frequency ratios, mixed and fed
 * through a dual-band shaping stage (HPF + resonant bandpass), then an
 * exponential decay envelope.
 *
 * More complex than HiHat: additional bandpass tonal control and separate
 * close/mid/open decay tiers. Persistent oscillator architecture — all
 * nodes run continuously, amplitude gated by per-note _ampGain.
 *
 * Audio graph:
 *   Osc×6 (square, persistent) → _mixGain
 *     → _hpf (HP, shapes brightness)
 *     → _bp  (resonant BP, adds metallic body)
 *     → _ampGain (per-note, exponential decay)
 *       → outputGain → [Filter]
 *
 * Parameters:
 *   'tune'         — base oscillator frequency Hz (100–800) — shifts the whole cluster
 *   'tone'         — HP filter cutoff Hz (500–16000), controls brightness
 *   'body'         — BP filter center Hz (200–4000), metallic body peak
 *   'resonance'    — BP filter Q (0.5–12), sharpness of body peak
 *   'decay'        — closed-cymbal decay (0.05–0.5s)
 *   'mid.decay'    — mid-open decay (0.1–2.0s)
 *   'open.decay'   — fully open decay (0.5–8.0s)
 *   'mode'         — 'closed' | 'mid' | 'open'
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';

const RATIOS   = [1.0, 1.4142, 1.5399, 1.7320, 2.0000, 2.3784];
const BASE_FREQ = 200;

export class CymbalMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'cymbal';
    this.label = 'Cymbal';

    this._params = {
      'tune':         300,
      'tone':         1500,
      'body':         3500,
      'resonance':    3.0,
      'decay':        0.15,
      'mid.decay':    0.6,
      'open.decay':   2.5,
      'mode':         'closed',
      'output.level': 0.5,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Mix gain — normalise by voice count, then boost to compensate for
    // filter attenuation (HPF + BP strip most energy from the square waves).
    this._mixGain = context.createGain();
    this._mixGain.gain.value = (1 / RATIOS.length) * 4;

    // Six inharmonic square oscillators
    this._oscs = RATIOS.map(ratio => {
      const osc = context.createOscillator();
      osc.type            = 'square';
      osc.frequency.value = this._params['tune'] * ratio;
      osc.connect(this._mixGain);
      osc.start();
      return osc;
    });

    // Persistent HP filter — cuts low rumble below the oscillator cluster
    this._hpf = context.createBiquadFilter();
    this._hpf.type            = 'highpass';
    this._hpf.frequency.value = this._params['tone'];
    this._hpf.Q.value         = 0.7071;
    this._mixGain.connect(this._hpf);

    // Persistent bandpass — metallic body resonance, centred above HPF cutoff
    this._bp = context.createBiquadFilter();
    this._bp.type            = 'bandpass';
    this._bp.frequency.value = this._params['body'];
    this._bp.Q.value         = this._params['resonance'];
    this._hpf.connect(this._bp);

    // Per-note amp gain
    this._ampGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const mode     = this._params['mode'];
    const decay    = mode === 'open' ? this._params['open.decay']
                   : mode === 'mid'  ? this._params['mid.decay']
                   : this._params['decay'];

    // Disconnect previous per-note amp
    if (this._ampGain) {
      try { this._bp.disconnect(this._ampGain); } catch (_) {}
      try { this._ampGain.disconnect();          } catch (_) {}
    }

    this._ampGain = this.context.createGain();
    this._ampGain.gain.setValueAtTime(velScale, t);
    this._ampGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._bp.connect(this._ampGain);
    this._ampGain.connect(this.outputGain);

    const ampGain = this._ampGain;
    const bp      = this._bp;
    const cleanupMs = (decay + 0.15) * 1000 + Math.max(t - this.context.currentTime, 0) * 1000;
    setTimeout(() => {
      try { bp.disconnect(ampGain);  } catch (_) {}
      try { ampGain.disconnect();    } catch (_) {}
    }, cleanupMs);
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'tune':
        this._oscs.forEach((osc, i) => {
          osc.frequency.setTargetAtTime(value * RATIOS[i], t, 0.005);
        });
        break;
      case 'tone':
        this._hpf.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'body':
        this._bp.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'resonance':
        this._bp.Q.setTargetAtTime(value, t, 0.01);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
      // 'decay', 'mid.decay', 'open.decay', 'mode' — JS-only, read in noteOn
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'tune',         label: 'Tune',        type: 'number', min: 100,  max: 800,   default: 300,  modulatable: true,  lfoMin: 100,  lfoMax: 800,   plockMode: 'audioParam' },
      { path: 'tone',         label: 'Tone',         type: 'number', min: 200,  max: 8000,  default: 1500, modulatable: true,  lfoMin: 200,  lfoMax: 8000,  plockMode: 'audioParam' },
      { path: 'body',         label: 'Body',         type: 'number', min: 500,  max: 16000, default: 3500, modulatable: true,  lfoMin: 500,  lfoMax: 16000, plockMode: 'audioParam' },
      { path: 'resonance',    label: 'Resonance',    type: 'number', min: 0.5,  max: 12,    default: 3.0,  modulatable: true,  lfoMin: 0.5,  lfoMax: 12,    plockMode: 'audioParam' },
      { path: 'decay',        label: 'Decay',        type: 'number', min: 0.05, max: 0.5,   default: 0.15,                                                  plockMode: 'js'        },
      { path: 'mid.decay',    label: 'Mid Decay',    type: 'number', min: 0.1,  max: 2.0,   default: 0.6,                                                   plockMode: 'js'        },
      { path: 'open.decay',   label: 'Open Decay',   type: 'number', min: 0.5,  max: 8.0,   default: 2.5,                                                   plockMode: 'js'        },
      { path: 'mode',         label: 'Mode',         type: 'enum',   options: ['closed','mid','open'],                                                       plockMode: 'js'        },
      { path: 'output.level', label: 'Level',        type: 'number', min: 0,    max: 1,     default: 0.5,  modulatable: true,  lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'tone':         return this._hpf.frequency;
      case 'body':         return this._bp.frequency;
      case 'resonance':    return this._bp.Q;
      case 'output.level': return this.outputGain.gain;
      // 'tune' — controls multiple oscs; use first for LFO (close enough for modulation use)
      case 'tune':         return this._oscs[0].frequency;
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
