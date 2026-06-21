/**
 * AnalogueCymbalMachine.js
 * ------------------------
 * Analogue-modelled cymbal — the analogue counterpart to CymbalMachine, built on
 * the shared PATINA building blocks in AnalogueParts.js.
 *
 * Same six-oscillator topology as Cymbal (6 inharmonic squares → HPF → resonant
 * bandpass → per-note decay, with closed/mid/open tiers), but with analogue
 * character on the metal:
 *   1. Each oscillator uses an imperfect-square `PeriodicWave` (makeImperfectWave).
 *   2. Per-instance RATIO tolerance: each oscillator's inharmonic ratio is nudged
 *      a fraction at construction (±0.5%), so the metallic cluster differs subtly
 *      per instance.
 *   3. A DriftClock wanders all six oscillator detunes ~12×/s (scaled by `drift`).
 *
 * Persistent oscillators + filters (LFOs bind permanently); only the per-note amp
 * is recreated each hit. Mirrors CymbalMachine. Note: `tune` (manualTarget) writes
 * each osc's .frequency by its ratio; drift writes .detune — the two coexist.
 *
 * Audio graph:
 *   Osc×6 (imperfect square, +ratio-tol, +drift) → _mixGain → _hpf → _bp → _ampGain (per-note) → outputGain → [Filter]
 *
 * Parameters (mirror Cymbal, plus 'drift'):
 *   'tune'         — base oscillator frequency Hz (100–800) — shifts the cluster
 *   'tone'         — HP filter cutoff Hz (200–8000)
 *   'body'         — BP filter center Hz (500–16000)
 *   'resonance'    — BP filter Q (0.5–12)
 *   'decay'        — closed-cymbal decay (0.05–0.5s)
 *   'mid.decay'    — mid-open decay (0.1–2.0s)
 *   'open.decay'   — fully open decay (0.5–8.0s)
 *   'mode'         — 'closed' | 'mid' | 'open'
 *   'drift'        — thermal pitch-wander amount (0–1)
 *   'output.level' — 0–1
 */

import { Machine }            from './Machine.js';
import { makeTrimGain }       from './LoudnessTrim.js';
import { scheduleCallback }   from '../util/AudioBuffers.js';
import { makeImperfectWave, DriftClock, rand } from './AnalogueParts.js';

const RATIOS   = [1.0, 1.4142, 1.5399, 1.7320, 2.0000, 2.3784];
const BASE_FREQ = 200;

