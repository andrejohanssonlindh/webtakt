/**
 * AnalogueTomMachine.js
 * ---------------------
 * Analogue-modelled tom — a tuned analogue drum voice built on the shared PATINA
 * building blocks in AnalogueParts.js. There is no digital "Tom" machine; this
 * is a focused single-body pitched drum (closest cousin to the analogue kick,
 * but tuned higher, no sub, and with a small noise attack rather than a punch).
 *
 * Analogue character:
 *   1. Body oscillator is an imperfect-sine `PeriodicWave` (makeImperfectWave) so
 *      the fundamental has trace harmonics, plus a fixed per-instance tuning
 *      tolerance and a DriftClock wandering its detune (scaled by `drift`).
 *   2. A short pink-noise attack (makePinkBuffer) adds a soft mallet/skin click
 *      without the hard transient of a kick punch.
 *
 * Persistent body oscillator (LFOs bind to .frequency); per-note GainNodes shape
 * the decay, recreated each hit. Body passes through a soft-clip waveshaper for a
 * little analogue warmth on harder hits.
 *
 * Audio graph:
 *   _tuneOsc (imperfect sine, +tol/drift) → _bodyGain (per-note) → _shaper → outputGain → [Filter]
 *   PinkNoiseSource (per-note) → _attackGain (per-note, bypasses shaper) ──────┘ (into outputGain)
 *
 * Parameters:
 *   'tune'         — base frequency in Hz (60–400) — tom pitch
 *   'decay'        — body decay time in seconds (0.1–1.5)
 *   'sweep'        — pitch sweep multiplier (1–4)
 *   'drive'        — pre-shaper gain overdrive (1–4)
 *   'drift'        — thermal pitch-wander amount (0–1)
 *   'attack'       — pink-noise attack level (0–1)
 *   'attack.decay' — attack noise decay (0.005–0.05)
 *   'output.level' — 0–1
 */

import { Machine }                            from './Machine.js';
import { makeTrimGain }                       from './LoudnessTrim.js';
import { scheduleCallback }                   from '../util/AudioBuffers.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

// Soft-clip waveshaper curve — tanh-based (shared idiom with the analogue kick).
function _makeShaperCurve(amount = 3, samples = 256) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export class AnalogueTomMachine extends Machine {
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 60, max: 400, default: 120, group: 'TONE',
                      modulatable: true, lfoMin: 60, lfoMax: 400, plockMode: 'audioParam',
                      target: m => m._tuneOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => m._tuneOsc.frequency.setTargetAtTime(v, t, 0.01) },
    'decay':        { label: 'Decay', type: 'number', min: 0.1, max: 1.5, default: 0.4, group: 'TONE', plockMode: 'js' },
    'sweep':        { label: 'Sweep', type: 'number', min: 1, max: 4, default: 1.8, group: 'TONE', plockMode: 'js' },
    'drive':        { label: 'Drive', type: 'number', min: 1, max: 4, default: 1.8, group: 'TONE', plockMode: 'js',
                      apply: (v, t, m) => { m._shaper.curve = _makeShaperCurve(v); } },
    'drift':        { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'TONE', plockMode: 'js' },
    'attack':       { label: 'Attack', type: 'number', min: 0, max: 1, default: 0.35, group: 'ATTACK', plockMode: 'js' },
    'attack.decay': { label: 'Atk Decay', type: 'number', min: 0.005, max: 0.05, default: 0.015, group: 'ATTACK', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'tom.analogue';
    this.label = 'Tom Analogue';

    this._initSpec();

    // Per-instance component tolerance — a fixed tuning skew the drift wanders on.
    this._tolTune = rand() * 5; // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Waveshaper — body passes through this before output.
    this._shaper = context.createWaveShaper();
    this._shaper.curve = _makeShaperCurve(this._params['drive']);
    this._shaper.oversample = '4x';
    this._shaper.connect(this.outputGain);

    // Persistent body oscillator — imperfect sine. LFO connects to .frequency.
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.03 }));
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.detune.value    = this._tolTune;
    this._tuneOsc.start();

    // Thermal drift on the body osc detune (wander on top of tolerance). The
    // per-note pitch sweep writes .frequency, drift writes .detune — no conflict.
    this._drift = new DriftClock(
      context,
      [this._tuneOsc.detune],
      { baseFor: () => this._tolTune, amountFor: () => this._params['drift'] * 3.0 },
    );

    // Pink-noise attack buffer.
    this._pinkBuf = makePinkBuffer(context, 0.1);

    // Per-note nodes (recreated each hit).
    this._bodyGain   = null;
    this._noise      = null;
    this._attackGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const tune     = this._params['tune'];
    const decay    = this._params['decay'];
    const sweep    = this._params['sweep'];
    const attack   = this._params['attack'];
    const ad       = this._params['attack.decay'];

    // Disconnect old per-note body node — both source→amp and amp→shaper.
    if (this._bodyGain) {
      try { this._tuneOsc.disconnect(this._bodyGain); } catch (_) {}
      try { this._bodyGain.disconnect(); } catch (_) {}
      this._bodyGain = null;
    }

    // ── Pitch sweep on the body oscillator ──
    // Note-tracked base freq: C4 (60) plays at `tune`, ±1:1 semitones either side.
    const f         = tune * Machine.noteRatio(midiNote);
    const startFreq = Math.max(f * sweep, 30);
    const endFreq   = Math.max(f, 30);
    this._tuneOsc.frequency.setValueAtTime(startFreq, t);
    this._tuneOsc.frequency.exponentialRampToValueAtTime(endFreq, t + decay * 0.3);

    // ── Per-note body gain — boosted 2x pre-shaper for drive ──
    this._bodyGain = this.context.createGain();
    this._bodyGain.gain.setValueAtTime(velScale * 2, t);
    this._bodyGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._tuneOsc.connect(this._bodyGain);
    this._bodyGain.connect(this._shaper);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock).
    const bodyGainRef = this._bodyGain;
    const tuneOscRef  = this._tuneOsc;
    const shaperRef   = this._shaper;
    scheduleCallback(this.context, t + decay * 1.3 + 0.1, () => {
      try { tuneOscRef.disconnect(bodyGainRef); } catch (_) {}
      try { bodyGainRef.disconnect(shaperRef);  } catch (_) {}
    });

    // ── Pink-noise attack burst — bypasses shaper for a soft skin click ──
    if (attack > 0.001) {
      if (this._noise) {
        try { this._noise.stop(); }            catch (_) {}
        try { this._attackGain.disconnect(); } catch (_) {}
      }

      this._noise = this.context.createBufferSource();
      this._noise.buffer = this._pinkBuf;
      this._noise.loop = false;

      this._attackGain = this.context.createGain();
      this._attackGain.gain.setValueAtTime(attack * velScale, t);
      this._attackGain.gain.exponentialRampToValueAtTime(0.001, t + ad);

      this._noise.connect(this._attackGain);
      this._attackGain.connect(this.outputGain);
      this._noise.start(t);
      this._noise.stop(t + ad + 0.005);
    }
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._drift.stop();
    try { this._tuneOsc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
