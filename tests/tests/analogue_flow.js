/**
 * analogue_flow.js — analogue-flow tests (Track.setAnalogue)
 *
 * Guards the unified analogue flow added on top of the Moog ladder filter:
 *   - RC (exponential) envelope curves (Envelope, gated by filter.engine),
 *   - filter keytrack (cutoff follows pitch),
 *   - velocity sensitivity (velocity scales amp + filter envelope),
 *   - BBD stereo chorus (ChorusFX),
 *   - the digital path staying byte-for-byte behaviourally unchanged.
 *
 * The analogue flow only engages when filter.engine resolves to 'analogue',
 * which needs the ladder worklet. AudioWorklet in OfflineAudioContext works in
 * Chromium but not Firefox (see filter_engine.js / TEST_DESIGN.md), so the
 * analogue-dependent tests load the ladder first and PASS-WITH-NOTE when it is
 * unavailable. The digital-regression test needs no worklet.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, spectralCentroid } from '../runner.js';

const LADDER_PATH = '../js/worklets/patina-ladder-processor.js';
const STEP_SEC = 0.4;
const STEP_LEN = 3;
const DURATION = 0.05 + 2 * STEP_SEC + 0.6;

async function loadLadder(ctx) {
  if (!ctx.audioWorklet) return false;
  try {
    await ctx.audioWorklet.addModule(LADDER_PATH);
    return true;
  } catch (e) {
    console.warn('analogue_flow: ladder worklet unavailable in OfflineAudioContext — passing with note.', e.message);
    return false;
  }
}

suite('Analogue flow', () => {

  test('analogue track is audible (RC envelopes do not silence it)', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('moogish', DURATION);
    if (!(await loadLadder(ctx))) return;

    track.setAnalogue(true);
    track.envelope.setParam('env.attack', 0.01);
    track.envelope.setParam('env.release', 0.1);

    const windows = await renderSteps(track, ctx, sampleRate, 2, STEP_SEC,
      () => ({ note: 60, velocity: 110, length: STEP_LEN }));
    for (const w of windows) {
      assert.gt(rms(w), 0.001, `analogue step RMS too low (rms=${rms(w).toFixed(6)})`);
    }
  });

  test('keytrack: a high note opens the filter brighter than a low note', async () => {
    // High keytrack ties cutoff to pitch, so the high note should have a clearly
    // higher spectral centroid. Low base cutoff so the effect is unmistakable.
    const { track, ctx, sampleRate } = await makeOfflineTrack('moogish', DURATION);
    if (!(await loadLadder(ctx))) return;

    track.setAnalogue(true);
    track.filter.setParam('filter.cutoff', 500);
    track.filter.setParam('filter.envAmount', 0);   // isolate keytrack from the env sweep
    track.filter.setParam('filter.keytrack', 1.0);

    const [low]  = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 36, velocity: 110, length: STEP_LEN }));

    const hi = await makeOfflineTrack('moogish', DURATION);
    await loadLadder(hi.ctx);
    hi.track.setAnalogue(true);
    hi.track.filter.setParam('filter.cutoff', 500);
    hi.track.filter.setParam('filter.envAmount', 0);
    hi.track.filter.setParam('filter.keytrack', 1.0);
    const [high] = await renderSteps(hi.track, hi.ctx, hi.sampleRate, 1, STEP_SEC,
      () => ({ note: 84, velocity: 110, length: STEP_LEN }));

    const cLow  = spectralCentroid(low,  sampleRate);
    const cHigh = spectralCentroid(high, hi.sampleRate);
    assert.gt(cHigh, cLow,
      `keytrack should brighten the high note (low centroid=${cLow.toFixed(0)}, high=${cHigh.toFixed(0)})`);
  });

  test('velocity sensitivity: a soft note is quieter than a hard one', async () => {
    const { track, ctx, sampleRate } = await makeOfflineTrack('moogish', DURATION);
    if (!(await loadLadder(ctx))) return;

    track.setAnalogue(true);
    track.envelope.setParam('env.velSens', 1.0);
    track.envelope.setParam('env.sustain', 0.8);

    const [hard] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 127, length: STEP_LEN }));

    const soft = await makeOfflineTrack('moogish', DURATION);
    await loadLadder(soft.ctx);
    soft.track.setAnalogue(true);
    soft.track.envelope.setParam('env.velSens', 1.0);
    soft.track.envelope.setParam('env.sustain', 0.8);
    const [softW] = await renderSteps(soft.track, soft.ctx, soft.sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 20, length: STEP_LEN }));

    assert.gt(rms(hard), rms(softW),
      `velocity should make the soft note quieter (hard rms=${rms(hard).toFixed(5)}, soft=${rms(softW).toFixed(5)})`);
  });

  test('digital path: velSens curve is a no-op (velocity scales linearly)', async () => {
    // Regression guard — no worklet needed. Velocity ALWAYS scales amplitude
    // (Envelope.scheduleNote: velFactor = vel on the digital path). What velSens
    // does is add an extra non-linear *curve*, and that curve must be inert when
    // not analogue. So the digital amp ratio must follow the LINEAR velocity ratio
    // (127/20 ≈ 6.35) regardless of env.velSens — i.e. velSens=0 and velSens=1
    // produce the same digital output.
    async function render(velSens, velocity) {
      const t = await makeOfflineTrack('synth', DURATION);
      t.track.envelope.setParam('env.velSens', velSens);  // curve only — inert on digital
      t.track.envelope.setParam('env.sustain', 0.8);
      const [w] = await renderSteps(t.track, t.ctx, t.sampleRate, 1, STEP_SEC,
        () => ({ note: 60, velocity, length: STEP_LEN }));
      return rms(w);
    }

    // velSens must not change the digital result: hard@0 == hard@1, soft@0 == soft@1.
    const hard0 = await render(0.0, 127);
    const hard1 = await render(1.0, 127);
    const soft0 = await render(0.0, 20);
    const soft1 = await render(1.0, 20);

    assert.near(hard0, hard1, Math.max(hard0 * 0.05, 1e-4),
      `digital velSens curve must be inert at high vel (velSens0=${hard0.toFixed(5)}, velSens1=${hard1.toFixed(5)})`);
    assert.near(soft0, soft1, Math.max(soft0 * 0.05, 1e-4),
      `digital velSens curve must be inert at low vel (velSens0=${soft0.toFixed(5)}, velSens1=${soft1.toFixed(5)})`);

    // And velocity still scales amplitude linearly on the digital path.
    assert.gt(hard0, soft0 * 2,
      `digital velocity should scale amplitude linearly (hard=${hard0.toFixed(5)}, soft=${soft0.toFixed(5)})`);
  });

  test('chorus changes the signal when enabled', async () => {
    // Chorus mixes a modulated, stereo-spread copy in, so the right channel must
    // differ from a dry render. We compare RMS of the wet vs dry right channel.
    const dry = await makeOfflineTrack('moogish', DURATION);
    dry.track.setAnalogue(true);
    dry.track.chorusFX.setEnabled(false);
    const [dryW] = await renderSteps(dry.track, dry.ctx, dry.sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 110, length: STEP_LEN }));

    const wet = await makeOfflineTrack('moogish', DURATION);
    wet.track.setAnalogue(true);
    wet.track.chorusFX.setParam('chorus.mix', 0.9);
    wet.track.chorusFX.setParam('chorus.depth', 0.8);
    wet.track.chorusFX.setEnabled(true);
    const [wetW] = await renderSteps(wet.track, wet.ctx, wet.sampleRate, 1, STEP_SEC,
      () => ({ note: 60, velocity: 110, length: STEP_LEN }));

    // Both audible, and the chorus path is not identical to dry.
    assert.gt(rms(dryW), 0.0005, 'dry render should be audible');
    assert.gt(rms(wetW), 0.0005, 'wet render should be audible');
    assert.gt(Math.abs(rms(wetW) - rms(dryW)), 1e-5,
      `chorus should alter the signal (dry rms=${rms(dryW).toFixed(6)}, wet=${rms(wetW).toFixed(6)})`);
  });

});
