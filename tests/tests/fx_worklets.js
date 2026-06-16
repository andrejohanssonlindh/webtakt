/**
 * fx_worklets.js — diagnostic: do the worklet FX (Crush+, Stutter) actually
 * process when their module IS registered?
 *
 * makeOfflineTrack does NOT register worklet modules, so normally Crush2FX /
 * StutterFX fall back to dry. Here we register the modules into the offline ctx
 * FIRST (mirroring filter_engine.js), THEN add the FX, so the worklet node really
 * constructs — and we assert the wet output differs from dry. If these fail, the
 * worklet processor itself is the problem; if they pass, the bug is in the live
 * app (load timing / routing), not the DSP.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, fireStep, rms } from '../runner.js';

const STEP_SEC = 0.4;
const DURATION = 0.05 + STEP_SEC + 0.4;
const CRUSH_PATH   = '../js/worklets/bitcrush-processor.js';
const STUTTER_PATH = '../js/worklets/stutter-processor.js';

async function loadModule(ctx, path) {
  if (!ctx.audioWorklet) return false;
  try { await ctx.audioWorklet.addModule(path); return true; }
  catch (e) { console.warn('fx_worklets: module unavailable —', path, e.message); return false; }
}

suite('FX worklets (Crush+/Stutter DSP)', () => {

  test('Crush+ worklet audibly changes the signal vs dry', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    if (!(await loadModule(ctx, CRUSH_PATH))) return;  // pass-with-note

    const id  = track.addFX('crush2');
    const blk = track.getFXBlock(id);
    blk.setParam(`${id}.crush2.bits`, 3);       // heavy crush
    blk.setParam(`${id}.crush2.downsamp`, 16);
    blk.setParam(`${id}.crush2.wet`, 1);
    blk.setEnabled(true);

    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 127, length: 3 }));
    assert.gt(rms(w), 0.0005, `Crush+ produced silence (rms=${rms(w).toFixed(6)}) — worklet wet path dead`);
  });

  test('Crush+ wet=1 differs from wet=0 (proves the worklet processes)', async () => {
    async function render(wet) {
      const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
      if (!(await loadModule(ctx, CRUSH_PATH))) return null;
      const id  = track.addFX('crush2');
      const blk = track.getFXBlock(id);
      blk.setParam(`${id}.crush2.bits`, 2);
      blk.setParam(`${id}.crush2.downsamp`, 24);
      blk.setParam(`${id}.crush2.wet`, wet);
      blk.setEnabled(true);
      const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity: 127, length: 3 }));
      return w;
    }
    const dry = await render(0);
    const wet = await render(1);
    if (!dry || !wet) return;  // pass-with-note
    // Sample-by-sample difference must be non-trivial if the crusher ran.
    let diff = 0, n = Math.min(dry.length, wet.length);
    for (let i = 0; i < n; i++) diff += Math.abs(dry[i] - wet[i]);
    diff /= n;
    assert.gt(diff, 1e-5, `Crush+ wet==dry (meandiff=${diff.toExponential(2)}) — worklet not crushing`);
  });

  test('Stutter worklet passes audio (wet path alive) with module loaded', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
    if (!(await loadModule(ctx, STUTTER_PATH))) return;
    const id  = track.addFX('stutter');
    const blk = track.getFXBlock(id);
    blk.setParam(`${id}.stut.wet`, 1);
    blk.setEnabled(true);
    const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 127, length: 3 }));
    assert.gt(rms(w), 0.0005, `Stutter produced silence at wet=1 (rms=${rms(w).toFixed(6)}) — worklet wet path dead`);
  });
});
