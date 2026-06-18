/**
 * machines/multi_sampler.js — MultiSamplerMachine tests
 *
 * Plain AudioBufferSourceNode playback (no worklet) → testable offline.
 * Each zone gets a distinct sine frequency so we can confirm which zone sounded.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.35;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;

function makeSineBuffer(ctx, freqHz, durationSec = 0.5) {
  const len = Math.ceil(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = 0.6 * Math.sin(2 * Math.PI * freqHz * i / ctx.sampleRate);
  return buf;
}

suite('MultiSamplerMachine', () => {

  test('stays silent with no zones loaded', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('multi-sampler', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 100, length: STEP_LEN }));
    assert.lt(rms(w), 0.001, `expected silence (rms=${rms(w).toFixed(6)})`);
  });

  test('velocity mode: hit velocity selects the matching zone', async () => {
    // Zone 0 (200Hz) covers vel 0–63; zone 1 (2000Hz) covers 64–127.
    const run = async (vel) => {
      const { track, ctx, sampleRate } = await makeOfflineTrack('multi-sampler', 0.05 + STEP_SEC + 0.3);
      track.filter.setParam('filter.cutoff', 20000);
      const m = track.machine;
      m.setBufferAt(0, makeSineBuffer(ctx, 200),  'z0', 'z0.wav');
      m.setBufferAt(1, makeSineBuffer(ctx, 2000), 'z1', 'z1.wav');
      m.setParam('mode', 'velocity');
      m.setParam('zone0.loVel', 0);   m.setParam('zone0.hiVel', 63);
      m.setParam('zone1.loVel', 64);  m.setParam('zone1.hiVel', 127);
      m.setParam('zone0.pitch', false); m.setParam('zone1.pitch', false);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: vel, length: STEP_LEN }));
      return { w, sampleRate };
    };
    const soft = await run(40);
    const hard = await run(110);
    const soft200  = bandpassRms(soft.w, soft.sampleRate, 200, 0.5);
    const soft2000 = bandpassRms(soft.w, soft.sampleRate, 2000, 0.5);
    const hard200  = bandpassRms(hard.w, hard.sampleRate, 200, 0.5);
    const hard2000 = bandpassRms(hard.w, hard.sampleRate, 2000, 0.5);
    assert.gt(soft200, soft2000 * 2, `soft hit → zone 0 (200Hz)`);
    assert.gt(hard2000, hard200 * 2, `hard hit → zone 1 (2000Hz)`);
  });

  test('velocity mode: overlapping ranges layer both zones', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('multi-sampler', 0.05 + STEP_SEC + 0.3);
    track.filter.setParam('filter.cutoff', 20000);
    const m = track.machine;
    m.setBufferAt(0, makeSineBuffer(ctx, 200),  'z0', 'z0.wav');
    m.setBufferAt(1, makeSineBuffer(ctx, 2000), 'z1', 'z1.wav');
    m.setParam('mode', 'velocity');
    m.setParam('zone0.loVel', 0); m.setParam('zone0.hiVel', 127);
    m.setParam('zone1.loVel', 0); m.setParam('zone1.hiVel', 127);
    m.setParam('zone0.pitch', false); m.setParam('zone1.pitch', false);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 100, length: STEP_LEN }));
    const e200  = bandpassRms(w, sampleRate, 200, 0.5);
    const e2000 = bandpassRms(w, sampleRate, 2000, 0.5);
    assert.gt(e200,  0.0005, `zone 0 audible when layered`);
    assert.gt(e2000, 0.0005, `zone 1 audible when layered`);
  });

  test('round-robin mode: consecutive hits alternate zones', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('multi-sampler', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    const m = track.machine;
    m.setBufferAt(0, makeSineBuffer(ctx, 200),  'z0', 'z0.wav');
    m.setBufferAt(1, makeSineBuffer(ctx, 2000), 'z1', 'z1.wav');
    m.setParam('mode', 'round');
    m.setParam('zone0.pitch', false); m.setParam('zone1.pitch', false);

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, velocity: 100, length: STEP_LEN }));
    // Hit 0 → zone0 (200), hit 1 → zone1 (2000), hit 2 → zone0, hit 3 → zone1.
    const h0_200  = bandpassRms(windows[0], sampleRate, 200, 0.5);
    const h0_2000 = bandpassRms(windows[0], sampleRate, 2000, 0.5);
    const h1_200  = bandpassRms(windows[1], sampleRate, 200, 0.5);
    const h1_2000 = bandpassRms(windows[1], sampleRate, 2000, 0.5);
    assert.gt(h0_200, h0_2000 * 2,  `hit 0 → zone 0 (200Hz)`);
    assert.gt(h1_2000, h1_200 * 2,  `hit 1 → zone 1 (2000Hz)`);
  });

  test('per-zone trim limits the played region', async () => {
    // Buffer = 200Hz for first half, 3000Hz second half. Trim zone 0 to [0.5,1]
    // → only 3000Hz should sound.
    const { track, ctx, sampleRate } = await makeOfflineTrack('multi-sampler', 0.05 + STEP_SEC + 0.3);
    track.filter.setParam('filter.cutoff', 20000);
    const len = Math.ceil(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const f = i < len / 2 ? 200 : 3000;
      data[i] = 0.6 * Math.sin(2 * Math.PI * f * i / ctx.sampleRate);
    }
    const m = track.machine;
    m.setBufferAt(0, buf, 'z0', 'z0.wav');
    m.setParam('zone0.pitch', false);
    m.setParam('zone0.start', 0.5);
    m.setParam('zone0.end', 1.0);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 100, length: STEP_LEN }));
    const e200  = bandpassRms(w, sampleRate, 200, 0.5);
    const e3000 = bandpassRms(w, sampleRate, 3000, 0.5);
    assert.gt(e3000, e200 * 2, `trimmed to back half → 3000Hz dominates`);
  });

  test('toJSON / fromJSON round-trips zone ids + params', async () => {
    const { track } = await makeOfflineTrack('multi-sampler', 0.1);
    const m = track.machine;
    m.setParam('mode', 'round');
    m.setParam('zone1.loVel', 50);
    m.setParam('zone1.hiVel', 90);
    m.zoneSampleIds[0] = 'aaa';
    m.zoneSampleNames[0] = 'kick.wav';
    m.zoneSampleIds[2] = 'ccc';
    const json = m.toJSON();
    assert.ok(json.type === 'multi-sampler', 'type in JSON');
    assert.ok(json.zoneSampleIds[0] === 'aaa', 'zone 0 id in JSON');
    assert.ok(json.zoneSampleIds[2] === 'ccc', 'zone 2 id in JSON');
    assert.ok(json.params['mode'] === 'round', 'mode in JSON');

    const { track: t2 } = await makeOfflineTrack('multi-sampler', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.zoneSampleIds[0] === 'aaa', 'zone 0 id restored');
    assert.ok(t2.machine.zoneSampleIds[2] === 'ccc', 'zone 2 id restored');
    assert.near(t2.machine.getParam('zone1.loVel'), 50, 0.001, 'zone1 loVel restored');
    assert.ok(t2.machine.getParam('mode') === 'round', 'mode restored');
  });

});
