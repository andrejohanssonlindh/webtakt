/**
 * plocks.js — P-lock tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 8 * STEP_SEC + 0.5;

suite('P-locks', () => {

  test('filter.cutoff p-lock — high cutoff steps have more high-frequency energy', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 400);
    track.filter.setParam('filter.slope', 1);
    track.filter.setParam('filter.envAmount', 0);

    const windows = await renderSteps(track, ctx, sampleRate, 8, STEP_SEC, i => ({
      note:   60,
      length: STEP_LEN,
      plocks: i % 2 === 1 ? new Map([['filter.cutoff', 12000]]) : undefined,
    }));

    const evenEnergy = windows.filter((_, i) => i % 2 === 0).map(w => bandpassRms(w, sampleRate, 2000, 1));
    const oddEnergy  = windows.filter((_, i) => i % 2 === 1).map(w => bandpassRms(w, sampleRate, 2000, 1));

    const evenMean = evenEnergy.reduce((a, b) => a + b, 0) / evenEnergy.length;
    const oddMean  = oddEnergy.reduce((a, b) => a + b, 0) / oddEnergy.length;

    assert.gt(oddMean, evenMean * 1.5,
      `P-locked cutoff=12000 should have more energy at 2kHz than baseline cutoff=400 (p-lock=${oddMean.toFixed(5)}, baseline=${evenMean.toFixed(5)})`);
  });

  test('filter.cutoff p-lock restores — step after p-lock resembles baseline', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 400);
    track.filter.setParam('filter.slope', 1);
    track.filter.setParam('filter.envAmount', 0);
    // Kill filter envelope so it doesn't sweep cutoff during the step window
    track.envelope.setParam('fenv.attack',  0.001);
    track.envelope.setParam('fenv.decay',   0.001);
    track.envelope.setParam('fenv.sustain', 0);

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC, i => ({
      note:   60,
      length: STEP_LEN,
      plocks: i === 1 ? new Map([['filter.cutoff', 12000]]) : undefined,
    }));

    const e0 = bandpassRms(windows[0], sampleRate, 2000, 1);
    const e1 = bandpassRms(windows[1], sampleRate, 2000, 1);
    const e2 = bandpassRms(windows[2], sampleRate, 2000, 1);

    assert.gt(e1, e0 * 1.5,
      `P-lock step should open filter vs baseline (e0=${e0.toFixed(5)}, e1=${e1.toFixed(5)})`);
    assert.lt(e2, e1 * 0.8,
      `After p-lock, filter should restore toward baseline (e1=${e1.toFixed(5)}, e2=${e2.toFixed(5)})`);
  });

  test('output.level p-lock — high level steps have more RMS', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.machine.setParam('output.level', 0.2);

    const windows = await renderSteps(track, ctx, sampleRate, 8, STEP_SEC, i => ({
      note:   60,
      length: STEP_LEN,
      plocks: i % 2 === 1 ? new Map([['output.level', 1.0]]) : undefined,
    }));

    const evenRms = windows.filter((_, i) => i % 2 === 0).map(w => rms(w));
    const oddRms  = windows.filter((_, i) => i % 2 === 1).map(w => rms(w));

    const evenMean = evenRms.reduce((a, b) => a + b, 0) / evenRms.length;
    const oddMean  = oddRms.reduce((a, b) => a + b, 0) / oddRms.length;

    assert.gt(oddMean, evenMean * 1.5,
      `P-locked output.level=1.0 should be louder than baseline 0.2 (p-lock=${oddMean.toFixed(4)}, baseline=${evenMean.toFixed(4)})`);
  });

});
