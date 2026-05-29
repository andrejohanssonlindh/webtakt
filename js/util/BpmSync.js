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
