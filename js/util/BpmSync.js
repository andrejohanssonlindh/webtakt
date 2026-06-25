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
 *   formatCount32(count)          — human label ("1/1 + 1/4", "2/1 + 5/128")
 *   divToCount32(div)             — legacy division string → grid count (load)
 *
 * GRID_BASE is the single knob that sets the resolution of the whole sync model:
 * it is the number of grid units in a WHOLE note. At the historical value of 32,
 * one grid unit == one 1/32 note and the stored counts match the old
 * `bpmCount32` semantics exactly (hence the field name is kept). Raising it makes
 * the grid finer everywhere the snap points / labels / conversions are derived —
 * change this one constant and the rest follows. The user's Settings grid lets the
 * knobs land on a SUB-grid (1/64 → count step 0.5, 1/128 → 0.25) so they can sit
 * BETWEEN musical divisions (e.g. between 1/32 and 1/16) — quantizeCount snaps free
 * drag to that step; counts stay in 1/32 units so saved projects never rescale.
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

/**
 * Smallest BPM count the sync knobs allow = ONE grid step (1 at 1/32, 0.5 at 1/64,
 * 0.25 at 1/128). Sync knobs use this as their `min` so a finer grid actually
 * lowers the floor below 1/32 — without it the hardcoded min:1 pins everything at
 * 1/32 no matter the grid (the "can't go below 1/32" bug). Follows the live grid.
 */
export function minBpmCount() {
  return _quantStep;
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

// COARSE musical divisions above the dense fine region (in grid units). The fine
// region (everything up to and including 1/4 = 8 units) is filled densely at the
// user's resolution by _buildSnap; these are the larger targets where a per-1/64
// snap would be pointless (you don't want 512 snap points up to 4 bars).
// dotted-1/4, 1/2, dotted-1/2, whole, 2 bars, 4 bars.
const _MUSICAL_COARSE_FRACTIONS = [3 / 8, 1 / 2, 3 / 4, 1, 3 / 2, 2, 3, 4];

// Top of the densely-filled fine region, in grid units (1/4 note = 8 × 1/32).
// Below/at this, shift-snap lands on EVERY step of the user's grid; above it, the
// coarse musical divisions take over.
const _FINE_REGION_TOP = 8;

/**
 * Build the snap-point array for a given finest division (grid units per whole
 * note, 32/64/128). The fine region (≤ 1/4 note) is filled with EVERY step of the
 * user's grid — at 1/32 the whole counts 1..8 (1/32, 1/16, …, 1/4: now incl. the
 * 5/32 and 7/32 the old musical-only set skipped, so shift-snap matches free-drag),
 * at 1/64 every half-unit (1/64 steps), at 1/128 every quarter-unit — so raising
 * the grid fills in the steps BETWEEN 1/32 and 1/16 (and up to 1/4), not just one
 * point below 1/32. Coarse musical divisions above 1/4 are appended unchanged.
 * Sorted ascending, de-duped.
 */
function _buildSnap(finestBase) {
  const step = GRID_BASE / finestBase;         // 1/32→1, 1/64→0.5, 1/128→0.25
  const fine = [];
  for (let v = step; v <= _FINE_REGION_TOP + 1e-9; v += step) fine.push(v);
  const coarse = _MUSICAL_COARSE_FRACTIONS.map(f => f * GRID_BASE);
  // De-dupe the boundary (1/4 = 8 is in `fine`; dotted-1/4 = 12 starts `coarse`).
  const all = [...fine, ...coarse].sort((a, b) => a - b);
  return all.filter((v, i) => i === 0 || Math.abs(v - all[i - 1]) > 1e-9);
}

/**
 * Snap points in grid units (1/32 unit). Shift-dragging a sync knob jumps between
 * these. The fine region (≤ 1/4) is filled at the user's grid resolution, so the
 * default 1/32 set is [1,2,3,4,5,6,7,8, 12,16,24,32,48,64,96,128] and 1/64 fills
 * in the half-steps between. Mutable: `setSnapResolution()` rebuilds it when the
 * user changes the finest-division setting.
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

function _gcd(a, b) { return b < 1e-9 ? a : _gcd(b, a % b); }

/**
 * Name a leftover of `units` 1/32-grid-units as ONE exact fraction of a whole note.
 * units/32 reduced to lowest terms. The finest grid is 1/128 (units multiple of
 * 0.25), so scale to 128ths first to stay integer. 8 → "1/4", 1 → "1/32",
 * 1.25 → "5/128". Denominator side reads "N/1" only for whole notes (handled by the
 * caller), so here the numerator is always < the denominator.
 */
function _fractionName(units) {
  // units of a whole note = units/GRID_BASE. Express over 128ths (4×GRID_BASE) to
  // absorb the 1/64 + 1/128 grid, then reduce.
  const denomBase = GRID_BASE * 4;                   // 128
  let num = Math.round(units * (denomBase / GRID_BASE));  // units → 128ths
  let den = denomBase;
  const g = _gcd(num, den) || 1;
  num /= g; den /= g;
  return `${num}/${den}`;
}

/**
 * Human-readable label for a grid count (in 1/32 units, may be fractional). At most
 * TWO terms: N whole notes ("N/1") + ONE exact fraction remainder. The remainder is
 * shown exactly (reduced), so an odd leftover reads e.g. "2/1 + 5/128":
 *   32 → "1/1"   40 → "1/1 + 1/4"   64 → "2/1"   97 → "3/1 + 1/32"
 *   64.25 → "2/1 + 1/128"   65.25 → "2/1 + 5/128"
 * Sub-whole values are just the fraction ("1/4", "1/64", "5/128").
 */
export function formatCount32(count) {
  const n = Math.max(0, count);
  const wholes = Math.floor(n / GRID_BASE + 1e-9);   // whole notes (1/1 each)
  const rem    = n - wholes * GRID_BASE;              // leftover, 0..<32 units

  const wholeLabel = wholes > 0 ? `${wholes}/1` : null;
  const remLabel   = rem > 1e-6 ? _fractionName(rem) : null;

  if (wholeLabel && remLabel) return `${wholeLabel} + ${remLabel}`;
  if (wholeLabel)             return wholeLabel;
  if (remLabel)               return remLabel;
  return '1/32';                                     // count 0 floor (never < 1/32 in use)
}

/** Map a legacy beat-division string → grid count (for project load). */
export function divToCount32(div) {
  // DIV_QN is in quarter-notes; grid units = qn / GRID_UNIT_QN.
  return Math.round((DIV_QN[div] ?? 1) / GRID_UNIT_QN);
}
