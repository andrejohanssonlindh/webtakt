/**
 * machines/kick_silk.js — KickSilkMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('KickSilkMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('kick.silk', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('low-frequency energy present at trigger (kick character)', async () => {
    // Measure the first 20ms only — the sine body is loudest right at the attack.
    const { track, ctx, sampleRate } = await makeOfflineTrack('kick.silk', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.machine.setParam('punch', 0);  // disable noise punch so we isolate the sine body

    const startTime = 0.05;
    const { Step } = await import('../../../js/sequencer/Step.js');
    const step = new Step(0);
    step.active = true; step.note = 60; step.length = 2;
    track.sequencer._fireStep(step, startTime);

    const rendered = await ctx.startRendering();
    const full = rendered.getChannelData(0);

    // 20ms window at the hit
    const hitStart = Math.floor(startTime * sampleRate);
    const hitEnd   = hitStart + Math.floor(0.02 * sampleRate);
    const w = full.slice(hitStart, hitEnd);

    const lo = bandEnergy(w, sampleRate, 20, 300);
    assert.gt(lo, 0, `Kick.silk should have low-frequency energy at attack (lo=${lo.toFixed(0)})`);
    assert.gt(rms(w), 0.001, `Kick.silk attack window is silent (rms=${rms(w).toFixed(6)})`);
  });

  test('higher tune produces higher low-frequency peak', async () => {
    // tune=30 Hz vs tune=120 Hz — the 60–200 Hz band should have more energy at tune=120
    const low  = await makeOfflineTrack('kick.silk', DURATION);
    low.track.machine.setParam('tune', 30);
    low.track.machine.setParam('punch', 0);
    low.track.filter.setParam('filter.cutoff', 20000);

    const high = await makeOfflineTrack('kick.silk', DURATION);
    high.track.machine.setParam('tune', 120);
    high.track.machine.setParam('punch', 0);
    high.track.filter.setParam('filter.cutoff', 20000);

    const startTime = 0.05;
    for (const { track, ctx, sampleRate, result } of [
      { ...low,  result: 'low'  },
      { ...high, result: 'high' },
    ]) {
      const { Step } = await import('../../../js/sequencer/Step.js');
      const step = new Step(0);
      step.active = true; step.note = 60; step.length = 2;
      track.sequencer._fireStep(step, startTime);
    }

    const rLow  = await low.ctx.startRendering();
    const rHigh = await high.ctx.startRendering();

    const hitStart = Math.floor(startTime * low.sampleRate);
    const hitEnd   = hitStart + Math.floor(0.05 * low.sampleRate);
    const wLow  = rLow.getChannelData(0).slice(hitStart, hitEnd);
    const wHigh = rHigh.getChannelData(0).slice(hitStart, hitEnd);

    // tune=120 Hz should have more energy in 80–200 Hz band than tune=30
    const eLow  = bandEnergy(wLow,  low.sampleRate,  80, 200);
    const eHigh = bandEnergy(wHigh, high.sampleRate, 80, 200);

    assert.gt(eHigh, eLow,
      `tune=120 should have more 80–200 Hz energy than tune=30 (high=${eHigh.toFixed(0)}, low=${eLow.toFixed(0)})`);
  });

});
