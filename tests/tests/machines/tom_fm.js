/**
 * machines/tom_fm.js — TomFMMachine (metallic FM tom) tests
 *
 * A 2-op FM drum: modulator→carrier with a fast FM-depth envelope for inharmonic
 * metallic bite. Checks audibility, low/mid body, that higher FM index adds
 * upper-spectrum (sideband) energy, and toJSON/fromJSON round-trips.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 2;
const DURATION = 0.05 + 4 * STEP_SEC + 0.6;

suite('TomFMMachine (metallic)', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom.fm', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('low/mid-frequency body present', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('tom.fm', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const body = bandEnergy(w, sampleRate, 60, 500);
    assert.gt(body, 0, `FM tom should have low/mid body energy (60–500 Hz), got ${body.toFixed(0)}`);
  });

  test('higher FM index adds upper-spectrum sidebands', async () => {
    // FM depth bursts on the attack; raising the `fm` index widens the sideband
    // spread. bandpassRms is amplitude-based (NOT peak-normalised like
    // bandEnergy), so the wider sidebands at fm=1 give clearly higher RMS in a
    // band the pure carrier (fm=0) barely reaches. With tune 120, ratio 2.5 the
    // modulator is 300 Hz and the fm=1 index ≈ 3.2, so significant sidebands
    // reach well past 800 Hz — far above the 120 Hz carrier. Hold pitch steady
    // (sweep 1) so the band reads sidebands, not a swept fundamental.
    const mk = async (fm) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('tom.fm', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setParam('tune', 120);
      track.machine.setParam('sweep', 1);
      track.machine.setParam('ratio', 2.5);
      track.machine.setParam('fm', fm);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return bandpassRms(w, sampleRate, 800, 1);
    };
    const clean    = await mk(0);
    const metallic = await mk(1);
    assert.gt(metallic, clean * 1.5,
      `fm=1 should add high-spectrum sidebands over fm=0 (${metallic.toFixed(6)} vs ${clean.toFixed(6)})`);
  });

  test('toJSON/fromJSON round-trips params', async () => {
    const { track } = await makeOfflineTrack('tom.fm', DURATION);
    const m = track.machine;
    m.setParam('tune', 160);
    m.setParam('ratio', 5.5);
    m.setParam('fm', 0.8);
    m.setParam('fm.decay', 0.6);
    const json = m.toJSON();

    const { track: t2 } = await makeOfflineTrack('tom.fm', DURATION);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('tune')     === 160, 'tune round-trip');
    assert.ok(t2.machine.getParam('ratio')    === 5.5, 'ratio round-trip');
    assert.ok(t2.machine.getParam('fm')       === 0.8, 'fm round-trip');
    assert.ok(t2.machine.getParam('fm.decay') === 0.6, 'fm.decay round-trip');
  });

});
