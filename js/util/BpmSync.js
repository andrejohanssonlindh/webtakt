/**
 * BpmSync.js
 * ----------
 * Shared BPM-sync utilities.
 *
 * The unified sync-knob model (see design/audio-signal-chain.md (Unified Sync-Knob Model)) expresses BPM
 * mode as a COUNT of 1/GRID_BASE-of-a-whole-note grid units. Active API used by
 * DelayFX, ReverbFX, LFO and Arpeggiator:
 *   count32ToSeconds(count, bpm)  — grid count → wall-clock seconds
 *   MUSICAL_SNAP_32               — shift-snap points (grid units)
 *   formatCount32(count)          — human label ("1/8 + 1/32")
 *   divToCount32(div)             — legacy division string → grid count (load)
 *
 * GRID_BASE is the single knob that sets the resolution of the whole sync model:
 * it is the number of grid units in a WHOLE note. At the historical value of 32,
 * one grid unit == one 1/32 note and the stored counts match the old
 * `bpmCount32` semantics exactly (hence the field name is kept). Raising it makes
 * the grid finer everywhere the snap points / labels / conversions are derived —
 * change this one constant and the rest follows. The FX sync knobs additionally
 * sweep a SUB-grid (see FINE_STEP) so they can land BETWEEN musical divisions
 * (e.g. the points between 1/32 and 1/16) without disturbing the integer-count
 * defaults stored by envelopes / LFO / arp.
 *
 * Legacy (back-compat only, consumed by divToCount32):
 *   DIV_QN / SYNC_DIVISIONS / divToSeconds(div, bpm)
 *
 * User-settable finest division: the snap points (`MUSICAL_SNAP_32`) gain extra
 * sub-1/32 targets (1/64, 1/128) when the user raises the grid resolution in
 * Settings. Stored COUNTS stay in 1/32 units (`GRID_BASE` is fixed at 32) so no
 * saved project is ever rescaled — a 1/64 note is simply the fractional count
 * 0.5. `setSnapResolution()` is called by index.html when the setting changes.
 */

/**
 * Grid units per WHOLE note. The base resolution of the stored count model.
 * 32 ⇒ one grid unit = one 1/32 note (the historical/stored unit). The
 * quarter-note multiplier and division names are derived from this; it stays
 * fixed so stored counts keep their meaning across sessions. The user-facing
 * "finer grid" setting only adds finer SNAP targets (see MUSICAL_SNAP_32).
 */
export const GRID_BASE = 32;

export const DIV_QN = {
  '1/32': 0.125,
  '1/16': 0.25,
  '1/8':  0.5,
  '1/4':  1,
  '1/2':  2,
  '1/1':  4,
  '2/1':  8,
  '4/1':  16,
};

export const SYNC_DIVISIONS = Object.keys(DIV_QN);

/** Convert a beat-division string + BPM to seconds. */
export function divToSeconds(div, bpm) {
  return (DIV_QN[div] ?? 1) * 60 / bpm;
}

// ---------------------------------------------------------------------------
// Continuous grid (sync-knob model)
// ---------------------------------------------------------------------------
// BPM mode expresses time as a COUNT of grid units, where GRID_BASE units span
// a whole note. One grid unit = GRID_UNIT_QN quarter-notes. At GRID_BASE=32 that
// is 0.125 (a 1/32 note). Seconds = count * GRID_UNIT_QN * 60 / bpm.

/** Quarter-note multiplier of a single grid unit (4 quarter-notes per whole). */
export const GRID_UNIT_QN = 4 / GRID_BASE;

/**
 * Display resolution for the fractional remainder of a count. formatCount32
 * splits a count into whole grid units + a remainder of 1/FINE_STEP-th of a
 * unit; at 16 the remainder can name 1/64 (8/16) and 1/128 (4/16) cleanly. This
 * is a LABEL granularity only — free drag quantizes to the user's grid (see
 * `quantizeCount`), so the remainder in practice is always 0, a 1/64 or a 1/128.
 */
export const FINE_STEP = 16;

/** Smallest fractional grid increment the formatter can name. */
export const FINE_INCREMENT = 1 / FINE_STEP;

/**
 * Free-drag quantize step in stored 1/32 units. The user's Settings grid sets
 * how finely the sync knobs move WITHOUT shift: 1/32 → 1 unit, 1/64 → 0.5,
 * 1/128 → 0.25. Stored counts stay in 1/32 units (GRID_BASE is fixed) so a 1/64
 * step is simply 0.5. `setSnapResolution()` keeps this in sync with the snap
 * points whenever the grid setting changes.
 */
let _quantStep = 1;

/** Quantize a free-dragged count to the current grid step (1/32, 1/64, 1/128). */
export function quantizeCount(count) {
  return Math.round(count / _quantStep) * _quantStep;
}

/** Convert a grid count (may be fractional) + BPM to seconds. */
export function count32ToSeconds(count, bpm) {
  return count * GRID_UNIT_QN * 60 / bpm;
}

/**
 * Convert a grid count + BPM to a rate in Hz, treating the count as the PERIOD
 * (one full cycle spans `count` grid units). Used by LFO-style rate knobs
 * (LFO.js, Strings vibrato, WT-sampler sweep) whose BPM mode expresses the
 * oscillator period rather than a one-shot duration.
 */
export function count32ToHz(count, bpm) {
  return 1 / Math.max(count32ToSeconds(count, bpm), 1e-6);
}

