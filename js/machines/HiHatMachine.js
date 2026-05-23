/**
 * HiHatMachine.js
 * ---------------
 * Synthesis hi-hat. Classic 808-style: six persistent square-wave oscillators
 * at inharmonic ratios, mixed through a persistent HP filter.
 *
 * Persistent nodes allow LFOs to connect permanently:
 *   _hp.frequency   — cutoff
 *   _hp.Q           — tone
 *   outputGain.gain — output.level
 *
 * Per-note: only _ampGain is recreated each hit to shape the decay envelope.
 * The six oscillators and HP filter run continuously; amplitude stays at 0
 * between hits because _ampGain is disconnected after each decay tail.
 *
 * Audio graph:
 *   Osc×6 (persistent) → _mixGain → _hp (persistent) → _ampGain (per-note) → outputGain → [Filter]
 *
 * Parameters:
 *   'decay'        — closed-hat decay (0.01–0.25s)
 *   'open.decay'   — open-hat decay (0.1–2.0s)
 *   'open'         — boolean
 *   'cutoff'       — HP filter cutoff Hz (500–12000)
 *   'tone'         — HP filter Q (0–8)
 *   'output.level' — 0–1
 */

import { Machine }            from './Machine.js';
import { scheduleCallback }  from '../util/AudioBuffers.js';

const RATIOS   = [1.0, 1.3420, 1.2312, 1.6420, 1.9689, 2.0782];
const BASE_FREQ = 300;

export class HiHatMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'hihat';
    this.label = 'HiHat';

    this._params = {
      'decay':        0.06,
      'open.decay':   0.5,
      'open':         false,
      'cutoff':       3000,
      'tone':         2.0,
      'output.level': 0.75,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Persistent mix gain
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1 / RATIOS.length;

    // Persistent oscillators
    this._oscs = RATIOS.map(ratio => {
      const osc = context.createOscillator();
      osc.type = 'square';
      osc.frequency.value = BASE_FREQ * ratio;
      osc.connect(this._mixGain);
      osc.start();
      return osc;
    });

    // Persistent HP filter — LFO connects to frequency and Q
    this._hp = context.createBiquadFilter();
    this._hp.type = 'highpass';
    this._hp.frequency.value = this._params['cutoff'];
    this._hp.Q.value         = this._params['tone'];
    this._mixGain.connect(this._hp);

    // Per-note amp gain (replaced each hit)
    this._ampGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const isOpen   = this._params['open'];
    const decay    = isOpen ? this._params['open.decay'] : this._params['decay'];

    // Disconnect previous amp gain
    if (this._ampGain) {
      try { this._hp.disconnect(this._ampGain); } catch (_) {}
      try { this._ampGain.disconnect();          } catch (_) {}
    }

    // Per-note amp decay
    this._ampGain = this.context.createGain();
    this._ampGain.gain.setValueAtTime(velScale, t);
    this._ampGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._hp.connect(this._ampGain);
    this._ampGain.connect(this.outputGain);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock)
    const ampGain = this._ampGain;
    const hp      = this._hp;
    scheduleCallback(this.context, t + decay + 0.15, () => {
      try { hp.disconnect(ampGain); } catch (_) {}
      try { ampGain.disconnect();   } catch (_) {}
    });
  }

  noteOff(time) {}  // Self-enveloping

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'cutoff':
        this._hp.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'tone':
        this._hp.Q.setTargetAtTime(value, t, 0.01);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'decay',        label: 'Decay',      type: 'number',  min: 0.01, max: 0.25,  default: 0.06,                                               plockMode: 'js'        },
      { path: 'open.decay',   label: 'Open Decay', type: 'number',  min: 0.1,  max: 2.0,   default: 0.5,                                                plockMode: 'js'        },
      { path: 'open',         label: 'Open',       type: 'boolean',                         default: false,                                              plockMode: 'js'        },
      { path: 'cutoff',       label: 'Cutoff',     type: 'number',  min: 500,  max: 12000,  default: 3000, modulatable: true, lfoMin: 500,  lfoMax: 12000, plockMode: 'audioParam' },
      { path: 'tone',         label: 'Tone',       type: 'number',  min: 0,    max: 8,      default: 2.0,  modulatable: true, lfoMin: 0,    lfoMax: 8,     plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',      type: 'number',  min: 0,    max: 1,      default: 0.75, modulatable: true, lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'cutoff':       return this._hp.frequency;
      case 'tone':         return this._hp.Q;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON() { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
