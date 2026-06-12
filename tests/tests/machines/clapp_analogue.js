/**
 * machines/clapp_analogue.js — AnalogueClappMachine tests
 *
 * Mirrors the clap topology: three pink-noise bursts through a shared bandpass.
 * Checks audibility and that energy sits in the bandpass region (mid band).
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('AnalogueClappMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('clapp.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('has mid-band energy (bandpass clap character)', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('clapp.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const mid = bandEnergy(w, sampleRate, 800, 5000);
    assert.gt(mid, 0, `Clap should have mid-band energy (800–5000 Hz), got ${mid.toFixed(0)}`);
  });

});
