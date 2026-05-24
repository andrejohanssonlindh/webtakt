/**
 * machines/bass.js — BassMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('BassMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('bass', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 40, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('C4 note has more amplitude at its fundamental than C6', async () => {
    // C4=261 Hz. bandpassRms at 261 Hz should be >> for note 60 vs note 84.
    const low  = await makeOfflineTrack('bass', DURATION);
    const high = await makeOfflineTrack('bass', DURATION);
    for (const t of [low.track, high.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
      t.machine.setParam('sub.level', 0);
    }

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 84, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  261, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 261, 0.5);

    assert.gt(rLow, rHigh * 3,
      `Bass C4 bandpassRms at 261 Hz should be >> C6 (C4=${rLow.toFixed(5)}, C6=${rHigh.toFixed(5)})`);
  });

  test('drive increases high-frequency energy', async () => {
    const clean = await makeOfflineTrack('bass', DURATION);
    clean.track.filter.setParam('filter.cutoff', 20000);
    clean.track.machine.setParam('drive', 0);

    const driven = await makeOfflineTrack('bass', DURATION);
    driven.track.filter.setParam('filter.cutoff', 20000);
    driven.track.machine.setParam('drive', 1.0);

    const [wClean]  = await renderSteps(clean.track,  clean.ctx,  clean.sampleRate,  1, STEP_SEC, () => ({ note: 48, length: STEP_LEN }));
    const [wDriven] = await renderSteps(driven.track, driven.ctx, driven.sampleRate, 1, STEP_SEC, () => ({ note: 48, length: STEP_LEN }));

    const eClean  = bandEnergy(wClean,  clean.sampleRate,  1000, 10000);
    const eDriven = bandEnergy(wDriven, driven.sampleRate, 1000, 10000);

    assert.gt(eDriven, eClean,
      `Drive=1.0 should add harmonics above 1kHz (driven=${eDriven.toFixed(0)}, clean=${eClean.toFixed(0)})`);
  });

});