// Musical divisions as a fraction of a whole note → grid units (× GRID_BASE).
// dotted-1/16, 1/8, dotted-1/8, 1/4, dotted-1/4, 1/2, dotted-1/2,
// whole, 2 bars, 4 bars. The fine head (1/32 and any finer 1/64, 1/128) is
// prepended by _buildSnap() per the user's resolution setting.
const _MUSICAL_WHOLE_FRACTIONS = [
  3 / 32, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2,
  3 / 4, 1, 3 / 2, 2, 3, 4,
];

/**
 * Build the snap-point array for a given finest division (grid units per whole
 * note, 32/64/128). Always includes 1/32, 1/16 and every musical division
 * above; for 64/128 it prepends 1/64 (and 1/128) as fractional 1/32 counts
 * (1/64 → 0.5, 1/128 → 0.25). Sorted ascending.
 */
function _buildSnap(finestBase) {
  const head = [1 / 32, 1 / 16];               // always available
  if (finestBase >= 64)  head.unshift(1 / 64);
  if (finestBase >= 128) head.unshift(1 / 128);
  const fracs = [...head, ..._MUSICAL_WHOLE_FRACTIONS];
  return fracs.map(f => f * GRID_BASE).sort((a, b) => a - b);
}

/**
 * Musical snap points in grid units (1/32 unit). Shift-dragging a sync knob
 * jumps between these. Mutable: `setSnapResolution()` rebuilds it when the user
 * changes the finest-division setting. Default = 1/32 (the historical set).
 */
export let MUSICAL_SNAP_32 = _buildSnap(32);

/**
 * Set the finest snap division app-wide. `finestBase` is grid units per whole
 * note (32 / 64 / 128). Reassigns the live `MUSICAL_SNAP_32` binding so every
 * panel that imports it picks up the new targets on its next render.
 */
export function setSnapResolution(finestBase) {
  MUSICAL_SNAP_32 = _buildSnap(finestBase);
  // Free drag steps one grid unit at the chosen resolution. GRID_BASE units span
  // a whole note; finestBase units span a whole note at the new resolution, so
  // one step = GRID_BASE / finestBase stored 1/32 units (32→1, 64→0.5, 128→0.25).
  _quantStep = GRID_BASE / finestBase;
}

// Clean fraction names keyed by grid-unit count (derived from GRID_BASE).
const _COUNT32_NAME = (() => {
  const names = {};
  const fracs = { '1/32': 1 / 32, '1/16': 1 / 16, '1/8': 1 / 8, '1/4': 1 / 4,
                  '1/2': 1 / 2, '1/1': 1, '2/1': 2, '4/1': 4 };
  for (const [label, frac] of Object.entries(fracs)) {
    const units = frac * GRID_BASE;
    if (Number.isInteger(units)) names[units] = label;
  }
  return names;
})();

// Sub-1/32 remainders the formatter can name, keyed by 1/FINE_STEP units.
// 8/16 of a 1/32 unit = 1/64, 4/16 = 1/128. Anything else falls back to "·N".
const _FINE_REM_NAME = { 8: `1/${GRID_BASE * 2}`, 4: `1/${GRID_BASE * 4}`, 12: `3/${GRID_BASE * 4}` };

/**
 * Human-readable label for a grid count (may be fractional). Exact divisions
 * render clean ("1/4"); otherwise the largest clean division ≤ count plus the
 * remainder ("1/8 + 1/32", "3/16 + 1/32"). A fractional remainder (the knob now
 * lands on 1/64 / 1/128 when the user raises the grid) reads as "+ 1/64" etc.
 */
export function formatCount32(count) {
  const n = Math.max(FINE_INCREMENT, count);
  // Snap to the fine grid first, then split into whole + fine remainder so a
  // value like 8.9999 reads as "1/4" (9 → next whole), not "1/8 + 1/64".
  const fineTotal = Math.round(n * FINE_STEP);
  const whole   = Math.floor(fineTotal / FINE_STEP);
  const fineRem = fineTotal - whole * FINE_STEP;
  if (whole === 0) {
    // Sub-one-unit value (only reachable when the grid is 1/64 or finer).
    return _FINE_REM_NAME[fineRem] ?? `1/${GRID_BASE} ·-${FINE_STEP - fineRem}`;
  }
  const baseLabel = _formatWholeCount(whole);
  if (fineRem === 0) return baseLabel;
  const remName = _FINE_REM_NAME[fineRem];
  return remName ? `${baseLabel} + ${remName}` : `${baseLabel} ·${fineRem}`;
}

/** Label for an integer grid count (the clean/remainder logic). */
function _formatWholeCount(n) {
  if (_COUNT32_NAME[n]) return _COUNT32_NAME[n];
  const cleanUnits = Object.keys(_COUNT32_NAME).map(Number).sort((a, b) => b - a);
  const base = cleanUnits.find(u => u <= n) ?? 1;
  const rem  = n - base;
  if (rem === 0) return _COUNT32_NAME[base];
  const baseLabel = _COUNT32_NAME[base] ?? `${base}/${GRID_BASE}`;
  const remLabel  = _COUNT32_NAME[rem]  ?? `${rem}/${GRID_BASE}`;
  return `${baseLabel} + ${remLabel}`;
}

/** Map a legacy beat-division string → grid count (for project load). */
export function divToCount32(div) {
  // DIV_QN is in quarter-notes; grid units = qn / GRID_UNIT_QN.
  return Math.round((DIV_QN[div] ?? 1) / GRID_UNIT_QN);
}
