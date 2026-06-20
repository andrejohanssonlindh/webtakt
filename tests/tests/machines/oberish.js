/**
 * machines/oberish.js — OberishMachine (2-osc brass/pad) tests
 *
 * Two detuned oscillators (saw + pulse) with a wide drift spread. param_spec.js
 * guards the descriptor contract + generic round-trip; this covers audible
 * behaviour. Filter forced wide-open digital to measure the MACHINE spectrum.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 3;
const DURATION = 0.05 + 2 * STEP_SEC + 0.6;

async function renderOb(overrides) {
  const { track, ctx, sampleRate } = await makeOfflineTrack('oberish', DURATION);
  track.setAnalogue(false);
  track.filter.setParam('filter.cutoff', 20000);
  track.filter.setParam('base.lpf', 20000);
  for (const [p, v] of Object.entries(overrides)) track.machine.setParam(p, v);
  const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
    () => ({ note: 48, velocity: 110, length: STEP_LEN }));
  return { w, sampleRate };
}

suite('OberishMachine', () => {

  test('produces audible output', async () => {
    const { w } = await renderOb({});
    assert.gt(rms(w), 0.001, `baseline RMS too low (rms=${rms(w).toFixed(6)})`);
  });

  test('second oscillator adds body at its own pitch', async () => {
    // Put osc2 an octave up (≈261.6 Hz at note 48) so it occupies its OWN band —
    // then turning it on adds energy there. (Comparing total RMS at unison fails:
    // two detuned saws BEAT and can cancel over the window, so two oscs can read
    // quieter than one. Measure osc2's distinct band instead.) Pure sines + drift
    // off so the band is clean.
    const common = { 'osc1.waveform': 'sine', 'osc2.waveform': 'sine',
                     'osc1.detune': 0, 'osc2.detune': 0, 'osc2.octave': 1,
                     'noise.level': 0, 'drift': 0, 'spread': 0 };
    const off = await renderOb({ ...common, 'osc1.level': 0.7, 'osc2.level': 0 });
    const on  = await renderOb({ ...common, 'osc1.level': 0.7, 'osc2.level': 0.7 });
    const bOff = bandpassRms(off.w, off.sampleRate, 261.6, 0.1);
    const bOn  = bandpassRms(on.w,  on.sampleRate,  261.6, 0.1);
    assert.gt(bOn, bOff * 1.5,
      `osc2 should add energy at ~261.6 Hz (${bOn.toFixed(6)} vs ${bOff.toFixed(6)})`);
  });

  test('spread detunes osc2 out of its resting band', async () => {
    // Put osc2 an octave up (≈261.6 Hz at note 48) so it sits cleanly in its own
    // band. spread pushes osc2 UP by `spread` cents, so a TIGHT band centred on
    // its un-spread position (261.6 Hz) holds full energy at spread=0 but much
    // less at spread=50 (osc2 moved to ≈269 Hz, out of the band). Pure sines +
    // drift off so the band is clean and stable.
    const common = { 'osc1.waveform': 'sine', 'osc2.waveform': 'sine',
                     'osc1.detune': 0, 'osc2.detune': 0, 'osc2.octave': 1,
                     'noise.level': 0, 'drift': 0 };
    const flat = await renderOb({ ...common, 'spread': 0 });
    const wide = await renderOb({ ...common, 'spread': 50 });
    const bFlat = bandpassRms(flat.w, flat.sampleRate, 261.6, 0.03);
    const bWide = bandpassRms(wide.w, wide.sampleRate, 261.6, 0.03);
    assert.gt(bFlat, bWide * 1.3,
      `spread should move osc2 out of its 261.6 Hz band (${bFlat.toFixed(6)} vs ${bWide.toFixed(6)})`);
  });

  test('toJSON/fromJSON round-trips params', async () => {
    const { track } = await makeOfflineTrack('oberish', DURATION);
    const m = track.machine;
    m.setParam('osc1.detune', -20);
    m.setParam('osc2.waveform', 'saw');
    m.setParam('spread', 30);
    m.setParam('drift', 0.8);
    const json = m.toJSON();

    const { track: t2 } = await makeOfflineTrack('oberish', DURATION);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('osc1.detune') === -20, 'osc1.detune round-trip');
    assert.ok(t2.machine.getParam('osc2.waveform') === 'saw', 'osc2.waveform round-trip');
    assert.ok(t2.machine.getParam('spread') === 30, 'spread round-trip');
    assert.near(t2.machine.getParam('drift'), 0.8, 1e-9, 'drift round-trip');
  });

});
