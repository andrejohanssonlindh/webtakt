/**
 * machines/karplus.js — KarplusMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.5;
const STEP_LEN = 4;
const DURATION = 0.05 + 4 * STEP_SEC + 0.8;

suite('KarplusMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('karplus', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.0001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('C4 note has more amplitude at its fundamental than C6', async () => {
    // Karplus resonates at tuned delay frequency. C4=261 Hz, bandpassRms at 261 Hz >> C6.
    const low  = await makeOfflineTrack('karplus', DURATION);
    const high = await makeOfflineTrack('karplus', DURATION);
    for (const t of [low.track, high.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
    }

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 84, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  261, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 261, 0.5);

    assert.gt(rLow, rHigh * 2,
      `Karplus C4 bandpassRms at 261 Hz should be >> C6 (C4=${rLow.toFixed(5)}, C6=${rHigh.toFixed(5)})`);
  });

});
