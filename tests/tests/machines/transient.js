/**
 * machines/transient.js — TransientMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('TransientMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('transient', DURATION);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.0001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

});
