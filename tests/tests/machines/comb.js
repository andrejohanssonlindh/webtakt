/**
 * machines/comb.js — CombMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 1.0;
const STEP_LEN = 4;
const DURATION = 0.05 + STEP_SEC + 0.5;

suite('CombMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('comb', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    assert.gt(rms(windows[0]), 0.001, `Step RMS too low (rms=${rms(windows[0]).toFixed(6)})`);
  });

  test('C4 fundamental is louder at 261 Hz than C5 is at 261 Hz', async () => {
    // The machine synthesises partial 1 at the played note frequency.
    // C4 (261 Hz) should have strong energy at 261 Hz.
    // C5 (523 Hz) has its fundamental at 523 Hz — not 261 Hz — so its
    // bandpassRms at 261 Hz should be much lower than C4's.
    const low  = await makeOfflineTrack('comb', DURATION);
    const high = await makeOfflineTrack('comb', DURATION);
    for (const t of [low.track, high.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
      // Single partial only (mix=0) so the test is unambiguous
      t.machine.setParam('mix', 0);
      t.machine.setParam('ratio', 2.756);
    }

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 72, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  261, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 261, 0.5);

    assert.gt(rLow, rHigh * 3,
      `Comb C4 bandpassRms at 261 Hz should be >> C5 (C4=${rLow.toFixed(5)}, C5=${rHigh.toFixed(5)})`);
  });

});
