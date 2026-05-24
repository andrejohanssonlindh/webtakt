/**
 * runner.js
 * ---------
 * Test harness for Webtakt audio tests.
 *
 * Provides:
 *   makeOfflineTrack(machineType, durationSec)
 *     — spins up a full Track + minimal AudioEngine/Clock shim against an
 *       OfflineAudioContext. Returns { track, ctx, render }.
 *
 *   fireStep(track, ctx, opts)
 *     — directly calls sequencer._fireStep with a hand-built Step at a
 *       given scheduled time. Returns the time at which the note ends.
 *
 *   renderAndSlice(track, ctx, steps, stepSec)
 *     — fires N steps spaced stepSec apart, renders the offline context,
 *       returns an array of Float32Array windows (one per step).
 *
 *   rms(buffer)          — root mean square of a Float32Array
 *   spectralCentroid(buf, sampleRate)
 *   bandEnergy(buf, sampleRate, loHz, hiHz)
 *
 *   suite(name, fn)      — declare a named test suite
 *   test(name, fn)       — declare a test inside a suite; fn receives assert helpers
 *   assert.gt(a, b, msg) / assert.lt / assert.near / assert.ok
 *
 *   runAll()             — run all registered suites, write results to localStorage,
 *                          and render them in #results
 */

// ─── Result store ──────────────────────────────────────────────────────────────

const _suites   = [];
let   _current  = null;

export function suite(name, fn) {
  const s = { name, tests: [] };
  _suites.push(s);
  _current = s;
  fn();
  _current = null;
}

export function test(name, fn) {
  if (!_current) throw new Error('test() called outside suite()');
  _current.tests.push({ name, fn });
}

// ─── Assertions ────────────────────────────────────────────────────────────────

function fail(msg) { throw new Error(msg); }

export const assert = {
  ok(val, msg)           { if (!val) fail(msg ?? `expected truthy, got ${val}`); },
  gt(a, b, msg)          { if (!(a > b))  fail(msg ?? `expected ${a} > ${b}`);  },
  lt(a, b, msg)          { if (!(a < b))  fail(msg ?? `expected ${a} < ${b}`);  },
  near(a, b, tol, msg)   { if (Math.abs(a - b) > tol) fail(msg ?? `expected ${a} ≈ ${b} ±${tol}`); },
  notNear(a, b, tol, msg){ if (Math.abs(a - b) <= tol) fail(msg ?? `expected ${a} and ${b} to differ by > ${tol}`); },
};

// ─── Audio math ────────────────────────────────────────────────────────────────

export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function spectralCentroid(buf, sampleRate) {
  const n    = buf.length;
  const re   = new Float32Array(n);
  const im   = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = buf[i];
  _fft(re, im, n);

  let weightedSum = 0, totalMag = 0;
  const half = Math.floor(n / 2);
  for (let k = 0; k < half; k++) {
    const mag  = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const freq = k * sampleRate / n;
    weightedSum += freq * mag;
    totalMag    += mag;
  }
  return totalMag > 0 ? weightedSum / totalMag : 0;
}

export function bandEnergy(buf, sampleRate, loHz, hiHz) {
  const n    = buf.length;
  const re   = new Float32Array(n);
  const im   = new Float32Array(n);
  // Normalise before FFT to prevent overflow on high-amplitude resonators
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const scale = peak > 0 ? 1 / peak : 1;
  for (let i = 0; i < n; i++) re[i] = buf[i] * scale;
  _fft(re, im, n);

  let energy = 0;
  const half = Math.floor(n / 2);
  for (let k = 0; k < half; k++) {
    const freq = k * sampleRate / n;
    if (freq >= loHz && freq <= hiHz) {
      energy += re[k] * re[k] + im[k] * im[k];
    }
  }
  return energy;
}

/**
 * RMS of the signal after a time-domain bandpass filter (two-pole Butterworth).
 * Use this for pitch-presence tests — it does not scale with cycle count,
 * only with amplitude in the band.
 * @param {Float32Array} buf
 * @param {number} sampleRate
 * @param {number} centerHz  — centre frequency of the bandpass
 * @param {number} bwOctaves — bandwidth in octaves (default 1)
 */
