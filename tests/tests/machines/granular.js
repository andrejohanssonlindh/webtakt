/**
 * machines/granular.js — GranularMachine tests
 *
 * GranularMachine runs an AudioWorkletNode, which is unavailable / unreliable
 * in OfflineAudioContext (see TEST_DESIGN.md — same exclusion as wt-sampler),
 * so we do NOT render audio here. Instead we assert the param / JSON / API
 * contract that the rest of the app (LFO routing, p-locks, serialization,
 * VoicePool carry-over) depends on.
 */

import { suite, test, assert, makeOfflineTrack } from '../../runner.js';

suite('GranularMachine', () => {

  test('param list exposes position + level as AudioParam-backed, modulatable', async () => {
    const { track } = await makeOfflineTrack('granular', 0.1);
    const list = track.machine.getParamList();

    const pos = list.find(p => p.path === 'position');
    assert.ok(pos, 'has position param');
    assert.ok(pos.modulatable === true, 'position is modulatable');
    assert.ok(pos.plockMode === 'audioParam', 'position is audioParam-backed');

    const lvl = list.find(p => p.path === 'output.level');
    assert.ok(lvl, 'has output.level param');
    assert.ok(lvl.plockMode === 'audioParam', 'output.level is audioParam-backed');

    // Grain params are JS-only (read fresh per trigger).
    for (const path of ['grain.size', 'grain.density', 'spray', 'spread', 'scan']) {
      const p = list.find(x => x.path === path);
      assert.ok(p, `has ${path}`);
      assert.ok(p.plockMode === 'js', `${path} is JS-only`);
    }
  });

  test('default params are sane', async () => {
    const { track } = await makeOfflineTrack('granular', 0.1);
    const m = track.machine;
    assert.near(m.getParam('position'), 0, 0.001, 'position default 0');
    assert.near(m.getParam('grain.size'), 40, 0.001, 'grain.size default 40ms');
    assert.near(m.getParam('grain.density'), 25, 0.001, 'density default 25');
    assert.ok(m.getParam('sample.pitch') === true, 'pitch tracking on by default');
    assert.near(m.getParam('output.level'), 0.85, 0.001, 'level default 0.85');
  });

  test('setParam stores values; getParam reads them back', async () => {
    const { track } = await makeOfflineTrack('granular', 0.1);
    const m = track.machine;
    m.setParam('grain.size', 120);
    m.setParam('grain.density', 80);
    m.setParam('spray', 0.3);
    m.setParam('spread', 0.9);
    m.setParam('scan', 1.5);
    m.setParam('pitch.jitter', 0.25);
    m.setParam('position', 0.42);
    assert.near(m.getParam('grain.size'), 120, 0.001, 'grain.size stored');
    assert.near(m.getParam('grain.density'), 80, 0.001, 'density stored');
    assert.near(m.getParam('spray'), 0.3, 0.001, 'spray stored');
    assert.near(m.getParam('spread'), 0.9, 0.001, 'spread stored');
    assert.near(m.getParam('scan'), 1.5, 0.001, 'scan stored');
    assert.near(m.getParam('pitch.jitter'), 0.25, 0.001, 'jitter stored');
    assert.near(m.getParam('position'), 0.42, 0.001, 'position stored');
  });

  test('has sample.start / sample.end trim params (JS-only)', async () => {
    const { track } = await makeOfflineTrack('granular', 0.1);
    const list = track.machine.getParamList();
    const start = list.find(p => p.path === 'sample.start');
    const end   = list.find(p => p.path === 'sample.end');
    assert.ok(start && end, 'has start + end trim params');
    assert.ok(start.plockMode === 'js' && end.plockMode === 'js', 'trim params JS-only');
    assert.near(track.machine.getParam('sample.start'), 0, 0.001, 'start default 0');
    assert.near(track.machine.getParam('sample.end'), 1, 0.001, 'end default 1');
    track.machine.setParam('sample.start', 0.25);
    track.machine.setParam('sample.end', 0.75);
    assert.near(track.machine.getParam('sample.start'), 0.25, 0.001, 'start stored');
    assert.near(track.machine.getParam('sample.end'), 0.75, 0.001, 'end stored');
  });

  test('toJSON / fromJSON round-trips params + sampleId', async () => {
    const { track } = await makeOfflineTrack('granular', 0.1);
    const m = track.machine;
    m.setParam('grain.size', 77);
    m.setParam('spread', 0.55);
    m.setParam('position', 0.33);
    m.sampleId   = 'abc123';
    m.sampleName = 'pad.wav';

    const json = m.toJSON();
    assert.ok(json.type === 'granular', 'type in JSON');
    assert.ok(json.sampleId === 'abc123', 'sampleId in JSON');
    assert.ok(json.sampleName === 'pad.wav', 'sampleName in JSON');
    assert.near(json.params['grain.size'], 77, 0.001, 'grain.size in JSON');

    const { track: t2 } = await makeOfflineTrack('granular', 0.1);
    t2.machine.fromJSON(json);
    assert.near(t2.machine.getParam('grain.size'), 77, 0.001, 'grain.size restored');
    assert.near(t2.machine.getParam('spread'), 0.55, 0.001, 'spread restored');
    assert.near(t2.machine.getParam('position'), 0.33, 0.001, 'position restored');
    assert.ok(t2.machine.sampleId === 'abc123', 'sampleId restored');
  });

  test('single-buffer protocol: setBuffer / hasBuffer / getBuffer / clearBuffer', async () => {
    const { track, ctx } = await makeOfflineTrack('granular', 0.1);
    const m = track.machine;
    assert.ok(m.hasBuffer === false, 'no buffer initially');

    const buf = ctx.createBuffer(1, 1024, ctx.sampleRate);
    m.setBuffer(buf, 'id1', 's.wav');
    assert.ok(m.hasBuffer === true, 'hasBuffer after setBuffer');
    assert.ok(m.getBuffer() === buf, 'getBuffer returns the buffer');
    assert.ok(m.sampleId === 'id1', 'sampleId set');

    m.clearBuffer();
    assert.ok(m.hasBuffer === false, 'cleared');
    assert.ok(m.getBuffer() === null, 'getBuffer null after clear');
  });

  test('syncFrom copies the buffer reference (VoicePool carry-over)', async () => {
    const { track, ctx } = await makeOfflineTrack('granular', 0.1);
    const { track: t2 }  = await makeOfflineTrack('granular', 0.1);
    const buf = ctx.createBuffer(1, 512, ctx.sampleRate);
    track.machine.setBuffer(buf, 'shared', 'sh.wav');

    t2.machine.syncFrom(track.machine);
    assert.ok(t2.machine.getBuffer() === buf, 'buffer reference shared');
    assert.ok(t2.machine.sampleId === 'shared', 'sampleId carried');
  });

});
