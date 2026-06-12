/**
 * ════════════════════════════════════════════════════════════════════════
 *  PATINA — an analog-modelling synthesizer engine for the Web Audio API
 *  v1.0.0 · single file · zero dependencies · ES module
 * ════════════════════════════════════════════════════════════════════════
 *
 *  Why it sounds analog (the short version — full story in MANUAL.md):
 *
 *   · VCOs run continuously and are gated by the VCA, like real voice cards
 *   · Every voice gets fixed random "component tolerance" offsets
 *     (tuning, cutoff, envelope times) — no two voices are identical
 *   · Slow thermal pitch drift via a bounded random walk per oscillator
 *   · A 4-pole transistor-ladder lowpass filter (Moog topology) with tanh
 *     saturation, self-oscillation and thermal cutoff drift, implemented
 *     as an AudioWorklet (per-sample DSP, not a clean biquad)
 *   · RC-curve (exponential) envelopes — never linear ramps
 *   · Custom oscillator spectra with harmonic tolerance, phase smear and
 *     slew-limited highs (no two saws alike)
 *   · BBD-style stereo chorus, soft-clipping drive, noise floor and
 *     mains hum, all dialable
 *
 *  Quick start:
 *
 *      import { PatinaSynth } from './patina.js';
 *      const synth = new PatinaSynth();          // creates its own context
 *      await synth.ready;
 *      synth.loadPreset('warm-pad');
 *      synth.noteOn('C4', 0.8);                  // ... later:
 *      synth.noteOff('C4');
 *
 *  License: MIT. Do whatever you like.
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════ utilities ════════════════════════════ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (lo = -1, hi = 1) => lo + Math.random() * (hi - lo);
const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d+)$/;
const NOTE_OFFSET = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Accepts MIDI numbers (60) or note names ('C4', 'F#2', 'Bb3'). */
export function toMidi(note) {
  if (typeof note === 'number') return clamp(Math.round(note), 0, 127);
  const m = NOTE_RE.exec(String(note).trim());
  if (!m) throw new Error(`Patina: cannot parse note "${note}"`);
  let n = NOTE_OFFSET[m[1].toLowerCase()];
  if (m[2] === '#') n += 1;
  if (m[2] === 'b') n -= 1;
  return clamp(n + (parseInt(m[3], 10) + 1) * 12, 0, 127);
}

export function midiToFreq(midi, masterTune = 440) {
  return masterTune * Math.pow(2, (midi - 69) / 12);
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepMerge(target[k], sv);
    } else {
      target[k] = sv;
    }
  }
  return target;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

/* Cancel automation but hold current value; falls back where unsupported. */
function holdParam(param, t) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t);
  } else {
    param.cancelScheduledValues(t);
  }
}

/* ═══════════════════ the ladder filter (AudioWorklet) ═══════════════════
 *
 * A Huovilainen-style 4-pole transistor ladder:
 *   · tanh saturation in the input/feedback path (the "Moog growl")
 *   · resonance > 1.0 pushes it into self-oscillation
 *   · a slow thermal random walk modulates the cutoff
 *   · a whisper of noise keeps self-oscillation alive and denormals away
 *
 * Shipped as a source string and loaded from a Blob URL, so the library
 * stays a single file.
 * ════════════════════════════════════════════════════════════════════ */

const LADDER_WORKLET_SRC = `
class PatinaLadder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff',    defaultValue: 1200, minValue: 10,  maxValue: 18000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.2,  minValue: 0,   maxValue: 1.15,  automationRate: 'k-rate' },
      { name: 'drive',     defaultValue: 1.0,  minValue: 0.1, maxValue: 12,    automationRate: 'k-rate' },
      { name: 'drift',     defaultValue: 0.004,minValue: 0,   maxValue: 0.08,  automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0;
    this.thermal = 0;
    this.thermalTarget = 0;
    this.thermalClock = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'kill') this.alive = false; };
  }
  process(inputs, outputs, p) {
    if (!this.alive) return false;
    const inCh  = (inputs[0] && inputs[0][0]) || null;
    const out   = outputs[0];
    if (!out || !out[0]) return true;
    const n     = out[0].length;
    const res   = p.resonance[0];
    const drive = p.drive[0];
    const driftAmt = p.drift[0];
    const cut   = p.cutoff;
    const aRate = cut.length > 1;
    const sr    = sampleRate;
    const fMax  = sr * 0.45;
    const fb    = res * 4.2;                    // > 4 → self-oscillation
    const makeup = (1 + res * 0.85) / Math.max(1, Math.sqrt(drive));

    let s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4;

    for (let i = 0; i < n; i++) {
      /* thermal drift: bounded random walk, new target every ~25–50 ms */
      if (--this.thermalClock <= 0) {
        this.thermalTarget = Math.random() * 2 - 1;
        this.thermalClock = 1024 + ((Math.random() * 1024) | 0);
      }
      this.thermal += (this.thermalTarget - this.thermal) * 0.0006;

      let fc = (aRate ? cut[i] : cut[0]) * (1 + this.thermal * driftAmt);
      if (fc < 10) fc = 10; else if (fc > fMax) fc = fMax;
      const g = 1 - Math.exp(-6.283185307179586 * fc / sr);

      const xin = inCh ? inCh[i] : 0;
      /* tiny noise: seeds self-oscillation, kills denormals */
      let x = xin * drive + (Math.random() - 0.5) * 2e-6;
      x = Math.tanh(x - fb * Math.tanh(s4));

      s1 += g * (x  - s1);
      s2 += g * (s1 - s2);
      s3 += g * (s2 - s3);
      s4 += g * (s3 - s4);

      const y = s4 * makeup;
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = y;
    }
    this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
    return true;
  }
}
registerProcessor('patina-ladder', PatinaLadder);
`;

