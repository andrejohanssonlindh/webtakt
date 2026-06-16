/**
 * machines/input.js — InputMachine tests
 *
 * getUserMedia is not available in an OfflineAudioContext, so these tests cover
 * everything that does NOT need a live stream: the declarative SPEC, the
 * no-audio note interface, the continuous/gated amp-gate behaviour (driven by
 * Track._applyInputGate), and the sequencer's continuous-input firing guard.
 * Live-stream acquisition is exercised manually (see design/input-machine.md).
 */

import { suite, test, assert, makeOfflineTrack, fireStep } from '../../runner.js';
import { InputMachine } from '../../../js/machines/InputMachine.js';

// Strict-equality helper on top of the runner's assert.ok (the runner has no eq).
const eq = (a, b, msg) => assert.ok(a === b, msg ? `${msg} (got ${a}, want ${b})` : `${a} === ${b}`);

suite('InputMachine', () => {

  test('SPEC exposes level + gate, derives param list', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    const m = track.machine;
    eq(m.type, 'input', 'machine type is input');

    const paths = m.getParamList().map(p => p.path).sort();
    eq(JSON.stringify(paths), JSON.stringify(['input.gain', 'input.gate', 'output.level']),
      `param paths (got ${JSON.stringify(paths)})`);

    const level = m.getParamList().find(p => p.path === 'output.level');
    eq(level.modulatable, true, 'output.level is modulatable');
    const gate = m.getParamList().find(p => p.path === 'input.gate');
    eq(gate.type, 'boolean', 'input.gate is boolean');
  });

  test('noteOn/noteOff are no-ops (no synthesis, pitch ignored)', async () => {
    const { track, ctx } = await makeOfflineTrack('input', 0.2);
    const m = track.machine;
    // Should not throw, should not create/alter audible state.
    m.noteOn(60, 127, ctx.currentTime);
    m.noteOff(ctx.currentTime + 0.1);
    eq(m.active, false, 'no stream acquired without enableInput');
  });

  test('getInputLevel returns zeros when no stream is active', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    const { rms, peak } = track.machine.getInputLevel();
    eq(rms, 0, 'rms zero when inactive');
    eq(peak, 0, 'peak zero when inactive');
  });

  test('continuous mode pins every slot amp gate open', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    // Default gate = false → continuous → ampGain held at 1 on all slots.
    eq(track.machine.gated, false, 'defaults to continuous');
    for (const env of track._pool.envelopes) {
      eq(env.ampGain.gain.value, 1, 'continuous: ampGain open');
    }
  });

  test('gated mode leaves amp gate closed (envelope drives it)', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    track.machine.setParam('input.gate', true);
    // The gate toggle is an explicit re-baseline (see InputPanel gate button):
    // continuous → gated must reset, else the gate stays pinned open at 1.
    track._applyInputGate({ reset: true });
    eq(track.machine.gated, true, 'gate on');
    for (const env of track._pool.envelopes) {
      eq(env.ampGain.gain.value, 0, 'gated: ampGain closed until a note');
    }
  });

  test('continuous input ignores sequencer step gating', async () => {
    const { track, ctx } = await makeOfflineTrack('input', 0.2);
    // Pin the gate, then fire a step. _fireStep must NOT call scheduleNote on a
    // continuous-input track (which would re-gate). The held-open value survives.
    track._applyInputGate();
    const before = track._pool.envelopes.map(e => e.ampGain.gain.value);
    fireStep(track, ctx.currentTime + 0.01, { note: 60, length: 2 });
    track._pool.envelopes.forEach((e, i) => {
      eq(e.ampGain.gain.value, before[i], 'step did not disturb continuous gate');
    });
  });

  test('switching away from input restores a closed gate', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    // Continuous input → open.
    eq(track._pool.envelopes[0].ampGain.gain.value, 1, 'open while input');
    track.setMachine('synth');
    // setMachine calls _applyInputGate → non-input → closed.
    for (const env of track._pool.envelopes) {
      eq(env.ampGain.gain.value, 0, 'closed after leaving input');
    }
  });

  test('toJSON/fromJSON round-trips device + params without auto-enabling', async () => {
    const { track } = await makeOfflineTrack('input', 0.2);
    const m = track.machine;
    m.setParam('output.level', 0.5);
    m.setParam('input.gate', true);
    m._deviceId = 'fake-device-id';

    const json = m.toJSON();
    eq(json.deviceId, 'fake-device-id', 'device id serialised');

    const fresh = new InputMachine(track.audio.context);
    fresh.fromJSON(json);
    eq(fresh.getParam('output.level'), 0.5, 'level restored');
    eq(fresh.gated, true, 'gate restored');
    eq(fresh.getDevice(), 'fake-device-id', 'device restored');
    eq(fresh.active, false, 'fromJSON does NOT auto-enable input');
  });

});
