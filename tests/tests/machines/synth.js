/**
 * machines/synth.js — SynthMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('SynthMachine', () => {

  test('produces audible output on noteOn', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('C2 note has more amplitude at its fundamental than C5', async () => {
    // bandpassRms at 65 Hz (C2 fundamental). C5=523 Hz has near-zero amplitude there.
    const low  = await makeOfflineTrack('synth', DURATION);
    const high = await makeOfflineTrack('synth', DURATION);
    low.track.filter.setParam('filter.cutoff', 20000);
    high.track.filter.setParam('filter.cutoff', 20000);
    low.track.filter.setParam('filter.envAmount', 0);
    high.track.filter.setParam('filter.envAmount', 0);
    low.track.machine.setParam('sub.level', 0);
    high.track.machine.setParam('sub.level', 0);

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 36, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 72, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  65, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 65, 0.5);

    assert.gt(rLow, rHigh * 3,
      `C2 bandpassRms at 65 Hz should be >> C5 (C2=${rLow.toFixed(5)}, C5=${rHigh.toFixed(5)})`);
  });

  test('sawtooth has more amplitude at 2nd harmonic than sine', async () => {
    // Both at C4 (261 Hz), sub off, filter open.
    // Sine: zero energy above fundamental.
    // Sawtooth: strong 2nd harmonic at 522 Hz.
    const sineT = await makeOfflineTrack('synth', DURATION);
    sineT.track.filter.setParam('filter.cutoff', 20000);
    sineT.track.filter.setParam('filter.envAmount', 0);
    sineT.track.machine.setParam('osc.waveform', 'sine');
    sineT.track.machine.setParam('sub.level', 0);

    const sawT = await makeOfflineTrack('synth', DURATION);
    sawT.track.filter.setParam('filter.cutoff', 20000);
    sawT.track.filter.setParam('filter.envAmount', 0);
    sawT.track.machine.setParam('osc.waveform', 'sawtooth');
    sawT.track.machine.setParam('sub.level', 0);

    const [wSine] = await renderSteps(sineT.track, sineT.ctx, sineT.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wSaw]  = await renderSteps(sawT.track,  sawT.ctx,  sawT.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    const rSine = bandpassRms(wSine, sineT.sampleRate, 522, 0.5);
    const rSaw  = bandpassRms(wSaw,  sawT.sampleRate,  522, 0.5);

    assert.gt(rSaw, rSine * 3,
      `Sawtooth should have much more 2nd-harmonic (522 Hz) amplitude than sine (saw=${rSaw.toFixed(5)}, sine=${rSine.toFixed(5)})`);
  });

});
