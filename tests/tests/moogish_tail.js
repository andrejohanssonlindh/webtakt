/**
 * moogish_tail.js — persistent-oscillator gate-leak guard
 *
 * Bug under investigation: some Moogish sounds, after playing in the sequencer,
 * leave a fixed-pitch drone that never stops (only the global STOP/panic
 * silences it). Moogish runs its oscillators continuously (noteOff is a no-op),
 * so the ONLY thing that produces silence between/after notes is the per-voice
 * amp gate (envelope.ampGain) reaching 0. If the gate fails to settle to 0, the
 * always-on oscillators bleed through forever — audible only on persistent-osc
 * machines (synth/bass/strings/chord/moogish), masked on machines whose
 * noteOff stops the source.
 *
 * Strategy: fire a short sequence, then render WELL past the last note's
 * release and measure the RMS of the trailing "should be silent" window. A
 * correctly-closing gate makes that tail ~0. A leak leaves it audible.
 *
 * We test moogish plus the other persistent-osc machines (same gate path) so a
 * regression in the shared Envelope/VoicePool gating is caught broadly. The
 * sequencer fires the notes, so this exercises the real _fireStep → nextVoice →
 * scheduleNote path, not a synthetic envelope call.
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../runner.js';

const SR = 44100;

// Persistent-oscillator machines: their oscillators never stop, so the amp gate
// must fully close or they drone. (Excludes sampler/wt-sampler — worklet/buffer
// deps don't render offline.)
const PERSISTENT = ['moogish', 'synth', 'bass', 'strings', 'chord'];

// Fire a handful of short notes, leave a long silent tail, measure the tail.
const STEP_SEC   = 0.4;
const NOTE_TICKS = 2;      // note length in ticks (≈ a 16th at 120 BPM)
const HITS       = 4;
const RELEASE    = 0.3;    // default amp release
// Render: all hits, plus a generous tail far beyond the last release so the gate
// has every chance to settle. The tail window we measure starts after the last
// note's release is comfortably over.
const LAST_NOTE_START = (HITS - 1) * STEP_SEC + 0.05;
const TAIL_START      = LAST_NOTE_START + 1.5;   // 1.5 s after last note → release long gone
const RENDER_SEC      = TAIL_START + 1.0;

async function tailRms(machineType) {
  const { track, ctx } = await makeOfflineTrack(machineType, RENDER_SEC, { sampleRate: SR });

  // Fire HITS short notes through the sequencer.
  for (let i = 0; i < HITS; i++) {
    const t = 0.05 + i * STEP_SEC;
    fireStep(track, t, { note: 60, velocity: 110, length: NOTE_TICKS });
  }

  const rendered = await ctx.startRendering();
  const data     = rendered.getChannelData(0);

  // Trailing window: should be silence once every note has released.
  const start = Math.floor(TAIL_START * SR);
  const tail  = data.slice(start);
  // Sanity: confirm the patch actually made sound earlier (guards against a
  // silent render that would trivially "pass" the tail check).
  const body  = data.slice(Math.floor(0.05 * SR), Math.floor((0.05 + 0.2) * SR));
  return { tail: rms(tail), body: rms(body) };
}

suite('Persistent-osc gate tail (drone guard)', () => {
  for (const m of PERSISTENT) {
    test(`${m}: amp gate fully closes after release (no drone)`, async () => {
      const { tail, body } = await tailRms(m);
      // The patch must have been audible during playback.
      assert.gt(body, 1e-4, `${m}: produced no sound during playback (test invalid)`);
      // After the release tail, the gate must be effectively silent. A lingering
      // drone shows up as a tail RMS comparable to the body. Threshold is a hard
      // noise floor — a real drone is orders of magnitude above this.
      assert.lt(tail, 1e-4, `${m}: gate left a lingering tail (RMS ${tail.toExponential(2)}) — drone bug`);
    });
  }
});