export function bandpassRms(buf, sampleRate, centerHz, bwOctaves = 1) {
  const w0    = 2 * Math.PI * centerHz / sampleRate;
  const bw    = 2 * Math.PI * centerHz * (Math.pow(2, bwOctaves) - 1) / (Math.pow(2, bwOctaves / 2)) / sampleRate;
  const alpha = Math.sin(w0) * Math.sinh(Math.log(2) / 2 * bw * w0 / Math.sin(w0));

  const b0 =  alpha,  b1 = 0,  b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;

  const B0 = b0/a0, B1 = b1/a0, B2 = b2/a0;
  const A1 = a1/a0, A2 = a2/a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const x0 = buf[i];
    const y0 = B0*x0 + B1*x1 + B2*x2 - A1*y1 - A2*y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    sum += y0 * y0;
  }
  return Math.sqrt(sum / buf.length);
}

// Cooley-Tukey FFT — works on power-of-2 lengths; pads if needed.
function _fft(re, im, n) {
  // Bit-reversal
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let uRe = 1, uIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const tRe = uRe * re[i+k+len/2] - uIm * im[i+k+len/2];
        const tIm = uRe * im[i+k+len/2] + uIm * re[i+k+len/2];
        re[i+k+len/2] = re[i+k] - tRe;
        im[i+k+len/2] = im[i+k] - tIm;
        re[i+k] += tRe;
        im[i+k] += tIm;
        const nuRe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nuRe;
      }
    }
  }
}

// ─── Track / AudioEngine shims ─────────────────────────────────────────────────

/**
 * Minimal AudioEngine-shape object wrapping an OfflineAudioContext.
 * Track.js accesses audio.context and audio.fxBus.
 */
function makeAudioShim(offlineCtx) {
  const fxBus = offlineCtx.createGain();
  fxBus.gain.value = 1.0;
  fxBus.connect(offlineCtx.destination);
  return { context: offlineCtx, fxBus };
}

/**
 * Minimal Clock-shape object.
 * Sequencer accesses clock.register/unregister, clock._secondsPerTick, clock.bpm.
 * We never start the clock — tests call _fireStep directly.
 */
function makeClockShim(bpm = 120) {
  return {
    bpm,
    ticksPerBeat: 4,
    get _secondsPerTick() { return 60 / (this.bpm * this.ticksPerBeat); },
    register()   {},
    unregister() {},
    audio: null,  // set to audioShim after construction in makeOfflineTrack
  };
}

/**
 * Build a full Track against an OfflineAudioContext.
 * Returns { track, ctx, clock, audioShim }.
 *
 * @param {string}  machineType  — e.g. 'synth', 'kick.silk', 'fm'
 * @param {number}  durationSec  — length of the offline context
 * @param {object}  [opts]
 * @param {number}  [opts.bpm]   — default 120
 * @param {number}  [opts.channels] — default 1
 * @param {number}  [opts.sampleRate] — default 44100
 */
export async function makeOfflineTrack(machineType, durationSec, opts = {}) {
  const sampleRate = opts.sampleRate ?? 44100;
  const channels   = opts.channels  ?? 1;
  const bpm        = opts.bpm       ?? 120;

  const ctx        = new OfflineAudioContext(channels, Math.ceil(sampleRate * durationSec), sampleRate);
  const audioShim  = makeAudioShim(ctx);
  const clock      = makeClockShim(bpm);
  clock.audio      = audioShim;  // Sequencer._fireStep reads clock.audio.context.currentTime

  // Dynamic import so the test file can be served as a plain module
  const { Track } = await import('../js/state/Track.js');
  const track = new Track(0, audioShim, clock);
  track.setMachine(machineType);

  // LFOs are already started by Track.addLFO(); call start() only if somehow not running
  track.lfos.forEach(lfo => { if (!lfo._running) lfo.start(); });

  return { track, ctx, clock, audioShim, sampleRate };
}

// ─── Step builder ──────────────────────────────────────────────────────────────

