/**
 * fx_bypass_gain.js — a DISABLED FX block must be transparent
 *
 * Invariant under test: adding an FX block but leaving it OFF must not change
 * the track's output level. A bypassed effect is supposed to pass the dry
 * signal at unity — if it colours, filters, saturates, or re-gains the signal
 * while disabled, simply *adding* it (the default state in the Add-FX menu)
 * audibly changes the track before the user has turned anything on.
 *
 * This was caught on Tape: its saturation waveshaper sat unconditionally in the
 * dry path, so a freshly-added (disabled) Tape boosted the track. The same class
 * of bug can hide in any block, so this suite sweeps EVERY addable FX type and
 * compares the rendered RMS to the bare track.
 *
 * Method: render one note through a bare synth track, then render the identical
 * note with each FX type added-and-disabled. The two RMS values must match
 * within tolerance. We measure RMS (not a tail) because a level change shows up
 * across the whole note, and we use the same seeded-noise determinism as the
 * rest of the suite so the comparison is stable.
 *
 * Notes:
 *  - addFX() leaves the block DISABLED by default (the bug's real-world trigger).
 *  - Time-smearing blocks (delay/tape/comb/reverb/shimmer) would, if they leaked
 *    wet, mostly add a TAIL rather than change the note-window RMS — so we also
 *    compare the full-buffer RMS, which catches both in-window colouring and any
 *    leaked tail.
 *  - Worklet blocks (crush2, stutter) degrade to dry passthrough offline (no
 *    module registered on the OfflineAudioContext), so they are trivially
 *    transparent here; included for completeness.
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../runner.js';

// Long enough to capture the note plus any tail a leaky disabled block might add.
const DURATION = 0.05 + 0.4 + 1.2;

// Every addable FX type (mirrors Track.FX_TYPES). Base blocks delay/crush/
// chorus/reverb are exercised too via the base-block test below.
const ALL_TYPES = [
  'delay', 'crush', 'chorus', 'reverb', 'distortion', 'compressor', 'phaser',
  'filter', 'normalizer', 'eq3', 'autopan', 'gate', 'width', 'limiter',
  'ringmod', 'tape', 'comb', 'shimmer', 'crush2', 'stutter',
];

// Relative RMS tolerance: a disabled block should be sample-identical in theory,
// but setEnabled()/setParam() use short setTargetAtTime ramps and stereo blocks
// can sum L+R slightly differently, so allow a small fractional drift.
const TOL = 0.03;   // 3 %

/**
 * Full-buffer RMS of one note rendered on a fresh track, optional FX added.
 * Measures the WHOLE buffer (not a per-step window) so a leaked wet tail from a
 * delay/reverb/tape-class block — which rings out past the note — also counts
 * against the bypass invariant, not just in-window colouring.
 */
async function noteRms(addType) {
  const { track, ctx, sampleRate } = await makeOfflineTrack('synth', DURATION);
  if (addType) {
    const id = track.addFX(addType);
    // Explicitly assert the freshly-added block is OFF — that's the state we're
    // guarding. If a future change defaults added FX to ON, this test should
    // fail loudly rather than silently measure the wrong thing.
    assert.ok(track.getFXBlock(id)?.enabled !== true, `${addType} was enabled on add — test assumes OFF`);
  }
  fireStep(track, 0.05, { note: 60, velocity: 127, length: 3 });
  const rendered = await ctx.startRendering();
  return rms(rendered.getChannelData(0));
}

// The three blocks fixed via the parallel dry-bypass pattern. Each gained a
// `_bypassGain` node. We assert it exists so a STALE cached module (the classic
// Webtakt cache trap) fails with a clear "you're running old code" message
// instead of silently reproducing the pre-fix RMS numbers.
const BYPASS_NODE_TYPES = ['tape', 'normalizer', 'limiter'];

suite('FX bypass (disabled = transparent)', () => {

  test('baseline: bare track produces audible signal', async () => {
    const base = await noteRms(null);
    assert.gt(base, 0.001, `bare track silent (rms=${base.toFixed(6)})`);
  });

  test('fresh code loaded (cache sentinel)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    for (const type of BYPASS_NODE_TYPES) {
      const id  = track.addFX(type);
      const fx  = track.getFXBlock(id)?.fx;   // unwrap the FXInstance
      assert.ok(
        fx && fx._bypassGain,
        `${type} has no _bypassGain — STALE CACHED MODULE. Empty Cache and Hard Reload, then re-run.`
      );
    }
  });

  // One test per type so the report names the exact offender instead of failing
  // the whole sweep on the first bad block.
  for (const type of ALL_TYPES) {
    test(`adding disabled '${type}' does not change level`, async () => {
      const base = await noteRms(null);
      const with_ = await noteRms(type);
      const ratio = base > 0 ? with_ / base : 0;
      assert.near(
        ratio, 1.0, TOL,
        `disabled '${type}' changed level: bare rms=${base.toFixed(6)}, ` +
        `with-fx rms=${with_.toFixed(6)} (ratio=${ratio.toFixed(3)}, tol=±${TOL})`
      );
    });
  }

});
