/**
 * AnalogueHiHatMachine.js
 * -----------------------
 * Analogue-modelled hi-hat — the analogue counterpart to HiHatMachine, built on
 * the shared PATINA building blocks in AnalogueParts.js.
 *
 * Same six-oscillator 808-style structure as HiHat (six inharmonic squares mixed
 * through a persistent HP filter, gated by a per-note amp), but with analogue
 * character on the metal:
 *   1. Each oscillator uses an imperfect-square `PeriodicWave` (makeImperfectWave)
 *      — even-harmonic leakage + amplitude tolerance per osc, so the cluster isn't
 *      sterile.
 *   2. Per-instance RATIO tolerance: each oscillator's inharmonic ratio is nudged
 *      a fraction at construction, so the metallic cluster differs subtly per
 *      instance (like one hat of a vintage machine).
 *   3. A DriftClock wanders all six oscillator detunes ~12×/s (scaled by `drift`),
 *      the slow shimmer of a warm circuit.
 *
 * Persistent oscillators + HP filter (LFOs bind permanently); only the per-note
 * amp gain is recreated each hit. Mirrors HiHatMachine.
 *
 * Audio graph:
 *   Osc×6 (imperfect square, +tol/drift) → _mixGain → _hp → _ampGain (per-note) → outputGain → [Filter]
 *
 * Parameters (mirror HiHat, plus 'drift'):
 *   'decay'        — closed-hat decay (0.01–0.25s)
 *   'open.decay'   — open-hat decay (0.1–2.0s)
 *   'open'         — boolean
 *   'cutoff'       — HP filter cutoff Hz (500–12000)
 *   'tone'         — HP filter Q (0–8)
 *   'drift'        — thermal pitch-wander amount (0–1)
 *   'output.level' — 0–1
 */

import { Machine }            from './Machine.js';
import { makeTrimGain }       from './LoudnessTrim.js';
import { scheduleCallback }   from '../util/AudioBuffers.js';
import { makeImperfectWave, DriftClock, rand } from './AnalogueParts.js';

const RATIOS    = [1.0, 1.3420, 1.2312, 1.6420, 1.9689, 2.0782];
const BASE_FREQ = 300;

export class AnalogueHiHatMachine extends Machine {
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
    'drift':        { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'TONE', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.75, group: 'OUTPUT', ampMaster: true,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'hihat.analogue';
    this.label = 'HiHat Analogue';

    this._initSpec();

    // Per-instance ratio tolerance — one fixed nudge per oscillator (±0.6%),
    // and a per-instance detune tolerance the drift wanders on.
    this._tolRatio = RATIOS.map(() => 1 + rand() * 0.006);
    this._tolTune  = rand() * 6; // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent mix gain
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1 / RATIOS.length;

    // Persistent oscillators — imperfect squares at tolerance-skewed ratios
    this._oscs = RATIOS.map((ratio, i) => {
      const osc = context.createOscillator();
      osc.setPeriodicWave(makeImperfectWave(context, 'square', { tolerance: 0.04 }));
      osc.frequency.value = BASE_FREQ * ratio * this._tolRatio[i];
      osc.detune.value    = this._tolTune;
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

    // Thermal drift on all six oscillator detunes (wander on top of tolerance).
    this._drift = new DriftClock(
      context,
      this._oscs.map(o => o.detune),
      { baseFor: () => this._tolTune, amountFor: () => this._params['drift'] * 4.0 },
    );

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
    // (C4 = the resting BASE_FREQ × ratio × tolerance). Writes .frequency, so the
    // .detune drift wander coexists. Off → fixed pitch as before.
    if (this._params['note.track']) {
      const r = Machine.noteRatio(midiNote);
      this._oscs.forEach((osc, i) =>
        osc.frequency.setValueAtTime(BASE_FREQ * RATIOS[i] * this._tolRatio[i] * r, t));
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
    this._drift.stop();
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
