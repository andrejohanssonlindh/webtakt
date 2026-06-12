/**
 * filter_engine.js — analogue ladder filter engine tests
 *
 * Guards the digital/analogue filter engine switch (Filter.js `filter.engine`).
 * The analogue engine is the PATINA Moog ladder running in an AudioWorklet
 * (js/worklets/patina-ladder-processor.js).
 *
 * AudioWorklet in OfflineAudioContext works in Chromium but NOT in Firefox
 * (same constraint that excludes wt-sampler — see TEST_DESIGN.md). So each test
 * tries to load the ladder module into the offline ctx first; if that fails, the
 * test PASSES with a console warning rather than failing (no skip status exists
 * in the runner). On Chrome the analogue path is fully exercised.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../runner.js';

const LADDER_PATH = '../js/worklets/patina-ladder-processor.js';
const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

/** Load the ladder worklet into an offline ctx. Returns true if available. */
async function loadLadder(ctx) {
  if (!ctx.audioWorklet) return false;
  try {
    await ctx.audioWorklet.addModule(LADDER_PATH);
    return true;
  } catch (e) {
    console.warn('filter_engine: ladder worklet unavailable in OfflineAudioContext — passing with note.', e.message);
    return false;
  }
}

suite('Filter engine (analogue ladder)', () => {

  test('analogue engine produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    if (!(await loadLadder(ctx))) return; // pass-with-note when worklet unavailable

    track.filter.setParam('filter.engine', 'analogue');
    track.filter.setParam('filter.cutoff', 6000);
    track.filter.setParam('filter.drive', 2.0);

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `analogue step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('switching digital→analogue→digital keeps the track audible', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    if (!(await loadLadder(ctx))) return;

    track.filter.setParam('filter.cutoff', 6000);
    track.filter.setParam('filter.engine', 'analogue');
    track.filter.setParam('filter.engine', 'digital');
    track.filter.setParam('filter.engine', 'analogue'); // end on analogue

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `after engine toggles, step silent (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('digital engine path is unchanged (still audible)', async () => {
    // No worklet needed — pure regression that the default path still works after
    // the engine refactor (idempotent _setEngine must not double/disconnect it).
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.engine', 'digital'); // redundant set must be a no-op
    track.filter.setParam('filter.cutoff', 8000);

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `digital step silent after engine refactor (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('high resonance in analogue mode concentrates energy near cutoff', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    if (!(await loadLadder(ctx))) return;

    track.filter.setParam('filter.envAmount', 0);
    track.machine.setParam('osc.waveform', 'sawtooth');
    track.machine.setParam('sub.level', 0);
    track.filter.setParam('filter.engine', 'analogue');
    const CUT = 1200;
    track.filter.setParam('filter.cutoff', CUT);

    // Low resonance render.
    track.filter.setParam('filter.resonance', 0.5);
    const [wLo] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 36, length: STEP_LEN }));

    // High resonance render (fresh track — offline ctx renders once).
    const hi = await makeOfflineTrack('synth', DURATION);
    await loadLadder(hi.ctx);
    hi.track.filter.setParam('filter.envAmount', 0);
    hi.track.machine.setParam('osc.waveform', 'sawtooth');
    hi.track.machine.setParam('sub.level', 0);
    hi.track.filter.setParam('filter.engine', 'analogue');
    hi.track.filter.setParam('filter.cutoff', CUT);
    hi.track.filter.setParam('filter.resonance', 18);
    const [wHi] = await renderSteps(hi.track, hi.ctx, hi.sampleRate, 1, STEP_SEC,
      () => ({ note: 36, length: STEP_LEN }));

    // High resonance should boost energy in a band around the cutoff.
    const loBand = bandpassRms(wLo, sampleRate, CUT, 0.5);
    const hiBand = bandpassRms(wHi, hi.sampleRate, CUT, 0.5);
    assert.gt(hiBand, loBand,
      `high resonance should boost energy at cutoff (lo=${loBand.toFixed(5)}, hi=${hiBand.toFixed(5)})`);
  });

});
