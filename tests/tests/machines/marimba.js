/**
 * machines/marimba.js — MarimbaMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 2.5;  // long enough to capture fundamental decay
const STEP_LEN = 4;
const DURATION = 0.05 + STEP_SEC + 0.5;

suite('MarimbaMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('marimba', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    assert.gt(rms(windows[0]), 0.001, `Step RMS too low (rms=${rms(windows[0]).toFixed(6)})`);
  });

  test('C4 fundamental is louder at 261 Hz than C5 is at 261 Hz', async () => {
    // Partial 1 is at the played note frequency. C4 (261 Hz) should have
    // strong energy at 261 Hz; C5 (523 Hz) should have very little.
    const low  = await makeOfflineTrack('marimba', DURATION);
    const high = await makeOfflineTrack('marimba', DURATION);
    for (const t of [low.track, high.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
      // Suppress overtones so only the fundamental contributes to the measurement
      t.machine.setParam('p2level', 0);
      t.machine.setParam('p3level', 0);
      t.machine.setParam('mallet',  0);
    }

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 72, length: STEP_LEN }));

    const rLow  = bandpassRms(wLow,  low.sampleRate,  261, 0.5);
    const rHigh = bandpassRms(wHigh, high.sampleRate, 261, 0.5);

    assert.gt(rLow, rHigh * 3,
      `Marimba C4 bandpassRms at 261 Hz should be >> C5 (C4=${rLow.toFixed(5)}, C5=${rHigh.toFixed(5)})`);
  });

  test('second partial appears at p2ratio × fundamental', async () => {
    // With only partial 2 active, energy should be concentrated around
    // 261 × 3.9 ≈ 1018 Hz, not at 261 Hz.
    const { track, ctx, sampleRate } = await makeOfflineTrack('marimba', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.filter.setParam('filter.envAmount', 0);
    track.machine.setParam('p2level', 1);
    track.machine.setParam('p3level', 0);
    track.machine.setParam('mallet',  0);
    // Silence fundamental so p2 dominates
    track.machine.setParam('decay1',  0.001);

    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    const rFund = bandpassRms(w, sampleRate,  261, 0.5);
    const rP2   = bandpassRms(w, sampleRate, 1018, 0.5); // 261 × 3.9

    assert.gt(rP2, rFund * 2,
      `P2 energy at 1018 Hz should dominate over fundamental (p2=${rP2.toFixed(5)}, fund=${rFund.toFixed(5)})`);
  });

  test('overtones decay faster than fundamental', async () => {
    // Render a long note; measure RMS in an early window vs a late window.
    // In the early window overtones are alive — spectral content should be
    // broader. In the late window only the fundamental survives — bandpassRms
    // at 261 Hz should be a larger fraction of total RMS than early on.
    const longDur = 4.0;
    const { track, ctx, sampleRate } = await makeOfflineTrack('marimba', longDur + 0.2);
    track.filter.setParam('filter.cutoff', 20000);
    track.filter.setParam('filter.envAmount', 0);
    track.machine.setParam('decay1', 3.5);
    track.machine.setParam('decay2', 0.15);
    track.machine.setParam('decay3', 0.04);
    track.machine.setParam('mallet', 0);

    const [w] = await renderSteps(track, ctx, sampleRate, 1, longDur,
      () => ({ note: 60, length: 999 }));

    // Early window: first 10 % of render
    const earlyEnd = Math.floor(w.length * 0.10);
    const early    = w.subarray(0, earlyEnd);
    // Late window: 60–80 % of render (overtones long gone)
    const lateStart = Math.floor(w.length * 0.60);
    const lateEnd   = Math.floor(w.length * 0.80);
    const late      = w.subarray(lateStart, lateEnd);

    const earlyRatio = bandpassRms(early, sampleRate, 261, 0.5) / (rms(early) + 1e-9);
    const lateRatio  = bandpassRms(late,  sampleRate, 261, 0.5) / (rms(late)  + 1e-9);

    assert.gt(lateRatio, earlyRatio * 1.1,
      `Fundamental fraction should grow over time as overtones decay ` +
      `(early=${earlyRatio.toFixed(3)}, late=${lateRatio.toFixed(3)})`);
  });

  test('mallet parameter affects attack level', async () => {
    // The mallet adds a short soft-noise burst at the onset (its own ~25ms
    // envelope). We can't fully silence the tonal partials — the fundamental has
    // no level param and minimum decay is still an audible click — so we isolate
    // the mallet two ways: drop the partial LEVELS we can (p2/p3) and lower the
    // fundamental's reach by minimum decay, then measure only the first 30ms,
    // where the mallet burst dominates and the decayed partials have died away.
    const WINDOW_SEC = 0.03;
    const { track: tOn,  ctx: cOn,  sampleRate: srOn  } = await makeOfflineTrack('marimba', WINDOW_SEC + 0.1);
    const { track: tOff, ctx: cOff, sampleRate: srOff } = await makeOfflineTrack('marimba', WINDOW_SEC + 0.1);

    for (const t of [tOn, tOff]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
      // Knock the tonal partials down as far as the params allow.
      t.machine.setParam('decay1', 0.001);
      t.machine.setParam('decay2', 0.001);
      t.machine.setParam('decay3', 0.001);
      t.machine.setParam('p2level', 0);
      t.machine.setParam('p3level', 0);
    }
    tOn.machine.setParam('mallet',  1.0);
    tOff.machine.setParam('mallet', 0.0);

    const [wOn]  = await renderSteps(tOn,  cOn,  srOn,  1, WINDOW_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wOff] = await renderSteps(tOff, cOff, srOff, 1, WINDOW_SEC, () => ({ note: 60, length: STEP_LEN }));

    // mallet=1 must add clearly more onset energy than mallet=0. The residual
    // fundamental click (un-silenceable: decay1 floors at 1ms and the fundamental
    // has no level param) shares the 30ms window and dilutes the mallet's share to
    // a stable ~1.33× (noise is seeded, so this is reproducible). 1.25× is a solid
    // guard that the mallet adds real onset energy without over-claiming isolation.
    assert.gt(rms(wOn), rms(wOff) * 1.25,
      `mallet=1 onset RMS should exceed mallet=0 (on=${rms(wOn).toFixed(5)}, off=${rms(wOff).toFixed(5)})`);
  });

  test('velocity scales output level', async () => {
    const { track: tLoud, ctx: cLoud, sampleRate: srLoud } = await makeOfflineTrack('marimba', DURATION);
    const { track: tSoft, ctx: cSoft, sampleRate: srSoft } = await makeOfflineTrack('marimba', DURATION);
    for (const t of [tLoud, tSoft]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
    }

    const [wLoud] = await renderSteps(tLoud, cLoud, srLoud, 1, STEP_SEC, () => ({ note: 60, velocity: 127, length: STEP_LEN }));
    const [wSoft] = await renderSteps(tSoft, cSoft, srSoft, 1, STEP_SEC, () => ({ note: 60, velocity:  30, length: STEP_LEN }));

    assert.gt(rms(wLoud), rms(wSoft) * 1.5,
      `Velocity 127 should be louder than velocity 30 (loud=${rms(wLoud).toFixed(5)}, soft=${rms(wSoft).toFixed(5)})`);
  });

});
