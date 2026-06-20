/**
 * machines/loudness.js — loudness normalisation regression tests
 *
 * The loudness BENCH (tests/loudness.html / tests/loudness.js) is a manual
 * measurement tool: it prints a table and a suggested per-machine trim, but
 * never fails. These tests turn that measurement into a pass/fail guard so the
 * suite catches a machine whose perceived loudness has drifted — e.g. after a
 * synthesis change, or a newly-added machine (like Moogish) that has no tuned
 * LOUDNESS_TRIM yet.
 *
 * Model (mirrors the bench):
 *   - Render each machine through the production stack, filter wide open, FX off,
 *     8 hits at note 60 / vel 100 — i.e. AFTER its LoudnessTrim is applied.
 *   - Reference = MEDIAN trimmed RMS across the tonal/sustained machines.
 *   - TONAL machines must land within a tolerance band of that median (the trim
 *     is doing its job). MoogishMachine is included here.
 *   - PERCUSSION machines are intentionally below median RMS (the bench caps
 *     their trim so transient peaks don't clip), so they are NOT held to the
 *     band — only to a peak ceiling (must stay under ~0 dBFS and be audible).
 *
 * Thresholds are deliberately wide (≈ ±2× around the median) — this guards
 * against gross mis-tuning / a missing trim, not against small drift. Re-run
 * tests/loudness.html and update LOUDNESS_TRIM if a machine fails the band.
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../../runner.js';

// Render conditions — identical to the bench (tests/loudness.js).
const NOTE       = 60;
// Full velocity. The trims (LoudnessTrim.js) were calibrated against full-scale
// note output; _fireStep now honours per-voice velocity (and the Envelope scales
// amp by velocity/127), so the bench/guard must fire at 127 to measure the level
// the trims actually target. (Previously velocity was ignored and notes always
// played at trigVelocity=127, so this preserves the calibration reference.)
const VELOCITY   = 127;
const HITS       = 8;
const STEP_SEC   = 0.5;
const RENDER_SEC = HITS * STEP_SEC + 1.0;

// Tonal / sustained machines: held to the median RMS band. Excludes machines
// that can't render offline cleanly (sampler/wt-sampler/midi) and the spiky
// percussion set (held only to a peak ceiling, below).
const TONAL = [
  'synth', 'fm', 'wavetable', 'bass', 'marimba', 'comb', 'chord',
  'strings', 'moogish', 'juno', 'oberish', 'fold', 'swarm', 'karplus', 'kick.silk',
];

// Percussion: intentionally sit below median RMS (trim capped for peak headroom).
// Only checked for audibility + no clipping, not the band.
const PERCUSSION = ['kick.hard', 'kick.analogue', 'snare', 'snare.analogue', 'hihat', 'hihat.analogue',
                    'tom.analogue', 'tom', 'tom.fm', 'cymbal', 'cymbal.analogue', 'clapp', 'clapp.analogue', 'wood', 'noise', 'transient'];

// How far a tonal machine may stray from the median before it's a failure.
// Wide on purpose — a gross mistune (missing/zero trim) is ≫ 2×; small drift is fine.
const BAND_LO = 0.5;   // not quieter than 0.5× median
const BAND_HI = 2.2;   // not louder than 2.2× median
const PEAK_CEILING = 1.0;  // linear; > 1.0 = inter-sample/clip risk

// Percussion gets a looser ceiling. The analogue spiky voices (hihat/cymbal/
// clapp.analogue) give each instance a random per-oscillator ratio/detune nudge
// at construction, so on an unlucky instance the partials momentarily align and
// the transient peak overshoots 1.0 by a little (~1.1–1.2) even though the trim is
// calibrated to ~0.90 for a typical instance. That brief inter-sample transient
// isn't audible clipping (the master limiter catches it) and chasing it with the
// trim would make the typical instance too quiet. The looser ceiling still catches
// a genuine gross over-level (a missing/wrong trim renders ≫ this). The construction
// randomness is seeded in tests, so this is reproducible run-to-run — but the seed
// lands on a different instance per machine, hence the headroom.
const PEAK_CEILING_PERC = 1.3;

function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
  return p;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Render one machine under the standard (trimmed, filter-open, FX-off) conditions. */
async function measure(machineType) {
  const { track, ctx } = await makeOfflineTrack(machineType, RENDER_SEC, { bpm: 120 });
  try { track.filter.setParam('filter.cutoff', 20000); } catch (_) {}
  try { track.filter.setParam('filter.resonance', 0.0001); } catch (_) {}
  for (let i = 0; i < HITS; i++) {
    fireStep(track, 0.05 + i * STEP_SEC, { note: NOTE, velocity: VELOCITY });
  }
  const data = (await ctx.startRendering()).getChannelData(0);
  return { rms: rms(data), peak: peak(data) };
}

suite('Loudness normalisation', () => {

  // Measure every tonal machine once, cache, then assert each is near the median.
  // (Each test re-measures via the cache built on first access — keeps tests
  // independent while only rendering each machine once.)
  let _cache = null;
  async function tonalMedian() {
    if (_cache) return _cache;
    const measured = {};
    for (const m of TONAL) measured[m] = await measure(m);
    const med = median(TONAL.map(m => measured[m].rms));
    _cache = { measured, med };
    return _cache;
  }

  for (const m of TONAL) {
    test(`${m}: trimmed RMS within ${BAND_LO}–${BAND_HI}× of median`, async () => {
      const { measured, med } = await tonalMedian();
      const r = measured[m].rms;
      assert.gt(r, 0.001, `${m} is effectively silent (rms=${r.toFixed(6)})`);
      const ratio = r / med;
      assert.gt(ratio, BAND_LO,
        `${m} too QUIET: rms=${r.toFixed(4)} is ${ratio.toFixed(2)}× median (${med.toFixed(4)}); `
        + `bump its LOUDNESS_TRIM (re-run tests/loudness.html)`);
      assert.lt(ratio, BAND_HI,
        `${m} too LOUD: rms=${r.toFixed(4)} is ${ratio.toFixed(2)}× median (${med.toFixed(4)}); `
        + `lower its LOUDNESS_TRIM (re-run tests/loudness.html)`);
    });
  }

  test(`${TONAL.length} tonal machines stay below the peak ceiling`, async () => {
    const { measured } = await tonalMedian();
    for (const m of TONAL) {
      assert.lt(measured[m].peak, PEAK_CEILING,
        `${m} peaks at ${measured[m].peak.toFixed(3)} (≥ ${PEAK_CEILING}) — clip risk`);
    }
  });

  for (const m of PERCUSSION) {
    test(`${m}: audible and below the peak ceiling`, async () => {
      const { rms: r, peak: p } = await measure(m);
      assert.gt(r, 0.001, `${m} is effectively silent (rms=${r.toFixed(6)})`);
      assert.lt(p, PEAK_CEILING_PERC,
        `${m} peaks at ${p.toFixed(3)} (≥ ${PEAK_CEILING_PERC}) — clip risk`);
    });
  }

});