import { Step } from '../js/sequencer/Step.js';

/**
 * Build a Step object ready for _fireStep.
 * @param {object} opts
 * @param {number}  [opts.note=60]
 * @param {number}  [opts.velocity=100]
 * @param {number}  [opts.length=2]   — in ticks
 * @param {Map}     [opts.plocks]     — Map of path→value
 */
export function makeStep(opts = {}) {
  const s        = new Step(0);
  s.active       = true;
  s.note         = opts.note     ?? 60;
  s.velocity     = opts.velocity ?? 100;
  s.length       = opts.length   ?? 2;
  if (opts.plocks) {
    for (const [k, v] of opts.plocks) s.plocks.set(k, v);
  }
  return s;
}

/**
 * Fire one step directly via sequencer._fireStep.
 * @param {object} track
 * @param {number} scheduledTime — AudioContext time
 * @param {object} [stepOpts]    — passed to makeStep
 */
export function fireStep(track, scheduledTime, stepOpts = {}) {
  const step = makeStep(stepOpts);
  track.sequencer._fireStep(step, scheduledTime);
}

// ─── Render helpers ────────────────────────────────────────────────────────────

const SR = 44100;

/**
 * Fire N evenly-spaced steps then render the offline context.
 * Returns an array of Float32Array windows — one per step, length = stepSec * sampleRate.
 *
 * @param {object}  track
 * @param {OfflineAudioContext} ctx
 * @param {number}  sampleRate
 * @param {number}  stepCount
 * @param {number}  stepSec        — seconds between steps
 * @param {function} [stepBuilder] — (stepIndex) => stepOpts; default: all note=60
 * @param {number}  [startTime=0.05]
 */
export async function renderSteps(track, ctx, sampleRate, stepCount, stepSec, stepBuilder, startTime = 0.05) {
  const times = [];
  for (let i = 0; i < stepCount; i++) {
    const t    = startTime + i * stepSec;
    const opts = stepBuilder ? stepBuilder(i) : {};
    fireStep(track, t, opts);
    times.push(t);
  }

  const rendered = await ctx.startRendering();
  const full     = rendered.getChannelData(0);

  return times.map(t => {
    const start = Math.floor(t * sampleRate);
    const end   = Math.min(full.length, start + Math.floor(stepSec * sampleRate));
    return full.slice(start, end);
  });
}

// ─── Runner ────────────────────────────────────────────────────────────────────

export async function runAll() {
  const results = { timestamp: new Date().toISOString(), suites: [] };

  for (const s of _suites) {
    const suiteResult = { name: s.name, tests: [] };
    for (const t of s.tests) {
      const start = performance.now();
      let status = 'pass', error = null;
      try {
        await t.fn();
      } catch (e) {
        status = 'fail';
        error  = e.message;
      }
      suiteResult.tests.push({
        name:   t.name,
        status,
        error,
        ms: Math.round(performance.now() - start),
      });
    }
    results.suites.push(suiteResult);
  }

  // Share on window so results.html can read it if open in the same tab
  window.__webtaktResults = results;

  // Render to DOM
  _renderResults(results);

  return results;
}

function _renderResults(results) {
  const el = document.getElementById('results');
  if (!el) return;
  el.textContent = '';

  let pass = 0, fail = 0;

  const append = (text, color) => {
    const span = document.createElement('span');
    span.textContent = text + '\n';
    if (color) span.style.color = color;
    el.appendChild(span);
  };

  for (const s of results.suites) {
    append(`\n── ${s.name} ──`, '#aaa');
    for (const t of s.tests) {
      const icon  = t.status === 'pass' ? '✓' : '✗';
      const color = t.status === 'pass' ? '#8f8' : '#f88';
      const text  = `  ${icon} ${t.name}${t.error ? ` — ${t.error}` : ''} (${t.ms}ms)`;
      append(text, color);
      t.status === 'pass' ? pass++ : fail++;
    }
  }

  append(`\n${pass} passed, ${fail} failed — ${results.timestamp}`, fail > 0 ? '#f88' : '#8f8');
}
