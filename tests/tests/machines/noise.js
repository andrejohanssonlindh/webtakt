/**
 * machines/noise.js — NoiseMachine tests
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.3;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

suite('NoiseMachine', () => {

  test('produces audible output', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('noise', DURATION);
    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  // Render one hit of `note` and return the body-band slice + sampleRate.
  async function hit(note, { noteTrack }) {
    const { track, ctx, sampleRate } = await makeOfflineTrack('noise', DURATION);
    track.machine.setParam('body.freq', 400);   // C4-neutral center
    track.machine.setParam('body.level', 1);     // emphasise the body band
    track.machine.setParam('color.freq', 400);
    track.machine.setParam('note.track', noteTrack);
    track.filter.setParam('filter.cutoff', 20000);
    const startTime = 0.05;
    const { Step } = await import('../../../js/sequencer/Step.js');
    const step = new Step(0);
    step.active = true; step.note = note; step.length = STEP_LEN;
    track.sequencer._fireStep(step, startTime);
    const rendered = await ctx.startRendering();
    const s = Math.floor(startTime * sampleRate);
    const e = s + Math.floor(0.1 * sampleRate);
    return { w: rendered.getChannelData(0).slice(s, e), sampleRate };
  }

  test('note.track ON: octave up shifts the body band upward', async () => {
    // body.freq=400 → C4 centers ~400 Hz, C5 (72) ~800 Hz. With tracking on, the
    // 800 Hz band should gain energy relative to the same band at C4.
    const c4 = await hit(60, { noteTrack: true });
    const c5 = await hit(72, { noteTrack: true });
    const e4 = bandpassRms(c4.w, c4.sampleRate, 800, 0.5);
    const e5 = bandpassRms(c5.w, c5.sampleRate, 800, 0.5);
    assert.gt(e5, e4,
      `note 72 should push more energy to the 800 Hz band than note 60 (c5=${e5.toFixed(4)}, c4=${e4.toFixed(4)})`);
  });

  test('note.track OFF: pitch is unchanged across notes', async () => {
    // Default behaviour: the body band stays put regardless of note.
    const c4 = await hit(60, { noteTrack: false });
    const c5 = await hit(72, { noteTrack: false });
    const e4 = bandpassRms(c4.w, c4.sampleRate, 800, 0.5);
    const e5 = bandpassRms(c5.w, c5.sampleRate, 800, 0.5);
    // Allow generous noise variance — assert they're within ~30% of each other.
    const ratio = e5 / Math.max(e4, 1e-9);
    assert.ok(ratio > 0.6 && ratio < 1.6,
      `note.track OFF: 800 Hz energy should be note-independent (ratio=${ratio.toFixed(2)})`);
  });

});