let workletUrl = null;
function getWorkletUrl() {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(
      new Blob([LADDER_WORKLET_SRC], { type: 'application/javascript' })
    );
  }
  return workletUrl;
}

/* ════════════════════ imperfect oscillator spectra ════════════════════
 *
 * Real analog waveforms are never textbook-perfect: component tolerance
 * skews harmonic amplitudes, comparator asymmetry leaks even harmonics
 * into "square" waves, and op-amp slew limiting rounds off the very top.
 * We bake all of that into PeriodicWaves — a fresh, slightly different
 * one per oscillator, so no two voices share a spectrum.
 * ═══════════════════════════════════════════════════════════════════ */

function makeImperfectWave(ctx, type, { tolerance = 0.03, pulseWidth = 0.25 } = {}) {
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

/* ═══════════════════════ shared noise resources ═══════════════════════ */

function makePinkNoiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;            // Paul Kellet pink filter
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

function makeReverbImpulse(ctx, seconds = 2.2, tone = 0.4) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    const lpCoef = clamp(0.05 + tone * 0.6, 0.02, 0.9); // lower = darker tail
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.4) * Math.exp((-3 * i) / len);
      const w = (Math.random() * 2 - 1) * env;
      lp += lpCoef * (w - lp);
      d[i] = lp * 3;
    }
  }
  return buf;
}

/* soft-clip transfer curve for the drive stage */
function makeDriveCurve(amount) {
  const k = clamp(amount, 0.01, 12);
  const N = 2048;
  const curve = new Float32Array(N);
  const norm = Math.tanh(k);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    /* slight asymmetry — like a single-ended transistor stage (even harmonics) */
    const bias = 0.04 * k * 0.1;
    curve[i] = Math.tanh(k * (x + bias)) / norm - Math.tanh(k * bias) / norm;
  }
  return curve;
}

/* ══════════════════════ filter unit (with fallback) ══════════════════════
 * Wraps either the ladder worklet or (if AudioWorklet is unavailable)
 * two cascaded biquads + a soft clipper, behind one small interface.
 * ═══════════════════════════════════════════════════════════════════════ */

class FilterUnit {
  constructor(ctx, useWorklet) {
    this.ctx = ctx;
    this.isLadder = useWorklet;
    if (useWorklet) {
      this.node = new AudioWorkletNode(ctx, 'patina-ladder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.input = this.node;
      this.output = this.node;
      this.cutoffParams = [this.node.parameters.get('cutoff')];
      this._res = this.node.parameters.get('resonance');
      this._drive = this.node.parameters.get('drive');
      this._drift = this.node.parameters.get('drift');
    } else {
      /* fallback: 2 × 12 dB biquads ≈ 24 dB/oct + tanh shaper */
      const b1 = ctx.createBiquadFilter();
      const b2 = ctx.createBiquadFilter();
      b1.type = b2.type = 'lowpass';
      const sat = ctx.createWaveShaper();
      sat.curve = makeDriveCurve(1.4);
      sat.oversample = '2x';
      b1.connect(b2).connect(sat);
      this.input = b1;
      this.output = sat;
      this.cutoffParams = [b1.frequency, b2.frequency];
      this._biquads = [b1, b2];
    }
  }
  setResonance(v) {
    if (this.isLadder) this._res.value = clamp(v, 0, 1.15);
    else this._biquads.forEach((b) => (b.Q.value = clamp(v, 0, 1.15) * 9));
  }
  setDrive(v) {
    if (this.isLadder) this._drive.value = clamp(v, 0.1, 12);
  }
  setDrift(v) {
    if (this.isLadder) this._drift.value = clamp(v, 0, 0.08);
  }
  /* schedule cutoff: target value, start time, RC time constant */
  glideCutoff(value, t, tc) {
    const v = clamp(value, 20, 18000);
    for (const p of this.cutoffParams) {
      holdParam(p, t);
      p.setTargetAtTime(v, t, Math.max(0.001, tc));
    }
  }
  destroy() {
    if (this.isLadder) {
      try { this.node.port.postMessage('kill'); } catch (e) { /* noop */ }
    }
    try { this.output.disconnect(); } catch (e) { /* noop */ }
  }
}

/* ═══════════════════════════════ Voice ═══════════════════════════════
 * A complete voice card: oscillators (always running) + sub + noise
 * → ladder filter → VCA → slight per-voice pan.  Carries its own fixed
 * component-tolerance offsets, like one slot in a vintage polysynth.
 * ════════════════════════════════════════════════════════════════════ */

class Voice {
  constructor(synth, index) {
    this.synth = synth;
    this.index = index;
    const ctx = synth.ctx;
    const P = synth.params;
    const tolScale = P.character.tolerance;

    /* fixed "this voice card" imperfections */
    this.tol = {
      tune: rand() * 4 * tolScale,                       // cents
      cutoff: 1 + rand() * 0.06 * tolScale,              // multiplier
      env: 1 + rand() * 0.12 * tolScale,                 // env-time multiplier
      pan: rand() * 0.08 * tolScale,
      level: 1 + rand() * 0.05 * tolScale,
    };

    this.note = null;
    this.gateOn = false;
    this.startedAt = 0;
    this.driftState = [];

    /* nodes */
    this.filter = new FilterUnit(ctx, synth.workletReady);
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.panner = ctx.createStereoPanner
      ? ctx.createStereoPanner()
      : ctx.createGain();
    if (this.panner.pan) this.panner.pan.value = this.tol.pan;

    this.oscBus = ctx.createGain();
    this.oscBus.gain.value = 1;
    this.oscBus.connect(this.filter.input);
    this.filter.output.connect(this.vca);
    this.vca.connect(this.panner);
    this.panner.connect(synth.voiceBus);

    this.oscs = [];
    this.subOsc = null;
    this.subGain = null;
    this.noiseGain = null;

    this._buildSources();
    this._applyStaticParams();
  }

