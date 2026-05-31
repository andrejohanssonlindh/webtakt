/**
 * lfo.js — LFO tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms } from '../runner.js';

const STEP_SEC = 0.25;
const STEP_LEN = 3;
const N_STEPS  = 4;
const DURATION = 0.05 + N_STEPS * STEP_SEC + 0.5;

suite('LFO', () => {

  test('LFO depth=0 produces consistent RMS across notes', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.lfos[0].setParam('lfo.depth', 0);
    track.setLFODestination(0, 'output.level');

    const windows = await renderSteps(track, ctx, sampleRate, N_STEPS, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const rmsList = windows.map(w => rms(w));
    const mean    = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
    const maxDev  = Math.max(...rmsList.map(r => Math.abs(r - mean)));

    assert.lt(maxDev / mean, 0.10,
      `Baseline RMS varies too much (${(maxDev/mean*100).toFixed(1)}%) — LFO may be leaking at depth=0`);
  });

  test('LFO depth=100 on output.level produces RMS variation across notes', async () => {
    // Each 0.25s step catches the LFO at a different phase → different RMS per step.
    // At 3 Hz, one cycle = 0.33s. Over 4 steps of 0.25s, phase advances 270° total
    // — adjacent steps differ by ~90° which gives clearly different instantaneous gain.
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.lfos[0].setParam('lfo.depth', 100);
    track.lfos[0].setParam('lfo.speed', 3);
    track.lfos[0].setParam('lfo.syncMode', 'hz');
    track.setLFODestination(0, 'output.level');

    const windows = await renderSteps(track, ctx, sampleRate, N_STEPS, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const rmsList = windows.map(w => rms(w));
    const maxRms  = Math.max(...rmsList);
    const minRms  = Math.min(...rmsList);

    // The loudest step should be at least 15% louder than the quietest
    assert.gt(maxRms / minRms, 1.15,
      `LFO notes too uniform (max/min ratio=${( maxRms/minRms).toFixed(3)}) — LFO may not be modulating output.level (max=${maxRms.toFixed(4)}, min=${minRms.toFixed(4)})`);
  });

  test('LFO bias shifts the modulation window up/down (mean level: +bias > 0 > -bias)', async () => {
    // output.level base 0.5, depth 50% → amplitude ±0.25 around 0.5.
    //   bias  0   → window [0.25, 0.75]  (symmetric)
    //   bias +100 → window [0.50, 1.00]  (only up)   → higher mean level
    //   bias -100 → window [0.00, 0.50]  (only down) → lower mean level
    // A fast free-running sine averaged over the whole render isolates the DC
    // offset (the oscillation averages out), so mean RMS tracks the window centre.
    async function meanRmsForBias(bias) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setParam('output.level', 0.5);
      track.lfos[0].setParam('lfo.syncMode', 'hz');
      track.lfos[0].setParam('lfo.speed', 8);     // fast → several cycles per step
      track.lfos[0].setParam('lfo.waveform', 'sine');
      track.lfos[0].setParam('lfo.depth', 50);
      track.lfos[0].setParam('lfo.bias', bias);
      track.setLFODestination(0, 'output.level');
      const windows = await renderSteps(track, ctx, sampleRate, N_STEPS, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      const rmsList = windows.map(w => rms(w));
      return rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
    }

    const up   = await meanRmsForBias(100);
    const mid  = await meanRmsForBias(0);
    const down = await meanRmsForBias(-100);

    assert.gt(up, mid * 1.05,
      `+bias should raise mean level above symmetric (up=${up.toFixed(4)}, mid=${mid.toFixed(4)})`);
    assert.gt(mid, down * 1.05,
      `-bias should lower mean level below symmetric (mid=${mid.toFixed(4)}, down=${down.toFixed(4)})`);
  });

  test('LFO TRG mode resets phase — identical renders produce matching RMS per step', async () => {
    async function renderTRG() {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.lfos[0].setParam('lfo.depth', 100);
      track.lfos[0].setParam('lfo.speed', 3);
      track.lfos[0].setParam('lfo.trigMode', 'trig');
      track.lfos[0].setParam('lfo.startPhase', 0);
      track.setLFODestination(0, 'output.level');
      const windows = await renderSteps(track, ctx, sampleRate, N_STEPS, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return windows.map(w => rms(w));
    }

    const run1 = await renderTRG();
    const run2 = await renderTRG();

    for (let i = 0; i < N_STEPS; i++) {
      assert.near(run1[i], run2[i], run1[i] * 0.05,
        `TRG step ${i} not deterministic: run1=${run1[i].toFixed(4)}, run2=${run2[i].toFixed(4)}`);
    }
  });

});
