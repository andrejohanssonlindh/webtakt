/**
 * fx_chain.js — per-track reorderable FX pipeline (Track.setFXOrder)
 *
 * Guards the data-driven FX chain that replaced the hardwired
 * panner → delay → crush → chorus → reverb wiring:
 *   - getFXOrder() defaults to the historical order,
 *   - setFXOrder() rebuilds the graph and audio still reaches the output bus
 *     in ANY order (no node left dangling),
 *   - a wet FX is audible regardless of its position in the chain,
 *   - setFXOrder() repairs partial / unknown orders (no FX vanishes),
 *   - order round-trips through toJSON/fromJSON (legacy projects keep default).
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, fireStep, rms } from '../runner.js';

const STEP_SEC = 0.4;
const DURATION = 0.05 + STEP_SEC + 0.6;

suite('FX chain (pipeline order)', () => {

  test('default order matches the historical chain', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    assert.ok(
      JSON.stringify(track.getFXOrder()) === JSON.stringify(['delay', 'crush', 'chorus', 'reverb']),
      `default order was ${JSON.stringify(track.getFXOrder())}`
    );
  });

  test('audio passes through after a full reversal', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    track.setFXOrder(['reverb', 'chorus', 'crush', 'delay']);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 127, length: 3 }));
    assert.gt(rms(w), 0.001, `reversed-chain step silent (rms=${rms(w).toFixed(6)})`);
  });

  test('a wet delay is audible whether first or last in the chain', async () => {
    // A wet delay should ring on past the note (in its TAIL) regardless of its
    // chain position. Render once per order, slice the tail from the full buffer.
    async function delayTail(order) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      track.setFXOrder(order);
      track.delayFX.setParam('delay.time', 0.12);
      track.delayFX.setParam('delay.feedback', 0.6);
      track.delayFX.setParam('delay.wet', 0.9);
      track.delayFX.setEnabled(true);
      fireStep(track, 0.05, { note: 60, velocity: 127, length: 1 });
      const rendered = await ctx.startRendering();
      const full = rendered.getChannelData(0);
      // Tail window: 0.25s onward (well past a length-1 note at 120bpm).
      const start = Math.floor(0.25 * sampleRate);
      return rms(full.slice(start));
    }
    const first = await delayTail(['delay', 'crush', 'chorus', 'reverb']);
    const last  = await delayTail(['crush', 'chorus', 'reverb', 'delay']);
    assert.gt(first, 0.0005, `delay tail silent when first (rms=${first.toFixed(6)})`);
    assert.gt(last,  0.0005, `delay tail silent when last (rms=${last.toFixed(6)})`);
  });

  test('base blocks omitted from setFXOrder stay out of the chain', async () => {
    // Base blocks are now removable: omitting one from the order detaches it
    // (it stays registered for re-add, but is no longer in the signal path).
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.setFXOrder(['reverb']);
    const order = track.getFXOrder();
    assert.ok(JSON.stringify(order) === JSON.stringify(['reverb']),
      `expected just reverb, got ${JSON.stringify(order)}`);
    // The detached base blocks are still registered and offered for re-add.
    assert.ok(
      JSON.stringify(track.getDetachedBaseIds().sort()) === JSON.stringify(['chorus', 'crush', 'delay']),
      `detached set wrong: ${JSON.stringify(track.getDetachedBaseIds())}`);
  });

  test('unknown ids are dropped; added instances never orphaned', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.addFX('reverb');  // fx1 — an instance must never be dropped from the graph
    track.setFXOrder(['delay', 'bogus', 'crush', 'delay']); // dup + unknown, omits fx1
    const order = track.getFXOrder();
    assert.ok(!order.includes('bogus'), 'unknown id leaked into order');
    assert.ok(new Set(order).size === order.length, `duplicate retained in ${JSON.stringify(order)}`);
    assert.ok(order.includes('fx1'), 'added instance was orphaned out of the chain');
  });

  test('removeFX detaches a base block but keeps it registered + re-addable', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    assert.ok(track.isFXRemovable('reverb'), 'base block should be removable now');
    track.removeFX('reverb');
    assert.ok(!track.getFXOrder().includes('reverb'), 'reverb still in chain after remove');
    assert.ok(track.getFXBlock('reverb') === track.reverbFX, 'base block was deleted (should stay registered)');
    assert.ok(track.getDetachedBaseIds().includes('reverb'), 'reverb not offered for re-add');
    assert.ok(track.reattachBaseFX('reverb') === 'reverb', 'reattach failed');
    assert.ok(track.getFXOrder().includes('reverb'), 'reverb not back in chain after reattach');
  });

  test('order round-trips through toJSON / fromJSON', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.setFXOrder(['chorus', 'reverb', 'delay', 'crush']);
    const json = track.toJSON();
    assert.ok(
      JSON.stringify(json.fxOrder) === JSON.stringify(['chorus', 'reverb', 'delay', 'crush']),
      `toJSON order wrong: ${JSON.stringify(json.fxOrder)}`
    );
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.fromJSON(json);
    assert.ok(
      JSON.stringify(t2.getFXOrder()) === JSON.stringify(['chorus', 'reverb', 'delay', 'crush']),
      `restored order wrong: ${JSON.stringify(t2.getFXOrder())}`
    );
  });

  test('legacy project (no fxOrder) keeps the default order', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const json = track.toJSON();
    delete json.fxOrder;            // simulate a pre-pipeline save
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.fromJSON(json);
    assert.ok(
      JSON.stringify(t2.getFXOrder()) === JSON.stringify(['delay', 'crush', 'chorus', 'reverb']),
      `legacy default wrong: ${JSON.stringify(t2.getFXOrder())}`
    );
  });

});

suite('FX chain (multi-instance)', () => {

  test('addFX appends an instance with a namespaced id', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const id = track.addFX('reverb');
    assert.ok(id === 'fx1', `expected fx1, got ${id}`);
    assert.ok(track.getFXOrder().includes('fx1'), 'instance not in order');
    assert.ok(track.isFXRemovable('fx1'), 'instance should be removable');
    assert.ok(track.isFXBase('reverb'), 'reverb should report as a base block');
    assert.ok(!track.isFXBase('fx1'), 'instance should not report as base');
    assert.ok(track.getFXType('fx1') === 'reverb', `type wrong: ${track.getFXType('fx1')}`);
  });

  test('instance param paths are namespaced and resolve to the instance', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const id = track.addFX('reverb');
    const inst = track.getFXBlock(id);
    const paths = inst.getParamList().map(p => p.path);
    assert.ok(paths.includes('fx1.reverb.wet'), `missing namespaced path; got ${paths.join(',')}`);
    // Owner resolution: namespaced path → the instance; bare path → base block.
    assert.ok(track.fxObjForPath('fx1.reverb.wet') === inst, 'namespaced path resolved wrong owner');
    assert.ok(track.fxObjForPath('reverb.wet') === track.reverbFX, 'bare path resolved wrong owner');
    // setParam/getParam through the proxy hit the wrapped FX.
    inst.setParam('fx1.reverb.wet', 0.5);
    assert.near(inst.getParam('fx1.reverb.wet'), 0.5, 1e-6, 'proxy getParam mismatch');
    assert.near(track.reverbFX.getParam('reverb.wet'), 0, 1e-6, 'base reverb wrongly written');
  });

  test('two reverbs do not collide', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const a = track.addFX('reverb');
    const b = track.addFX('reverb');
    track.getFXBlock(a).setParam('fx1.reverb.wet', 0.3);
    track.getFXBlock(b).setParam('fx2.reverb.wet', 0.7);
    assert.near(track.getFXBlock(a).getParam('fx1.reverb.wet'), 0.3, 1e-6, 'instance A clobbered');
    assert.near(track.getFXBlock(b).getParam('fx2.reverb.wet'), 0.7, 1e-6, 'instance B clobbered');
  });

  test('new FX types build and pass audio', async () => {
    // Phaser is parked (removed from FX_TYPES), so it's not in this list.
    for (const type of ['distortion', 'compressor', 'filter', 'normalizer']) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', 0.6);
      const id = track.addFX(type);
      assert.ok(id, `addFX(${type}) returned null`);
      const inst = track.getFXBlock(id);
      inst.setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, 0.4,
        () => ({ note: 60, velocity: 127, length: 3 }));
      assert.gt(rms(w), 0.001, `${type} silenced the signal (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('removeFX detaches the instance and strips its p-locks', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const id = track.addFX('reverb');
    const step = track.sequencer.steps[0];
    step.plocks.set('fx1.reverb.wet', 0.8);
    track.removeFX(id);
    assert.ok(!track.getFXOrder().includes(id), 'instance still in order after remove');
    assert.ok(!step.plocks.has('fx1.reverb.wet'), 'instance p-lock not stripped');
    assert.ok(track.getFXBlock(id) === null, 'instance block not deleted');
  });

  test('instances round-trip through toJSON / fromJSON with stable ids', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.addFX('reverb');             // fx1
    const fId = track.addFX('filter'); // fx2
    track.getFXBlock(fId).setParam('fx2.fxfilt.cutoff', 4000);
    track.setFXOrder(['fx2', 'delay', 'crush', 'chorus', 'reverb', 'fx1']);
    const json = track.toJSON();

    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.fromJSON(json);
    assert.ok(
      JSON.stringify(t2.getFXOrder()) === JSON.stringify(['fx2', 'delay', 'crush', 'chorus', 'reverb', 'fx1']),
      `restored order wrong: ${JSON.stringify(t2.getFXOrder())}`
    );
    assert.ok(t2.getFXType('fx2') === 'filter', `fx2 type wrong: ${t2.getFXType('fx2')}`);
    assert.near(t2.getFXBlock('fx2').getParam('fx2.fxfilt.cutoff'), 4000, 1e-6, 'instance param not restored');
    // Next added id must not collide with restored ids.
    const next = t2.addFX('delay');
    assert.ok(next === 'fx3', `next id should be fx3, got ${next}`);
  });

  test('normalizer instance builds and passes audio', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', 0.6);
    const id = track.addFX('normalizer');
    assert.ok(id, 'addFX(normalizer) returned null');
    const inst = track.getFXBlock(id);
    inst.setEnabled(true);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, 0.4,
      () => ({ note: 60, velocity: 127, length: 3 }));
    assert.gt(rms(w), 0.001, `normalizer silenced the signal (rms=${rms(w).toFixed(6)})`);
  });

});

suite('FX chain (FX binds)', () => {

  test('setFXBind assigns and toggleFXBind flips the assigned block', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    assert.ok(track.getFXBindFor('reverb') === null, 'reverb should start unbound');
    track.setFXBind(1, 'reverb');
    assert.ok(track.getFXBindFor('reverb') === 1, 'bind 1 not assigned to reverb');
    assert.ok(track.getFXBindBlock(1) === 'reverb', 'getFXBindBlock(1) wrong');
    const before = track.reverbFX.enabled;
    track.toggleFXBind(1);
    assert.ok(track.reverbFX.enabled === !before, 'toggleFXBind did not flip reverb');
  });

  test('assigning a bind enforces the 1:1 rule', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.setFXBind(1, 'reverb');
    track.setFXBind(1, 'delay');     // steal bind 1 → delay
    assert.ok(track.getFXBindFor('reverb') === null, 'reverb kept a stolen bind');
    assert.ok(track.getFXBindFor('delay') === 1, 'delay did not take bind 1');
    track.setFXBind(2, 'delay');     // a block holds at most one bind
    assert.ok(track.getFXBindFor('delay') === 2, 'delay did not move to bind 2');
    assert.ok(track.getFXBindBlock(1) === null, 'bind 1 still points at delay');
  });

  test('removing a bound block clears its bind', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const id = track.addFX('reverb');
    track.setFXBind(3, id);
    track.removeFX(id);
    assert.ok(track.getFXBindBlock(3) === null, 'bind not cleared on remove');
  });

  test('binds round-trip through toJSON / fromJSON (stale binds dropped)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.setFXBind(2, 'crush');
    const json = track.toJSON();
    assert.ok(json.fxBinds[2] === 'crush', `fxBinds not serialised: ${JSON.stringify(json.fxBinds)}`);
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.fromJSON(json);
    assert.ok(t2.getFXBindFor('crush') === 2, 'bind not restored');

    // A bind pointing at a block no longer in the chain is dropped on load.
    const json2 = track.toJSON();
    json2.fxBinds[4] = 'fx99';      // nonexistent
    const { track: t3 } = await makeOfflineTrack('synth', 0.1);
    t3.fromJSON(json2);
    assert.ok(t3.getFXBindBlock(4) === null, 'stale bind survived load');
  });

});

suite('FX chain (presets)', () => {

  test('exportFXPreset captures order, base params, and instances', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.delayFX.setParam('delay.wet', 0.42);
    track.addFX('reverb');             // fx1
    track.setFXOrder(['fx1', 'delay', 'crush', 'chorus', 'reverb']);
    const p = track.exportFXPreset();
    assert.ok(
      JSON.stringify(p.fxOrder) === JSON.stringify(['fx1', 'delay', 'crush', 'chorus', 'reverb']),
      `preset order wrong: ${JSON.stringify(p.fxOrder)}`
    );
    assert.near(p.delayFX.params['delay.wet'], 0.42, 1e-6, 'base delay param not captured');
    assert.ok(p.fxInstances.length === 1, `expected 1 instance, got ${p.fxInstances.length}`);
  });

  test('applyFXPreset round-trips onto a fresh track', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const fId = track.addFX('filter'); // fx1
    track.getFXBlock(fId).setParam('fx1.fxfilt.cutoff', 3200);
    track.delayFX.setParam('delay.wet', 0.55);
    track.setFXOrder(['fx1', 'reverb', 'delay', 'crush', 'chorus']);
    const preset = track.exportFXPreset();

    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.applyFXPreset(preset);
    assert.ok(
      JSON.stringify(t2.getFXOrder()) === JSON.stringify(['fx1', 'reverb', 'delay', 'crush', 'chorus']),
      `applied order wrong: ${JSON.stringify(t2.getFXOrder())}`
    );
    assert.ok(t2.getFXType('fx1') === 'filter', `fx1 type wrong: ${t2.getFXType('fx1')}`);
    assert.near(t2.getFXBlock('fx1').getParam('fx1.fxfilt.cutoff'), 3200, 1e-6, 'instance param not applied');
    assert.near(t2.delayFX.getParam('delay.wet'), 0.55, 1e-6, 'base delay param not applied');
  });

  test('applying a preset replaces a different existing chain cleanly', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.addFX('reverb');             // fx1 — will be replaced
    track.addFX('distortion');         // fx2 — will be replaced
    const preset = (await makeOfflineTrack('synth', 0.1)).track.exportFXPreset(); // base-four default
    track.applyFXPreset(preset);
    assert.ok(
      JSON.stringify(track.getFXOrder()) === JSON.stringify(['delay', 'crush', 'chorus', 'reverb']),
      `chain not reset to preset: ${JSON.stringify(track.getFXOrder())}`
    );
    assert.ok(track.getFXBlock('fx1') === null && track.getFXBlock('fx2') === null,
      'old instances not torn down on apply');
  });

  test('auditionFXPreset(dry) bypasses every block; the prior chain is recoverable', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    track.reverbFX.setEnabled(true);
    track.delayFX.setEnabled(true);
    const snapshot = track.exportFXPreset();   // what auditionFXPreset snapshots internally
    assert.ok(track.reverbFX.enabled && track.delayFX.enabled, 'precondition: blocks enabled');

    track.auditionFXPreset(null, { dry: true });
    // Synchronously, dry audition bypasses every block.
    assert.ok(!track.reverbFX.enabled && !track.delayFX.enabled, 'dry audition did not bypass blocks');
    assert.ok(track._auditionRestoreTimer != null, 'no restore timer scheduled');

    // Fire the restore deterministically (the real one is on a timer) and confirm
    // the enabled flags come back.
    clearTimeout(track._auditionRestoreTimer);
    track.applyFXPreset(snapshot);
    assert.ok(track.reverbFX.enabled && track.delayFX.enabled, 'enabled flags not restored from snapshot');
  });

});
