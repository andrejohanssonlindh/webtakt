/**
 * machines/time_stretch.js — TimeStretchMachine tests
 *
 * Uses an AudioWorkletNode (excluded from audio rendering per TEST_DESIGN.md —
 * same as wt-sampler), so we test the param/JSON/API + the ratio & BPM-detect
 * math, which is plain JS and the part most likely to regress.
 */

import { suite, test, assert, makeOfflineTrack } from '../../runner.js';

suite('TimeStretchMachine', () => {

  test('computeRatio = origBpm / projectBpm when synced', async () => {
    const { track } = await makeOfflineTrack('stretch', 0.1, { bpm: 120 });
    const m = track.machine;
    m.setParam('sync', true);
    m.setParam('orig.bpm', 90);
    m.setBpm(120);
    assert.near(m.computeRatio(), 90 / 120, 0.0001, '90→120 ratio 0.75');

    m.setParam('orig.bpm', 140);
    m.setBpm(120);
    assert.near(m.computeRatio(), 140 / 120, 0.0001, '140→120 ratio ~1.167');
  });

  test('computeRatio = 1 when sync is off', async () => {
    const { track } = await makeOfflineTrack('stretch', 0.1, { bpm: 120 });
    const m = track.machine;
    m.setParam('orig.bpm', 90);
    m.setParam('sync', false);
    assert.near(m.computeRatio(), 1, 0.0001, 'unsynced → 1.0');
  });

  test('setBpm updates the effective ratio', async () => {
    const { track } = await makeOfflineTrack('stretch', 0.1, { bpm: 120 });
    const m = track.machine;
    m.setParam('sync', true);
    m.setParam('orig.bpm', 120);
    m.setBpm(60);
    assert.near(m.computeRatio(), 2, 0.0001, '120-loop at 60 BPM → 2× stretch');
    m.setBpm(240);
    assert.near(m.computeRatio(), 0.5, 0.0001, '120-loop at 240 BPM → 0.5×');
  });

  test('detectBpm derives original tempo from length × bars', async () => {
    const { track, ctx } = await makeOfflineTrack('stretch', 0.1);
    const m = track.machine;
    // 2-second buffer, assumed 1 bar (4 beats) → 4 beats / 2s = 2 bps = 120 BPM.
    const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
    m.setBuffer(buf, 'id', 'loop.wav');
    m.setParam('bars', 1);
    m.setParam('sample.start', 0);
    m.setParam('sample.end', 1);
    assert.near(m.detectBpm(), 120, 0.5, '2s, 1 bar → 120 BPM');

    // Same 2-second buffer, 2 bars → 8 beats / 2s → 240 BPM.
    m.setParam('bars', 2);
    assert.near(m.detectBpm(), 240, 0.5, '2s, 2 bars → 240 BPM');
  });

  test('detectBpm honours the trim region', async () => {
    const { track, ctx } = await makeOfflineTrack('stretch', 0.1);
    const m = track.machine;
    const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 4), ctx.sampleRate);
    m.setBuffer(buf, 'id', 'loop.wav');
    m.setParam('bars', 1);
    // Trim to the first half (2s) → 4 beats / 2s → 120 BPM.
    m.setParam('sample.start', 0);
    m.setParam('sample.end', 0.5);
    assert.near(m.detectBpm(), 120, 0.5, 'trimmed 2s, 1 bar → 120 BPM');
  });

  test('param list: level is the only AudioParam-backed/modulatable param', async () => {
    const { track } = await makeOfflineTrack('stretch', 0.1);
    const list = track.machine.getParamList();
    const modulatable = list.filter(p => p.modulatable);
    assert.ok(modulatable.length === 1, 'exactly one modulatable param');
    assert.ok(modulatable[0].path === 'output.level', 'and it is output.level');
  });

  test('toJSON / fromJSON round-trips params + sampleId', async () => {
    const { track } = await makeOfflineTrack('stretch', 0.1);
    const m = track.machine;
    m.setParam('orig.bpm', 174);
    m.setParam('bars', 4);
    m.setParam('transpose', -5);
    m.setParam('sync', false);
    m.sampleId = 'dnb';
    m.sampleName = 'amen.wav';
    const json = m.toJSON();
    assert.ok(json.type === 'stretch', 'type in JSON');
    assert.near(json.params['orig.bpm'], 174, 0.001, 'orig.bpm in JSON');
    assert.near(json.params['transpose'], -5, 0.001, 'transpose in JSON');
    assert.ok(json.params['sync'] === false, 'sync in JSON');
    assert.ok(json.sampleId === 'dnb', 'sampleId in JSON');

    const { track: t2 } = await makeOfflineTrack('stretch', 0.1);
    t2.machine.fromJSON(json);
    assert.near(t2.machine.getParam('orig.bpm'), 174, 0.001, 'orig.bpm restored');
    assert.near(t2.machine.getParam('bars'), 4, 0.001, 'bars restored');
    assert.ok(t2.machine.sampleId === 'dnb', 'sampleId restored');
  });

  test('single-buffer protocol works', async () => {
    const { track, ctx } = await makeOfflineTrack('stretch', 0.1);
    const m = track.machine;
    assert.ok(m.hasBuffer === false, 'no buffer initially');
    const buf = ctx.createBuffer(1, 1024, ctx.sampleRate);
    m.setBuffer(buf, 'id', 's.wav');
    assert.ok(m.hasBuffer === true && m.getBuffer() === buf, 'set/get buffer');
    m.clearBuffer();
    assert.ok(m.hasBuffer === false, 'cleared');
  });

});
