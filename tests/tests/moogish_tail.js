/**
 * moogish_tail.js — persistent-oscillator gate-leak / drone guard
 *
 * Bug (root cause): Envelope.scheduleNote (the sequencer/arp path) queues the
 * full A→D→S then R in one shot, with no cancel between (by design — the prior
 * note's release runs until the next attack). Each ADSR segment ends with a pin
 * event at its endpoint. When the DECAY is long enough that its end
 * (`time + attack + decay`) lands AFTER the release's end (`offTime + release`)
 * — i.e. attack+decay > gateLen+release — the decay's trailing pin-to-SUSTAIN
 * is later in the timeline than the release, so it fires AFTER the release has
 * driven the gate to 0 and slams it back to sustain, holding it there.
 *
 * On a persistent-oscillator machine (Moogish/synth/bass/strings/chord) whose
 * oscillators never stop, that frozen-at-sustain amp gate is an endless drone —
 * the "lingering note that never stops", only silenced by STOP/panic. (The famous
 * "~2 s of silence then it starts" is the gap between the release pin and the
 * late decay pin.) The live keyboard path is immune (noteOff cancels first).
 *
 * Unlike the lookahead theories, this needs NO real-time lookahead — it is fully
 * deterministic offline: schedule ONE note with a long decay and a short gate so
 * attack+decay > gateLen+release, render past everything, assert the tail is
 * silent. Fixed by cancel-and-hold at offTime in Envelope._scheduleR (and the
 * filter twin in Filter.scheduleFrequency).
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../runner.js';

const SR = 44100;

// Persistent-oscillator machines: oscillators never stop, so the amp gate must
// fully close. (sampler/wt-sampler excluded — worklet/buffer deps offline.)
const PERSISTENT = ['moogish', 'synth', 'bass', 'strings', 'chord'];

// The drone condition: long decay + high sustain + SHORT note gate, so the decay
// extends well past the release. A 1-tick gate at 120 BPM = 0.125 s; decay 1.5 s
// and release 0.3 s ⇒ attack+decay (≈1.5) ≫ gateLen+release (≈0.425). sustain 0.7.
const NOTE_LEN_TICKS = 1;       // short gate (0.125 s at 120 BPM)
const ENV = {
  'env.attack':  0.005,
  'env.decay':   1.5,           // long decay — its pin lands after the release
  'env.sustain': 0.7,           // > 0 so a frozen gate is audible
  'env.release': 0.3,
};
// Render: the note, plus a long tail beyond decay+release so a correct gate has
// fully closed. The drone (if present) sits at sustain for the whole tail.
const NOTE_T     = 0.05;
const TAIL_START = NOTE_T + 2.0;   // past decay (1.5) + release (0.3) + margin
const RENDER_SEC = TAIL_START + 1.0;

async function tailRms(machineType) {
  const { track, ctx } = await makeOfflineTrack(machineType, RENDER_SEC, { sampleRate: SR });

  // Apply the drone-prone envelope to every voice slot.
  Object.entries(ENV).forEach(([k, v]) => track.envelope.setParam(k, v));
  track._pool.syncParams();

  // One note via the sequencer path (scheduleNote — the affected path).
  fireStep(track, NOTE_T, { note: 60, velocity: 110, length: NOTE_LEN_TICKS });

  const rendered = await ctx.startRendering();
  const data     = rendered.getChannelData(0);

  const tail = data.slice(Math.floor(TAIL_START * SR));
  const body = data.slice(Math.floor((NOTE_T + 0.02) * SR), Math.floor((NOTE_T + 0.12) * SR));
  return { tail: rms(tail), body: rms(body) };
}

suite('Persistent-osc gate drone (long-decay / short-gate)', () => {
  for (const m of PERSISTENT) {
    test(`${m}: gate closes when decay outlasts the note (no drone)`, async () => {
      const { tail, body } = await tailRms(m);
      assert.gt(body, 1e-4, `${m}: produced no sound during the note (test invalid)`);
      assert.lt(tail, 1e-4, `${m}: gate froze at sustain (tail RMS ${tail.toExponential(2)}) — drone bug`);
    });
  }
});
