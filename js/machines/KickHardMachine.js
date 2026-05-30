/**
 * KickHardMachine.js
 * ------------------
 * Fat, saturated kick drum. Three-layer design:
 *   1. Persistent body oscillator with frequency sweep per hit
 *   2. Persistent sub oscillator (octave below body) for low-end weight
 *   3. Short white-noise burst via per-note BufferSourceNode (punch)
 *
 * Body and sub share the same pitch sweep. Both feed through a WaveShaperNode
 * (soft-clip saturation) before the output gain, adding harmonics and weight.
 *
 * The body/sub oscillators are PERSISTENT — they run continuously and their
 * amplitudes are shaped by per-note GainNodes recreated each hit.
 * This allows LFOs to connect directly to _tuneOsc.frequency permanently.
 *
 * Audio graph:
 *   _tuneOsc (persistent) → _bodyGain (per-note) ─┐
 *   _subOsc  (persistent) → _subGain  (per-note) ─┼→ _shaper → outputGain → [Filter]
 *   NoiseSource (per-note) → _punchGain (per-note) ─┘
 *
 * Parameters:
 *   'tune'         — base frequency in Hz (20–200)
 *   'decay'        — body decay time in seconds (0.05–2.0)
 *   'sweep'        — pitch sweep multiplier (1–8)
 *   'sub.level'    — sub oscillator level relative to body (0–1)
 *   'drive'        — pre-shaper gain overdrive (1–6)
 *   'punch'        — level of noise transient (0–1)
 *   'punch.decay'  — punch noise decay (0.005–0.08)
 *   'output.level' — 0–1
 */

import { Machine }                        from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.25);

// Soft-clip waveshaper curve — tanh-based, amount controls drive character
function _makeShaperCurve(amount = 3, samples = 256) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export class KickHardMachine extends Machine {
  // 'tune' = manualTarget (resolves to _tuneOsc.frequency for LFO, but setParam
  // sweeps both body + sub oscs via apply). 'drive' rebuilds the waveshaper curve.
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 20, max: 200, default: 60,
                      modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam',
                      target: m => m._tuneOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => {
                        m._tuneOsc.frequency.setTargetAtTime(v, t, 0.01);
                        m._subOsc.frequency.setTargetAtTime(v / 2, t, 0.01);
                      } },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 2.0, default: 0.45, plockMode: 'js' },
    'sweep':        { label: 'Sweep', type: 'number', min: 1, max: 8, default: 4.0, plockMode: 'js' },
    'sub.level':    { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.8, plockMode: 'js' },
    'drive':        { label: 'Drive', type: 'number', min: 1, max: 6, default: 3.0, plockMode: 'js',
                      apply: (v, t, m) => { m._shaper.curve = _makeShaperCurve(v); } },
    'punch':        { label: 'Punch', type: 'number', min: 0, max: 1, default: 0.7, plockMode: 'js' },
    'punch.decay':  { label: 'Punch Decay', type: 'number', min: 0.005, max: 0.08, default: 0.025, plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.9,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'kick.hard';
    this.label = 'Kick Hard';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Waveshaper — body + sub pass through this before output
    this._shaper = context.createWaveShaper();
    this._shaper.curve = _makeShaperCurve(this._params['drive']);
    this._shaper.oversample = '4x';
    this._shaper.connect(this.outputGain);

    // Persistent body oscillator — LFO connects to .frequency directly
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.type = 'sine';
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.start();

    // Persistent sub oscillator — one octave below body
    this._subOsc = context.createOscillator();
    this._subOsc.type = 'sine';
    this._subOsc.frequency.value = this._params['tune'] / 2;
    this._subOsc.start();

    // Per-note nodes (recreated each hit)
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

    // Disconnect old per-note nodes — both source→amp and amp→output
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

    // Disconnect after decay tail using AudioContext-time callback (not wall clock)
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

    // ── Punch noise burst — bypasses shaper for click clarity ──
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
    this._trimGain.connect(destinationNode);
  }

  disconnect() {
    try { this._tuneOsc.stop(); } catch (_) {}
    try { this._subOsc.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
