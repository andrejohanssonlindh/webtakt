/**
 * AnalogueKickMachine.js
 * ----------------------
 * Analogue-modelled kick drum — the analogue counterpart to KickHardMachine,
 * built from the shared PATINA building blocks in AnalogueParts.js.
 *
 * Same proven three-layer structure as KickHard (persistent body + sub through a
 * soft-clip waveshaper, plus a per-note noise punch), but every layer is given
 * "analogue" character:
 *   1. Body + sub oscillators use imperfect spectra (makeImperfectWave 'sine' —
 *      a near-sine with trace harmonics + component tolerance) instead of a
 *      textbook sine, so the fundamental isn't sterile.
 *   2. Per-instance TUNING TOLERANCE: a fixed random cents offset baked in at
 *      construction (like one voice of a vintage drum machine).
 *   3. Thermal DRIFT: a bounded random walk wanders the body/sub pitch ~12×/s
 *      (DriftClock), the slow detune wobble of a warm circuit. `drift` scales it.
 *   4. PINK noise punch (makePinkBuffer) rather than white — the noise colour of
 *      real analogue drums.
 *
 * Persistent body/sub oscillators (LFOs bind to .frequency permanently);
 * per-note GainNodes shape the decay, recreated each hit. Mirrors KickHard.
 *
 * Audio graph:
 *   _tuneOsc (persistent) → _bodyGain (per-note) ─┐
 *   _subOsc  (persistent) → _subGain  (per-note) ─┼→ _shaper → outputGain → [Filter]
 *   PinkNoiseSource (per-note) → _punchGain (per-note) ─┘
 *
 * Parameters (mirror KickHard, plus 'drift'):
 *   'tune'         — base frequency in Hz (20–200)
 *   'decay'        — body decay time in seconds (0.05–2.0)
 *   'sweep'        — pitch sweep multiplier (1–8)
 *   'sub.level'    — sub oscillator level relative to body (0–1)
 *   'drive'        — pre-shaper gain overdrive (1–6)
 *   'drift'        — thermal pitch-wander amount (0–1)
 *   'punch'        — level of pink-noise transient (0–1)
 *   'punch.decay'  — punch noise decay (0.005–0.08)
 *   'output.level' — 0–1
 */

import { Machine }                            from './Machine.js';
import { makeTrimGain }                       from './LoudnessTrim.js';
import { scheduleCallback }                   from '../util/AudioBuffers.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

