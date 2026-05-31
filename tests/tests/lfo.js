/**
 * lfo.js — LFO tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, spectralCentroid } from '../runner.js';

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

  test('LFO on filter.cutoff at full depth reaches the ceiling from a LOW base (bias +100 opens, -100 stays dark)', async () => {
    // Regression for two cutoff bugs:
    //   1) Linear-Hz LFO: down darkened far harder than up brightened, and could
    //      slam a lowpass to 0 Hz.
    //   2) Detune with a FIXED ±N octaves: from a low base, base·2^N stays low, so
    //      full depth still couldn't reach 20 kHz ("darker at the bottom, never
    //      caps to the roof"). Fixed by scaling depth to the full log range.
    // Setup: base cutoff pinned LOW (60 Hz). With a square LFO at 100% depth and
    // bias +100, the bright half must open the filter all the way up — a high
    // spectral centroid — even though the base is near the floor. Bias -100 keeps
    // the same note dark. We read the settled first half-cycle of each.
    const SR_DUR = 1.0;

    async function brightnessForBias(bias) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', SR_DUR);
      track.filter.setParam('filter.type', 'lowpass');
      track.filter.setParam('filter.cutoff', 60);    // base near the floor
      track.filter.setParam('filter.envAmount', 0);   // isolate the LFO from the filter env
      track.lfos[0].setParam('lfo.waveform', 'square');
      track.lfos[0].setParam('lfo.syncMode', 'hz');
      track.lfos[0].setParam('lfo.speed', 2);          // half-cycle = 0.25s
      track.lfos[0].setParam('lfo.depth', 100);
      track.lfos[0].setParam('lfo.bias', bias);
      track.lfos[0].setParam('lfo.trigMode', 'trig');
      track.lfos[0].setParam('lfo.startPhase', 0);
      track.setLFODestination(0, 'filter.cutoff');

      const [full] = await renderSteps(track, ctx, sampleRate, 1, SR_DUR - 0.1,
        () => ({ note: 48, length: 64 }), 0.05);
      // Square +bias holds the bright plateau for the first half-cycle; read its
      // settled middle (0.12–0.28s after note-on), skipping the detune ramp.
      const a = Math.floor(0.12 * sampleRate);
      const b = Math.floor(0.28 * sampleRate);
      const win = full.slice(a, b);
      return { centroid: spectralCentroid(win, sampleRate), rms: rms(win) };
    }

    const up   = await brightnessForBias(100);   // only-up: must reach bright
    const down = await brightnessForBias(-100);  // only-down: must stay dark

    // From a 60 Hz base, the up-sweep must open well past a few kHz — proof the
    // sweep reaches toward the ceiling rather than topping out near the base.
    assert.gt(up.centroid, 3000,
      `bias +100 from low base did not open the filter (centroid=${up.centroid.toFixed(0)}Hz) — sweep not reaching the ceiling`);

    // Directionality is best read as ENERGY through the filter, not centroid:
    // bias -100 holds the cutoff at the 60 Hz base, which passes almost nothing
    // of a note at MIDI 48 (~130 Hz) and its harmonics — the output is near
    // silence, whose spectral centroid is dominated by numerical noise and so is
    // meaningless. So compare how much sound gets through: only-up must pass much
    // more than only-down.
    assert.gt(up.rms, down.rms * 3,
      `bias should be directional (up passes far more energy than down) — up.rms=${up.rms.toFixed(5)}, down.rms=${down.rms.toFixed(5)}`);
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
