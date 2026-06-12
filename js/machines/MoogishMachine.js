/**
 * MoogishMachine.js
 * -----------------
 * Analogue-modelling oscillator machine — the tone-generator section of the
 * PATINA engine (js/patina/patina.js) adapted to the Webtakt machine contract.
 *
 * What makes it sound "analogue" (ported from Patina):
 *   - Custom oscillator spectra (`_makeImperfectWave`): real analogue waveforms
 *     are never textbook-perfect. Component tolerance skews harmonic amplitudes,
 *     comparator asymmetry leaks even harmonics into "square" waves, and op-amp
 *     slew limiting rounds off the very top. Each oscillator gets a fresh,
 *     slightly different PeriodicWave so no two are identical.
 *   - Slow thermal pitch DRIFT: a bounded random walk nudges every oscillator's
 *     detune ~12×/s (own setInterval, like SwarmMachine). `drift` scales it.
 *   - Per-instance component TOLERANCE: fixed random tuning/level offsets baked
 *     in at construction, so two MoogishMachine instances differ subtly.
 *   - Pink-noise hiss layer (circuit noise) blended in pre-filter.
 *
 * This machine is the OSCILLATOR section only. It deliberately does NOT include
 * Patina's ladder filter, envelopes, LFO, or FX — those are owned by the
 * Webtakt Track (Filter / Envelope / LFO / FX), so the existing GUI tabs,
 * p-locks and LFO routing drive this machine's tone for free. The analogue
 * ladder filter is a separate, later phase (see project_patina_analogue memory
 * / DESIGN.md). For now Moogish feeds the standard biquad Filter chain.
 *
 * Persistent-oscillator architecture (like SynthMachine / StringsMachine): all
 * nodes run continuously and amplitude is gated entirely by the track Envelope.
 * noteOn just retunes; noteOff is a no-op. LFOs / mod-wheel bind permanently.
 *
 * Audio graph:
 *   Osc1 → g1 ─┐
 *   Osc2 → g2 ─┤
 *   Osc3 → g3 ─┼→ _mixGain → outputGain → _trimGain → [Filter]
 *   Sub  → gS ─┤
 *   Noise→ gN ─┘
 *
 * Parameters (all p-lockable + LFO-assignable where they back an AudioParam):
 *   'osc1.waveform' 'osc1.octave' 'osc1.detune' 'osc1.level'
 *   'osc2.waveform' 'osc2.octave' 'osc2.detune' 'osc2.level'
 *   'osc3.waveform' 'osc3.octave' 'osc3.detune' 'osc3.level'
 *   'sub.level'     — sub sine, one octave below osc1 (0–1)
 *   'noise.level'   — circuit hiss (0–1)
 *   'drift'         — thermal pitch wander amount (0–1)
 *   'osc.detune'    — master detune cents (hidden, trig tab), -100..+100
 *   'output.level'  — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

const WAVEFORMS = ['saw', 'square', 'triangle', 'pulse', 'sine'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand  = (lo = -1, hi = 1) => lo + Math.random() * (hi - lo);

/**
 * Imperfect oscillator spectrum (ported from Patina makeImperfectWave).
 * Bakes component tolerance, even-harmonic leakage, phase smear and gentle
 * HF slew-limiting into a PeriodicWave — a fresh, slightly different one per osc.
 */
function _makeImperfectWave(ctx, type, { tolerance = 0.03, pulseWidth = 0.25 } = {}) {
  const N = 64;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) {
    let a = 0;
    switch (type) {
      case 'saw':
        a = 1 / n;
        break;
      case 'square':
        a = n % 2 === 1 ? 1 / n : (tolerance * 0.5 * Math.random()) / n; // even-harmonic leakage
        break;
      case 'triangle':
        a = n % 2 === 1
          ? ((n % 4 === 1 ? 1 : -1) / (n * n))
          : (tolerance * 0.25 * Math.random()) / (n * n);
        break;
      case 'pulse':
        a = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * pulseWidth);
        break;
      case 'sine':
        a = n === 1 ? 1 : n <= 3 ? (tolerance * 0.3) / (n * n) : 0; // trace harmonics
        break;
      default:
        a = 1 / n;
    }
    if (a === 0) continue;
    a *= 1 + rand() * tolerance;          // harmonic amplitude tolerance
    a *= Math.exp(-0.0007 * n * n);       // slew limiting: gentle HF rounding
    const ph = rand() * tolerance * 0.7;  // slight phase smear
    imag[n] = a * Math.cos(ph);
    real[n] = a * Math.sin(ph);
  }
  return ctx.createPeriodicWave(real, imag);
}

