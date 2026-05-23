/**
 * FilterViz.js
 * ------------
 * Canvas widget showing the combined frequency response of the track filter.
 * Draws:
 *   - Main filter frequency response (type, cutoff, resonance) — amber line
 *   - Base filter LPF + HPF response (no resonance) — dim white line
 *   - Combined response — bright line
 *   - Amp envelope ghost: a faint ADSR shape projected onto the right side
 *     (shows how the envelope will modulate cutoff over time)
 *
 * Pure-math biquad magnitude response — no AnalyserNode needed.
 * The biquad coefficients are computed analytically per Web Audio spec.
 *
 * Public:
 *   new FilterViz(opts)
 *     opts.getFilter()   — returns Filter instance
 *     opts.getEnvelope() — returns Envelope instance (for env ghost)
 *     opts.showBase      — bool, whether to show base filter curves
 *   .el                 — the root DOM element
 *   .refresh()          — redraw (call after param changes)
 *   .destroy()          — clean up ResizeObserver
 */

const FREQ_MIN  = 20;
const FREQ_MAX  = 20000;
const DB_MIN    = -42;
const DB_MAX    = 30;
const ACCENT    = '#e8a020';
const BASE_COL  = 'rgba(255,255,255,0.25)';
const GRID_COL  = 'rgba(255,255,255,0.04)';
const ENV_COL   = 'rgba(232,160,32,0.18)';
const ENV_LINE  = 'rgba(232,160,32,0.45)';

function _hzToX(hz, w) {
  return (Math.log10(hz / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN)) * w;
}

function _dbToY(db, h, pad) {
  return pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * (h - pad.t - pad.b);
}

/**
 * Compute biquad magnitude response in dB at a given normalised frequency w = f / sampleRate.
 * Coefficients computed per Web Audio spec for each filter type.
 * Returns dB.
 */
function _biquadMag(type, freq_hz, Q, gain_db, sample_rate) {
  const f0 = freq_hz / sample_rate;
  const w0 = 2 * Math.PI * f0;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cosW) / 2; b1 = 1 - cosW; b2 = (1 - cosW) / 2;
      a0 = 1 + alpha;      a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosW) / 2; b1 = -(1 + cosW); b2 = (1 + cosW) / 2;
      a0 = 1 + alpha;       a1 = -2 * cosW;   a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = sinW / 2; b1 = 0; b2 = -sinW / 2;
      a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    default:
      return 0;
  }

  // Normalise
  b0 /= a0; b1 /= a0; b2 /= a0;
  a1 /= a0; a2 /= a0;

  // H(e^jw) magnitude at w = w0 — need to eval at arbitrary freq, not just fc.
  // Use the standard z-transform evaluation approach.
  return null; // placeholder — actual eval below
}

/**
 * Evaluate normalised biquad transfer function magnitude at frequency hz.
 * Returns linear magnitude.
 */
function _evalBiquad(type, cutoff_hz, Q, sample_rate, eval_hz, gain_db = 0) {
  const fc = Math.min(cutoff_hz, sample_rate * 0.4999);
  const w0 = 2 * Math.PI * fc / sample_rate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(Q, 0.001));
  const A = Math.pow(10, gain_db / 40); // sqrt(10^(dB/20))

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cosW) / 2; b1 = 1 - cosW; b2 = (1 - cosW) / 2;
      a0 = 1 + alpha;       a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosW) / 2; b1 = -(1 + cosW); b2 = (1 + cosW) / 2;
      a0 = 1 + alpha;       a1 = -2 * cosW;   a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = sinW / 2; b1 = 0; b2 = -sinW / 2;
      a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cosW; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cosW; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
      break;
    case 'peaking': {
      const alphaS = sinW / (2 * Math.max(Q, 0.001));
      b0 = 1 + alphaS * A; b1 = -2 * cosW; b2 = 1 - alphaS * A;
      a0 = 1 + alphaS / A; a1 = -2 * cosW; a2 = 1 - alphaS / A;
      break;
    }
    default:
      return 1;
  }

  // Evaluate H(z) at z = e^(j*w) where w = 2π * eval_hz / sample_rate
  const w  = 2 * Math.PI * Math.min(eval_hz, sample_rate * 0.4999) / sample_rate;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2w = Math.cos(2 * w), s2w = Math.sin(2 * w);

  // Numerator: b0 + b1*z^-1 + b2*z^-2
  const nr = b0 + b1 * cw + b2 * c2w;
  const ni = -(b1 * sw + b2 * s2w);
  // Denominator: a0 + a1*z^-1 + a2*z^-2  (a0 = 1 after normalisation)
  const dr = a0 + a1 * cw + a2 * c2w;
  const di = -(a1 * sw + a2 * s2w);

  const num = Math.sqrt(nr * nr + ni * ni);
  const den = Math.sqrt(dr * dr + di * di);
  return den < 1e-10 ? 0 : num / den;
}