  _buildSources() {
    const ctx = this.synth.ctx;
    const P = this.synth.params;
    const now = ctx.currentTime;

    /* main oscillators — created once, run forever, gated by the VCA */
    for (const cfg of P.oscillators) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(
        makeImperfectWave(ctx, cfg.type, {
          tolerance: 0.02 + 0.05 * P.character.tolerance,
          pulseWidth: cfg.pulseWidth ?? 0.25,
        })
      );
      const g = ctx.createGain();
      g.gain.value = cfg.level;
      osc.connect(g).connect(this.oscBus);
      osc.start(now);
      /* pitch bend + vibrato LFO feed every oscillator's detune */
      this.synth.bendCents.connect(osc.detune);
      this.synth.lfoPitchGain.connect(osc.detune);
      this.oscs.push({
        osc, gain: g, cfg,
        waveKey: `${cfg.type}|${cfg.pulseWidth ?? 0.25}|${P.character.tolerance}`,
      });
      this.driftState.push({ value: 0, target: 0 });
    }

    /* sub oscillator (one octave below osc 1) */
    const sub = ctx.createOscillator();
    sub.setPeriodicWave(makeImperfectWave(ctx, P.sub.type || 'sine', { tolerance: 0.02 }));
    this.subGain = ctx.createGain();
    this.subGain.gain.value = P.sub.level;
    sub.connect(this.subGain).connect(this.oscBus);
    sub.start(now);
    this.synth.bendCents.connect(sub.detune);
    this.subOsc = sub;
    this.driftState.push({ value: 0, target: 0 });

    /* per-voice noise */
    const noise = ctx.createBufferSource();
    noise.buffer = this.synth.pinkBuffer;
    noise.loop = true;
    noise.playbackRate.value = 1 + rand() * 0.1; // decorrelate voices
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = P.noise.level;
    noise.connect(this.noiseGain).connect(this.oscBus);
    noise.start(now);
    this.noiseSrc = noise;
  }

  _applyStaticParams() {
    const P = this.synth.params;
    this.filter.setResonance(P.filter.resonance);
    this.filter.setDrive(P.filter.drive);
    this.filter.setDrift(0.002 + 0.02 * P.character.drift);
  }

  /** Refresh levels / waveforms after a set() without rebuilding the voice. */
  refresh() {
    const P = this.synth.params;
    const ctx = this.synth.ctx;
    this.oscs.forEach((o, i) => {
      const cfg = P.oscillators[i];
      if (!cfg) return;
      o.cfg = cfg;
      o.gain.gain.setTargetAtTime(cfg.level, ctx.currentTime, 0.02);
      /* only regenerate the spectrum if it would actually differ */
      const key = `${cfg.type}|${cfg.pulseWidth ?? 0.25}|${P.character.tolerance}`;
      if (o.waveKey !== key) {
        o.waveKey = key;
        o.osc.setPeriodicWave(
          makeImperfectWave(ctx, cfg.type, {
            tolerance: 0.02 + 0.05 * P.character.tolerance,
            pulseWidth: cfg.pulseWidth ?? 0.25,
          })
        );
      }
    });
    this.subGain.gain.setTargetAtTime(P.sub.level, ctx.currentTime, 0.02);
    this.noiseGain.gain.setTargetAtTime(P.noise.level, ctx.currentTime, 0.02);
    this._applyStaticParams();
    /* retune if a note is sounding (osc detune/octave may have changed) */
    if (this.note !== null) this._setPitch(this.note, 0.01);
  }

  _setPitch(midi, glideTime) {
    const ctx = this.synth.ctx;
    const P = this.synth.params;
    const t = ctx.currentTime;
    const tc = Math.max(0.001, glideTime / 3);
    this.oscs.forEach((o) => {
      const f = midiToFreq(midi + (o.cfg.octave || 0) * 12, P.masterTune);
      holdParam(o.osc.frequency, t);
      o.osc.frequency.setTargetAtTime(f, t, tc);
      o.osc.detune.value = (o.cfg.detune || 0) + this.tol.tune;
    });
    const fSub = midiToFreq(midi + (P.oscillators[0]?.octave || 0) * 12 - 12, P.masterTune);
    holdParam(this.subOsc.frequency, t);
    this.subOsc.frequency.setTargetAtTime(fSub, t, tc);
    this.subOsc.detune.value = this.tol.tune * 0.7;
  }