export class MoogishMachine extends Machine {
  // Per-osc waveform/octave are JS side-effects (PeriodicWave swap / retune);
  // detune/level back AudioParams so they p-lock + LFO natively. 'osc.detune' is
  // the hidden trig-tab master detune; like other persistent-osc machines it is
  // manualTarget so the per-osc offsets are preserved (written via _retune).
  static SPEC = {
    'osc1.waveform': { label: 'O1 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       plockMode: 'js', apply: (v, t, m) => m._setWave(0, v) },
    'osc1.octave':   { label: 'O1 Oct', type: 'number', min: -2, max: 2, default: 0, plockMode: 'js',
                       apply: (v, t, m) => m._retune(t) },
    'osc1.detune':   { label: 'O1 Detune', type: 'number', min: -50, max: 50, default: -6,
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc1.level':    { label: 'O1 Level', type: 'number', min: 0, max: 1, default: 0.45,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[0].gain, schedule: 'setTarget', tc: 0.005 },

    'osc2.waveform': { label: 'O2 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       plockMode: 'js', apply: (v, t, m) => m._setWave(1, v) },
    'osc2.octave':   { label: 'O2 Oct', type: 'number', min: -2, max: 2, default: 0, plockMode: 'js',
                       apply: (v, t, m) => m._retune(t) },
    'osc2.detune':   { label: 'O2 Detune', type: 'number', min: -50, max: 50, default: 7,
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[1].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc2.level':    { label: 'O2 Level', type: 'number', min: 0, max: 1, default: 0.45,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[1].gain, schedule: 'setTarget', tc: 0.005 },

    'osc3.waveform': { label: 'O3 Wave', type: 'enum', options: WAVEFORMS, default: 'triangle',
                       plockMode: 'js', apply: (v, t, m) => m._setWave(2, v) },
    'osc3.octave':   { label: 'O3 Oct', type: 'number', min: -2, max: 2, default: -1, plockMode: 'js',
                       apply: (v, t, m) => m._retune(t) },
    'osc3.detune':   { label: 'O3 Detune', type: 'number', min: -50, max: 50, default: 2,
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[2].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc3.level':    { label: 'O3 Level', type: 'number', min: 0, max: 1, default: 0.0,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[2].gain, schedule: 'setTarget', tc: 0.005 },

    'sub.level':     { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.0,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'noise.level':   { label: 'Noise', type: 'number', min: 0, max: 1, default: 0.0,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._noiseGain.gain, schedule: 'setTarget', tc: 0.01 },
    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.5,
                       plockMode: 'js' },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'moogish';
    this.label = 'Moogish';

    this._initSpec();
    this._rootMidi = 60;   // needed before any _retune (setParam during fromJSON)

    // Fixed per-instance "component tolerance" — like one slot in a vintage poly.
    this._tolTune  = rand() * 4;            // cents
    this._tolSub   = rand() * 2;            // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix bus — sums the three oscillators + sub + noise into outputGain.
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1;
    this._mixGain.connect(this.outputGain);

    // Three persistent main oscillators, each with its own imperfect spectrum.
    this._oscs       = [];
    this._gains      = [];
    this._driftState = [];
    for (let i = 0; i < 3; i++) {
      const osc = context.createOscillator();
      osc.setPeriodicWave(_makeImperfectWave(context, this._params[`osc${i + 1}.waveform`], {
        tolerance: 0.04,
      }));
      osc.frequency.value = 261.63;
      osc.detune.value    = this._params[`osc${i + 1}.detune`] + this._tolTune;

      const g = context.createGain();
      g.gain.value = this._params[`osc${i + 1}.level`];
      osc.connect(g);
      g.connect(this._mixGain);
      osc.start();

      this._oscs.push(osc);
      this._gains.push(g);
      this._driftState.push({ value: 0, target: 0 });
    }

    // Sub oscillator — sine, one octave below osc1.
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this._mixGain);
    this._oscSub = context.createOscillator();
    this._oscSub.setPeriodicWave(_makeImperfectWave(context, 'sine', { tolerance: 0.02 }));
    this._oscSub.frequency.value = 130.81;
    this._oscSub.detune.value    = this._tolSub;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();
    this._driftState.push({ value: 0, target: 0 }); // sub drift slot

    // Circuit hiss — looped pink noise, gated by _noiseGain.
    this._noiseGain = context.createGain();
    this._noiseGain.gain.value = this._params['noise.level'];
    this._noiseGain.connect(this._mixGain);
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = this._makePinkBuffer(context, 2);
    this._noiseSrc.loop   = true;
    this._noiseSrc.playbackRate.value = 1 + rand() * 0.1; // decorrelate
    this._noiseSrc.connect(this._noiseGain);
    this._noiseSrc.start();

    // Thermal drift clock — bounded random walk on every osc detune, ~12×/s.
    // Released in disconnect() (Machine base warns: un-released timers leak).
    this._driftTimer = setInterval(() => this._tickDrift(), 85);

    this._retune(context.currentTime);
  }

  /** Paul Kellet pink noise (ported from Patina makePinkNoiseBuffer). */
  _makePinkBuffer(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  /** Swap one oscillator's waveform (regenerates its imperfect spectrum). */
  _setWave(idx, type) {
    this._oscs[idx].setPeriodicWave(_makeImperfectWave(this.context, type, { tolerance: 0.04 }));
  }

  /**
   * Retune all oscillators to the current root note, applying per-osc octave +
   * detune (+ master detune + component tolerance). Sub tracks osc1 one octave
   * below. Mirrors StringsMachine._applyTuning.
   */
  _retune(time) {
    const t = time ?? this.context.currentTime;
    const master = this._params['osc.detune'];
    for (let i = 0; i < 3; i++) {
      const oct  = this._params[`osc${i + 1}.octave`];
      const det  = this._params[`osc${i + 1}.detune`];
      const freq = Machine.midiToFreq(this._rootMidi + oct * 12);
      this._oscs[i].frequency.setValueAtTime(freq, t);
      this._oscs[i].detune.setValueAtTime(det + master + this._tolTune, t);
    }
    const subOct = this._params['osc1.octave'];
    const subFreq = Machine.midiToFreq(this._rootMidi + subOct * 12 - 12);
    this._oscSub.frequency.setValueAtTime(subFreq, t);
  }

  /** Thermal drift: bounded random walk nudging each osc detune. */
  _tickDrift() {
    const cents = this._params['drift'] * 3.5; // up to ±3.5 cents wander
    if (cents <= 0) return;
    const t = this.context.currentTime;
    const master = this._params['osc.detune'];
    const all = [...this._oscs, this._oscSub];
    all.forEach((osc, i) => {
      const st = this._driftState[i];
      if (Math.random() < 0.25) st.target = rand() * cents;
      st.value += (st.target - st.value) * 0.3;
      const base = i < 3
        ? this._params[`osc${i + 1}.detune`] + master + this._tolTune
        : this._tolSub;
      osc.detune.setTargetAtTime(base + st.value, t, 0.15);
    });
  }

  /** Retune to the played note. Amplitude gating handled by the track Envelope. */
  noteOn(midiNote, velocity, time) {
    this._rootMidi = midiNote;
    this._retune(time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    clearInterval(this._driftTimer);
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    try { this._oscSub.stop();   } catch (_) {}
    try { this._noiseSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). Per-osc
  // retune side-effects live in _retune, referenced by the spec apply hooks.
}
