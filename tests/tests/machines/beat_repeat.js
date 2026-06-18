/**
 * machines/beat_repeat.js — BeatRepeatMachine tests
 *
 * Plain AudioBufferSourceNode scheduling (no worklet) → fully testable offline.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms } from '../../runner.js';

const STEP_SEC = 0.6;     // long enough to contain a multi-repeat roll
const STEP_LEN = 6;
const DURATION = 0.05 + STEP_SEC + 0.4;

/** A short noisy buffer so each repeat carries energy across the spectrum. */
function makeNoiseBuffer(ctx, durationSec = 0.5) {
  const len = Math.ceil(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x40000000 - 1) * 0.5;
  }
  return buf;
}

suite('BeatRepeatMachine', () => {

  test('produces audible output with a buffer', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('beat-repeat', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    track.machine.setBuffer(makeNoiseBuffer(ctx), 'id', 't.wav');
    track.machine.setParam('repeats', 4);
    track.machine.setParam('rate', '1/16');

    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    assert.gt(rms(w), 0.001, `expected audible roll (rms=${rms(w).toFixed(6)})`);
  });

  test('stays silent with no buffer', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('beat-repeat', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    assert.lt(rms(w), 0.001, `expected silence (rms=${rms(w).toFixed(6)})`);
  });

  test('more repeats carry more total energy across the window', async () => {
    const run = async (repeats) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('beat-repeat', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeNoiseBuffer(ctx), 'r' + repeats, 't.wav');
      track.machine.setParam('rate', '1/16');
      track.machine.setParam('repeats', repeats);
      track.machine.setParam('decay', 0);
      track.machine.setParam('length', 0.05);
      track.machine.setParam('gate', 0.9);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return rms(w);
    };
    const few  = await run(1);
    const many = await run(8);
    assert.gt(many, few * 1.5,
      `8 repeats should carry more energy than 1 (many=${many.toFixed(5)}, few=${few.toFixed(5)})`);
  });

  test('decay reduces the roll tail vs a flat roll', async () => {
    const run = async (decay) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('beat-repeat', DURATION);
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeNoiseBuffer(ctx), 'd' + decay, 't.wav');
      track.machine.setParam('rate', '1/16');
      track.machine.setParam('repeats', 8);
      track.machine.setParam('length', 0.05);
      track.machine.setParam('decay', decay);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      return rms(w);
    };
    const flat   = await run(0);
    const fading = await run(1);
    assert.gt(flat, fading * 1.1,
      `flat roll should be louder overall than a fully-decaying one (flat=${flat.toFixed(5)}, fade=${fading.toFixed(5)})`);
  });

  test('rate resolves through BPM (faster rate packs repeats tighter)', async () => {
    // Same repeats; 1/32 spans half the time of 1/16. We assert the machine
    // schedules within the expected total span by checking energy lands earlier.
    const run = async (rate, bpm) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('beat-repeat', DURATION, { bpm });
      track.filter.setParam('filter.cutoff', 20000);
      track.machine.setBuffer(makeNoiseBuffer(ctx), rate, 't.wav');
      track.machine.setBpm(bpm);
      track.machine.setParam('rate', rate);
      track.machine.setParam('repeats', 4);
      track.machine.setParam('length', 0.03);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, length: STEP_LEN }));
      // Energy in the FIRST quarter of the window: a tighter roll (1/32) packs
      // all repeats earlier, so more energy is front-loaded.
      const q = Math.floor(w.length / 4);
      return rms(w.slice(0, q));
    };
    const slow = await run('1/16', 120);
    const fast = await run('1/32', 120);
    assert.gt(fast, slow * 1.1,
      `1/32 should front-load energy vs 1/16 (fast=${fast.toFixed(5)}, slow=${slow.toFixed(5)})`);
  });

  test('toJSON / fromJSON round-trips params + sampleId', async () => {
    const { track } = await makeOfflineTrack('beat-repeat', 0.1);
    const m = track.machine;
    m.setParam('rate', '1/32');
    m.setParam('repeats', 12);
    m.setParam('length', 0.2);
    m.setParam('pitch.ramp', 3);
    m.setParam('decay', 0.5);
    m.sampleId = 'br';
    m.sampleName = 'roll.wav';
    const json = m.toJSON();
    assert.ok(json.type === 'beat-repeat', 'type in JSON');
    assert.ok(json.params['rate'] === '1/32', 'rate in JSON');
    assert.near(json.params['repeats'], 12, 0.001, 'repeats in JSON');
    assert.near(json.params['pitch.ramp'], 3, 0.001, 'ramp in JSON');
    assert.ok(json.sampleId === 'br', 'sampleId in JSON');

    const { track: t2 } = await makeOfflineTrack('beat-repeat', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('rate') === '1/32', 'rate restored');
    assert.near(t2.machine.getParam('repeats'), 12, 0.001, 'repeats restored');
    assert.near(t2.machine.getParam('decay'), 0.5, 0.001, 'decay restored');
    assert.ok(t2.machine.sampleId === 'br', 'sampleId restored');
  });

});
