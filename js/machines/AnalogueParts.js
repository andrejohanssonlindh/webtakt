/**
 * AnalogueParts.js
 * ----------------
 * Shared analogue-modelling building blocks, extracted from MoogishMachine /
 * PATINA (js/patina/patina.js — the side project this engine was prototyped in).
 *
 * These are the techniques that make a Web Audio voice sound "analogue" rather
 * than textbook-digital, factored out so every analogue machine (Moogish and the
 * analogue drums) imports them instead of carrying private copies:
 *
 *   - makeImperfectWave : oscillator spectra with component tolerance, even-
 *     harmonic leakage, phase smear and gentle HF slew-limiting. A fresh,
 *     slightly-different PeriodicWave per call — no two oscillators identical.
 *   - makePinkBuffer    : Paul-Kellet pink noise (circuit hiss / drum noise
 *     colour; white noise sounds digital, real drum machines are pinkish).
 *   - DriftClock        : bounded random-walk thermal pitch drift on a set of
 *     oscillator detune params (the wander that makes analogue toms feel alive).
 *   - rand / clamp      : the small helpers these share.
 *
 * Nothing here owns audio routing or params — callers wire the returned nodes
 * into their own graph and decide which params to drift. Keeping this layer
 * graph-agnostic is what lets both the Moogish oscillator voice and the kick
 * reuse it without inheriting each other's structure.
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rand  = (lo = -1, hi = 1) => lo + Math.random() * (hi - lo);

/**
 * Imperfect oscillator spectrum (ported from Patina makeImperfectWave).
 * Bakes component tolerance, even-harmonic leakage, phase smear and gentle
 * HF slew-limiting into a PeriodicWave — a fresh, slightly different one per call.
 *
 * @param {BaseAudioContext} ctx
 * @param {'saw'|'square'|'triangle'|'pulse'|'sine'} type
 * @param {{tolerance?:number, pulseWidth?:number}} [opts]
 * @returns {PeriodicWave}
 */
export function makeImperfectWave(ctx, type, { tolerance = 0.03, pulseWidth = 0.25 } = {}) {
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

/**
 * Paul Kellet pink noise buffer (ported from Patina makePinkNoiseBuffer).
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @returns {AudioBuffer}
 */
export function makePinkBuffer(ctx, seconds) {
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

/**
 * Thermal-drift clock: a bounded random walk that nudges a set of oscillator
 * `detune` AudioParams ~12×/s, the slow wander of a warm analogue circuit.
 *
 * The caller owns the oscillators and the per-osc *base* detune (tuning offsets,
 * component tolerance, etc.); DriftClock only adds a small wandering delta on
 * top. Each tick the caller supplies, per oscillator, that base value via the
 * `baseFor(i)` callback — DriftClock writes `base + wander` to the param.
 *
 * Usage:
 *   this._drift = new DriftClock(ctx, oscs.map(o => o.detune), {
 *     baseFor: i => this._baseDetune(i),
 *     amountFor: () => this._params['drift'] * 3.5,   // max ±cents
 *   });
 *   // ... in disconnect(): this._drift.stop();
 */
export class DriftClock {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioParam[]} detuneParams  — one detune AudioParam per oscillator
   * @param {{baseFor:(i:number)=>number, amountFor:()=>number,
   *          intervalMs?:number, tc?:number}} opts
   */
  constructor(ctx, detuneParams, { baseFor, amountFor, intervalMs = 85, tc = 0.15 }) {
    this.ctx     = ctx;
    this.params  = detuneParams;
    this.baseFor = baseFor;
    this.amountFor = amountFor;
    this.tc      = tc;
    this._state  = detuneParams.map(() => ({ value: 0, target: 0 }));
    this._timer  = setInterval(() => this._tick(), intervalMs);
  }

  _tick() {
    const cents = this.amountFor();
    if (cents <= 0) return;
    const t = this.ctx.currentTime;
    this.params.forEach((param, i) => {
      const st = this._state[i];
      if (Math.random() < 0.25) st.target = rand() * cents;
      st.value += (st.target - st.value) * 0.3;
      param.setTargetAtTime(this.baseFor(i) + st.value, t, this.tc);
    });
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}
