/**
 * BpmSync.js
 * ----------
 * Shared BPM-sync utilities used by DelayFX, ReverbFX, and Arpeggiator.
 *
 * DIV_QN maps beat-division string → quarter-note multiplier.
 * SYNC_DIVISIONS is the canonical ordered list for UI dropdowns.
 * divToSeconds(div, bpm) converts a division string to wall-clock seconds.
 */

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
// Continuous 32nd-note grid (sync-knob model)
// ---------------------------------------------------------------------------
// The unified MS/BPM sync knob expresses BPM mode as an INTEGER COUNT of 1/32
// notes. One 1/32 note = 0.125 quarter-notes. Seconds = count32 * (60/bpm)/8.

/** Quarter-note multiplier of a single 1/32 note. */
export const THIRTYSECOND_QN = 0.125;

/** Convert an integer count of 1/32 notes + BPM to seconds. */
export function count32ToSeconds(count32, bpm) {
  return count32 * THIRTYSECOND_QN * 60 / bpm;
}

/**
 * Musical snap points expressed in 1/32 units. Shift-dragging a sync knob
 * jumps between these (1/32, 1/16, dotted-1/16, 1/8, dotted-1/8, 1/4, …).
 * Derived from DIV_QN plus the dotted variants in between.
 *   1/32=1, 1/16=2, dotted-1/16=3, 1/8=4, dotted-1/8=6, 1/4=8,
 *   dotted-1/4=12, 1/2=16, dotted-1/2=24, 1/1=32, 2/1=64, 4/1=128
 */
export const MUSICAL_SNAP_32 = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];

// Clean fraction names for exact 32nd counts (no remainder).
const _COUNT32_NAME = {
  1: '1/32', 2: '1/16', 4: '1/8', 8: '1/4', 16: '1/2',
  32: '1/1', 64: '2/1', 128: '4/1',
};

/**
 * Human-readable label for a 1/32 count. Exact divisions render clean
 * ("1/4"); otherwise the largest clean division ≤ count plus the 1/32
 * remainder ("1/8 + 1/32", "3/16 + 1/32"). Dotted values fall out naturally
 * as "1/8 + 1/16"-style sums via the remainder logic.
 */
export function formatCount32(count32) {
  const n = Math.max(1, Math.round(count32));
  if (_COUNT32_NAME[n]) return _COUNT32_NAME[n];

  // Largest clean division (in 32nd units) that fits.
  const cleanUnits = Object.keys(_COUNT32_NAME).map(Number).sort((a, b) => b - a);
  const base = cleanUnits.find(u => u <= n) ?? 1;
  const rem  = n - base;
  if (rem === 0) return _COUNT32_NAME[base];
  // Express the base as a multiple of clean divisions where possible, else raw.
  const baseLabel = _COUNT32_NAME[base] ?? `${base}/32`;
  const remLabel  = _COUNT32_NAME[rem]  ?? `${rem}/32`;
  return `${baseLabel} + ${remLabel}`;
}

/** Map a legacy beat-division string → integer 1/32 count (for project load). */
export function divToCount32(div) {
  return Math.round((DIV_QN[div] ?? 1) * 8);
}