export class AnalogueCymbalMachine extends Machine {
  // 'tune' = manualTarget: resolves to _oscs[0].frequency for LFO, but setParam
  // shifts all 6 oscs (each by its tolerance-skewed inharmonic RATIO) via apply.
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 100, max: 800, default: 300, group: 'TONE',
                      modulatable: true, lfoMin: 100, lfoMax: 800, plockMode: 'audioParam',
                      target: m => m._oscs[0].frequency, manualTarget: true,
                      apply: (v, t, m) => m._oscs.forEach((osc, i) => osc.frequency.setTargetAtTime(v * RATIOS[i] * m._tolRatio[i], t, 0.005)) },
    'tone':         { label: 'Tone', type: 'number', min: 200, max: 8000, default: 1500, group: 'TONE',
                      modulatable: true, lfoMin: 200, lfoMax: 8000,
                      target: m => m._hpf.frequency, schedule: 'setTarget', tc: 0.01 },
    'body':         { label: 'Body', type: 'number', min: 500, max: 16000, default: 3500, group: 'TONE',
                      modulatable: true, lfoMin: 500, lfoMax: 16000,
                      target: m => m._bp.frequency, schedule: 'setTarget', tc: 0.01 },
    'resonance':    { label: 'Resonance', type: 'number', min: 0.5, max: 12, default: 3.0, group: 'TONE',
                      modulatable: true, lfoMin: 0.5, lfoMax: 12,
                      target: m => m._bp.Q, schedule: 'setTarget', tc: 0.01 },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 0.5, default: 0.15, group: 'DECAY', plockMode: 'js' },
    'mid.decay':    { label: 'Mid Decay', type: 'number', min: 0.1, max: 2.0, default: 0.6, group: 'DECAY', plockMode: 'js' },
    'open.decay':   { label: 'Open Decay', type: 'number', min: 0.5, max: 8.0, default: 2.5, group: 'DECAY', plockMode: 'js' },
    'mode':         { label: 'Mode', type: 'enum', options: ['closed','mid','open'], default: 'closed', group: 'DECAY', plockMode: 'js' },
    'drift':        { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'DECAY', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.5, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'cymbal.analogue';
    this.label = 'Cymbal Analogue';

    this._initSpec();

    // Per-instance ratio tolerance (one fixed nudge per oscillator, ±0.5%) and a
    // per-instance detune tolerance the drift wanders on.
    this._tolRatio = RATIOS.map(() => 1 + rand() * 0.005);
    this._tolTune  = rand() * 6; // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix gain — normalise by voice count, then boost to compensate for filter
    // attenuation (HPF + BP strip most energy from the square waves).
    this._mixGain = context.createGain();
    this._mixGain.gain.value = (1 / RATIOS.length) * 4;

    // Six inharmonic imperfect-square oscillators at tolerance-skewed ratios.
    this._oscs = RATIOS.map((ratio, i) => {
      const osc = context.createOscillator();
      osc.setPeriodicWave(makeImperfectWave(context, 'square', { tolerance: 0.04 }));
      osc.frequency.value = this._params['tune'] * ratio * this._tolRatio[i];
      osc.detune.value    = this._tolTune;
      osc.connect(this._mixGain);
      osc.start();
      return osc;
    });

    // Persistent HP filter — cuts low rumble below the oscillator cluster.
    this._hpf = context.createBiquadFilter();
    this._hpf.type            = 'highpass';
    this._hpf.frequency.value = this._params['tone'];
    this._hpf.Q.value         = 0.7071;
    this._mixGain.connect(this._hpf);

    // Persistent bandpass — metallic body resonance, centred above HPF cutoff.
    this._bp = context.createBiquadFilter();
    this._bp.type            = 'bandpass';
    this._bp.frequency.value = this._params['body'];
    this._bp.Q.value         = this._params['resonance'];
    this._hpf.connect(this._bp);

    // Thermal drift on all six oscillator detunes (wander on top of tolerance).
    this._drift = new DriftClock(
      context,
      this._oscs.map(o => o.detune),
      { baseFor: () => this._tolTune, amountFor: () => this._params['drift'] * 4.0 },
    );

    // Per-note amp gain.
    this._ampGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const mode     = this._params['mode'];
    const decay    = mode === 'open' ? this._params['open.decay']
                   : mode === 'mid'  ? this._params['mid.decay']
                   : this._params['decay'];

    // Disconnect previous per-note amp.
    if (this._ampGain) {
      try { this._bp.disconnect(this._ampGain); } catch (_) {}
      try { this._ampGain.disconnect();          } catch (_) {}
    }

    // Note-track the inharmonic cluster: shift all 6 oscs by the note ratio
    // (C4 = the resting `tune`). Mirrors `tune.apply` (RATIO × per-osc tolerance);
    // writes .frequency, so the .detune drift wander coexists. Holds until the
    // next note or a `tune`/LFO write.
    const ratio = Machine.noteRatio(midiNote);
    if (ratio !== 1) {
      const tune = this._params['tune'];
      this._oscs.forEach((osc, i) => {
        osc.frequency.cancelScheduledValues(t);   // kill syncParamsAt's setTarget tail
        osc.frequency.setValueAtTime(tune * RATIOS[i] * this._tolRatio[i] * ratio, t);
      });
    }

    this._ampGain = this.context.createGain();
    this._ampGain.gain.setValueAtTime(velScale, t);
    this._ampGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._bp.connect(this._ampGain);
    this._ampGain.connect(this.outputGain);

    const ampGain = this._ampGain;
    const bp      = this._bp;
    // Cleanup on the audio thread at note end (avoids wall-clock setTimeout drift).
    scheduleCallback(this.context, t + decay + 0.15, () => {
      try { bp.disconnect(ampGain);  } catch (_) {}
      try { ampGain.disconnect();    } catch (_) {}
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._drift.stop();
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
