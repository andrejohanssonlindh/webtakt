/**
 * machines/kick_silk.js — KickSilkMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

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

  test('note tracking: octave up raises the body pitch (C4 = neutral)', async () => {
    // Same tune; note 60 (C4, neutral) vs note 72 (one octave up = 2× freq).
    // Sweep is disabled so the body holds a steady pitch (no transient to smear
    // the measurement), and we use bandpassRms (absolute energy in a band) since
    // bandEnergy peak-normalises and would read equal for two pure-ish tones.
    const mkHit = async (note) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('kick.silk', DURATION);
      track.machine.setParam('tune', 100);  // C4 = 100 Hz, C5 = 200 Hz
      track.machine.setParam('sweep', 1);    // no pitch sweep — steady body
      track.machine.setParam('punch', 0);    // isolate the sine body
      track.machine.setParam('decay', 0.4);
      track.filter.setParam('filter.cutoff', 20000);
      const startTime = 0.05;
      const { Step } = await import('../../../js/sequencer/Step.js');
      const step = new Step(0);
      step.active = true; step.note = note; step.length = 2;
      track.sequencer._fireStep(step, startTime);
      const rendered = await ctx.startRendering();
      const hitStart = Math.floor(startTime * sampleRate);
      const hitEnd   = hitStart + Math.floor(0.1 * sampleRate);
      return { w: rendered.getChannelData(0).slice(hitStart, hitEnd), sampleRate };
    };

    const c4 = await mkHit(60);   // body ≈ 100 Hz
    const c5 = await mkHit(72);   // body ≈ 200 Hz
    // C4 energy should dominate the 100 Hz band; C5 should dominate the 200 Hz band.
    const c4_at100 = bandpassRms(c4.w, c4.sampleRate, 100, 0.5);
    const c4_at200 = bandpassRms(c4.w, c4.sampleRate, 200, 0.5);
    const c5_at100 = bandpassRms(c5.w, c5.sampleRate, 100, 0.5);
    const c5_at200 = bandpassRms(c5.w, c5.sampleRate, 200, 0.5);
    assert.gt(c4_at100, c4_at200, `C4 body should sit near 100 Hz (100=${c4_at100.toFixed(4)}, 200=${c4_at200.toFixed(4)})`);
    assert.gt(c5_at200, c5_at100, `C5 body should sit near 200 Hz (200=${c5_at200.toFixed(4)}, 100=${c5_at100.toFixed(4)})`);
    assert.gt(c5_at200, c4_at200, `note 72 should have more 200 Hz energy than note 60 (c5=${c5_at200.toFixed(4)}, c4=${c4_at200.toFixed(4)})`);
  });

});
