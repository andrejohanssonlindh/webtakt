/**
 * machines/juno.js — JunoMachine (PWM string/pad) tests
 *
 * One PWM oscillator (saw − delayed-saw) + square sub + pink noise, analogue-
 * family. param_spec.js guards the descriptor contract + generic round-trip; this
 * covers audible behaviour. Filter forced wide-open digital to measure the
 * MACHINE spectrum, not the analogue flow.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandEnergy, bandpassRms } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 3;
const DURATION = 0.05 + 2 * STEP_SEC + 0.6;

async function renderJuno(overrides) {
  const { track, ctx, sampleRate } = await makeOfflineTrack('juno', DURATION);
  track.setAnalogue(false);
  track.filter.setParam('filter.cutoff', 20000);
  track.filter.setParam('base.lpf', 20000);
  for (const [p, v] of Object.entries(overrides)) track.machine.setParam(p, v);
  const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
    () => ({ note: 48, velocity: 110, length: STEP_LEN }));
  return { w, sampleRate };
}

suite('JunoMachine', () => {

  test('produces audible output', async () => {
    const { w } = await renderJuno({});
    assert.gt(rms(w), 0.001, `baseline RMS too low (rms=${rms(w).toFixed(6)})`);
  });

  test('PW width changes the pulse spectrum', async () => {
    // The PWM duty changes which harmonics are present. A near-square (50%) and a
    // narrow pulse (10%) should have measurably different harmonic energy, so the
    // total upper-band energy differs between widths (sub + noise off to isolate).
    const a = await renderJuno({ 'pwm.width': 0.5, 'sub.level': 0, 'noise.level': 0 });
    const b = await renderJuno({ 'pwm.width': 0.1, 'sub.level': 0, 'noise.level': 0 });
    const eA = bandEnergy(a.w, a.sampleRate, 400, 4000);
    const eB = bandEnergy(b.w, b.sampleRate, 400, 4000);
    // Both must be audible and the spectra must differ (not byte-identical).
    assert.gt(eA, 0, 'PW 50% has upper-band energy');
    assert.gt(eB, 0, 'PW 10% has upper-band energy');
    assert.gt(Math.abs(eA - eB) / Math.max(eA, eB), 0.05,
      `PW width should change the spectrum (${eA.toFixed(0)} vs ${eB.toFixed(0)})`);
  });

  test('sub oscillator adds low-frequency weight', async () => {
    // bandpassRms is amplitude-based (not peak-normalised) — the right tool for
    // "is there more energy here". note 48 → osc ≈ 130 Hz, sub ≈ 65 Hz.
    const dry = await renderJuno({ 'sub.level': 0, 'noise.level': 0 });
    const wet = await renderJuno({ 'sub.level': 1, 'noise.level': 0 });
    const bDry = bandpassRms(dry.w, dry.sampleRate, 65, 0.5);
    const bWet = bandpassRms(wet.w, wet.sampleRate, 65, 0.5);
    assert.gt(bWet, bDry * 1.5, `sub=1 should add low-end at ~65 Hz over sub=0 (${bWet.toFixed(6)} vs ${bDry.toFixed(6)})`);
  });

  test('toJSON/fromJSON round-trips params', async () => {
    const { track } = await makeOfflineTrack('juno', DURATION);
    const m = track.machine;
    m.setParam('pwm.width', 0.3);
    m.setParam('octave', 1);
    m.setParam('sub.level', 0.6);
    m.setParam('sub.waveform', 'triangle');
    const json = m.toJSON();

    const { track: t2 } = await makeOfflineTrack('juno', DURATION);
    t2.machine.fromJSON(json);
    assert.near(t2.machine.getParam('pwm.width'), 0.3, 1e-9, 'pwm.width round-trip');
    assert.ok(t2.machine.getParam('octave') === 1, 'octave round-trip');
    assert.near(t2.machine.getParam('sub.level'), 0.6, 1e-9, 'sub.level round-trip');
    assert.ok(t2.machine.getParam('sub.waveform') === 'triangle', 'sub.waveform round-trip');
  });

});
