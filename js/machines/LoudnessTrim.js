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
  'kick.analogue': 0.34,  // measured: RMS 0.072 ≈ kick.hard, lands on median (GAIN× 0.96)
  'synth':        0.39,
  'tom.analogue': 0.44,   // measured: imperfect-sine body is loud (RMS 0.154) — pulled to median (peak 0.30, safe)
  'tom':          0.44,   // digital tom: sine+tri body ≈ analogue tom amplitude — START; verify via tests/loudness.html
  'tom.fm':       0.50,   // FM tom: metallic sidebands add harmonics (a touch quieter RMS) — START; verify via tests/loudness.html
  'wavetable':    0.44,
  'bass':         0.46,
  'moogish':      0.42,   // PATINA-derived dual imperfect saws ≈ synth/wavetable level (verify via tests/loudness.html)
  'juno':         0.45,   // 1 PWM osc + square sub ≈ moogish level — START; verify via tests/loudness.html
  'oberish':      0.40,   // 2 detuned oscs (saw+pulse), a touch hotter than moogish — START; verify via tests/loudness.html
  'fold':         0.45,   // wavefolder output level-compensated (_foldOut) ≈ moogish — START; verify via tests/loudness.html
  'marimba':      0.50,
  'fm':           0.57,
  'comb':         0.61,
  'kick.silk':    0.96,

  // ── reference (median) ──
  'chord':        1.00,

  // ── coming UP (quieter than median) ──
  'sample-swarm': 1.31,
  'swarm':        1.55,
  'karplus':      1.49,     // was 1.74; the K-S resonance can peak ~1.05 — pulled down for headroom
  'transient':    2.43,
  'strings':      3.54,

  // ── spiky percussion: capped so peak ≤ ~0.90 (sit below median RMS) ──
  // Noise buffers are now seeded (deterministic) so these peaks are reproducible.
  // Five machines genuinely clipped at full velocity (peak > 0 dBFS) and were
  // pulled down with headroom; the others kept their calibrated values.
  'clapp':        1.21,     // was 1.34; sat exactly at peak 1.000 (bench) — pulled to ~0.90 for headroom
  'snare':        1.42,     // was 1.70; peaks ~1.05 at full vel — scaled to peak ≤0.90
  'snare.analogue': 3.67,   // measured: pink snares quiet (RMS 0.054); capped to peak ≤0.90 (peak 0.78)
  'clapp.analogue': 4.14,   // measured: pink clap very quiet (RMS 0.017) but huge headroom (peak 0.29); capped to peak ≤0.90
  'cymbal':       4.26,     // was 4.89; peak crept to 1.033 at full vel — scaled to peak ≤0.90
  'cymbal.analogue': 4.42,  // measured: at peak ceiling (peak 1.00); held to peak ≤0.90, sits just below cymbal
  'noise':        4.80,     // was 6.87; peak crept over 0 dBFS at full vel — scaled to peak ≤0.90
  'hihat.analogue': 8.17,   // was 11.46; peak crept over 0 dBFS at full vel — scaled to peak ≤0.90
  'wood':         7.14,     // was 12.68; peak crept to 1.599 at full vel — scaled to peak ≤0.90
  'hihat':       10.26,     // was 12.68; peak crept to 1.112 at full vel — scaled to peak ≤0.90
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
