/**
 * machines/hihat_analogue.js — AnalogueHiHatMachine tests
 *
 * Mirrors hihat.js: the analogue hi-hat shares HiHat's six-oscillator cluster
 * through an HP filter, so audibility + high-band concentration checks apply.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('AnalogueHiHatMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('hihat.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.0001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('energy concentrated in high frequencies (hi-hat character)', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('hihat.analogue', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const lo = bandEnergy(w, sampleRate, 20,   500);
    const hi = bandEnergy(w, sampleRate, 3000, 20000);

    assert.gt(hi, lo, `Hi-hat should have more high energy (hi=${hi.toFixed(0)}) than low (lo=${lo.toFixed(0)})`);
  });

});
