/**
 * ADSRWidget.js
 * -------------
 * Interactive ADSR envelope display + 4 knobs.
 * The canvas shows the envelope shape; drag handles to reshape.
 * Four knobs below mirror the values and are also draggable.
 *
 * Fine control: hold Shift or Ctrl while dragging any knob or canvas
 * handle to reduce sensitivity by 10×.
 *
 * Release drag fix: total width is computed without R during release
 * drag so the handle doesn't chase itself.
 *
 * opts.prefix  — param prefix, either 'env' (default) or 'fenv'.
 *                All param keys will be `${prefix}.attack` etc.
 * opts.accent  — optional CSS color string for the envelope line/knobs.
 *                Defaults to amber '#e8a020'.
 * opts.canvasH — optional canvas height in px (default 140).
 * opts.getBpm  — optional () => number; current BPM used to render BPM-synced
 *                stage durations on the canvas (default () => 120).
 *
 * Tempo-sync (per stage): A / D / R each show a clickable MS/BPM label in the
 * knob body — clicking the center (no drag) flips that stage's mode, matching
 * the FX delay knob. In BPM mode the stage stores a 1/32 count
 * (`${prefix}.${stage}.bpmCount32`) and its mode (`…​.syncMode`); the knob value
 * + display switch to the count (shown as "1/8"), while the canvas always plots
 * the resolved seconds so the shape stays readable. Sustain has no duration and
 * no mode label. See js/signal/Envelope.js and design/sync-knob-rollout.md.
 */

