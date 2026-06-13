/**
 * BpmSync.js
 * ----------
 * Shared BPM-sync utilities.
 *
 * The unified sync-knob model (see design/sync-knob-rollout.md) expresses BPM
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
 */

/**
 * Grid units per WHOLE note. The base resolution of the entire BPM-sync model.
 * 32 ⇒ one grid unit = one 1/32 note (the historical/stored unit). Everything
 * below — quarter-note multiplier, musical snap points, division names — is
 * derived from this, so bumping it rescales the grid in one edit.
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
 * FX sync knobs sweep a SUB-grid this many steps finer than the base grid, so
 * they can land between musical divisions (the gap the user hit between 1/32 and
 * 1/16). At 16, there are 15 sub-steps between adjacent base-grid units. Stored
 * counts become fractional (multiples of 1/FINE_STEP) — count32ToSeconds and
 * formatCount32 both handle fractional input. Envelopes/LFO/arp keep integer
 * counts (they don't opt into the sub-grid), so their stored defaults are
 * unchanged.
 */
export const FINE_STEP = 16;

/** Smallest fractional grid increment the FX sync knobs move in. */
export const FINE_INCREMENT = 1 / FINE_STEP;

/** Convert a grid count (may be fractional) + BPM to seconds. */
export function count32ToSeconds(count, bpm) {
  return count * GRID_UNIT_QN * 60 / bpm;
}

// Musical divisions as a fraction of a whole note → grid units (× GRID_BASE).
// 1/32, 1/16, dotted-1/16, 1/8, dotted-1/8, 1/4, dotted-1/4, 1/2, dotted-1/2,
// whole, 2 bars, 4 bars. Derived from GRID_BASE so they track the resolution.
const _MUSICAL_WHOLE_FRACTIONS = [
  1 / 32, 1 / 16, 3 / 32, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2,
  3 / 4, 1, 3 / 2, 2, 3, 4,
];

/**
 * Musical snap points in grid units. Shift-dragging a sync knob jumps between
 * these (1/32, 1/16, dotted-1/16, 1/8, …). Derived from GRID_BASE so raising
 * the resolution keeps the same musical targets at finer counts.
 */
export const MUSICAL_SNAP_32 = _MUSICAL_WHOLE_FRACTIONS.map(f => f * GRID_BASE);

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

/**
 * Human-readable label for a grid count (may be fractional). Exact divisions
 * render clean ("1/4"); otherwise the largest clean division ≤ count plus the
 * remainder ("1/8 + 1/32", "3/16 + 1/32"). Fractional sub-grid values append a
 * "·N" fine-step suffix so the knob shows movement between divisions.
 */
export function formatCount32(count) {
  const n = Math.max(FINE_INCREMENT, count);
  // Snap to the fine grid first, then split into whole + fine remainder so a
  // value like 8.9999 reads as "1/4" (9 → next whole), not "1/8 ·16".
  const fineTotal = Math.round(n * FINE_STEP);
  const whole   = Math.floor(fineTotal / FINE_STEP);
  const fineRem = fineTotal - whole * FINE_STEP;
  if (whole === 0) {
    // Sub-one-unit value (only reachable on the fine FX sub-grid).
    return `1/${GRID_BASE} ·-${FINE_STEP - fineRem}`;
  }
  const baseLabel = _formatWholeCount(whole);
  if (fineRem === 0) return baseLabel;
  return `${baseLabel} ·${fineRem}`;
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