// Soft-clip waveshaper curve — tanh-based, amount controls drive character.
// (Identical to KickHard — kept local so the two kicks stay independent.)
function _makeShaperCurve(amount = 3, samples = 256) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export class AnalogueKickMachine extends Machine {
  // Mirrors KickHard's SPEC. 'tune' = manualTarget (LFO resolves to
  // _tuneOsc.frequency; setParam sweeps both body + sub). 'drive' rebuilds the
  // waveshaper curve. 'drift' is JS-only (read by the DriftClock each tick).
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 20, max: 200, default: 55, group: 'TONE',
                      modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam',
                      target: m => m._tuneOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => {
                        m._tuneOsc.frequency.setTargetAtTime(v, t, 0.01);
                        m._subOsc.frequency.setTargetAtTime(v / 2, t, 0.01);
                      } },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 2.0, default: 0.50, group: 'TONE', plockMode: 'js' },
    'sweep':        { label: 'Sweep', type: 'number', min: 1, max: 8, default: 4.0, group: 'TONE', plockMode: 'js' },
    'sub.level':    { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.8, group: 'TONE', plockMode: 'js' },
    'drive':        { label: 'Drive', type: 'number', min: 1, max: 6, default: 2.5, group: 'TONE', plockMode: 'js',
                      apply: (v, t, m) => { m._shaper.curve = _makeShaperCurve(v); } },
    'drift':        { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'TONE', plockMode: 'js' },
    'punch':        { label: 'Punch', type: 'number', min: 0, max: 1, default: 0.6, group: 'PUNCH', plockMode: 'js' },
    'punch.decay':  { label: 'Punch Decay', type: 'number', min: 0.005, max: 0.08, default: 0.025, group: 'PUNCH', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.9, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'kick.analogue';
    this.label = 'Kick Analogue';

    this._initSpec();

    // Per-instance component tolerance — a fixed tuning skew, like one voice of
    // a vintage drum machine. Drift wanders on top of this.
    this._tolTune = rand() * 4; // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Waveshaper — body + sub pass through this before output.
    this._shaper = context.createWaveShaper();
    this._shaper.curve = _makeShaperCurve(this._params['drive']);
    this._shaper.oversample = '4x';
    this._shaper.connect(this.outputGain);

    // Persistent body oscillator — imperfect "sine" so the fundamental isn't
    // sterile. LFO connects to .frequency directly.
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.03 }));
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.detune.value    = this._tolTune;
    this._tuneOsc.start();

    // Persistent sub oscillator — one octave below body, its own imperfect sine.
    this._subOsc = context.createOscillator();
    this._subOsc.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.02 }));
    this._subOsc.frequency.value = this._params['tune'] / 2;
    this._subOsc.detune.value    = this._tolTune;
    this._subOsc.start();

    // Thermal drift on body + sub pitch — bounded random walk on detune, ~12×/s.
    // Base is the component-tolerance offset; drift wanders on top. The kick's
    // per-note pitch sweep writes .frequency (not .detune), so drift and sweep
    // stack cleanly without fighting.
    this._drift = new DriftClock(
      context,
      [this._tuneOsc.detune, this._subOsc.detune],
      { baseFor: () => this._tolTune, amountFor: () => this._params['drift'] * 3.0 },
    );

    // Pink-noise punch buffer (looped off, sliced per hit).
    this._pinkBuf = makePinkBuffer(context, 0.25);

    // Per-note nodes (recreated each hit).
    this._bodyGain  = null;
    this._subGain   = null;
    this._noise     = null;
    this._punchGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale  = velocity / 127;
    const t         = time;
    const tune      = this._params['tune'];
    const decay     = this._params['decay'];
    const sweep     = this._params['sweep'];
    const subLevel  = this._params['sub.level'];
    const punch     = this._params['punch'];
    const pd        = this._params['punch.decay'];

    // Disconnect old per-note nodes — both source→amp and amp→output.
    if (this._bodyGain) {
      try { this._tuneOsc.disconnect(this._bodyGain); } catch (_) {}
      try { this._bodyGain.disconnect(); } catch (_) {}
      this._bodyGain = null;
    }
    if (this._subGain) {
      try { this._subOsc.disconnect(this._subGain); } catch (_) {}
      try { this._subGain.disconnect(); } catch (_) {}
      this._subGain = null;
    }

    // ── Pitch sweep on both oscillators ──
    const startFreq = Math.max(tune * sweep, 20);
    const endFreq   = Math.max(tune, 20);
    this._tuneOsc.frequency.setValueAtTime(startFreq, t);
    this._tuneOsc.frequency.exponentialRampToValueAtTime(endFreq, t + decay * 0.25);
    this._subOsc.frequency.setValueAtTime(startFreq / 2, t);
    this._subOsc.frequency.exponentialRampToValueAtTime(endFreq / 2, t + decay * 0.25);

    // ── Per-note body gain — boosted 2x pre-shaper for drive ──
    this._bodyGain = this.context.createGain();
    this._bodyGain.gain.setValueAtTime(velScale * 2, t);
    this._bodyGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._tuneOsc.connect(this._bodyGain);
    this._bodyGain.connect(this._shaper);

    // ── Per-note sub gain ──
    this._subGain = this.context.createGain();
    this._subGain.gain.setValueAtTime(velScale * subLevel * 2, t);
    this._subGain.gain.exponentialRampToValueAtTime(0.001, t + decay * 1.2);
    this._subOsc.connect(this._subGain);
    this._subGain.connect(this._shaper);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock).
    const bodyGainRef = this._bodyGain;
    const subGainRef  = this._subGain;
    const tuneOscRef  = this._tuneOsc;
    const subOscRef   = this._subOsc;
    const shaperRef   = this._shaper;
    scheduleCallback(this.context, t + decay * 1.3 + 0.1, () => {
      try { tuneOscRef.disconnect(bodyGainRef); } catch (_) {}
      try { bodyGainRef.disconnect(shaperRef);  } catch (_) {}
      try { subOscRef.disconnect(subGainRef);   } catch (_) {}
      try { subGainRef.disconnect(shaperRef);   } catch (_) {}
    });

    // ── Pink-noise punch burst — bypasses shaper for click clarity ──
    if (punch > 0.001) {
      if (this._noise) {
        try { this._noise.stop(); }           catch (_) {}
        try { this._punchGain.disconnect(); } catch (_) {}
      }

      this._noise = this.context.createBufferSource();
      this._noise.buffer = this._pinkBuf;
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
    this._trimGain.connect(destinationNode);
  }

  disconnect() {
    this._drift.stop();
    try { this._tuneOsc.stop(); } catch (_) {}
    try { this._subOsc.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