  noteOn(midi, velocity, { legato = false } = {}) {
    const ctx = this.synth.ctx;
    const P = this.synth.params;
    const t = ctx.currentTime;
    const wasHeld = this.gateOn;

    this.note = midi;
    this.gateOn = true;
    this.startedAt = t;

    const glide = P.glide > 0 && (P.mode === 'mono' || wasHeld) ? P.glide : 0.003;
    this._setPitch(midi, glide);

    if (legato && wasHeld) return; // mono-legato: pitch only, envelopes ride on

    const vSens = clamp(P.velocitySensitivity, 0, 1);
    const vAmp = (1 - vSens) + vSens * Math.pow(velocity, 1.4);

    /* ── amp envelope (RC curves: setTargetAtTime ≈ capacitor charging) ── */
    const env = P.envelope;
    const aT = Math.max(0.001, env.attack * this.tol.env);
    const dT = Math.max(0.001, env.decay * this.tol.env);
    const peak = clamp(vAmp * this.tol.level, 0, 1.2);
    const g = this.vca.gain;
    holdParam(g, t);
    g.setTargetAtTime(peak, t, aT / 3);
    g.setTargetAtTime(clamp(env.sustain, 0, 1) * peak, t + aT, dT / 3);

    /* ── filter envelope ── */
    const fe = P.filterEnvelope;
    const keytrack = Math.pow(2, ((midi - 60) / 12) * P.filter.keytrack);
    const base = clamp(P.filter.cutoff * this.tol.cutoff * keytrack, 20, 18000);
    const envAmt = fe.amount * ((1 - vSens) + vSens * velocity);
    const fPeak = clamp(base + envAmt, 20, 18000);
    const fSus = clamp(base + envAmt * clamp(fe.sustain, 0, 1), 20, 18000);
    const faT = Math.max(0.001, fe.attack * this.tol.env);
    const fdT = Math.max(0.001, fe.decay * this.tol.env);
    this.filter.glideCutoff(fPeak, t, faT / 3);
    /* second stage scheduled on each cutoff param directly */
    for (const p of this.filter.cutoffParams) {
      p.setTargetAtTime(fSus, t + faT, Math.max(0.001, fdT / 3));
    }
    this._filterBase = base;
  }

  noteOff() {
    if (!this.gateOn) return;
    const ctx = this.synth.ctx;
    const P = this.synth.params;
    const t = ctx.currentTime;
    this.gateOn = false;

    const rT = Math.max(0.005, P.envelope.release * this.tol.env);
    const g = this.vca.gain;
    holdParam(g, t);
    g.setTargetAtTime(0.0001, t, rT / 3);

    const frT = Math.max(0.005, P.filterEnvelope.release * this.tol.env);
    const back = this._filterBase ?? P.filter.cutoff;
    this.filter.glideCutoff(back, t, frT / 3);

    this.note = null;
  }

  /* called ~12×/s by the synth's drift clock */
  tickDrift(amountCents) {
    const ctx = this.synth.ctx;
    const t = ctx.currentTime;
    const all = [...this.oscs.map((o) => o.osc), this.subOsc];
    all.forEach((osc, i) => {
      const st = this.driftState[i];
      if (Math.random() < 0.25) st.target = rand() * amountCents;
      st.value += (st.target - st.value) * 0.3;
      const base =
        i < this.oscs.length
          ? (this.oscs[i].cfg.detune || 0) + this.tol.tune
          : this.tol.tune * 0.7;
      osc.detune.setTargetAtTime(base + st.value, t, 0.15);
    });
  }

  destroy() {
    const stop = (n) => { try { n.stop(); } catch (e) { /* noop */ } };
    this.oscs.forEach((o) => stop(o.osc));
    stop(this.subOsc);
    stop(this.noiseSrc);
    this.filter.destroy();
    try { this.panner.disconnect(); } catch (e) { /* noop */ }
  }
}

/* ═══════════════════════════ default patch ═══════════════════════════ */

const DEFAULTS = {
  polyphony: 8,
  mode: 'poly',            // 'poly' | 'mono'
  glide: 0,                // seconds (mono glide / legato slew)
  masterTune: 440,
  velocitySensitivity: 0.6,

  oscillators: [
    { type: 'saw', octave: 0, detune: -6, level: 0.5 },
    { type: 'saw', octave: 0, detune: +7, level: 0.5 },
  ],
  sub:   { type: 'sine', level: 0.0 },
  noise: { level: 0.0 },

  filter: {
    cutoff: 1400,          // Hz
    resonance: 0.25,       // 0–1.15 (>1.0 self-oscillates)
    drive: 1.6,            // input gain into the ladder's tanh stage
    keytrack: 0.4,         // 0–1
  },

  envelope:       { attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.35 },
  filterEnvelope: { attack: 0.01, decay: 0.30, sustain: 0.25, release: 0.30, amount: 2200 },

  lfo: { rate: 5.2, pitch: 0, filter: 0, delay: 0.4 }, // pitch in cents, filter in Hz

  character: {
    drift: 0.5,            // 0–1 · slow VCO/VCF thermal wander
    tolerance: 0.6,        // 0–1 · voice-to-voice component spread
    noiseFloor: 0.35,      // 0–1 · circuit hiss
    hum: 0.15,             // 0–1 · mains hum level
    humFreq: 50,           // 50 or 60
  },

  fx: {
    drive: 0.25,           // 0–1 · output soft-clip amount
    chorus: { mix: 0.0, rate: 0.55, depth: 0.5 },
    reverb: { mix: 0.0, size: 2.2, tone: 0.4 },
  },

  master: 0.8,
};

/* ═══════════════════════════════ presets ═══════════════════════════════ */

