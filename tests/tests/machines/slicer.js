/**
 * machines/slicer.js — SlicerMachine tests
 *
 * Plain AudioBufferSourceNode playback (no worklet) → fully testable offline.
 * We build a buffer whose four quarters each hold a distinct sine frequency,
 * then verify that selecting a slice plays the matching frequency band.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.35;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

const FREQS = [200, 500, 1200, 3000];  // one per quarter-slice

/** Buffer split into 4 equal regions, each a different sine frequency. */
function makeBandedBuffer(ctx, durationSec = 1.0) {
  const len = Math.ceil(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const quarter = Math.floor(len / 4);
  for (let i = 0; i < len; i++) {
    const region = Math.min(3, Math.floor(i / quarter));
    const f = FREQS[region];
    data[i] = 0.6 * Math.sin(2 * Math.PI * f * i / ctx.sampleRate);
  }
  return buf;
}

suite('SlicerMachine', () => {

  test('produces audible output when a buffer is loaded', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.machine.setBuffer(makeBandedBuffer(ctx), 'id', 't.wav');
    track.machine.setParam('slices', 4);
    track.machine.setParam('slice.mode', 'fixed');
    track.machine.setParam('slice', 0);

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('stays silent with no buffer', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const windows = await renderSteps(track, ctx, sampleRate, 2, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    for (const w of windows) {
      assert.lt(rms(w), 0.001, `Expected silence (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('fixed mode: each slice plays its own frequency band', async () => {
    // Render slice 0 (200Hz) and slice 3 (3000Hz); confirm the bandpass energy
    // at each slice's own frequency dominates.
    const run = async (sliceIdx) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', 0.05 + STEP_SEC + 0.3);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeBandedBuffer(ctx), 's' + sliceIdx, 't.wav');
      track.machine.setParam('slices', 4);
      track.machine.setParam('slice.mode', 'fixed');
      track.machine.setParam('slice', sliceIdx);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return { w, sampleRate };
    };

    const s0 = await run(0);
    const s3 = await run(3);

    const s0_at200  = bandpassRms(s0.w, s0.sampleRate, 200,  0.5);
    const s0_at3000 = bandpassRms(s0.w, s0.sampleRate, 3000, 0.5);
    assert.gt(s0_at200, s0_at3000 * 2,
      `slice 0 should be dominated by 200Hz (200=${s0_at200.toFixed(5)}, 3000=${s0_at3000.toFixed(5)})`);

    const s3_at200  = bandpassRms(s3.w, s3.sampleRate, 200,  0.5);
    const s3_at3000 = bandpassRms(s3.w, s3.sampleRate, 3000, 0.5);
    assert.gt(s3_at3000, s3_at200 * 2,
      `slice 3 should be dominated by 3000Hz (200=${s3_at200.toFixed(5)}, 3000=${s3_at3000.toFixed(5)})`);
  });

  test('note mode: MIDI note selects the slice', async () => {
    // base note 60 → slice 0 (200Hz); note 63 → slice 3 (3000Hz).
    const run = async (note) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', 0.05 + STEP_SEC + 0.3);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeBandedBuffer(ctx), 'n' + note, 't.wav');
      track.machine.setParam('slices', 4);
      track.machine.setParam('slice.mode', 'note');
      track.machine.setParam('slice.base', 60);
      // Slicer has no note-pitch tracking — the note picks the SLICE, not pitch,
      // so the frequency bands stay clean for this test.
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note, length: STEP_LEN }));
      return { w, sampleRate };
    };

    const lo = await run(60);
    const hi = await run(63);
    const lo200  = bandpassRms(lo.w, lo.sampleRate, 200, 0.5);
    const hi3000 = bandpassRms(hi.w, hi.sampleRate, 3000, 0.5);
    const lo3000 = bandpassRms(lo.w, lo.sampleRate, 3000, 0.5);
    const hi200  = bandpassRms(hi.w, hi.sampleRate, 200, 0.5);
    assert.gt(lo200, lo3000 * 2, `note 60 → slice 0 (200Hz dominates)`);
    assert.gt(hi3000, hi200 * 2, `note 63 → slice 3 (3000Hz dominates)`);
  });

  test('slices divide the trim region, not the whole buffer', async () => {
    // Trim to the back half [0.5, 1] (the 1200Hz + 3000Hz quarters). With 2
    // slices over that region: slice 0 = 1200Hz quarter, slice 1 = 3000Hz.
    const run = async (sliceIdx) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', 0.05 + STEP_SEC + 0.3);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeBandedBuffer(ctx), 't' + sliceIdx, 't.wav');
      track.machine.setParam('sample.start', 0.5);
      track.machine.setParam('sample.end', 1.0);
      track.machine.setParam('slices', 2);
      track.machine.setParam('slice.mode', 'fixed');
      track.machine.setParam('slice', sliceIdx);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return { w, sampleRate };
    };
    const s0 = await run(0);  // 1200Hz quarter
    const s1 = await run(1);  // 3000Hz quarter
    const s0_1200 = bandpassRms(s0.w, s0.sampleRate, 1200, 0.5);
    const s0_3000 = bandpassRms(s0.w, s0.sampleRate, 3000, 0.5);
    const s1_1200 = bandpassRms(s1.w, s1.sampleRate, 1200, 0.5);
    const s1_3000 = bandpassRms(s1.w, s1.sampleRate, 3000, 0.5);
    assert.gt(s0_1200, s0_3000 * 1.8, `region slice 0 → 1200Hz quarter`);
    assert.gt(s1_3000, s1_1200 * 1.8, `region slice 1 → 3000Hz quarter`);
  });

  test('gate shortens the played region', async () => {
    // Short gate plays less of the slice → lower total energy over the window.
    const run = async (gate) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('slicer', 0.05 + STEP_SEC + 0.3);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeBandedBuffer(ctx), 'g' + gate, 't.wav');
      track.machine.setParam('slices', 4);
      track.machine.setParam('slice.mode', 'fixed');
      track.machine.setParam('slice', 0);
      track.machine.setParam('sample.loop', false);
      track.machine.setParam('gate', gate);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return rms(w);
    };
    const full  = await run(1.0);
    const short = await run(0.1);
    assert.gt(full, short * 1.3,
      `gate=1 should carry more energy than gate=0.1 (full=${full.toFixed(5)}, short=${short.toFixed(5)})`);
  });

  test('toJSON / fromJSON round-trips params + sampleId', async () => {
    const { track } = await makeOfflineTrack('slicer', 0.1);
    const m = track.machine;
    m.setParam('slices', 32);
    m.setParam('slice', 7);
    m.setParam('slice.mode', 'fixed');
    m.setParam('gate', 0.5);
    m.sampleId = 'xyz';
    m.sampleName = 'break.wav';
    const json = m.toJSON();
    assert.ok(json.type === 'slicer', 'type in JSON');
    assert.near(json.params['slices'], 32, 0.001, 'slices in JSON');
    assert.near(json.params['slice'], 7, 0.001, 'slice in JSON');
    assert.ok(json.params['slice.mode'] === 'fixed', 'mode in JSON');
    assert.ok(json.sampleId === 'xyz', 'sampleId in JSON');

    const { track: t2 } = await makeOfflineTrack('slicer', 0.1);
    t2.machine.fromJSON(json);
    assert.near(t2.machine.getParam('slices'), 32, 0.001, 'slices restored');
    assert.near(t2.machine.getParam('gate'), 0.5, 0.001, 'gate restored');
    assert.ok(t2.machine.sampleId === 'xyz', 'sampleId restored');
  });

});
