/**
 * sync_knob.js — unified MS/BPM sync-knob model tests
 *
 * Guards the migration of synced time params from beat-division strings to the
 * integer 1/32-count model (see design/sync-knob-rollout.md). Covers DelayFX,
 * ReverbFX, LFO and Arpeggiator: BPM-mode timing math, serialise round-trip,
 * and legacy `*.bpmDiv` → `*.bpmCount32` back-compat on load.
 */

import { suite, test, assert, makeOfflineTrack } from '../runner.js';
import { count32ToSeconds, divToCount32 } from '../../js/util/BpmSync.js';

suite('Sync knob (MS/BPM unified)', () => {

  test('BpmSync: count32ToSeconds + divToCount32 are consistent', () => {
    // 120 BPM: one 1/32 = (60/120)/8 = 0.0625s. 8×1/32 = 1/4 = 0.5s.
    assert.near(count32ToSeconds(1, 120), 0.0625, 1e-9, '1/32 @120');
    assert.near(count32ToSeconds(8, 120), 0.5,    1e-9, '1/4 @120');
    assert.ok(divToCount32('1/32') === 1,  '1/32 → 1');
    assert.ok(divToCount32('1/8')  === 4,  '1/8 → 4');
    assert.ok(divToCount32('1/4')  === 8,  '1/4 → 8');
    assert.ok(divToCount32('1/1')  === 32, '1/1 → 32');
  });

  test('DelayFX: bpm mode sets delay time from 1/32 count', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);   // clock 120 BPM
    const d = track.delayFX;
    d.setBpm(120);
    d.setParam('delay.syncMode', 'bpm');
    d.setParam('delay.bpmCount32', 8);   // 1/4 = 0.5s
    assert.near(d._delayNode.delayTime.value, 0.5, 0.02, 'delay time follows bpm count');
  });

  test('ReverbFX: bpm pre-delay + bpmDiv back-compat on load', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const r = track.reverbFX;
    r.setBpm(120);
    r.setParam('reverb.syncMode', 'bpm');
    r.setParam('reverb.bpmCount32', 4);  // 1/16 = 0.25s, clamped to 0.5 max
    assert.near(r.getParam('reverb.predelay'), 0.25, 0.001, 'predelay from bpm count');

    // Legacy project: division string must map to a count and the old key drop.
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.reverbFX.fromJSON({ params: { 'reverb.syncMode': 'bpm', 'reverb.bpmDiv': '1/8' }, enabled: false });
    assert.ok(t2.reverbFX.getParam('reverb.bpmCount32') === 4, '1/8 → count 4');
    assert.ok(t2.reverbFX.getParam('reverb.bpmDiv') === undefined, 'legacy key dropped');
  });

  test('LFO: bpm count drives osc Hz (count = period) + back-compat', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const lfo = track.lfos[0];
    lfo.setParam('lfo.syncMode', 'bpm');
    lfo.setParam('lfo.bpmCount32', 8);   // 1/4 = 0.5s period → 2 Hz @120
    lfo.start();
    assert.near(lfo._lfoOsc.frequency.value, 2, 1e-6, 'osc Hz from bpm count');

    // Advanced per-section count fields exist and serialise.
    lfo.setParam('lfo.adsr.a.bpmCount32', 6);
    const j = lfo.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.lfos[0].fromJSON(j);
    assert.ok(t2.lfos[0].getParam('lfo.bpmCount32') === 8, 'global count round-trip');
    assert.ok(t2.lfos[0].getParam('lfo.adsr.a.bpmCount32') === 6, 'section count round-trip');

    // Legacy lfo.bpmDiv string maps to count.
    const { track: t3 } = await makeOfflineTrack('synth', 0.1);
    t3.lfos[0].fromJSON({ index: 0, params: { 'lfo.syncMode': 'bpm', 'lfo.bpmDiv': '1/4' } });
    assert.ok(t3.lfos[0].getParam('lfo.bpmCount32') === 8, 'lfo bpmDiv → count 8');
  });

  test('Arpeggiator: bpm gap from count + per-step + back-compat', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const arp = track.arp;
    arp.setBpm(120);
    arp.setParam('syncMode', 'bpm');
    arp.setParam('bpmCount32', 8);  // 1/4 = 0.5s gap
    assert.near(arp._gapSec('bpm', 0, 8), 0.5, 1e-9, 'arp gap from count');

    // Legacy arp + per-step bpmDiv strings map to counts; old keys dropped.
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.arp.fromJSON({
      enabled: false,
      params: {
        syncMode: 'bpm', bpmDiv: '1/8',
        steps: [{ semitone: 0, syncMode: 'bpm', bpmDiv: '1/16', gate: 100 }],
      },
    });
    assert.ok(t2.arp.getParam('bpmCount32') === 4, 'arp bpmDiv → count 4');
    assert.ok(t2.arp.getParam('bpmDiv') === undefined, 'arp legacy key dropped');
    assert.ok(t2.arp.getParam('steps')[0].bpmCount32 === 2, 'step bpmDiv → count 2');
    assert.ok(t2.arp.getParam('steps')[0].bpmDiv === undefined, 'step legacy key dropped');
  });

  test('Envelope: per-stage tempo-sync resolves seconds + round-trips', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);   // clock 120 BPM
    const env = track.envelope;
    env.setBpm(120);

    // Default ms mode: attack stays the raw seconds value.
    env.setParam('env.attack', 0.05);
    assert.near(env._stageSeconds('env', 'attack'), 0.05, 1e-9, 'ms stage = raw seconds');

    // BPM mode: attack follows the 1/32 count (8 = 1/4 = 0.5s @120).
    env.setParam('env.attack.syncMode', 'bpm');
    env.setParam('env.attack.bpmCount32', 8);
    assert.near(env._stageSeconds('env', 'attack'), 0.5, 1e-6, 'bpm stage from count');

    // BPM change re-resolves live (no write-back to env.attack).
    env.setBpm(60);
    assert.near(env._stageSeconds('env', 'attack'), 1.0, 1e-6, 'bpm stage follows tempo');

    // Filter env stage independent.
    env.setParam('fenv.release.syncMode', 'bpm');
    env.setParam('fenv.release.bpmCount32', 4);
    env.setBpm(120);
    assert.near(env._stageSeconds('fenv', 'release'), 0.25, 1e-6, 'fenv stage from count');

    // p-lock-style override wins for both mode + count.
    const secs = env._stageSeconds('env', 'attack', { 'env.attack.bpmCount32': 4 });
    assert.near(secs, 0.25, 1e-6, 'override count honoured');

    // Round-trip the new sync params.
    const json = env.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.envelope.fromJSON(json);
    assert.ok(t2.envelope.getParam('env.attack.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.envelope.getParam('env.attack.bpmCount32') === 8, 'count round-trip');
    assert.ok(t2.envelope.getParam('fenv.release.bpmCount32') === 4, 'fenv count round-trip');
  });

});