export const PRESETS = {
  'init': {},

  'warm-pad': {
    oscillators: [
      { type: 'saw', octave: 0, detune: -9, level: 0.42 },
      { type: 'saw', octave: 0, detune: +8, level: 0.42 },
      { type: 'triangle', octave: -1, detune: 2, level: 0.35 },
    ],
    filter: { cutoff: 900, resonance: 0.18, drive: 1.8, keytrack: 0.3 },
    envelope: { attack: 0.9, decay: 1.2, sustain: 0.8, release: 1.8 },
    filterEnvelope: { attack: 1.4, decay: 1.6, sustain: 0.5, release: 1.6, amount: 1100 },
    lfo: { rate: 4.6, pitch: 3, filter: 60, delay: 1.2 },
    character: { drift: 0.7, tolerance: 0.8, noiseFloor: 0.45, hum: 0.2 },
    fx: { drive: 0.18, chorus: { mix: 0.55, rate: 0.5, depth: 0.6 }, reverb: { mix: 0.3, size: 3.2, tone: 0.35 } },
  },

  'fat-bass': {
    mode: 'mono', glide: 0.05,
    oscillators: [
      { type: 'saw', octave: 0, detune: -4, level: 0.55 },
      { type: 'square', octave: 0, detune: 5, level: 0.4 },
    ],
    sub: { type: 'sine', level: 0.55 },
    filter: { cutoff: 420, resonance: 0.35, drive: 3.2, keytrack: 0.5 },
    envelope: { attack: 0.004, decay: 0.3, sustain: 0.55, release: 0.12 },
    filterEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.15, release: 0.1, amount: 2600 },
    character: { drift: 0.4, tolerance: 0.5, noiseFloor: 0.25, hum: 0.1 },
    fx: { drive: 0.45, chorus: { mix: 0 }, reverb: { mix: 0 } },
  },

  'screaming-lead': {
    mode: 'mono', glide: 0.08,
    oscillators: [
      { type: 'saw', octave: 0, detune: -3, level: 0.55 },
      { type: 'saw', octave: 1, detune: 4, level: 0.35 },
    ],
    filter: { cutoff: 2400, resonance: 0.55, drive: 4.0, keytrack: 0.6 },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.85, release: 0.2 },
    filterEnvelope: { attack: 0.01, decay: 0.35, sustain: 0.4, release: 0.2, amount: 3200 },
    lfo: { rate: 5.6, pitch: 7, filter: 0, delay: 0.5 },
    character: { drift: 0.6, tolerance: 0.6, noiseFloor: 0.3, hum: 0.15 },
    fx: { drive: 0.55, chorus: { mix: 0.2, rate: 0.7, depth: 0.4 }, reverb: { mix: 0.18, size: 1.8, tone: 0.5 } },
  },

  'string-machine': {
    oscillators: [
      { type: 'saw', octave: 0, detune: -11, level: 0.4 },
      { type: 'saw', octave: 0, detune: 10, level: 0.4 },
      { type: 'saw', octave: 1, detune: -5, level: 0.22 },
    ],
    filter: { cutoff: 2600, resonance: 0.08, drive: 1.3, keytrack: 0.4 },
    envelope: { attack: 0.35, decay: 0.5, sustain: 0.85, release: 0.9 },
    filterEnvelope: { attack: 0.4, decay: 0.5, sustain: 0.6, release: 0.8, amount: 500 },
    character: { drift: 0.8, tolerance: 0.9, noiseFloor: 0.5, hum: 0.25 },
    fx: { drive: 0.12, chorus: { mix: 0.85, rate: 0.65, depth: 0.8 }, reverb: { mix: 0.25, size: 2.6, tone: 0.4 } },
  },

  'ep-keys': {
    oscillators: [
      { type: 'sine', octave: 0, detune: -2, level: 0.6 },
      { type: 'triangle', octave: 1, detune: 3, level: 0.18 },
    ],
    sub: { type: 'sine', level: 0.2 },
    filter: { cutoff: 1900, resonance: 0.12, drive: 2.2, keytrack: 0.7 },
    envelope: { attack: 0.003, decay: 1.6, sustain: 0.25, release: 0.5 },
    filterEnvelope: { attack: 0.002, decay: 0.7, sustain: 0.1, release: 0.4, amount: 1500 },
    velocitySensitivity: 0.85,
    character: { drift: 0.35, tolerance: 0.5, noiseFloor: 0.3, hum: 0.2 },
    fx: { drive: 0.3, chorus: { mix: 0.4, rate: 0.8, depth: 0.5 }, reverb: { mix: 0.22, size: 2.0, tone: 0.45 } },
  },

  'acid-303': {
    mode: 'mono', glide: 0.06,
    oscillators: [{ type: 'square', octave: 0, detune: 0, level: 0.7 }],
    filter: { cutoff: 320, resonance: 0.92, drive: 2.6, keytrack: 0.4 },
    envelope: { attack: 0.003, decay: 0.18, sustain: 0.0, release: 0.08 },
    filterEnvelope: { attack: 0.003, decay: 0.22, sustain: 0.0, release: 0.1, amount: 3400 },
    character: { drift: 0.45, tolerance: 0.4, noiseFloor: 0.2, hum: 0.1 },
    fx: { drive: 0.5, chorus: { mix: 0 }, reverb: { mix: 0.1, size: 1.2, tone: 0.5 } },
  },

  'poly-brass': {
    oscillators: [
      { type: 'saw', octave: 0, detune: -7, level: 0.5 },
      { type: 'saw', octave: 0, detune: 6, level: 0.5 },
    ],
    filter: { cutoff: 700, resonance: 0.3, drive: 2.4, keytrack: 0.5 },
    envelope: { attack: 0.06, decay: 0.25, sustain: 0.85, release: 0.25 },
    filterEnvelope: { attack: 0.09, decay: 0.4, sustain: 0.45, release: 0.25, amount: 2800 },
    lfo: { rate: 5, pitch: 4, filter: 0, delay: 0.8 },
    character: { drift: 0.6, tolerance: 0.7, noiseFloor: 0.35, hum: 0.2 },
    fx: { drive: 0.35, chorus: { mix: 0.25, rate: 0.6, depth: 0.4 }, reverb: { mix: 0.15, size: 1.8, tone: 0.5 } },
  },

  'haunted-organ': {
    oscillators: [
      { type: 'pulse', pulseWidth: 0.18, octave: 0, detune: -5, level: 0.4 },
      { type: 'pulse', pulseWidth: 0.32, octave: 0, detune: 6, level: 0.4 },
      { type: 'sine', octave: 1, detune: 0, level: 0.2 },
    ],
    sub: { type: 'sine', level: 0.3 },
    filter: { cutoff: 1500, resonance: 0.2, drive: 1.8, keytrack: 0.3 },
    envelope: { attack: 0.05, decay: 0.1, sustain: 1.0, release: 0.4 },
    filterEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.4, amount: 300 },
    lfo: { rate: 6.2, pitch: 5, filter: 90, delay: 0 },
    character: { drift: 0.9, tolerance: 0.9, noiseFloor: 0.6, hum: 0.4 },
    fx: { drive: 0.2, chorus: { mix: 0.5, rate: 0.4, depth: 0.7 }, reverb: { mix: 0.45, size: 3.6, tone: 0.3 } },
  },

  'self-oscillating-whistle': {
    mode: 'mono', glide: 0.15,
    oscillators: [{ type: 'saw', octave: 0, detune: 0, level: 0.0 }],
    filter: { cutoff: 800, resonance: 1.08, drive: 1.2, keytrack: 1.0 },
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.8, release: 0.6 },
    filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 1.0, release: 0.6, amount: 0 },
    character: { drift: 0.8, tolerance: 0.5, noiseFloor: 0.4, hum: 0.1 },
    fx: { drive: 0.1, chorus: { mix: 0.3, rate: 0.5, depth: 0.5 }, reverb: { mix: 0.4, size: 3.0, tone: 0.35 } },
  },
};

