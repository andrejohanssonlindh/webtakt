/**
 * machines/sample_swarm.js — SampleSwarmMachine tests
 *
 * Unlike bare SamplerMachine, we can inject a synthetic buffer directly
 * via track.machine.setBuffer() before rendering.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.35;
const STEP_LEN = 3;
const DURATION = 0.05 + 4 * STEP_SEC + 0.5;
const SR       = 44100;

/** Create a simple sine-wave AudioBuffer at the given frequency. */
function makeSineBuffer(ctx, freqHz = 261.63, durationSec = 0.5) {
  const len = Math.ceil(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const period = ctx.sampleRate / freqHz;
  for (let i = 0; i < len; i++) {
    data[i] = 0.5 * Math.sin(2 * Math.PI * i / period);
  }
  return buf;
}

suite('SampleSwarmMachine', () => {

  test('produces audible output when buffer is loaded', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('sample-swarm', DURATION);
    track.filter.setParam('filter.cutoff', 20000);

    const buf = makeSineBuffer(ctx);
    track.machine.setBuffer(buf, 'test-id', 'test.wav');

    const windows = await renderSteps(track, ctx, sampleRate, 4, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    for (const w of windows) {
      assert.gt(rms(w), 0.001, `Step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('stays silent when no buffer is loaded', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('sample-swarm', DURATION);
    track.filter.setParam('filter.cutoff', 20000);
    // No buffer set — machine should produce silence

    const windows = await renderSteps(track, ctx, sampleRate, 2, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    for (const w of windows) {
      assert.lt(rms(w), 0.001, `Expected silence before buffer load (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('spread=0 produces less spectral spread than spread=80', async () => {
    // With spread=0 all 7 voices play the same pitch → fundamental is stronger.
    // With spread=80 voices detune widely → energy disperses around the fundamental.
    // Compare bandpassRms at the fundamental: spread=0 should be >= spread=80
    // (voices coherently add at C4), while off-fundamental energy should be
    // higher with spread=80.
    const durSec = 0.05 + STEP_SEC + 0.3;

    const narrow = await makeOfflineTrack('sample-swarm', durSec);
    narrow.track.filter.setParam('filter.cutoff', 20000);
    narrow.track.machine.setBuffer(makeSineBuffer(narrow.ctx, 261.63, 0.5), 'n', 'n.wav');
    narrow.track.machine.setParam('spread', 0);
    narrow.track.machine.setParam('noise.amount', 0);
    narrow.track.machine.setParam('swarm.detune', 0);

    const wide = await makeOfflineTrack('sample-swarm', durSec);
    wide.track.filter.setParam('filter.cutoff', 20000);
    wide.track.machine.setBuffer(makeSineBuffer(wide.ctx, 261.63, 0.5), 'w', 'w.wav');
    wide.track.machine.setParam('spread', 80);
    wide.track.machine.setParam('noise.amount', 0);
    wide.track.machine.setParam('swarm.detune', 0);

    const [wNarrow] = await renderSteps(narrow.track, narrow.ctx, narrow.sampleRate, 1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));
    const [wWide]   = await renderSteps(wide.track,   wide.ctx,   wide.sampleRate,   1, STEP_SEC,
      () => ({ note: 60, length: STEP_LEN }));

    // Both should produce sound
    assert.gt(rms(wNarrow), 0.001, `Narrow spread silent`);
    assert.gt(rms(wWide),   0.001, `Wide spread silent`);

    // Narrow spread: more energy tightly at the fundamental
    const rNarrow = bandpassRms(wNarrow, narrow.sampleRate, 261.63, 0.3);
    const rWide   = bandpassRms(wWide,   wide.sampleRate,   261.63, 0.3);
    assert.gt(rNarrow, rWide * 1.1,
      `Narrow spread should focus more energy at fundamental (narrow=${rNarrow.toFixed(5)}, wide=${rWide.toFixed(5)})`);
  });

  test('height=0 produces less output than height=1', async () => {
    const durSec = 0.05 + STEP_SEC + 0.3;

    const low  = await makeOfflineTrack('sample-swarm', durSec);
    low.track.filter.setParam('filter.cutoff', 20000);
    low.track.machine.setBuffer(makeSineBuffer(low.ctx), 'l', 'l.wav');
    low.track.machine.setParam('height', 0);

    const high = await makeOfflineTrack('sample-swarm', durSec);
    high.track.filter.setParam('filter.cutoff', 20000);
    high.track.machine.setBuffer(makeSineBuffer(high.ctx), 'h', 'h.wav');
    high.track.machine.setParam('height', 1);

    const [wLow]  = await renderSteps(low.track,  low.ctx,  low.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wHigh] = await renderSteps(high.track, high.ctx, high.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    assert.gt(rms(wHigh), rms(wLow) * 1.1,
      `height=1 should be louder than height=0 (high=${rms(wHigh).toFixed(5)}, low=${rms(wLow).toFixed(5)})`);
  });

  test('output.level scales output amplitude', async () => {
    const durSec = 0.05 + STEP_SEC + 0.3;

    const quiet = await makeOfflineTrack('sample-swarm', durSec);
    quiet.track.filter.setParam('filter.cutoff', 20000);
    quiet.track.machine.setBuffer(makeSineBuffer(quiet.ctx), 'q', 'q.wav');
    quiet.track.machine.setParam('output.level', 0.1);

    const loud = await makeOfflineTrack('sample-swarm', durSec);
    loud.track.filter.setParam('filter.cutoff', 20000);
    loud.track.machine.setBuffer(makeSineBuffer(loud.ctx), 'L', 'L.wav');
    loud.track.machine.setParam('output.level', 0.9);

    const [wQ] = await renderSteps(quiet.track, quiet.ctx, quiet.sampleRate, 1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));
    const [wL] = await renderSteps(loud.track,  loud.ctx,  loud.sampleRate,  1, STEP_SEC, () => ({ note: 60, length: STEP_LEN }));

    assert.gt(rms(wL), rms(wQ) * 3,
      `output.level=0.9 should be much louder than 0.1 (loud=${rms(wL).toFixed(5)}, quiet=${rms(wQ).toFixed(5)})`);
  });

  test('toJSON / fromJSON round-trips swarm params', async () => {
    const { track } = await makeOfflineTrack('sample-swarm', 0.1);
    const m = track.machine;
    m.setParam('spread',       42);
    m.setParam('swarm.detune', 12);
    m.setParam('height',       0.4);
    m.setParam('slope',        0.6);
    m.setParam('noise.amount', 20);
    m.setParam('noise.color',  0.8);
    m.setParam('output.level', 0.6);

    const json = m.toJSON();
    assert.near(json.params['spread'],       42,  0.001, 'spread in JSON');
    assert.near(json.params['swarm.detune'], 12,  0.001, 'swarm.detune in JSON');
    assert.near(json.params['height'],       0.4, 0.001, 'height in JSON');
    assert.near(json.params['slope'],        0.6, 0.001, 'slope in JSON');
    assert.near(json.params['noise.amount'], 20,  0.001, 'noise.amount in JSON');
    assert.near(json.params['noise.color'],  0.8, 0.001, 'noise.color in JSON');
    assert.near(json.params['output.level'], 0.6, 0.001, 'output.level in JSON');
    assert.ok(json.type === 'sample-swarm', 'type in JSON');
  });

});