import { formatCount32, count32ToSeconds, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

// Count bounds for BPM-mode stage knobs (1/32 … 4 bars in 1/32 units).
const COUNT_LO = 1, COUNT_HI = 128;

const ADSR_ACCENT_DEFAULT = '#e8a020';
const FENV_ACCENT         = '#4a90d9';   // blue for filter envelope
const ADSR_TRACK  = 'rgba(255,255,255,0.09)';
const ADSR_BODY   = '#181828';

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const BOUNDS_TABLE = {
  'env.attack':   { lo: 0.001, hi: 4.0 },
  'env.decay':    { lo: 0.001, hi: 4.0 },
  'env.sustain':  { lo: 0.0,   hi: 1.0 },
  'env.release':  { lo: 0.001, hi: 8.0 },
  'fenv.attack':  { lo: 0.001, hi: 4.0 },
  'fenv.decay':   { lo: 0.001, hi: 4.0 },
  'fenv.sustain': { lo: 0.0,   hi: 1.0 },
  'fenv.release': { lo: 0.001, hi: 8.0 },
};

function _mkKnobCanvas(w) {
  const c = document.createElement('canvas');
  c.width  = w * 2;
  c.height = w * 2;
  c.style.width  = w + 'px';
  c.style.height = w + 'px';
  c.className    = 'knob-canvas';
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  return { c, ctx };
}

function _drawKnob(ctx, w, norm, color, centerLabel) {
  ctx.clearRect(0, 0, w, w);
  const cx = w / 2, cy = w / 2, r = w * 0.35;
  const startA = Math.PI * 0.75, endA = Math.PI * 2.25;
  const a = startA + norm * (endA - startA);

  for (let i = 0; i <= 12; i++) {
    const ta  = startA + (i / 12) * (endA - startA);
    const big = i % 3 === 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ta) * (r + r * 0.28), cy + Math.sin(ta) * (r + r * 0.28));
    ctx.lineTo(cx + Math.cos(ta) * (r + r * 0.42 + (big ? r * 0.1 : 0)),
               cy + Math.sin(ta) * (r + r * 0.42 + (big ? r * 0.1 : 0)));
    ctx.strokeStyle = ta <= a ? color : 'rgba(255,255,255,0.14)';
    ctx.lineWidth   = big ? 2 : 1;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r + r * 0.14, startA, endA);
  ctx.strokeStyle = ADSR_TRACK; ctx.lineWidth = 2; ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r + r * 0.14, startA, a);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = ADSR_BODY; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1; ctx.stroke();

  const dotX = cx + Math.cos(a) * (r + r * 0.14);
  const dotY = cy + Math.sin(a) * (r + r * 0.14);
  ctx.beginPath();
  ctx.arc(dotX, dotY, r * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();

  // Clickable mode label drawn in the body (e.g. "MS"/"BPM").
  if (centerLabel) {
    ctx.save();
    ctx.fillStyle    = color;
    ctx.font         = `bold ${Math.round(w * 0.16)}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(centerLabel, cx, cy);
    ctx.restore();
  }
}

export class ADSRWidget {
  constructor(opts) {
    this._getParam      = opts.getParam;
    this._setParam      = opts.setParam;
    this._getStepPLock  = opts.getStepPLock  ?? (() => null);
    this._setStepPLock  = opts.setStepPLock  ?? null;
    this._hasStep       = opts.hasStep       ?? (() => false);
    this._onRelease     = opts.onRelease     ?? null;

    this._prefix  = opts.prefix ?? 'env';
    this._accent  = opts.accent ?? (this._prefix === 'fenv' ? FENV_ACCENT : ADSR_ACCENT_DEFAULT);
    this._envH    = opts.canvasH ?? 140;
    this._getBpm  = opts.getBpm  ?? (() => 120);

    this._cleanups = [];
    this._knobs    = {};
    this._envW     = 0;

    // Derive the four param keys from the prefix
    this._keys = {
      attack:  `${this._prefix}.attack`,
      decay:   `${this._prefix}.decay`,
      sustain: `${this._prefix}.sustain`,
      release: `${this._prefix}.release`,
    };

    this.el = document.createElement('div');
    this.el.className = 'adsr-widget';

    this._buildCanvas();
    this._buildKnobs();
    this._sizeCanvas();
  }

  // ── Helpers ──────────────────────────────────────────────

  _get(key) {
    if (this._hasStep()) {
      const pv = this._getStepPLock(key);
      if (pv !== null && pv !== undefined) return pv;
    }
    return this._getParam(key);
  }

  _set(key, val) {
    const bounds = BOUNDS_TABLE[key];
    val = _clamp(val, bounds.lo, bounds.hi);
    if (this._hasStep() && this._setStepPLock) {
      this._setStepPLock(key, val);
    } else {
      this._setParam(key, val);
    }
    this._drawEnv();
    this._syncKnobs();
  }

  _toNorm(key, val) {
    const { lo, hi } = BOUNDS_TABLE[key];
    return _clamp((val - lo) / (hi - lo), 0, 1);
  }

  _fromNorm(key, norm) {
    const { lo, hi } = BOUNDS_TABLE[key];
    return lo + _clamp(norm, 0, 1) * (hi - lo);
  }

  _fmt(key, val) {
    if (key === this._keys.sustain) return Math.round(val * 100) + '%';
    return Math.round(val * 1000) + 'ms';
  }

  // ── Per-stage sync helpers ────────────────────────────────
  // A timed stage carries two sibling params: `${key}.syncMode` ('ms'|'bpm')
  // and `${key}.bpmCount32` (integer 1/32 count). Sustain is never syncable.

  /** Sustain has no duration → not sync-capable. */
  _isSyncable(key) { return key !== this._keys.sustain; }

  _modeKey(key)  { return `${key}.syncMode`; }
  _countKey(key) { return `${key}.bpmCount32`; }

  /** Current sync mode for a stage ('ms' default; sustain is always 'ms'). */
  _stageMode(key) {
    if (!this._isSyncable(key)) return 'ms';
    return this._get(this._modeKey(key)) ?? 'ms';
  }

  /**
   * Resolve a stage to seconds, mirroring Envelope._stageSeconds: BPM stages
   * convert their 1/32 count via the current BPM; MS stages return raw seconds.
   */
  _stageSeconds(key) {
    if (this._stageMode(key) === 'bpm') {
      return count32ToSeconds(this._get(this._countKey(key)), this._getBpm());
    }
    return this._get(key);
  }

  // ── Envelope canvas ───────────────────────────────────────

  _buildCanvas() {
    const wrapper = document.createElement('div');
    wrapper.className = 'adsr-canvas-wrap';
    wrapper.style.width    = '100%';
    wrapper.style.position = 'relative';

    const c = document.createElement('canvas');
    c.style.display     = 'block';
    c.style.width       = '100%';
    c.style.cursor      = 'crosshair';
    c.style.touchAction = 'none';
    this._envCanvas = c;
    this._eCtx = c.getContext('2d');

    wrapper.appendChild(c);
    this.el.appendChild(wrapper);

    this._buildEnvInteraction();
  }

  _sizeCanvas() {
    const w = this._envCanvas.parentElement?.clientWidth || 300;
    const h = this._envH;
    this._envW = w;
    this._envCanvas.width  = w * 2;
    this._envCanvas.height = h * 2;
    this._envCanvas.style.height = h + 'px';
    this._eCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._eCtx.scale(2, 2);
    this._drawEnv();
  }

  _envPoints() {
    const w = this._envW, h = this._envH;
    const pad = { l: 24, r: 24, t: 16, b: 26 };
    const uw = w - pad.l - pad.r;
    const uh = h - pad.t - pad.b;
    // Timed stages resolve to seconds (BPM stages → count32ToSeconds) so the
    // plotted shape always reflects real durations regardless of sync mode.
    const A = this._stageSeconds(this._keys.attack);
    const D = this._stageSeconds(this._keys.decay);
    const S = this._get(this._keys.sustain);
    const R = this._stageSeconds(this._keys.release);
    const total = A + D + 0.28 + R;
    const xA  = pad.l + (A / total) * uw;
    const xD  = xA    + (D / total) * uw;
    const xS  = xD    + (0.28 / total) * uw;
    const xR  = xS    + (R / total) * uw;
    const yB  = pad.t + uh;
    const yT  = pad.t;
    const yS  = pad.t + uh * (1 - S);
    return {
      pad, uw, uh,
      start: { x: pad.l, y: yB },
      a:     { x: xA, y: yT },
      d:     { x: xD, y: yS },
      s:     { x: xS, y: yS },
      end:   { x: xR, y: yB },
      yB, yT,
    };
  }

  _drawEnv() {
    if (!this._envW) return;
    const ctx = this._eCtx;
    const w = this._envW, h = this._envH;
    ctx.clearRect(0, 0, w, h);
    const p = this._envPoints();

    // grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    for (let i = 1; i < 4; i++) {
      const y = p.pad.t + (p.uh / 4) * i;
      ctx.beginPath();
      ctx.moveTo(p.pad.l, y);
      ctx.lineTo(w - p.pad.r, y);
      ctx.stroke();
    }

    // axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font      = '9px "JetBrains Mono", monospace';
    [['A', p.a], ['D', p.d], ['S', p.s], ['R', p.end]].forEach(([lbl, pt]) => {
      ctx.fillText(lbl, pt.x - 4, p.yB + 14);
    });

    // fill
    const fillColor = this._accent.startsWith('#')
      ? this._accent + '12'   // hex: append low-alpha suffix
      : this._accent.replace(')', ', 0.07)').replace('rgb(', 'rgba(');
    ctx.beginPath();
    ctx.moveTo(p.start.x, p.start.y);
    ctx.lineTo(p.a.x, p.a.y);
    ctx.lineTo(p.d.x, p.d.y);
    ctx.lineTo(p.s.x, p.s.y);
    ctx.lineTo(p.end.x, p.end.y);
    ctx.lineTo(p.end.x, p.yB);
    ctx.closePath();
    ctx.fillStyle = this._prefix === 'fenv'
      ? 'rgba(74,144,217,0.09)'
      : 'rgba(232,160,32,0.07)';
    ctx.fill();

    // line
    ctx.beginPath();
    ctx.moveTo(p.start.x, p.start.y);
    ctx.lineTo(p.a.x, p.a.y);
    ctx.lineTo(p.d.x, p.d.y);
    ctx.lineTo(p.s.x, p.s.y);
    ctx.lineTo(p.end.x, p.end.y);
    ctx.strokeStyle = this._accent;
    ctx.lineWidth   = 1.8;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.stroke();

    // drag handles
    for (const pt of [p.a, p.d, p.s, p.end]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#111120';
      ctx.fill();
      ctx.strokeStyle = this._accent;
      ctx.lineWidth   = 1.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = this._accent;
      ctx.fill();
    }
  }

  _envXY(e) {
    const r  = this._envCanvas.getBoundingClientRect();
    const sx = (this._envCanvas.width  / 2) / r.width;
    const sy = (this._envCanvas.height / 2) / r.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
  }

  _hitEnv(mx, my) {
    const p = this._envPoints();
    for (const [k, pt] of [['a', p.a], ['d', p.d], ['s', p.s], ['end', p.end]]) {
      const dx = mx - pt.x, dy = my - pt.y;
      if (Math.sqrt(dx * dx + dy * dy) < 14) return k;
    }
    return null;
  }

  /**
   * Apply a canvas drag for an ADSR handle.
   * `snap` holds the A/D/S/R values captured at drag start so calculations
   * stay stable while dragging.
   */
  _applyEnvDrag(key, mx, my, snap, fine) {
    const p   = this._envPoints();
    const { attack, decay, sustain, release } = this._keys;

    if (key === 'a') {
      const total = snap.A + snap.D + 0.28 + snap.R;
      const rawA  = _clamp(((mx - p.pad.l) / p.uw) * total,
                           BOUNDS_TABLE[attack].lo, BOUNDS_TABLE[attack].hi);
      this._setStageFromSeconds(attack, rawA, fine);

    } else if (key === 'd') {
      const total = snap.A + snap.D + 0.28 + snap.R;
      const xA    = p.pad.l + (snap.A / total) * p.uw;
      const rawD  = _clamp(((mx - xA) / p.uw) * total,
                           BOUNDS_TABLE[decay].lo, BOUNDS_TABLE[decay].hi);
      this._setStageFromSeconds(decay, rawD, fine);
      const s = _clamp(1 - (my - p.pad.t) / p.uh,
                       BOUNDS_TABLE[sustain].lo, BOUNDS_TABLE[sustain].hi);
      this._set(sustain, s);

    } else if (key === 's') {
      const s = _clamp(1 - (my - p.pad.t) / p.uh,
                       BOUNDS_TABLE[sustain].lo, BOUNDS_TABLE[sustain].hi);
      this._set(sustain, s);

    } else if (key === 'end') {
      const total = snap.A + snap.D + 0.28 + snap.R;
      const xS    = p.pad.l + ((snap.A + snap.D + 0.28) / total) * p.uw;
      const rawR  = _clamp(((mx - xS) / p.uw) * total,
                           BOUNDS_TABLE[release].lo, BOUNDS_TABLE[release].hi);
      this._setStageFromSeconds(release, rawR, fine);
    }
  }

  /**
   * Write a stage from a target-seconds value, honouring its sync mode.
   * MS stages store raw seconds. BPM stages convert seconds → 1/32 count
   * (snapped to the nearest musical division when shift/ctrl held) so dragging
   * a synced handle lands on clean divisions. See design/sync-knob-rollout.md.
   */
  _setStageFromSeconds(key, secs, fine) {
    if (this._stageMode(key) !== 'bpm') { this._set(key, secs); return; }
    const perCount = count32ToSeconds(1, this._getBpm());   // seconds per 1/32
    let count = _clamp(Math.round(secs / Math.max(perCount, 1e-6)), COUNT_LO, COUNT_HI);
    if (fine) {
      // Snap to the nearest musical division (1/32 units).
      let best = MUSICAL_SNAP_32[0], bestD = Math.abs(count - best);
      for (const c of MUSICAL_SNAP_32) {
        const d = Math.abs(count - c);
        if (d < bestD) { best = c; bestD = d; }
      }
      count = _clamp(best, COUNT_LO, COUNT_HI);
    }
    this._setStageCount(key, count);
  }

  /** Set a BPM stage's 1/32 count (p-lock-aware), then redraw. */
  _setStageCount(key, count) {
    const c = _clamp(Math.round(count), COUNT_LO, COUNT_HI);
    if (this._hasStep() && this._setStepPLock) {
      this._setStepPLock(this._countKey(key), c);
    } else {
      this._setParam(this._countKey(key), c);
    }
    this._drawEnv();
    this._syncKnobs();
  }

  /** Toggle a stage's MS↔BPM sync mode (p-lock-aware), then rebuild knobs. */
  _toggleStageMode(key) {
    const next = this._stageMode(key) === 'bpm' ? 'ms' : 'bpm';
    if (this._hasStep() && this._setStepPLock) {
      this._setStepPLock(this._modeKey(key), next);
    } else {
      this._setParam(this._modeKey(key), next);
    }
    this._refreshKnobMode(key);
    this._drawEnv();
    this._syncKnobs();
  }

  _buildEnvInteraction() {
    let envDrag = null;
    let snap    = null;

    const onDown = (e) => {
      const { x, y } = this._envXY(e);
      envDrag = this._hitEnv(x, y);
      if (envDrag) {
        snap = {
          A: this._get(this._keys.attack),
          D: this._get(this._keys.decay),
          S: this._get(this._keys.sustain),
          R: this._get(this._keys.release),
        };
        e.preventDefault();
      }
    };
    const onMove = (e) => {
      if (!envDrag) return;
      const { x, y } = this._envXY(e);
      const fine = e.shiftKey || e.ctrlKey;
      this._applyEnvDrag(envDrag, x, y, snap, fine);
      e.preventDefault();
    };
    const onUp = () => {
      if (envDrag && this._onRelease) this._onRelease();
      envDrag = null;
      snap    = null;
    };

    this._envCanvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    this._envCanvas.addEventListener('touchstart', onDown, { passive: false });
    this._envCanvas.addEventListener('touchmove',  onMove, { passive: false });
    this._envCanvas.addEventListener('touchend',   onUp);

    this._cleanups.push(() => {
      this._envCanvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._envCanvas.removeEventListener('touchstart', onDown);
      this._envCanvas.removeEventListener('touchmove', onMove);
      this._envCanvas.removeEventListener('touchend', onUp);
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this._eCtx.setTransform(1, 0, 0, 1, 0, 0);
        this._sizeCanvas();
      });
      ro.observe(this._envCanvas.parentElement);
      this._cleanups.push(() => ro.disconnect());
    }
  }

  // ── Knobs ─────────────────────────────────────────────────

  _buildKnobs() {
    const row = document.createElement('div');
    row.className = 'knob-row';
    this.el.appendChild(row);
    this._knobRow = row;

    const KEYS = [
      this._keys.attack,
      this._keys.decay,
      this._keys.sustain,
      this._keys.release,
    ];
    const LBLS = ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE'];
    const KS   = 64;

    KEYS.forEach((key, i) => {
      const { c, ctx } = _mkKnobCanvas(KS);
      const valEl = document.createElement('div');
      valEl.className = 'knob-val';
      const lblEl = document.createElement('div');
      lblEl.className = 'knob-label';
      lblEl.textContent = LBLS[i];

      this._knobs[key] = { ctx, c, valEl, lblEl, KS };

      let dragging = false, lastY = 0, downY = 0, downInCenter = false;
      const accent    = this._accent;
      const syncable  = this._isSyncable(key);

      // A timed stage in BPM mode drives its 1/32 count instead of seconds.
      const isBpm   = () => this._stageMode(key) === 'bpm';
      const getVal  = () => isBpm() ? this._get(this._countKey(key)) : this._get(key);
      const bounds  = () => isBpm()
        ? { lo: COUNT_LO, hi: COUNT_HI }
        : BOUNDS_TABLE[key];
      const toNorm  = (v) => { const { lo, hi } = bounds(); return _clamp((v - lo) / (hi - lo), 0, 1); };
      const fromNorm = (n) => { const { lo, hi } = bounds(); return lo + _clamp(n, 0, 1) * (hi - lo); };
      const setVal  = (v) => { isBpm() ? this._setStageCount(key, v) : this._set(key, v); };
      const fmtVal  = (v) => isBpm() ? formatCount32(v) : this._fmt(key, v);
      // Mode label drawn in the body; click it (no drag) to toggle MS↔BPM.
      const centerLabel = () => syncable ? (isBpm() ? 'BPM' : 'MS') : null;

      const redraw = () => {
        _drawKnob(ctx, KS, toNorm(getVal()), accent, centerLabel());
        valEl.textContent = fmtVal(getVal());
      };

      const onWheel = (e) => {
        e.preventDefault();
        const fine = e.shiftKey || e.ctrlKey;
        const { lo, hi } = bounds();
        const step = (hi - lo) * (fine ? 0.002 : 0.02);
        setVal(getVal() + (e.deltaY > 0 ? -step : step));
      };
      const onDown = (e) => {
        dragging = true;
        lastY    = e.clientY;
        downY    = e.clientY;
        // Did the press land on the center hotspot? (body radius ≈ KS*0.35)
        const rect = c.getBoundingClientRect();
        const dx = (e.clientX - rect.left) - KS / 2;
        const dy = (e.clientY - rect.top)  - KS / 2;
        downInCenter = Math.hypot(dx, dy) <= KS * 0.35;
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const fine  = e.shiftKey || e.ctrlKey;
        const speed = fine ? 0.0008 : 0.008;
        const dy    = (lastY - e.clientY) * speed;
        const norm  = _clamp(toNorm(getVal()) + dy, 0, 1);
        setVal(fromNorm(norm));
        lastY = e.clientY;
      };
      const onUp = (e) => {
        if (!dragging) return;
        const isClick = Math.abs((e?.clientY ?? downY) - downY) <= 4;
        if (isClick && downInCenter && syncable) {
          // Center click (no meaningful drag) → toggle mode, don't fire release.
          dragging = false;
          this._toggleStageMode(key);
          return;
        }
        if (this._onRelease) this._onRelease();
        dragging = false;
      };

      c.addEventListener('wheel', onWheel, { passive: false });
      c.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);

      this._cleanups.push(() => {
        c.removeEventListener('wheel', onWheel);
        c.removeEventListener('mousedown', onDown);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      });

      redraw();
      this._knobs[key].redraw = redraw;

      const cell = document.createElement('div');
      cell.className = 'knob-cell';
      cell.appendChild(c);
      cell.appendChild(valEl);
      cell.appendChild(lblEl);

      row.appendChild(cell);
      this._knobs[key].cell = cell;
    });
  }

  /** Redraw a stage knob (mode label lives in the body) after a mode toggle. */
  _refreshKnobMode(key) {
    this._knobs[key]?.redraw?.();
  }

  _syncKnobs() {
    for (const [key, kb] of Object.entries(this._knobs)) {
      if (kb.redraw) kb.redraw();
      // P-lock highlight reflects whichever param the active mode targets.
      const activeKey = (this._isSyncable(key) && this._stageMode(key) === 'bpm')
        ? this._countKey(key)
        : key;
      // Highlight when either the active value param OR the sync-mode param is
      // p-locked (the mode toggle lives in the knob body, no separate element).
      const pv     = this._getStepPLock(activeKey);
      const modePv = this._isSyncable(key) ? this._getStepPLock(this._modeKey(key)) : null;
      const isSet  = (v) => v !== null && v !== undefined;
      const hasPLock = this._hasStep() && (isSet(pv) || isSet(modePv));
      kb.lblEl.classList.toggle('has-plock', hasPLock);
    }
  }

  refresh() {
    this._drawEnv();
    this._syncKnobs();
  }

  destroy() {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
  }
}