/* ═══════════════════════════ PatinaSynth ═══════════════════════════ */

export class PatinaSynth {
  /**
   * @param {AudioContext|object} [contextOrOptions]  Pass an existing
   *        AudioContext, an options object, or nothing.
   * @param {object} [options]  Partial patch (same shape as DEFAULTS).
   */
  constructor(contextOrOptions, options) {
    let ctx = null;
    let opts = {};
    if (contextOrOptions && typeof contextOrOptions.createGain === 'function') {
      ctx = contextOrOptions;
      opts = options || {};
    } else {
      opts = contextOrOptions || {};
    }
    this.ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    this.params = deepMerge(deepClone(DEFAULTS), opts);
    this.workletReady = false;
    this.voices = [];
    this._noteMap = new Map();   // midi → voice (poly)
    this._monoStack = [];        // held notes (mono)
    this._destination = this.ctx.destination;
    this._destroyed = false;

    this.pinkBuffer = makePinkNoiseBuffer(this.ctx);

    this.ready = this._init();
  }

  async _init() {
    const ctx = this.ctx;

    /* try to load the ladder worklet; fall back gracefully */
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(getWorkletUrl());
        this.workletReady = true;
      } catch (e) {
        console.warn('Patina: AudioWorklet unavailable, using biquad fallback.', e);
      }
    }

    this._buildSharedNodes();
    this._buildVoices();
    this._applyAll();

    /* drift clock: nudges every oscillator's tuning ~12×/s */
    this._driftTimer = setInterval(() => this._tickDrift(), 85);
    return this;
  }

  /* ── shared modulation + output chain ── */
  _buildSharedNodes() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    /* pitch bend: a ConstantSource in cents feeding every osc.detune */
    this.bendCents = ctx.createConstantSource();
    this.bendCents.offset.value = 0;
    this.bendCents.start(now);

    /* global LFO (triangle — like most vintage panel LFOs) */
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'triangle';
    this.lfo.frequency.value = this.params.lfo.rate;
    this.lfoPitchGain = ctx.createGain();  // → osc.detune (cents)
    this.lfoFilterGain = ctx.createGain(); // → cutoffs (Hz)
    this.lfoPitchGain.gain.value = 0;
    this.lfoFilterGain.gain.value = 0;
    this.lfo.connect(this.lfoPitchGain);
    this.lfo.connect(this.lfoFilterGain);
    this.lfo.start(now);

    /* voice summing bus */
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.9;

    /* drive stage */
    this.drivePre = ctx.createGain();
    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.oversample = '4x';
    this.drivePost = ctx.createGain();
    this.voiceBus.connect(this.drivePre).connect(this.driveShaper).connect(this.drivePost);

    /* circuit hiss + mains hum, injected before the drive (so they get warmed) */
    this.hissSrc = ctx.createBufferSource();
    this.hissSrc.buffer = this.pinkBuffer;
    this.hissSrc.loop = true;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissSrc.connect(this.hissGain).connect(this.drivePre);
    this.hissSrc.start(now);

    this.humOsc = ctx.createOscillator();
    this.humOsc.type = 'sine';
    this.humOsc2 = ctx.createOscillator(); // 2nd harmonic — real hum is never pure
    this.humOsc2.type = 'sine';
    this.humGain = ctx.createGain();
    this.humGain2 = ctx.createGain();
    this.humGain.gain.value = 0;
    this.humGain2.gain.value = 0;
    this.humOsc.connect(this.humGain).connect(this.drivePre);
    this.humOsc2.connect(this.humGain2).connect(this.drivePre);
    this.humOsc.start(now);
    this.humOsc2.start(now);

    /* BBD-style stereo chorus */
    this.chorusIn = ctx.createGain();
    this.chorusDry = ctx.createGain();
    this.chorusWet = ctx.createGain();
    this.chorusOut = ctx.createGain();
    const dl = ctx.createDelay(0.06);
    const dr = ctx.createDelay(0.06);
    dl.delayTime.value = 0.013;
    dr.delayTime.value = 0.019;
    this.chorusLfoL = ctx.createOscillator();
    this.chorusLfoR = ctx.createOscillator();
    this.chorusLfoL.type = 'sine';
    this.chorusLfoR.type = 'sine';
    this.chorusDepthL = ctx.createGain();
    this.chorusDepthR = ctx.createGain();
    this.chorusLfoL.connect(this.chorusDepthL).connect(dl.delayTime);
    this.chorusLfoR.connect(this.chorusDepthR).connect(dr.delayTime);
    this.chorusLfoL.start(now);
    this.chorusLfoR.start(now);
    const merger = ctx.createChannelMerger(2);
    this.chorusIn.connect(this.chorusDry).connect(this.chorusOut);
    this.chorusIn.connect(dl).connect(merger, 0, 0);
    this.chorusIn.connect(dr).connect(merger, 0, 1);
    merger.connect(this.chorusWet).connect(this.chorusOut);
    this.drivePost.connect(this.chorusIn);

    /* reverb */
    this.reverbConvolver = ctx.createConvolver();
    this.reverbWet = ctx.createGain();
    this.reverbDry = ctx.createGain();
    this.reverbOut = ctx.createGain();
    this.chorusOut.connect(this.reverbDry).connect(this.reverbOut);
    this.chorusOut.connect(this.reverbConvolver).connect(this.reverbWet).connect(this.reverbOut);

    /* master + gentle glue compression */
    this.masterGain = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.18;
    this.output = ctx.createGain();
    this.reverbOut.connect(this.masterGain).connect(this.comp).connect(this.output);
    this.output.connect(this._destination);
  }

  _buildVoices() {
    const n = this.params.mode === 'mono' ? 1 : clamp(this.params.polyphony, 1, 16);
    this.voices.forEach((v) => v.destroy());
    this.voices = [];
    this._noteMap.clear();
    for (let i = 0; i < n; i++) {
      const v = new Voice(this, i);
      /* LFO → cutoff for each voice */
      for (const p of v.filter.cutoffParams) this.lfoFilterGain.connect(p);
      this.voices.push(v);
    }
  }

  /* push every current param into the graph */
  _applyAll() {
    const P = this.params;
    const t = this.ctx.currentTime;

    this.lfo.frequency.setTargetAtTime(P.lfo.rate, t, 0.05);
    this.lfoFilterGain.gain.setTargetAtTime(P.lfo.filter, t, 0.05);
    /* pitch LFO fades in over lfo.delay — like a delayed-vibrato trimmer */
    this.lfoPitchGain.gain.setTargetAtTime(P.lfo.pitch, t, Math.max(0.01, P.lfo.delay / 3));

    /* character */
    const C = P.character;
    this.hissGain.gain.setTargetAtTime(0.0035 * C.noiseFloor, t, 0.1);
    this.humOsc.frequency.setTargetAtTime(C.humFreq, t, 0.05);
    this.humOsc2.frequency.setTargetAtTime(C.humFreq * 2, t, 0.05);
    this.humGain.gain.setTargetAtTime(0.0011 * C.hum, t, 0.1);
    this.humGain2.gain.setTargetAtTime(0.0004 * C.hum, t, 0.1);

    /* drive */
    const dAmt = clamp(P.fx.drive, 0, 1);
    this.driveShaper.curve = makeDriveCurve(0.6 + dAmt * 7);
    this.drivePre.gain.setTargetAtTime(1 + dAmt * 2.5, t, 0.05);
    this.drivePost.gain.setTargetAtTime(1 / (1 + dAmt * 1.6), t, 0.05);

    /* chorus */
    const ch = P.fx.chorus;
    const mix = clamp(ch.mix, 0, 1);
    this.chorusWet.gain.setTargetAtTime(mix * 0.85, t, 0.05);
    this.chorusDry.gain.setTargetAtTime(1 - mix * 0.4, t, 0.05);
    this.chorusLfoL.frequency.setTargetAtTime(ch.rate, t, 0.05);
    this.chorusLfoR.frequency.setTargetAtTime(ch.rate * 1.27, t, 0.05);
    const depth = clamp(ch.depth, 0, 1) * 0.0035;
    this.chorusDepthL.gain.setTargetAtTime(depth, t, 0.05);
    this.chorusDepthR.gain.setTargetAtTime(depth * 0.9, t, 0.05);

    /* reverb */
    const rv = P.fx.reverb;
    const rmix = clamp(rv.mix, 0, 1);
    if (
      !this._irKey ||
      this._irKey !== `${rv.size}|${rv.tone}`
    ) {
      this.reverbConvolver.buffer = makeReverbImpulse(this.ctx, rv.size, rv.tone);
      this._irKey = `${rv.size}|${rv.tone}`;
    }
    this.reverbWet.gain.setTargetAtTime(rmix * 0.8, t, 0.05);
    this.reverbDry.gain.setTargetAtTime(1 - rmix * 0.3, t, 0.05);

    this.masterGain.gain.setTargetAtTime(clamp(P.master, 0, 1.5), t, 0.05);

    this.voices.forEach((v) => v.refresh());
  }

  _tickDrift() {
    if (this._destroyed) return;
    const cents = this.params.character.drift * 3.5; // up to ±3.5 cents wander
    if (cents <= 0) return;
    this.voices.forEach((v) => v.tickDrift(cents));
  }

  /* ─────────────────────────── public API ─────────────────────────── */

  /** Play a note. `note`: MIDI number or name ('C4'). `velocity`: 0–1. */
  noteOn(note, velocity = 0.8) {
    if (this._destroyed || this.voices.length === 0) return this;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const midi = toMidi(note);
    const vel = clamp(velocity, 0, 1);

    if (this.params.mode === 'mono') {
      this._monoStack = this._monoStack.filter((m) => m !== midi);
      const legato = this._monoStack.length > 0;
      this._monoStack.push(midi);
      this.voices[0].noteOn(midi, vel, { legato });
      return this;
    }

    /* poly: retrigger same note, else free voice, else steal oldest */
    let voice = this._noteMap.get(midi);
    if (!voice) voice = this.voices.find((v) => !v.gateOn);
    if (!voice) {
      voice = this.voices.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
      if (voice.note !== null) this._noteMap.delete(voice.note);
    }
    voice.noteOn(midi, vel);
    this._noteMap.set(midi, voice);
    return this;
  }

  /** Release a note. */
  noteOff(note) {
    if (this._destroyed) return this;
    const midi = toMidi(note);

    if (this.params.mode === 'mono') {
      this._monoStack = this._monoStack.filter((m) => m !== midi);
      if (this._monoStack.length > 0) {
        const last = this._monoStack[this._monoStack.length - 1];
        this.voices[0].noteOn(last, 0.8, { legato: true });
      } else {
        this.voices[0].noteOff();
      }
      return this;
    }

    const voice = this._noteMap.get(midi);
    if (voice) {
      voice.noteOff();
      this._noteMap.delete(midi);
    }
    return this;
  }

  /** Release everything (respects release envelopes). */
  allNotesOff() {
    this.voices.forEach((v) => v.noteOff());
    this._noteMap.clear();
    this._monoStack = [];
    return this;
  }

  /** Hard kill: instant silence. */
  panic() {
    const t = this.ctx.currentTime;
    this.voices.forEach((v) => {
      v.gateOn = false;
      v.note = null;
      holdParam(v.vca.gain, t);
      v.vca.gain.setTargetAtTime(0, t, 0.005);
    });
    this._noteMap.clear();
    this._monoStack = [];
    return this;
  }

  /**
   * Update any subset of parameters, e.g.
   *   synth.set({ filter: { cutoff: 600 }, fx: { chorus: { mix: 0.5 } } })
   * Changing `polyphony`, `mode` or the *number* of oscillators rebuilds
   * the voice pool (brief gap in sound); everything else is seamless.
   */
  set(partial) {
    const before = {
      n: this.params.oscillators.length,
      poly: this.params.polyphony,
      mode: this.params.mode,
    };
    deepMerge(this.params, partial);
    if (!this.voiceBus) return this; // pre-init: _init() will apply everything
    const after = {
      n: this.params.oscillators.length,
      poly: this.params.polyphony,
      mode: this.params.mode,
    };
    if (before.n !== after.n || before.poly !== after.poly || before.mode !== after.mode) {
      this._buildVoices();
    }
    this._applyAll();
    return this;
  }

  /** Replace the whole patch with a preset (plus optional overrides). */
  loadPreset(name, overrides = {}) {
    if (!(name in PRESETS)) {
      throw new Error(`Patina: unknown preset "${name}". Available: ${Object.keys(PRESETS).join(', ')}`);
    }
    this.allNotesOff();
    this.params = deepMerge(deepClone(DEFAULTS), deepClone(PRESETS[name]));
    deepMerge(this.params, overrides);
    if (!this.voiceBus) return this; // pre-init: _init() will build with these params
    this._buildVoices();
    this._applyAll();
    return this;
  }

  /** Current patch as a plain object (savable as JSON; reload via set / constructor). */
  getParams() {
    return deepClone(this.params);
  }

  /** Pitch bend in semitones (e.g. ±2). Slews like a real bend lever. */
  pitchBend(semitones) {
    this.bendCents.offset.setTargetAtTime(semitones * 100, this.ctx.currentTime, 0.02);
    return this;
  }

  /** Mod wheel 0–1 → vibrato depth (scales lfo.pitch up to +25 cents). */
  modWheel(value) {
    const v = clamp(value, 0, 1);
    const base = this.params.lfo.pitch;
    this.lfoPitchGain.gain.setTargetAtTime(base + v * 25, this.ctx.currentTime, 0.03);
    return this;
  }

  /** Route audio somewhere other than ctx.destination. */
  connect(node) {
    this.output.disconnect();
    this.output.connect(node);
    this._destination = node;
    return this;
  }

  disconnect() {
    this.output.disconnect();
    return this;
  }

  /** Resume a suspended AudioContext (call from a user gesture). */
  resume() {
    return this.ctx.resume();
  }

  /** Tear down all nodes and timers. The synth is unusable afterwards. */
  destroy() {
    this._destroyed = true;
    clearInterval(this._driftTimer);
    this.allNotesOff();
    this.voices.forEach((v) => v.destroy());
    const stop = (n) => { try { n.stop(); } catch (e) { /* noop */ } };
    [this.lfo, this.bendCents, this.hissSrc, this.humOsc, this.humOsc2,
     this.chorusLfoL, this.chorusLfoR].forEach(stop);
    try { this.output.disconnect(); } catch (e) { /* noop */ }
  }
}

/* convenience for non-module <script type="module"> consumers */
if (typeof window !== 'undefined') {
  window.Patina = { PatinaSynth, PRESETS, toMidi, midiToFreq };
}

export default PatinaSynth;
