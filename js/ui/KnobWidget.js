/**
 * KnobWidget.js
 * -------------
 * Reusable canvas-based knob control.
 * Supports unipolar (0→1) and bipolar (center-zero) modes.
 * Drag up/down or scroll to change value.
 *
 * Usage:
 *   const knob = new KnobWidget({
 *     label:    'CUTOFF',
 *     min:      20,
 *     max:      20000,
 *     value:    8000,
 *     bipolar:  false,          // optional, default false
 *     size:     72,             // optional px, default 72
 *     color:    '#e8a020',      // optional
 *     fmt:      v => v + 'Hz', // optional display formatter
 *     snapPoints: [1,2,4,8],   // optional; if set, shift snaps to nearest of these
 *     onChange: v => { ... },  // called with real value on change
 *   });
 *   container.appendChild(knob.el);   // .el is the .knob-cell div
 *   knob.setValue(newValue);           // update from outside (no onChange fired)
 *   knob.setRange(min, max, fmt);     // swap range + formatter (e.g. MS↔BPM mode)
 *   knob.setHasPLock(bool);           // tint label blue
 *   knob.destroy();                    // removes global listeners
 */

const KNOB_ACCENT  = '#e8a020';
const KNOB_TRACK   = 'rgba(255,255,255,0.09)';
const KNOB_BODY    = '#181828';

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function _mkCanvas(w) {
  const c = document.createElement('canvas');
  c.width  = w * 2;
  c.height = w * 2;
  c.style.width  = w + 'px';
  c.style.height = w + 'px';
  c.className = 'knob-canvas';
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  return { c, ctx };
}

