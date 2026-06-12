/**
 * machines/snare_analogue.js — AnalogueSnareMachine tests
 *
 * Mirrors snare.js: the analogue snare shares Snare's two-layer structure
 * (tuned body + HP-filtered noise), so the audibility + mid-band checks apply.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('AnalogueSnareMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('snare.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('has significant mid-frequency content (snare character)', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('snare.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const mid = bandEnergy(w, sampleRate, 200, 4000);
    assert.gt(mid, 0, `Snare should have mid-frequency energy (200–4000 Hz), got ${mid.toFixed(0)}`);
  });

});
