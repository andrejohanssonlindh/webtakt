/**
 * machines/fm.js — FMMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('FMMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('fm', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('C4 note has more amplitude at its fundamental than C6', async () => {
    // Disable modulation so carrier = pure sine at note frequency.
    // bandpassRms at 261 Hz (C4) should be >> when note=60 vs note=84 (C6=1047 Hz).
    const low  = await makeOfflineTrack('fm', DURATION);
    const high = await makeOfflineTrack('fm', DURATION);
    for (const t of [low.track, high.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
      t.machine.setParam('op2.level', 0);
      t.machine.setParam('op3.level', 0);
      t.machine.setParam('op4.level', 0);
    }

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 84, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  261, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 261, 0.5);

    assert.gt(rLow, rHigh * 3,
      `FM C4 bandpassRms at 261 Hz should be >> C6 (C4=${rLow.toFixed(5)}, C6=${rHigh.toFixed(5)})`);
  });

  test('op2 modulator level=1.0 spreads energy across more frequencies than level=0', async () => {
    const dry = await makeOfflineTrack('fm', DURATION);
    dry.track.filter.setParam('filter.cutoff', 20000);
    dry.track.machine.setParam('op2.level', 0);
    dry.track.machine.setParam('op3.level', 0);
    dry.track.machine.setParam('op4.level', 0);

    const wet = await makeOfflineTrack('fm', DURATION);
    wet.track.filter.setParam('filter.cutoff', 20000);
    wet.track.machine.setParam('op2.level', 1.0);

    const [wDry] = await renderSteps(dry.track, dry.ctx, dry.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wWet] = await renderSteps(wet.track, wet.ctx, wet.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    const eDrySide = bandEnergy(wDry, dry.sampleRate, 1000, 10000);
    const eWetSide = bandEnergy(wWet, wet.sampleRate, 1000, 10000);

    assert.gt(eWetSide, eDrySide * 2,
      `FM with op2.level=1 should have more sideband energy >1kHz (wet=${eWetSide.toFixed(0)}, dry=${eDrySide.toFixed(0)})`);
  });

});