function _drawUnipolar(ctx, w, norm, color) {
  ctx.clearRect(0, 0, w, w);
  const cx = w / 2, cy = w / 2, r = w * 0.35;
  const startA = Math.PI * 0.75, endA = Math.PI * 2.25;
  const a = startA + norm * (endA - startA);

  // ticks
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

  // arc track
  ctx.beginPath();
  ctx.arc(cx, cy, r + r * 0.14, startA, endA);
  ctx.strokeStyle = KNOB_TRACK;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // filled arc
  ctx.beginPath();
  ctx.arc(cx, cy, r + r * 0.14, startA, a);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle   = KNOB_BODY;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth   = 1;
  ctx.stroke();

  // rim dot
  const dotX = cx + Math.cos(a) * (r + r * 0.14);
  const dotY = cy + Math.sin(a) * (r + r * 0.14);
  ctx.beginPath();
  ctx.arc(dotX, dotY, r * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function _drawBipolar(ctx, w, norm, color) {
  ctx.clearRect(0, 0, w, w);
  const cx = w / 2, cy = w / 2, r = w * 0.35;
  const startA = Math.PI * 0.75, endA = Math.PI * 2.25;
  const midA   = (startA + endA) / 2;
  const a = startA + norm * (endA - startA);

  // ticks
  for (let i = 0; i <= 12; i++) {
    const ta  = startA + (i / 12) * (endA - startA);
    const big = i % 3 === 0 || i === 6;
    const mid = i === 6;
    const lit = mid ? false : (norm < 0.5 ? (ta >= a && ta <= midA) : (ta >= midA && ta <= a));
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ta) * (r + r * 0.28), cy + Math.sin(ta) * (r + r * 0.28));
    ctx.lineTo(cx + Math.cos(ta) * (r + r * 0.42 + (big ? r * 0.1 : 0)),
               cy + Math.sin(ta) * (r + r * 0.42 + (big ? r * 0.1 : 0)));
    ctx.strokeStyle = lit ? color : mid ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth   = big ? 2 : 1;
    ctx.stroke();
  }

  // arc track
  ctx.beginPath();
  ctx.arc(cx, cy, r + r * 0.14, startA, endA);
  ctx.strokeStyle = KNOB_TRACK;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // bipolar arc from center
  if (Math.abs(norm - 0.5) > 0.005) {
    const from = norm < 0.5 ? a    : midA;
    const to   = norm < 0.5 ? midA : a;
    ctx.beginPath();
    ctx.arc(cx, cy, r + r * 0.14, from, to);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }

  // center mark
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(midA) * (r + r * 0.07), cy + Math.sin(midA) * (r + r * 0.07));
  ctx.lineTo(cx + Math.cos(midA) * (r + r * 0.32), cy + Math.sin(midA) * (r + r * 0.32));
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle   = KNOB_BODY;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth   = 1;
  ctx.stroke();

  // rim dot
  const dotX = cx + Math.cos(a) * (r + r * 0.14);
  const dotY = cy + Math.sin(a) * (r + r * 0.14);
  ctx.beginPath();
  ctx.arc(dotX, dotY, r * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export class KnobWidget {
  /**
   * @param {{
   *   label:    string,
   *   min:      number,
   *   max:      number,
   *   value:    number,
   *   bipolar?: boolean,
   *   size?:    number,
   *   color?:   string,
   *   fmt?:     (v: number) => string,
   *   onChange?: (v: number) => void,
   * }} opts
   */
  constructor(opts) {
    this.min      = opts.min      ?? 0;
    this.max      = opts.max      ?? 1;
    this._value   = _clamp(opts.value ?? this.min, this.min, this.max);
    this.bipolar  = opts.bipolar  ?? false;
    this.size     = opts.size     ?? 72;
    this.color    = opts.color    ?? KNOB_ACCENT;
    this.fmt      = opts.fmt      ?? (v => v.toFixed(2));
    this.snapPoints = opts.snapPoints ?? null;  // shift snaps to nearest of these (real values)
    this.centerLabel  = opts.centerLabel  ?? null;  // text drawn in the knob body (e.g. mode)
    this.onCenterClick = opts.onCenterClick ?? null; // click (no drag) on center hotspot
    this.onChange  = opts.onChange  ?? null;
    this.onRelease = opts.onRelease ?? null;

    const { c, ctx } = _mkCanvas(this.size);
    this._canvas = c;
    this._ctx    = ctx;

    // Value display
    this._valEl = document.createElement('div');
    this._valEl.className = 'knob-val';

    // Label
    this._lblEl = document.createElement('div');
    this._lblEl.className = 'knob-label';
    this._lblEl.textContent = opts.label ?? '';

    // Cell wrapper
    this.el = document.createElement('div');
    this.el.className = 'knob-cell';
    this.el.appendChild(c);
    this.el.appendChild(this._valEl);
    this.el.appendChild(this._lblEl);

    this._bindInteraction();
    this._redraw();
  }

  /** Convert real value → 0..1 norm */
  _toNorm(v) {
    return (v - this.min) / (this.max - this.min);
  }

  /** Convert 0..1 norm → real value */
  _fromNorm(n) {
    return this.min + n * (this.max - this.min);
  }

  _redraw() {
    const norm = _clamp(this._toNorm(this._value), 0, 1);
    if (this.bipolar) {
      _drawBipolar(this._ctx, this.size, norm, this.color);
    } else {
      _drawUnipolar(this._ctx, this.size, norm, this.color);
    }
    if (this.centerLabel) this._drawCenterLabel();
    this._valEl.textContent = this.fmt(this._value);
  }

  /** Draw the clickable mode label in the knob body (e.g. "MS"/"BPM"). */
  _drawCenterLabel() {
    const ctx = this._ctx, w = this.size;
    ctx.save();
    ctx.fillStyle    = this.color;
    ctx.font         = `bold ${Math.round(w * 0.16)}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.centerLabel, w / 2, w / 2);
    ctx.restore();
  }

  /** Update the center label text and redraw. */
  setCenterLabel(text) {
    this.centerLabel = text;
    this._redraw();
  }

  _setFromNorm(n) {
    this._value = _clamp(this._fromNorm(_clamp(n, 0, 1)), this.min, this.max);
    this._redraw();
    if (this.onChange) this.onChange(this._value);
  }

  /** Snap a real value to the nearest configured snap point. */
  _snap(v) {
    if (!this.snapPoints || this.snapPoints.length === 0) return v;
    let best = this.snapPoints[0], bestD = Math.abs(v - best);
    for (const p of this.snapPoints) {
      const d = Math.abs(v - p);
      if (d < bestD) { best = p; bestD = d; }
    }
    return _clamp(best, this.min, this.max);
  }

  /** Step to the next/previous snap point in the given direction (+1/-1). */
  _snapStep(dir) {
    if (!this.snapPoints || this.snapPoints.length === 0) return this._value;
    const sorted = [...this.snapPoints].sort((a, b) => a - b);
    if (dir > 0) return _clamp(sorted.find(p => p > this._value + 1e-9) ?? sorted[sorted.length - 1], this.min, this.max);
    return _clamp([...sorted].reverse().find(p => p < this._value - 1e-9) ?? sorted[0], this.min, this.max);
  }

  _bindInteraction() {
    let dragging = false;
    let lastY    = 0;
    let downY    = 0;       // clientY at mousedown (for click-vs-drag threshold)
    let downInCenter = false;  // mousedown landed on the center hotspot

    const onWheel = (e) => {
      e.preventDefault();
      const snapMode = this.snapPoints && (e.shiftKey || e.ctrlKey);
      if (snapMode) {
        // Shift on a snap knob → jump to the adjacent musical division.
        this._value = this._snapStep(e.deltaY > 0 ? -1 : 1);
      } else {
        const fine = e.shiftKey || e.ctrlKey;
        const step = (this.max - this.min) * (fine ? 0.002 : 0.02);
        this._value = _clamp(this._value + (e.deltaY > 0 ? -step : step), this.min, this.max);
      }
      this._redraw();
      if (this.onChange) this.onChange(this._value);
      // Treat each wheel tick as its own release (no held state)
      if (this.onRelease) this.onRelease(this._value);
    };

    const onMouseDown = (e) => {
      dragging = true;
      lastY    = e.clientY;
      downY    = e.clientY;
      // Did the press land on the center hotspot? (body radius ≈ size*0.35)
      const rect = this._canvas.getBoundingClientRect();
      const dx = (e.clientX - rect.left) - this.size / 2;
      const dy = (e.clientY - rect.top)  - this.size / 2;
      downInCenter = Math.hypot(dx, dy) <= this.size * 0.35;
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const snapMode = this.snapPoints && (e.shiftKey || e.ctrlKey);
      const speed = (e.shiftKey || e.ctrlKey) && !snapMode ? 0.0008 : 0.008;
      const dy    = (lastY - e.clientY) * speed;
      const norm  = _clamp(this._toNorm(this._value) + dy, 0, 1);
      lastY       = e.clientY;
      if (snapMode) {
        // Drag with shift on a snap knob → continuously snap to nearest division.
        this._value = this._snap(this._fromNorm(norm));
        this._redraw();
        if (this.onChange) this.onChange(this._value);
      } else {
        this._setFromNorm(norm);
      }
    };

    const onMouseUp = (e) => {
      if (!dragging) return;
      const isClick = Math.abs((e?.clientY ?? downY) - downY) <= 4;
      if (isClick && downInCenter && this.onCenterClick) {
        // Center click (no meaningful drag) → toggle, don't fire release.
        dragging = false;
        this.onCenterClick();
        return;
      }
      if (this.onRelease) this.onRelease(this._value);
      dragging = false;
    };

    this._canvas.addEventListener('wheel', onWheel, { passive: false });
    this._canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Store for cleanup
    this._cleanup = () => {
      this._canvas.removeEventListener('wheel', onWheel);
      this._canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  /** Set value from outside without firing onChange */
  setValue(v) {
    this._value = _clamp(v, this.min, this.max);
    this._redraw();
  }

  /**
   * Swap the knob's range, formatter and (optionally) snap points without
   * firing onChange. Used to flip a sync knob between MS and BPM modes.
   * The caller should call setValue() afterwards with the new mode's value.
   */
  setRange(min, max, fmt, snapPoints = null) {
    this.min = min;
    this.max = max;
    if (fmt) this.fmt = fmt;
    this.snapPoints = snapPoints;
    this._value = _clamp(this._value, this.min, this.max);
    this._redraw();
  }

  getValue() {
    return this._value;
  }

  /** Toggle p-lock highlight on the label */
  setHasPLock(has) {
    this._lblEl.classList.toggle('has-plock', has);
  }

  /** Remove global event listeners */
  destroy() {
    if (this._cleanup) this._cleanup();
  }
}