function _magToDb(lin) {
  return 20 * Math.log10(Math.max(lin, 1e-6));
}

export class FilterViz {
  /**
   * @param {object} opts
   * @param {function} opts.getFilter    — () => Filter instance
   * @param {function} opts.getEnvelope  — () => Envelope instance
   * @param {boolean}  [opts.showBase]   — draw base filter curve (default true)
   * @param {number}   [opts.height]     — canvas CSS height in px (default 120)
   */
  constructor(opts) {
    this._getFilter    = opts.getFilter;
    this._getEnvelope  = opts.getEnvelope;
    this._getParam     = opts.getParam    ?? null;  // (path) => value, overrides filter.getParam
    this._getEnvParam  = opts.getEnvParam ?? null;  // (path) => value, overrides envelope.getParam
    this._showBase     = opts.showBase ?? true;
    this._h            = opts.height ?? 120;
    this._w           = 0;
    this._cleanups    = [];

    this.el = document.createElement('div');
    this.el.className = 'filter-viz-wrap';

    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';
    this._canvas.style.width   = '100%';
    this._canvas.style.height  = this._h + 'px';
    this._ctx = this._canvas.getContext('2d');
    this.el.appendChild(this._canvas);

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this._resize());
      ro.observe(this.el);
      this._cleanups.push(() => ro.disconnect());
    }

    requestAnimationFrame(() => this._resize());
  }

  _resize() {
    const w = this.el.clientWidth || 300;
    this._w = w;
    this._canvas.width  = w * 2;
    this._canvas.height = this._h * 2;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.scale(2, 2);
    this.refresh();
  }

  refresh() {
    if (!this._w) return;
    const filter = this._getFilter?.();
    if (!filter) return;
    this._draw(filter);
  }

  _draw(filter) {
    const ctx  = this._ctx;
    const w    = this._w;
    const h    = this._h;
    const pad  = { l: 32, r: 12, t: 10, b: 22 };
    const cw   = w - pad.l - pad.r;
    const ch   = h - pad.t - pad.b;

    ctx.clearRect(0, 0, w, h);

    // ── Background ───────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.roundRect?.(0, 0, w, h, 3) ?? ctx.rect(0, 0, w, h);
    ctx.fill();

    // ── Grid ─────────────────────────────────────────────────
    const FREQ_MARKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const DB_MARKS   = [DB_MIN, -24, -12, 0, DB_MAX];

    ctx.strokeStyle = GRID_COL;
    ctx.lineWidth   = 1;

    FREQ_MARKS.forEach(f => {
      const x = pad.l + _hzToX(f, cw);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '7px "JetBrains Mono",monospace';
      ctx.textAlign = 'center';
      const lbl = f >= 1000 ? (f / 1000) + 'k' : f;
      ctx.fillText(lbl, x, h - pad.b + 12);
    });

    DB_MARKS.forEach(db => {
      const y = pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * ch;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = db === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
      ctx.font = '7px "JetBrains Mono",monospace';
      ctx.textAlign = 'right';
      ctx.fillText(db + 'dB', pad.l - 3, y + 3);
    });

    // 0dB line brighter
    const y0 = pad.t + (1 - (0 - DB_MIN) / (DB_MAX - DB_MIN)) * ch;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y0); ctx.lineTo(w - pad.r, y0); ctx.stroke();

    const SR = 44100;
    const N  = Math.max(Math.round(cw), 128);

    // Helper: build dB curve array for a single biquad
    const buildCurve = (type, cutoff, Q, gain_db = 0) => {
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t  = i / N;
        const hz = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
        const mag = _evalBiquad(type, cutoff, Q, SR, hz, gain_db);
        const db  = Math.max(DB_MIN, Math.min(DB_MAX, _magToDb(mag)));
        const x   = pad.l + t * cw;
        const y   = pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * ch;
        pts.push({ x, y });
      }
      return pts;
    };

    // Helper: combine two curves by multiplying linear magnitudes
    const combineCurves = (c1, c2) => {
      return c1.map((pt, i) => {
        const t  = i / N;
        const hz = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
        const m1 = Math.pow(10, (_yToDb(pt.y, pad, ch) / 20));
        const m2 = Math.pow(10, (_yToDb(c2[i].y, pad, ch) / 20));
        const db = Math.max(DB_MIN, Math.min(DB_MAX, _magToDb(m1 * m2)));
        return { x: pt.x, y: pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * ch };
      });
    };

    const _yToDb = (y, pad, ch) => DB_MIN + (1 - (y - pad.t) / ch) * (DB_MAX - DB_MIN);

    // ── Base filter curves ───────────────────────────────────
    const gp = (path) => this._getParam ? this._getParam(path) : filter.getParam(path);
    const mainType   = gp('filter.type');
    const mainCutoff = gp('filter.cutoff');
    const mainQ      = gp('filter.resonance');
    const mainGain   = gp('filter.gain') ?? 0;
    const baseLPF    = gp('base.lpf') ?? 20000;
    const baseHPF    = gp('base.hpf') ?? 20;

    if (this._showBase) {
      // Draw base LPF + HPF combined (dim)
      const lpfCurve = buildCurve('lowpass',  baseLPF, 0.7071);
      const hpfCurve = buildCurve('highpass', baseHPF, 0.7071);
      const baseCombined = combineCurves(lpfCurve, hpfCurve);

      ctx.beginPath();
      baseCombined.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.strokeStyle = BASE_COL;
      ctx.lineWidth   = 1;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    }

    // ── Main filter curve ────────────────────────────────────
    const mainCurve = buildCurve(mainType, mainCutoff, mainQ, mainGain);

    // Fill under main filter
    ctx.beginPath();
    mainCurve.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.lineTo(w - pad.r, h - pad.b);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232,160,32,0.06)';
    ctx.fill();

    // Main filter line
    ctx.beginPath();
    mainCurve.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth   = 1.8;
    ctx.lineJoin    = 'round';
    ctx.stroke();

    // ── Cutoff marker ─────────────────────────────────────────
    const cutoffX = pad.l + _hzToX(mainCutoff, cw);
    ctx.beginPath();
    ctx.moveTo(cutoffX, pad.t);
    ctx.lineTo(cutoffX, h - pad.b);
    ctx.strokeStyle = 'rgba(232,160,32,0.3)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Env ghost ────────────────────────────────────────────
    // Show the amp env ADSR shape as a faint vertical strip on the right side,
    // indicating how the envelope will sweep the filter over time.
    const envelope = this._getEnvelope?.();
    if (envelope) {
      this._drawEnvGhost(ctx, envelope, filter, pad, w, h, cw, ch);
    }

    // ── Resonance dot at cutoff ───────────────────────────────
    const peakDb = _magToDb(_evalBiquad(mainType, mainCutoff, mainQ, SR, mainCutoff, mainGain));
    const peakY  = pad.t + (1 - (Math.min(peakDb, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN)) * ch;
    ctx.beginPath();
    ctx.arc(cutoffX, peakY, 4, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawEnvGhost(ctx, envelope, filter, pad, w, h, cw, ch) {
    const gep = (path) => {
      if (this._getEnvParam) {
        const v = this._getEnvParam(path);
        if (v !== undefined && v !== null) return v;
      }
      return envelope.getParam(path);
    };
    const gp = (path) => this._getParam ? this._getParam(path) : filter.getParam(path);

    const envAmt  = gp('filter.envAmount') ?? 0;
    if (Math.abs(envAmt) < 0.01) return;  // nothing to show

    const mainType   = gp('filter.type');
    const mainCutoff = gp('filter.cutoff');
    const mainQ      = gp('filter.resonance');
    const mainGain   = gp('filter.gain') ?? 0;
    const sustain    = gep('fenv.sustain') ?? 0;

    // The envelope modulates cutoff on a log scale.
    // Peak shift = envAmt × full-range. At sustain the shift = envAmt × sustain.
    // Show two ghost curves: attack peak (envAmt × 1.0) and sustain level (envAmt × sustain).
    // The envelope modulation range is ±4 octaves (same as Envelope.js convention).
    const OCTAVES = 4;
    const peakCutoff    = mainCutoff * Math.pow(2,  envAmt * OCTAVES);
    const sustainCutoff = mainCutoff * Math.pow(2,  envAmt * OCTAVES * sustain);

    const clampCutoff = hz => Math.max(FREQ_MIN, Math.min(FREQ_MAX * 0.99, hz));
    const SR = 44100;

    const buildCurve = (cutoff) => {
      const N = Math.max(Math.round(cw), 128);
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t  = i / N;
        const hz = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
        const mag = _evalBiquad(mainType, clampCutoff(cutoff), mainQ, SR, hz, mainGain);
        const db  = Math.max(DB_MIN, Math.min(DB_MAX, _magToDb(mag)));
        pts.push({
          x: pad.l + t * cw,
          y: pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * ch,
        });
      }
      return pts;
    };

    // Draw sustain-level ghost (dimmer)
    if (Math.abs(sustain) > 0.01 && Math.abs(sustainCutoff - mainCutoff) > 10) {
      const sCurve = buildCurve(sustainCutoff);
      ctx.beginPath();
      sCurve.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.strokeStyle = 'rgba(232,160,32,0.18)';
      ctx.lineWidth   = 1;
      ctx.lineJoin    = 'round';
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw peak ghost (brighter, dashed)
    if (Math.abs(peakCutoff - mainCutoff) > 10) {
      const pCurve = buildCurve(peakCutoff);
      ctx.beginPath();
      pCurve.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.strokeStyle = 'rgba(232,160,32,0.38)';
      ctx.lineWidth   = 1.2;
      ctx.lineJoin    = 'round';
      ctx.setLineDash([2, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  destroy() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
  }
}
