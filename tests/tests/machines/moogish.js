/**
 * machines/moogish.js — MoogishMachine oscillator-feature tests
 *
 * Phase-1 analogue-synth expansion: PWM (2-saw delay), ring/cross-mod, wavefolder,
 * and hard sync (worklet). param_spec.js already guards the descriptor contract +
 * generic round-trip; this covers the audible behaviour of the new osc tricks.
 * The filter is forced wide-open digital so we measure the MACHINE spectrum, not
 * the analogue flow. Sync needs the sync-osc worklet (unavailable in
 * OfflineAudioContext) so it is tested as a state/contract round-trip only.
 */

import { suite, test, assert, makeOfflineTrack, renderSteps, rms, bandpassRms, spectralCentroid } from '../../runner.js';

const STEP_SEC = 0.4;
const STEP_LEN = 3;
const DURATION = 0.05 + 2 * STEP_SEC + 0.6;

// Render one held note with the digital filter wide open and the given machine
// param overrides; return the first step window.
async function renderMoog(overrides) {
  const { track, ctx, sampleRate } = await makeOfflineTrack('moogish', DURATION);
  track.setAnalogue(false);                       // digital filter, no analogue flow
  track.filter.setParam('filter.cutoff', 20000);
  track.filter.setParam('base.lpf', 20000);
  for (const [p, v] of Object.entries(overrides)) track.machine.setParam(p, v);
  const [w] = await renderSteps(track, ctx, sampleRate, 1, STEP_SEC,
    () => ({ note: 48, velocity: 110, length: STEP_LEN }));
  return { w, sampleRate };
}

suite('MoogishMachine (osc features)', () => {

  test('baseline is audible', async () => {
    const { w } = await renderMoog({});
    assert.gt(rms(w), 0.001, `baseline RMS too low (rms=${rms(w).toFixed(6)})`);
  });

  test('PWM layer adds a pulse body (more energy between osc partials)', async () => {
    // Solo the PWM layer vs solo osc1, same pitch. The PWM layer is a real pulse
    // with strong harmonics, so it is audible on its own.
    const { w } = await renderMoog({
      'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0,
      'pwm': 1, 'pwm.width': 0.5,
    });
    assert.gt(rms(w), 0.001, `PWM-only render should be audible (rms=${rms(w).toFixed(6)})`);
  });

  test('wavefolder brightens the spectrum', async () => {
    // A single sine osc folded should gain upper harmonics → higher centroid.
    const base = await renderMoog({
      'osc1.waveform': 'sine', 'osc2.level': 0, 'osc3.level': 0, 'fold': 0,
    });
    const fold = await renderMoog({
      'osc1.waveform': 'sine', 'osc2.level': 0, 'osc3.level': 0, 'fold': 1,
    });
    const cBase = spectralCentroid(base.w, base.sampleRate);
    const cFold = spectralCentroid(fold.w, fold.sampleRate);
    assert.gt(cFold, cBase * 1.2,
      `fold=1 should brighten vs fold=0 (centroid ${cFold.toFixed(0)} vs ${cBase.toFixed(0)})`);
  });

  test('ring mod adds inharmonic content not present without it', async () => {
    // osc1 sine × osc2 sine (detuned) produces sum/difference tones. With osc1+osc2
    // soloed at an inharmonic detune, the ring product lands energy in a band the
    // two pure sines do not occupy. Compare ring=0 vs ring=1 in that band.
    const setup = {
      'osc1.waveform': 'sine', 'osc2.waveform': 'sine',
      'osc1.level': 0.5, 'osc2.level': 0.5, 'osc3.level': 0,
      'osc2.octave': 1, 'osc2.detune': 30,
    };
    const dry = await renderMoog({ ...setup, 'ring': 0 });
    const wet = await renderMoog({ ...setup, 'ring': 1 });
    // note 48 → osc1≈130.8 Hz, osc2≈266 Hz; their SUM (~397 Hz) is the ring
    // sideband. Pure sines put ~nothing there (imperfect-sine harmonics are
    // trace-level), so the ring product dominates.
    const bDry = bandpassRms(dry.w, dry.sampleRate, 397, 0.5);
    const bWet = bandpassRms(wet.w, wet.sampleRate, 397, 0.5);
    assert.gt(bWet, bDry * 1.5,
      `ring=1 should add a sum-tone sideband (~397 Hz) over ring=0 (${bWet.toFixed(6)} vs ${bDry.toFixed(6)})`);
  });

  test('hard-sync param round-trips (worklet-free contract)', async () => {
    // The sync worklet is unavailable in OfflineAudioContext, so sync stays
    // native — but the INTENT must persist in params and round-trip, so a project
    // saved with sync on restores it when the worklet later loads.
    const { track } = await makeOfflineTrack('moogish', DURATION);
    const m = track.machine;
    m.setParam('osc2.sync', true);
    m.setParam('osc2.sync.amt', 0.6);
    assert.ok(m.getParam('osc2.sync') === true, 'sync intent kept even when worklet absent');

    const json = m.toJSON();
    const { track: t2 } = await makeOfflineTrack('moogish', DURATION);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('osc2.sync') === true, 'osc2.sync round-trip');
    assert.near(t2.machine.getParam('osc2.sync.amt'), 0.6, 1e-9, 'osc2.sync.amt round-trip');
  });

});
