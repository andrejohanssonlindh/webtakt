/**
 * FoldMachine.js
 * --------------
 * West-coast / Buchla-flavoured analogue voice — the most distinct of the family.
 * Where Moogish/Juno/Oberish are subtractive (rich oscillators tamed by the
 * ladder), this one is ADDITIVE-by-folding: a clean sine/triangle core whose
 * harmonics are *generated* by a wavefolder rather than filtered down. The timbre
 * is bright and alive, blooming new partials as the fold deepens — no filtering
 * needed for its character (though the ladder is still there as an analogue tone
 * shaper, since it's analogue-family).
 *
 * Built on the Phase-1 Moogish wavefolder primitive, deepened with a `symmetry`
 * control (DC-offsetting the fold so even harmonics come in) and a `timbre` FM
 * path: a modulator oscillator at `ratio` brightens the core before folding (the
 * West-coast "timbre" gesture — a single knob that adds harmonic motion). Drift +
 * per-instance tolerance keep it analogue.
 *
 * Persistent-oscillator architecture: nodes run continuously, amplitude gated by
 * the track Envelope. noteOn retunes; noteOff is a no-op. LFOs bind permanently.
 *
 * Audio graph:
 *   modOsc → _fmGain (timbre) → carrier.frequency
 *   carrier (sine/tri) → _preGain → (+_symmetryDC) → _foldShaper → _foldOut → outputGain → _trimGain → [Filter]
 *
 * Parameters:
 *   'wave'         — core waveform: sine | triangle
 *   'octave'       — core octave offset (−2..+2)
 *   'detune'       — fine detune cents (±50)
 *   'fold'         — wavefolder amount (0–1) — the harmonic bloom
 *   'symmetry'     — fold DC offset (−1..+1) — asymmetric folding adds even harmonics
 *   'timbre'       — FM brightening from the modulator (0–1)
 *   'ratio'        — modulator : carrier frequency ratio (0.5–8)
 *   'drift'        — thermal pitch wander (0–1)
 *   'osc.detune'   — hidden trig-tab master detune (−100..+100)
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { makeImperfectWave, DriftClock, rand } from './AnalogueParts.js';

const CORE_WAVES = ['sine', 'triangle'];

export class FoldMachine extends Machine {
  static SPEC = {
    'wave':          { label: 'Wave', type: 'enum', options: CORE_WAVES, default: 'sine',
                       group: 'OSC', plockMode: 'js', apply: (v, t, m) => m._setWave(v) },
    'octave':        { label: 'Octave', type: 'number', min: -2, max: 2, default: 0, group: 'OSC',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'detune':        { label: 'Detune', type: 'number', min: -50, max: 50, default: 0, group: 'OSC',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._carOsc.detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'fold':          { label: 'Fold', type: 'number', min: 0, max: 1, default: 0.3, group: 'FOLD',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applyFold(t) },
    'symmetry':      { label: 'Sym', type: 'number', min: -1, max: 1, default: 0, group: 'FOLD',
                       modulatable: true, lfoMin: -1, lfoMax: 1,
                       target: m => m._symDC.offset, schedule: 'setTarget', tc: 0.01 },

    'timbre':        { label: 'Timbre', type: 'number', min: 0, max: 1, default: 0.0, group: 'FM',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applyTimbre(t) },
    'ratio':         { label: 'Ratio', type: 'number', min: 0.5, max: 8, default: 1.0, group: 'FM',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },

    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'TEXTURE',
                       plockMode: 'js' },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._carOsc.detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'fold';
    this.label = 'Fold';

    this._initSpec();
    this._rootMidi = 60;
    this._tolTune  = rand() * 4;   // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // ── Carrier (the core) ───────────────────────────────────────────────────
    this._carWave = this._params['wave'];
    this._carOsc  = context.createOscillator();
    this._carOsc.setPeriodicWave(makeImperfectWave(context, this._carWave, { tolerance: 0.02 }));
    this._carOsc.frequency.value = 261.63;
    this._carOsc.detune.value    = this._tolTune;
    this._carOsc.start();

    // ── Timbre FM: a modulator at `ratio` brightening the carrier pre-fold ────
    this._modOsc = context.createOscillator();
    this._modOsc.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.02 }));
    this._modOsc.frequency.value = 261.63;
    this._fmGain = context.createGain();
    this._fmGain.gain.value = 0;                 // peak Hz deviation, driven by _applyTimbre
    this._modOsc.connect(this._fmGain);
    this._fmGain.connect(this._carOsc.frequency);
    this._modOsc.start();

    // ── Wavefolder chain: carrier → preGain → (+symDC) → shaper → foldOut ─────
    // preGain pushes the signal harder into the fold; symDC offsets it so the
    // fold is asymmetric (adds even harmonics). foldOut compensates level.
    this._preGain = context.createGain();
    this._preGain.gain.value = 1;
    this._symDC = context.createConstantSource();
    this._symDC.offset.value = this._params['symmetry'];
    this._foldShaper = context.createWaveShaper();
    this._foldShaper.oversample = '4x';
    this._foldOut = context.createGain();
    this._foldOut.gain.value = 1;

    this._carOsc.connect(this._preGain);
    this._preGain.connect(this._foldShaper);
    this._symDC.connect(this._foldShaper);       // DC offset summed into the shaper input
    this._symDC.start();
    this._foldShaper.connect(this._foldOut);
    this._foldOut.connect(this.outputGain);

    // Thermal drift on the carrier detune.
    this._drift = new DriftClock(
      context,
      [this._carOsc.detune],
      { baseFor: () => this._params['detune'] + this._params['osc.detune'] + this._tolTune,
        amountFor: () => this._params['drift'] * 3.0 },
    );

    this._applyFold(context.currentTime);
    this._retune(context.currentTime);
  }

  /** Swap the core waveform (sine/triangle); no-op if unchanged. */
  _setWave(type) {
    if (this._carWave === type) return;
    this._carWave = type;
    this._carOsc.setPeriodicWave(makeImperfectWave(this.context, type, { tolerance: 0.02 }));
  }

  /**
   * Build the wavefolder curve from `fold`. preGain rises with fold (drives the
   * signal further into the sin() fold), and the curve folds back on itself so new
   * harmonics bloom. foldOut compensates the level so loud folds don't clip.
   */
  _applyFold(time) {
    const t    = time ?? this.context.currentTime;
    const fold = this._params['fold'];

    // A WaveShaper maps input ∈[−1,1] to output and CLAMPS anything outside that
    // domain — so "folding harder" must come from putting MORE LOBES in the curve,
    // not from pre-gaining the input past ±1 (that just clips at the curve edge).
    // The curve is sin(x·π·lobes): fold=0 → ~half a cycle (near-linear, nearly the
    // raw wave), fold=1 → ~4.5 cycles (deep multi-fold bloom). preGain stays 1.
    const lobes = 0.5 + fold * 4;                     // 0.5 … 4.5 cycles across [−1,1]
    // Carrier pre-gain < 1 leaves domain headroom so the `symmetry` DC offset can
    // shift the signal within [−1,1] (asymmetric folding) before the shaper clamps.
    this._preGain.gain.setTargetAtTime(0.7, t, 0.01);

    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;                // −1..+1
      curve[i] = Math.sin(x * Math.PI * lobes);
    }
    this._foldShaper.curve = curve;
    // Deeper folds add lobes but not level; keep output roughly unity.
    this._foldOut.gain.setTargetAtTime(1, t, 0.01);
  }

  /** Map `timbre` (0–1) to a peak FM deviation, scaled by pitch so it tracks. */
  _applyTimbre(time) {
    const t      = time ?? this.context.currentTime;
    const timbre = this._params['timbre'];
    const oct    = this._params['octave'];
    const freq   = Machine.midiToFreq(this._rootMidi + oct * 12);
    this._fmGain.gain.setTargetAtTime(timbre * freq * 4, t, 0.01);
  }

  /** Retune carrier + modulator (modulator at `ratio` × carrier). */
  _retune(time) {
    const t      = time ?? this.context.currentTime;
    const oct    = this._params['octave'];
    const master = this._params['osc.detune'];
    const det    = this._params['detune'];
    const ratio  = this._params['ratio'];
    const freq   = Machine.midiToFreq(this._rootMidi + oct * 12);
    this._carOsc.frequency.cancelScheduledValues(t);
    this._carOsc.frequency.setValueAtTime(freq, t);
    this._carOsc.detune.setValueAtTime(det + master + this._tolTune, t);
    this._modOsc.frequency.cancelScheduledValues(t);
    this._modOsc.frequency.setValueAtTime(freq * ratio, t);
    this._applyTimbre(t);   // deviation tracks pitch
  }

  /** Retune to the played note. Amplitude gating handled by the track Envelope. */
  noteOn(midiNote, velocity, time) {
    this._rootMidi = midiNote;
    this._retune(time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._drift.stop();
    try { this._carOsc.stop(); } catch (_) {}
    try { this._modOsc.stop(); } catch (_) {}
    try { this._symDC.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
