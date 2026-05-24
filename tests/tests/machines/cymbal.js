/**
 * machines/cymbal.js — CymbalMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.8;

suite('CymbalMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('cymbal', DURATION);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.0001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('energy concentrated in high frequencies', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('cymbal', DURATION);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const lo = bandEnergy(w, sampleRate, 20, 500);
    const hi = bandEnergy(w, sampleRate, 3000, 20000);

    assert.gt(hi, lo, `Cymbal should be high-freq dominant (hi=${hi.toFixed(0)}, lo=${lo.toFixed(0)})`);
  });

});
