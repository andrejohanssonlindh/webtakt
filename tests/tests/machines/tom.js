/**
 * machines/tom.js — TomMachine (digital tom) tests
 *
 * A clean synthetic tuned drum (sine + triangle body + pitch drop + noise click).
 * Checks audibility, that low/mid body energy is present, the tone blend adds
 * upper-harmonic energy, and toJSON/fromJSON round-trips.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('TomMachine (digital)', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('low/mid-frequency body present', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const body = bandEnergy(w, sampleRate, 60, 500);
    assert.gt(body, 0, `Tom should have low/mid body energy (60–500 Hz), got ${body.toFixed(0)}`);
  });

  test('tone blend adds upper-harmonic energy', async () => {
    // The triangle blend (`tone`) injects odd harmonics above the sine
    // fundamental (tune 110 Hz). bandpassRms is amplitude-based (NOT
    // peak-normalised like bandEnergy), so more harmonic content = higher RMS in
    // a band the pure sine barely reaches. Measure at the triangle's 3rd
    // harmonic (~330 Hz, the strongest odd harmonic at 1/9 amplitude), well
    // clear of the 110 Hz fundamental; noise click off to isolate the body.
    const mk = async (tone) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('tom', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setParam('tune', 110);
      track.machine.setParam('sweep', 1);   // no pitch sweep → stable harmonic positions
      track.machine.setParam('tone', tone);
      track.machine.setParam('click', 0);   // isolate the body from the noise click
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return bandpassRms(w, sampleRate, 330, 0.5);
    };
    const pure  = await mk(0);
    const toned = await mk(1);
    assert.gt(toned, pure * 1.5,
      `tone=1 should add clear upper-harmonic energy over tone=0 (${toned.toFixed(6)} vs ${pure.toFixed(6)})`);
  });

  test('toJSON/fromJSON round-trips params', async () => {
    const { track } = await makeOfflineTrack('tom', DURATION);
    const m = track.machine;
    m.setParam('tune', 180);
    m.setParam('decay', 0.9);
    m.setParam('sweep', 3.2);
    m.setParam('tone', 0.7);
    const json = m.toJSON();

    const { track: t2 } = await makeOfflineTrack('tom', DURATION);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('tune')  === 180, 'tune round-trip');
    assert.ok(t2.machine.getParam('decay') === 0.9, 'decay round-trip');
    assert.ok(t2.machine.getParam('sweep') === 3.2, 'sweep round-trip');
    assert.ok(t2.machine.getParam('tone')  === 0.7, 'tone round-trip');
  });

});
