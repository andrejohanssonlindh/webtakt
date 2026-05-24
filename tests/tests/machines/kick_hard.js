/**
 * machines/kick_hard.js — KickHardMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('KickHardMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('kick.hard', DURATION);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('low-frequency energy present in early transient', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('kick.hard', DURATION);
    track.filter.setParam('filter.cutoff', 20000);

    const startTime = 0.05;
    const { Step } = await import('../../../js/sequencer/Step.js');
    const step = new Step(0);
    step.active = true; step.note = 60; step.length = 2;
    track.sequencer._fireStep(step, startTime);
    const rendered = await ctx.startRendering();
    const full = rendered.getChannelData(0);

    const hitStart = Math.floor(startTime * sampleRate);
    const hitEnd   = hitStart + Math.floor(0.08 * sampleRate);
    const w = full.slice(hitStart, hitEnd);

    const lo = bandEnergy(w, sampleRate, 20, 300);
    assert.gt(lo, 0, `Kick.hard should have low-frequency energy (lo=${lo.toFixed(0)})`);
  });

});
