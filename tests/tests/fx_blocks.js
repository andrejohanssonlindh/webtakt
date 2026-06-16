/**
 * fx_blocks.js — second-wave add-only FX blocks
 *
 * Guards every new FX type registered in Track.FX_TYPES / FX_TYPE_LABELS:
 *   - each type is addable (addFX returns an id) and lands in the chain,
 *   - audio still reaches the output bus with the block inserted (no dangling
 *     node, no thrown construction — worklet blocks degrade to dry passthrough
 *     in the OfflineAudioContext, which registers no worklet modules),
 *   - params round-trip through the FXInstance toJSON/fromJSON,
 *   - a few wet/audible blocks measurably change the signal vs dry.
 *
 * Worklet-backed blocks (crush2, stutter) can't run their DSP here (no module
 * registered on the offline ctx) — they pass dry, so we only assert the chain
 * survives them, not their effect.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, fireStep, rms } from '../runner.js';

const STEP_SEC = 0.4;
const DURATION = 0.05 + STEP_SEC + 0.6;

// Every new add-only type from this batch (phaser un-parked included).
const NEW_TYPES = [
  'phaser', 'eq3', 'autopan', 'gate', 'width', 'limiter',
  'ringmod', 'tape', 'comb', 'shimmer', 'crush2', 'stutter',
];

suite('FX blocks (second wave)', () => {

  test('every new type is registered and addable', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    for (const type of NEW_TYPES) {
      const id = track.addFX(type);
      assert.ok(id, `addFX('${type}') returned no id`);
      assert.ok(track.getFXType(id) === type, `block ${id} type ${track.getFXType(id)} != ${type}`);
      assert.ok(track.getFXOrder().includes(id), `${type} not in chain order`);
    }
  });

  test('audio passes through with each new block inserted', async () => {
    for (const type of NEW_TYPES) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      track.addFX(type);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      assert.gt(rms(w), 0.0005, `chain silent with ${type} inserted (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('params round-trip through toJSON/fromJSON', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    // Add one of each, tweak a representative param, serialise, rebuild, compare.
    const tweaks = {
      eq3:    ['eq3.midGain', 6],
      autopan:['pan.depth', 0.33],
      gate:   ['gate.depth', 0.5],
      width:  ['width.amount', 1.7],
      limiter:['lim.threshold', -12],
      ringmod:['ring.wet', 0.4],
      tape:   ['tape.feedback', 0.7],
      comb:   ['comb.freq', 330],
      shimmer:['shim.shimmer', 0.8],
      crush2: ['crush2.bits', 4],
      stutter:['stut.chance', 0.5],
      phaser: ['phaser.depth', 0.2],
    };
    const ids = {};
    for (const type of NEW_TYPES) {
      const id = track.addFX(type);
      ids[type] = id;
      const [bare, val] = tweaks[type];
      track.getFXBlock(id).setParam(`${id}.${bare}`, val);
    }

    const json = track.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.fromJSON(json);

    for (const type of NEW_TYPES) {
      const id = ids[type];
      const [bare, val] = tweaks[type];
      const got = t2.getFXBlock(id)?.getParam(`${id}.${bare}`);
      assert.near(got, val, 1e-6, `${type} ${bare} round-trip: got ${got}, expected ${val}`);
    }
  });

  test('EQ mid boost raises level vs flat', async () => {
    async function render(midGain) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      const id = track.addFX('eq3');
      const blk = track.getFXBlock(id);
      blk.setParam(`${id}.eq3.midFreq`, 1000);
      blk.setParam(`${id}.eq3.midQ`, 1);
      blk.setParam(`${id}.eq3.midGain`, midGain);
      blk.setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      return rms(w);
    }
    const flat = await render(0);
    const boosted = await render(15);
    assert.gt(boosted, flat * 1.05, `+15dB mid boost (${boosted.toFixed(5)}) not louder than flat (${flat.toFixed(5)})`);
  });

  test('Width 0 collapses toward mono (side ≈ 0)', async () => {
    // Render stereo; width 0 should null the side (L−R) signal vs width 1.
    function sideRms(buf2L, buf2R) {
      let sum = 0;
      for (let i = 0; i < buf2L.length; i++) { const s = (buf2L[i] - buf2R[i]) * 0.5; sum += s * s; }
      return Math.sqrt(sum / buf2L.length);
    }
    async function render(width) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION, { channels: 2 });
      const id = track.addFX('width');
      const blk = track.getFXBlock(id);
      blk.setParam(`${id}.width.amount`, width);
      blk.setEnabled(true);
      // A wet chorus upstream creates stereo difference for the width block to act on.
      track.chorusFX.setParam('chorus.mix', 0.8);
      track.chorusFX.setEnabled(true);
      fireStep(track, 0.05, { note: 60, velocity: 127, length: 3 });
      const r = await ctx.startRendering();
      return sideRms(r.getChannelData(0), r.getChannelData(1));
    }
    const wide = await render(1);
    const mono = await render(0);
    // width 0 should have clearly less side energy than width 1.
    assert.lt(mono, wide * 0.5 + 1e-6, `width 0 side (${mono.toFixed(6)}) not << width 1 side (${wide.toFixed(6)})`);
  });

  test('a wet RingMod changes the signal vs dry', async () => {
    async function render(wet) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      const id = track.addFX('ringmod');
      const blk = track.getFXBlock(id);
      blk.setParam(`${id}.ring.freq`, 300);
      blk.setParam(`${id}.ring.wet`, wet);
      blk.setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      return rms(w);
    }
    const dry = await render(0);
    const wet = await render(1);
    assert.notNear(wet, dry, dry * 0.05 + 1e-5,
      `ring-mod wet (${wet.toFixed(5)}) indistinguishable from dry (${dry.toFixed(5)})`);
  });

  test('Phaser wet=1 changes the signal vs dry (non-worklet, must be audible)', async () => {
    async function render(wet) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      const id = track.addFX('phaser');
      const blk = track.getFXBlock(id);
      blk.setParam(`${id}.phaser.rate`, 2);
      blk.setParam(`${id}.phaser.feedback`, 0.6);
      blk.setParam(`${id}.phaser.wet`, wet);
      blk.setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      return w;
    }
    const dry = await render(0), wet = await render(1);
    let diff = 0, n = Math.min(dry.length, wet.length);
    for (let i = 0; i < n; i++) diff += Math.abs(dry[i] - wet[i]);
    diff /= n;
    assert.gt(diff, 1e-4, `Phaser wet==dry (meandiff=${diff.toExponential(2)}) — not phasing`);
  });

  test('Shimmer wet=1 produces a reverb tail past the note', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    const id = track.addFX('shimmer');
    const blk = track.getFXBlock(id);
    blk.setParam(`${id}.shim.wet`, 1);
    blk.setEnabled(true);
    fireStep(track, 0.05, { note: 60, velocity: 127, length: 1 });
    const r = await ctx.startRendering();
    const full = r.getChannelData(0);
    // Tail well past a length-1 note: reverb wet should still ring.
    const tail = full.slice(Math.floor(0.3 * sampleRate));
    assert.gt(rms(tail), 0.0003, `Shimmer tail silent (rms=${rms(tail).toFixed(6)}) — wet reverb dead`);
  });

  test('worklet blocks (crush2/stutter) pass audio dry without throwing', async () => {
    // No worklet module on the offline ctx → constructor falls back to dry. The
    // chain must still pass audio (the fallback wiring) and not throw.
    for (const type of ['crush2', 'stutter']) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      const id = track.addFX(type);
      track.getFXBlock(id).setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      assert.gt(rms(w), 0.0005, `${type} dry-fallback chain silent (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('LFO targets exclude js-driven FX params; mod/CC targets keep them', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    // Comb exposes comb.freq as modulatable BUT js-driven (no AudioParam): it must
    // NOT be an LFO destination (the LFO connects to AudioParams), while
    // comb.feedback (AudioParam-backed) must be. The mod-wheel/CC dropdown
    // (getAssignableParams) keeps BOTH — those apply via setParam.
    const id = track.addFX('comb');

    const lfoPaths = track.getLFOAssignableParams()
      .filter(g => g.group && g.group.startsWith('Comb'))
      .flatMap(g => g.items.map(it => it.path));
    assert.ok(lfoPaths.includes(`${id}.comb.feedback`), 'comb.feedback missing from LFO targets');
    assert.ok(!lfoPaths.includes(`${id}.comb.freq`), 'comb.freq (js) wrongly offered as LFO target');

    const ccPaths = track.getAssignableParams()
      .filter(g => g.group && g.group.startsWith('Comb'))
      .flatMap(g => g.items.map(it => it.path));
    assert.ok(ccPaths.includes(`${id}.comb.freq`), 'comb.freq should remain a mod/CC target');
  });
});
