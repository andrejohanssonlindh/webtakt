/**
 * TomMachine.js
 * -------------
 * Digital tom — a clean, synthetic tuned drum voice (the digital counterpart to
 * AnalogueTomMachine). Where the analogue tom leans on imperfect-sine spectra and
 * thermal drift for warmth, this one is deliberately precise: a pure sine + a
 * blendable triangle body with a fast pitch drop, plus a short white-noise click
 * for attack. Think DX / PCM-era electronic toms — punchy and clean, no drift.
 *
 * Persistent body oscillators (sine + triangle) so an LFO can bind to their
 * frequency permanently; per-note GainNodes shape the decay, recreated each hit.
 * The triangle adds odd-harmonic bite, mixed in via `tone` (0 = pure sine).
 *
 * Audio graph:
 *   _sineOsc (persistent) → _bodyGain (per-note) ─┐
 *   _triOsc  (persistent) → _toneGain → _bodyGain ┤→ outputGain → [Filter]
 *   NoiseSource (per-note) → _clickGain (per-note) ┘
 *
 * Parameters:
 *   'tune'         — base frequency in Hz (60–400) — tom pitch
 *   'decay'        — body decay time in seconds (0.1–1.5)
 *   'sweep'        — pitch sweep multiplier (1–4): start pitch = tune × sweep
 *   'sweep.time'   — fraction of decay the pitch drop spans (0.05–0.6)
 *   'tone'         — triangle (odd-harmonic) blend into the sine body (0–1)
 *   'click'        — white-noise attack level (0–1)
 *   'click.decay'  — attack click decay (0.003–0.04)
 *   'output.level' — 0–1
 */

import { Machine }          from './Machine.js';
import { makeTrimGain }     from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

export class TomMachine extends Machine {
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 60, max: 400, default: 110, group: 'TONE',
                      modulatable: true, lfoMin: 60, lfoMax: 400, plockMode: 'audioParam',
                      target: m => m._sineOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => {
                        m._sineOsc.frequency.setTargetAtTime(v, t, 0.01);
                        m._triOsc.frequency.setTargetAtTime(v, t, 0.01);
                      } },
    'decay':        { label: 'Decay', type: 'number', min: 0.1, max: 1.5, default: 0.45, group: 'TONE', plockMode: 'js' },
    'sweep':        { label: 'Sweep', type: 'number', min: 1, max: 4, default: 2.0, group: 'TONE', plockMode: 'js' },
    'sweep.time':   { label: 'Swp Time', type: 'number', min: 0.05, max: 0.6, default: 0.25, group: 'TONE', plockMode: 'js' },
    'tone':         { label: 'Tone', type: 'number', min: 0, max: 1, default: 0.25, group: 'TONE', plockMode: 'js',
                      apply: (v, t, m) => m._toneGain.gain.setTargetAtTime(v, t, 0.01) },
    'click':        { label: 'Click', type: 'number', min: 0, max: 1, default: 0.3, group: 'ATTACK', plockMode: 'js' },
    'click.decay':  { label: 'Clk Decay', type: 'number', min: 0.003, max: 0.04, default: 0.012, group: 'ATTACK', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'tom';
    this.label = 'Tom';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent body oscillators. Sine = clean fundamental; triangle adds odd
    // harmonics, blended in via _toneGain. Both share `tune`; LFO binds to the
    // sine's .frequency (the canonical target), and `tune.apply` writes both.
    this._sineOsc = context.createOscillator();
    this._sineOsc.type = 'sine';
    this._sineOsc.frequency.value = this._params['tune'];
    this._sineOsc.start();

    this._triOsc = context.createOscillator();
    this._triOsc.type = 'triangle';
    this._triOsc.frequency.value = this._params['tune'];
    this._triOsc.start();

    // Triangle blend level (the `tone` param). Routed sine→bodyGain directly and
    // tri→toneGain→bodyGain, so the per-note decay envelope shapes both together.
    this._toneGain = context.createGain();
    this._toneGain.gain.value = this._params['tone'];
    this._triOsc.connect(this._toneGain);

    // White-noise click buffer (cached per context/sample-rate).
    this._noiseCache = {};

    // Per-note nodes (recreated each hit).
    this._bodyGain  = null;
    this._noise     = null;
    this._clickGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const tune     = this._params['tune'];
    const decay    = this._params['decay'];
    const sweep    = this._params['sweep'];
    const sweepT   = this._params['sweep.time'];
    const click    = this._params['click'];
    const cd       = this._params['click.decay'];

    // Disconnect old per-note body node — both osc→amp and amp→output.
    if (this._bodyGain) {
      try { this._sineOsc.disconnect(this._bodyGain); } catch (_) {}
      try { this._toneGain.disconnect(this._bodyGain); } catch (_) {}
      try { this._bodyGain.disconnect(); } catch (_) {}
      this._bodyGain = null;
    }

    // ── Fast pitch drop on the body (both oscillators share the sweep) ──
    // Note-tracked base freq: C4 (60) plays at `tune`, ±1:1 semitones either side.
    const f         = tune * Machine.noteRatio(midiNote);
    const startFreq = Math.max(f * sweep, 30);
    const endFreq   = Math.max(f, 30);
    for (const osc of [this._sineOsc, this._triOsc]) {
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(startFreq, t);
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + decay * sweepT);
    }

    // ── Per-note body gain — exponential decay ──
    this._bodyGain = this.context.createGain();
    this._bodyGain.gain.setValueAtTime(velScale, t);
    this._bodyGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._sineOsc.connect(this._bodyGain);
    this._toneGain.connect(this._bodyGain);
    this._bodyGain.connect(this.outputGain);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock).
    const bodyGainRef = this._bodyGain;
    const sineRef = this._sineOsc, toneRef = this._toneGain;
    scheduleCallback(this.context, t + decay * 1.3 + 0.1, () => {
      try { sineRef.disconnect(bodyGainRef); } catch (_) {}
      try { toneRef.disconnect(bodyGainRef); } catch (_) {}
      try { bodyGainRef.disconnect(); } catch (_) {}
    });

    // ── White-noise click — a short, clean attack transient ──
    if (click > 0.001) {
      if (this._noise) {
        try { this._noise.stop(); }            catch (_) {}
        try { this._clickGain.disconnect(); }  catch (_) {}
      }

      this._noise = this.context.createBufferSource();
      this._noise.buffer = getNoiseBuffer(this.context, this._noiseCache, 0.1);
      this._noise.loop = false;

      this._clickGain = this.context.createGain();
      this._clickGain.gain.setValueAtTime(click * velScale, t);
      this._clickGain.gain.exponentialRampToValueAtTime(0.001, t + cd);

      this._noise.connect(this._clickGain);
      this._clickGain.connect(this.outputGain);
      this._noise.start(t);
      this._noise.stop(t + cd + 0.005);
    }
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._sineOsc.stop(); } catch (_) {}
    try { this._triOsc.stop(); }  catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
