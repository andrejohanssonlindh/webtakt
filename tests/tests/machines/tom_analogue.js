/**
 * machines/tom_analogue.js — AnalogueTomMachine tests
 *
 * A tuned analogue drum (imperfect-sine body + pitch sweep + pink attack).
 * Checks audibility and that low/mid energy is present (the tom body).
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('AnalogueTomMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('low/mid-frequency body present', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const body = bandEnergy(w, sampleRate, 60, 500);
    assert.gt(body, 0, `Tom should have low/mid body energy (60–500 Hz), got ${body.toFixed(0)}`);
  });

});
