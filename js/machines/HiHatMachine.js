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
import { makeTrimGain } from './LoudnessTrim.js';
import { scheduleCallback }  from '../util/AudioBuffers.js';

const RATIOS   = [1.0, 1.3420, 1.2312, 1.6420, 1.9689, 2.0782];
const BASE_FREQ = 300;

export class HiHatMachine extends Machine {
  static SPEC = {
    'decay':        { label: 'Decay', type: 'number', min: 0.01, max: 0.25, default: 0.06, group: 'DECAY', plockMode: 'js' },
    'open.decay':   { label: 'Open Decay', type: 'number', min: 0.1, max: 2.0, default: 0.5, group: 'DECAY', plockMode: 'js' },
    'open':         { label: 'Open', type: 'boolean', default: false, group: 'DECAY', plockMode: 'js' },
    'note.track':   { label: 'Note Track', type: 'boolean', default: false, group: 'TONE', plockMode: 'js' },
    'cutoff':       { label: 'Cutoff', type: 'number', min: 500, max: 12000, default: 3000, group: 'TONE',
                      modulatable: true, lfoMin: 500, lfoMax: 12000,
                      target: m => m._hp.frequency, schedule: 'setTarget', tc: 0.01 },
    'tone':         { label: 'Tone', type: 'number', min: 0, max: 8, default: 2.0, group: 'TONE',
                      modulatable: true, lfoMin: 0, lfoMax: 8,
                      target: m => m._hp.Q, schedule: 'setTarget', tc: 0.01 },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.75, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'hihat';
    this.label = 'HiHat';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

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

    // Opt-in note tracking: shift the metallic cluster by the note ratio
    // (C4 = the constructor's BASE_FREQ × ratio). Off → fixed pitch as before.
    if (this._params['note.track']) {
      const r = Machine.noteRatio(midiNote);
      this._oscs.forEach((osc, i) => osc.frequency.setValueAtTime(BASE_FREQ * RATIOS[i] * r, t));
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

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
