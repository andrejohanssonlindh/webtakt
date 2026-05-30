/**
 * LoudnessTrim.js
 * ---------------
 * Per-machine loudness normalisation factors.
 *
 * Machines were historically built with wildly different internal amp scaling
 * (e.g. WoodMachine multiplied velocity by 8, HiHatMachine by 1), so at equal
 * `output.level` they came out 30×+ apart in perceived loudness. These factors
 * normalise every machine to a common reference so the kit is balanced.
 *
 * How the numbers were derived
 * ----------------------------
 * Measured by `tests/loudness.html` (the loudness bench): each machine rendered
 * offline under identical conditions (note 60, vel 100, 8 hits, filter open,
 * FX off), measuring peak + RMS. Target = MEDIAN RMS of the set (≈0.068 — the
 * synth/bass/comb middle of the pack). Each factor = target_rms / machine_rms,
 * EXCEPT spiky percussion (clapp, snare, cymbal, hihat, noise, wood) whose
 * factor is capped so the projected peak stays ≤ 0.90 (≈ −0.9 dBFS) — pushing
 * a transient hit to median RMS would clip. Those sit slightly below median
 * RMS by design (a hihat at kick-level RMS would feel too loud anyway).
 *
 * Re-tuning
 * ---------
 * Re-run `tests/loudness.html` after changing any machine's synthesis. The
 * bench reports the suggested factor per machine; update the value here. The
 * trim is applied AFTER `outputGain` (a dedicated node — see makeTrimGain),
 * so it is never touched by `output.level`, p-locks, or LFOs.
 *
 * A factor of 1.0 = no change. Machines absent from this map default to 1.0.
 */

export const LOUDNESS_TRIM = {
  // ── coming DOWN (louder than median) ──
  'kick.hard':    0.34,
  'synth':        0.39,
  'wavetable':    0.44,
  'bass':         0.46,
  'marimba':      0.50,
  'fm':           0.57,
  'comb':         0.61,
  'kick.silk':    0.96,

  // ── reference (median) ──
  'chord':        1.00,

  // ── coming UP (quieter than median) ──
  'sample-swarm': 1.31,
  'swarm':        1.55,
  'karplus':      1.74,
  'transient':    2.43,

  // ── spiky percussion: capped so peak ≤ 0.90 (sit below median RMS) ──
  'clapp':        1.34,
  'snare':        1.70,
  'cymbal':       4.89,
  'noise':        6.87,
  'wood':        12.68,
  'hihat':       12.68,
};

/**
 * Look up the trim factor for a machine type (1.0 if not listed).
 * @param {string} type
 * @returns {number}
 */
export function trimFor(type) {
  return LOUDNESS_TRIM[type] ?? 1.0;
}

/**
 * Create a fixed-gain trim node for a machine and insert it in the output path.
 * The machine should connect its internal chain to `outputGain`, then route
 * `outputGain → trimGain`, and call `trimGain.connect(destination)` in connect().
 *
 * @param {BaseAudioContext} context
 * @param {string} type — machine type, used to look up the factor
 * @returns {GainNode}
 */
export function makeTrimGain(context, type) {
  const g = context.createGain();
  g.gain.value = trimFor(type);
  return g;
}
