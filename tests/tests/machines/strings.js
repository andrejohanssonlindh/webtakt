/**
 * machines/strings.js — StringsMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('StringsMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('strings', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('tracks pitch: C4 has energy at its fundamental', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('strings', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.filter.setParam('filter.envAmount', 0);
    track.machine.setParam('mode', 'viola');   // 0 st octave shift → C4 = 261 Hz

    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    const atRoot = bandpassRms(w, sampleRate, 261, 0.5);
    const offRoot = bandpassRms(w, sampleRate, 90, 0.5);
    assert.gt(atRoot, offRoot,
      `Viola C4 should have more energy at 261 Hz than at 90 Hz (root=${atRoot.toFixed(5)}, off=${offRoot.toFixed(5)})`);
  });

  test('cello mode shifts energy an octave below viola for the same note', async () => {
    // Same MIDI note: cello is -12 st (130 Hz for C4), viola is 0 st (261 Hz).
    const viola = await makeOfflineTrack('strings', DURATION);
    const cello = await makeOfflineTrack('strings', DURATION);
    for (const t of [viola.track, cello.track]) {
      t.filter.setParam('filter.cutoff', 20000);
      t.filter.setParam('filter.envAmount', 0);
    }
    viola.track.machine.setParam('mode', 'viola');
    cello.track.machine.setParam('mode', 'cello');

    const [wViola] = await renderSteps(viola.track, viola.ctx, viola.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wCello] = await renderSteps(cello.track, cello.ctx, cello.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    // Cello should have more low-octave (130 Hz) energy than viola at the same note.
    const celloLow = bandpassRms(wCello, cello.sampleRate, 130, 0.5);
    const violaLow = bandpassRms(wViola, viola.sampleRate, 130, 0.5);
    assert.gt(celloLow, violaLow,
      `Cello should have more 130 Hz energy than viola (cello=${celloLow.toFixed(5)}, viola=${violaLow.toFixed(5)})`);
  });

});
