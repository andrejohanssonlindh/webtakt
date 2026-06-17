/**
 * moogish_tail.js — persistent-oscillator gate-leak guard
 *
 * Bug: some Moogish sounds, after playing FROM THE SEQUENCER OR ARP (never the
 * live keyboard), leave a fixed-pitch drone that never stops — only the global
 * STOP/panic silences it. Moogish runs its oscillators continuously (noteOff is
 * a no-op), so the per-voice amp gate (envelope.ampGain) is the ONLY thing that
 * produces silence. A stuck gate ⇒ the always-on oscillators bleed forever.
 *
 * Why keyboard is fine but sequencer/arp is not: the keyboard fires at
 * currentTime; the sequencer/arp schedule ~100ms AHEAD (lookahead). The gate
 * scheduler (Envelope._scheduleADS) anchors with `setValueAtTime(param.value,
 * time)` — but `param.value` is read NOW (schedule time), while `time` is in the
 * future. When a note is scheduled while the PREVIOUS note is still mid-flight
 * on that voice slot, `param.value` ≠ the gate's value at `time`, which corrupts
 * the A-D-S-R chain so a release never reaches 0.
 *
 * A plain "schedule everything then render once" offline test CANNOT catch this:
 * nothing has rendered at schedule time, so `param.value` is always the idle 0.
 * To reproduce we render in SEGMENTS with ctx.suspend(): we fire note 2 from
 * inside a suspend callback that runs AFTER note 1 has partly rendered, so
 * `param.value` is a live mid-note value — exactly the live lookahead condition.
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../runner.js';

const SR = 44100;

// Persistent-oscillator machines: oscillators never stop, so the gate must close.
const PERSISTENT = ['moogish', 'synth', 'bass', 'strings', 'chord'];

// Timeline: two overlapping notes on the same slot, then a long silent tail.
// Note 1 fires at 0.05. We suspend mid-note-1 and schedule note 2 from there, so
// its _scheduleADS reads a live (non-zero) param.value — the lookahead trap.
const N1_TIME   = 0.05;
const SUSPEND_AT = 0.15;     // mid note-1 (gate open) — schedule note 2 here
const N2_TIME   = 0.20;      // note 2 starts shortly after the suspend point
const NOTE_LEN  = 2;         // ticks
const TAIL_START = 1.8;      // well past both releases
const RENDER_SEC = TAIL_START + 1.0;

async function tailRms(machineType) {
  const { track, ctx } = await makeOfflineTrack(machineType, RENDER_SEC, { sampleRate: SR });

  // Note 1 scheduled up front (idle gate → param.value 0, like the first note).
  fireStep(track, N1_TIME, { note: 60, velocity: 110, length: NOTE_LEN });

  // Schedule note 2 from inside a suspend callback so it runs AFTER note 1 has
  // rendered up to SUSPEND_AT — `param.value` is now a live mid-note value,
  // reproducing the sequencer/arp lookahead condition that the keyboard avoids.
  ctx.suspend(SUSPEND_AT).then(() => {
    fireStep(track, N2_TIME, { note: 67, velocity: 110, length: NOTE_LEN });
    ctx.resume();
  });

  const rendered = await ctx.startRendering();
  const data     = rendered.getChannelData(0);

  const tail = data.slice(Math.floor(TAIL_START * SR));
  const body = data.slice(Math.floor(N1_TIME * SR), Math.floor((N1_TIME + 0.2) * SR));
  return { tail: rms(tail), body: rms(body) };
}

// ── Fast-arp flurry stress ────────────────────────────────────────────────
// The user's worry: under FAST arping notes are "always flying about", so a
// fix that relies on a voice being idle might never get its quiet moment. This
// renders a dense flurry of overlapping notes (gate > gap, so notes overlap and
// cycle the 8 voice slots), each scheduled from inside its own suspend() so
// every _scheduleADS reads a live mid-flight param.value — the exact fast-arp
// lookahead condition. Then the keys "release": no more notes, long tail. Every
// voice's final release must still settle the gate to 0.
const FLURRY_GAP  = 0.05;   // 50ms between notes (fast arp)
const FLURRY_GATE = 0.18;   // gate LONGER than gap → notes overlap heavily
const FLURRY_N    = 16;     // notes in the flurry (cycles all 8 slots twice)
const FLURRY_NOTES = [60, 64, 67, 72];  // a chord arp
// In ticks: gate length as ticks (120bpm, 4 ticks/beat → 0.125s/tick).
const SEC_PER_TICK = 0.125;
const FLURRY_LEN_TICKS = FLURRY_GATE / SEC_PER_TICK;
const FLURRY_TAIL_START = FLURRY_N * FLURRY_GAP + FLURRY_GATE + 1.5;
const FLURRY_RENDER_SEC = FLURRY_TAIL_START + 1.0;

async function flurryTailRms(machineType) {
  const { track, ctx } = await makeOfflineTrack(machineType, FLURRY_RENDER_SEC, { sampleRate: SR });

  // First note up front; the rest scheduled live from suspend callbacks so each
  // reads a non-zero, mid-flurry param.value (the keyboard-immune condition).
  const t0 = 0.05;
  fireStep(track, t0, { note: FLURRY_NOTES[0], velocity: 110, length: FLURRY_LEN_TICKS });

  for (let i = 1; i < FLURRY_N; i++) {
    const at   = t0 + i * FLURRY_GAP;
    const susp = at - 0.01;   // suspend just before each note's start time
    // Alternate octave every chord-cycle for variety (keeps the flurry from being
    // a single repeated pitch); exact pitch doesn't matter to the gate test.
    const octave = ((i / FLURRY_NOTES.length) | 0) % 2 === 0 ? 0 : 12;
    const note = FLURRY_NOTES[i % FLURRY_NOTES.length] + octave;
    ctx.suspend(susp).then(() => {
      fireStep(track, at, { note, velocity: 110, length: FLURRY_LEN_TICKS });
      ctx.resume();
    });
  }

  const rendered = await ctx.startRendering();
  const data     = rendered.getChannelData(0);
  const tail = data.slice(Math.floor(FLURRY_TAIL_START * SR));
  const body = data.slice(Math.floor((t0 + 0.1) * SR), Math.floor((t0 + 0.3) * SR));
  return { tail: rms(tail), body: rms(body) };
}

suite('Persistent-osc gate tail (drone guard)', () => {
  for (const m of PERSISTENT) {
    test(`${m}: amp gate fully closes after overlapping notes (no drone)`, async () => {
      const { tail, body } = await tailRms(m);
      assert.gt(body, 1e-4, `${m}: produced no sound during playback (test invalid)`);
      assert.lt(tail, 1e-4, `${m}: gate left a lingering tail (RMS ${tail.toExponential(2)}) — drone bug`);
    });
  }

  for (const m of PERSISTENT) {
    test(`${m}: gate closes after a FAST-ARP flurry (no drone)`, async () => {
      const { tail, body } = await flurryTailRms(m);
      assert.gt(body, 1e-4, `${m}: flurry produced no sound (test invalid)`);
      assert.lt(tail, 1e-4, `${m}: flurry left a lingering tail (RMS ${tail.toExponential(2)}) — drone bug`);
    });
  }
});
