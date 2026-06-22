/**
 * fx_track.js — global FX track (Syntakt-style send + duck)
 *
 * Guards the dedicated FX track:
 *   - Project owns a separate `fxTrack` (not in tracks[]), flagged isFXTrack,
 *     routed to the same bus.
 *   - A track's SEND (setFXSend) re-routes it INTO the FX track (insert): its
 *     audio reaches the bus through the FX track, and an FX placed on the FX
 *     track processes the sent material (not the dry track).
 *   - DuckFX dips its output gain on trigger() and recovers.
 *   - The follow loop pulses the FX track's DuckFX on the followed track's steps.
 *   - fxTrack + per-track fxSend round-trip through Project toJSON/fromJSON, and
 *     old saves with no fxTrack key still load.
 *
 * Builds a Project on a shared OfflineAudioContext shim (so kick + FX track sum
 * on one bus), then fires steps directly via the sequencer (no transport).
 */

import { suite, test, assert, rms } from '../runner.js';

// ── Local shims (mirror runner.js internals; not exported there) ─────────────
function makeAudioShim(ctx) {
  const fxBus = ctx.createGain();
  fxBus.gain.value = 1.0;
  fxBus.connect(ctx.destination);
  return { context: ctx, fxBus };
}
function makeClockShim(bpm = 120) {
  return {
    bpm, ticksPerBeat: 4, isPlaying: false,
    get _secondsPerTick() { return 60 / (this.bpm * this.ticksPerBeat); },
    register() {}, unregister() {}, start() {}, stop() {}, setBPM(b) { this.bpm = b; },
    audio: null,
  };
}

async function makeProject(durationSec, { trackCount = 2, bpm = 120, kick = false } = {}) {
  const sampleRate = 44100;
  const ctx   = new OfflineAudioContext(1, Math.ceil(sampleRate * durationSec), sampleRate);
  const audio = makeAudioShim(ctx);
  const clock = makeClockShim(bpm);
  clock.audio = audio;
  const { Project } = await import('../../js/state/Project.js');
  const project = new Project(audio, clock, { trackCount });
  // Force DIGITAL machines: the default starter kit is analogue (kick/snare/hihat
  // .analogue + moogish), each spawning forever-running drift setInterval timers
  // across 8 voice slots. Left undisposed they accumulate across the suite and
  // crash the audio backend (error code 5). Plain 'synth' is the lightest voice
  // with no timers; only force a kick on track 0 when a test needs an audible one.
  project.tracks.forEach((t, i) => t.setMachine(kick && i === 0 ? 'kick.hard' : 'synth'));
  _projects.push({ project, ctx });
  return { project, ctx, clock, sampleRate };
}

// Every Project built in the CURRENT test, torn down in its finally (Projects
// aren't registered with the runner's _liveTracks, so we dispose them ourselves).
let _projects = [];
async function _teardown() {
  for (const { project, ctx } of _projects) {
    // Dispose each track INDEPENDENTLY — one throw must not leak the rest (a
    // leaked analogue/voice pool keeps drift setInterval timers + oscillators
    // alive, accumulating across the suite into the error-5 backend crash).
    for (const t of project.tracks) { try { t.dispose(); } catch (_) {} }
    try { project.fxTrack?.dispose(); } catch (_) {}
    try { if (ctx && ctx.state !== 'closed' && ctx.close) await ctx.close(); } catch (_) {}
  }
  _projects = [];
}

function fireStepOn(track, time, opts = {}) {
  track.sequencer._fireStep(_makeStep(opts), time);
}

let _Step;
function _makeStep(opts = {}) {
  const s = new _Step(0);
  s.active   = true;
  s.note     = opts.note     ?? 60;
  s.velocity = opts.velocity ?? 127;
  s.length   = opts.length   ?? 2;
  if (opts.plocks) for (const [k, v] of opts.plocks) s.plocks.set(k, v);
  return s;
}

// Wrap a test so its built Projects/contexts are always torn down (drift timers
// + contexts), even if an assertion throws — otherwise they leak into later suites.
function fxTest(name, fn) {
  test(name, async () => {
    try { await fn(); }
    finally { await _teardown(); }
  });
}

suite('Global FX track (send + duck)', () => {

  fxTest('FX track exists, is separate, and SEND sets the routing flag', async () => {
    // Structure-only (no render): fxTrack is a separate, flagged track NOT in
    // tracks[]; SEND flips the flag. The audible send path is covered by the
    // "FX on FX track processes sent material" + follow-duck render tests below.
    const { project } = await makeProject(0.1, { trackCount: 1 });
    assert.ok(project.fxTrack, 'no fxTrack on project');
    assert.ok(project.fxTrack.isFXTrack === true, 'fxTrack not flagged isFXTrack');
    assert.ok(!project.tracks.includes(project.fxTrack), 'fxTrack leaked into tracks[]');
    // FX track is SEPARATE — the requested trackCount is unchanged by it.
    assert.ok(project.tracks.length === 1, `track count shifted to ${project.tracks.length}`);

    const synth = project.tracks[0];
    synth.setFXSend(true, project.fxTrack);
    assert.ok(synth.fxSend === true, 'fxSend not set');
    synth.setFXSend(false, project.fxTrack);
    assert.ok(synth.fxSend === false, 'fxSend not cleared');
  });

  fxTest('an FX on the FX track processes the sent material', async () => {
    // SINGLE context (keeps the OfflineAudioContext count low): send a short note
    // through the FX track, which carries a wet reverb. If the send is processed,
    // there is reverb-tail energy AFTER the note ends; a dry note has ~none.
    const DUR = 0.7;
    ({ Step: _Step } = await import('../../js/sequencer/Step.js'));
    const { project, ctx, sampleRate } = await makeProject(DUR, { trackCount: 1 });
    const fx = project.fxTrack;
    const rid = fx.addFX('reverb');
    fx.getFXBlock(rid).setParam(`${rid}.reverb.wet`, 1);
    fx.getFXBlock(rid).setParam(`${rid}.reverb.decay`, 1.2);
    fx.getFXBlock(rid).setEnabled(true);
    const synth = project.tracks[0];
    synth.setFXSend(true, fx);
    fireStepOn(synth, 0.05, { note: 60, velocity: 127, length: 1 });
    const rendered = await ctx.startRendering();
    const full = rendered.getChannelData(0);
    // The reverb TAIL well after the short note ends proves the FX track processed
    // the sent note (a dry note has ~no energy here).
    const tail  = rms(full.slice(Math.floor(0.35 * sampleRate), Math.floor(0.68 * sampleRate)));
    assert.gt(tail, 0.0005, `no reverb tail on sent note — FX track didn't process the send (tail=${tail.toFixed(6)})`);
  });

  fxTest('DuckFX dips gain on trigger and recovers', async () => {
    // Steady tone through a DuckFX; trigger mid-render → a dip then recovery.
    const sampleRate = 44100;
    const dur = 0.6;
    const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * dur), sampleRate);
    _projects.push({ project: { tracks: [], fxTrack: null }, ctx });  // close ctx in teardown
    const { DuckFX } = await import('../../js/signal/DuckFX.js');
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const duck = new DuckFX(ctx);
    duck.setParam('duck.depth', 0.9);
    duck.setParam('duck.attack', 5);
    duck.setParam('duck.hold', 60);
    duck.setParam('duck.release', 150);
    duck.setEnabled(true);
    osc.connect(duck.inputNode);
    duck.connect(ctx.destination);
    osc.start(0);
    duck.trigger(0.3);
    const rendered = await ctx.startRendering();
    const buf = rendered.getChannelData(0);
    const win = (t0, t1) => rms(buf.slice(Math.floor(t0 * sampleRate), Math.floor(t1 * sampleRate)));
    const before = win(0.1, 0.25);   // pre-trigger steady
    const dipped = win(0.31, 0.36);  // right after the dip
    const after  = win(0.5, 0.58);   // recovered
    assert.gt(before, 0.05, 'no pre-trigger signal');
    assert.gt(before, dipped * 2, `duck did not dip (before=${before.toFixed(4)} dipped=${dipped.toFixed(4)})`);
    assert.gt(after,  dipped * 2, `duck did not recover (after=${after.toFixed(4)} dipped=${dipped.toFixed(4)})`);
  });

  fxTest('follow loop pulses the FX track DuckFX on the followed track steps', async () => {
    // FX track follows the kick (track 0) and carries a DuckFX. Send the synth
    // into the FX track, then fire a KICK step while the synth tone is ringing:
    // the duck (triggered by the kick step) should dip the sent tone.
    const sampleRate = 44100, dur = 0.7;
    ({ Step: _Step } = await import('../../js/sequencer/Step.js'));
    const { project, ctx } = await makeProject(dur, { trackCount: 2 });
    const fx = project.fxTrack;
    const did = fx.addFX('duck');
    fx.getFXBlock(did).setParam(`${did}.duck.depth`, 0.9);
    fx.getFXBlock(did).setParam(`${did}.duck.attack`, 5);
    fx.getFXBlock(did).setParam(`${did}.duck.hold`, 80);
    fx.getFXBlock(did).setParam(`${did}.duck.release`, 200);
    fx.getFXBlock(did).setEnabled(true);
    fx.setFollow(0);                         // FX track follows the TRIGGER track (0)

    // The trigger track only needs to FIRE a step (to drive the follow→duck) — its
    // own audio must NOT reach the bus, or its transient would swamp the dip
    // window. Use the SILENT 'midi' machine: _fireStep still runs fully and
    // notifies followers (so the duck triggers), but no audio is produced.
    // (Muting won't work — _fireStep early-returns on a muted track.)
    const trigger = project.tracks[0];
    trigger.setMachine('midi');

    const synth = project.tracks[1];
    synth.setFXSend(true, fx);
    // Long sustained synth note so we have steady tone to duck.
    synth.machine.setParam('output.level', 0.8);
    synth.envelope.setParam('env.sustain', 1.0);
    synth.envelope.setParam('env.release', 0.3);
    synth._pool.syncParams();
    fireStepOn(synth, 0.02, { note: 57, velocity: 127, length: 24 });

    // Fire a trigger step at 0.3 → its follower loop pulses the FX-track duck.
    trigger.sequencer._projectTracks = project._followerTracks();
    fireStepOn(trigger, 0.3, { note: 36, velocity: 127, length: 2 });

    const rendered = await ctx.startRendering();
    const buf = rendered.getChannelData(0);
    const win = (t0, t1) => rms(buf.slice(Math.floor(t0 * sampleRate), Math.floor(t1 * sampleRate)));
    const before = win(0.15, 0.28);   // synth ringing, pre-trigger
    const dipped = win(0.33, 0.40);   // during the duck dip (depth 0.9 → big drop)
    assert.gt(before, 0.02, `no pre-duck signal (before=${before.toFixed(4)})`);
    assert.gt(before, dipped * 1.5, `trigger did not duck the sent tone (before=${before.toFixed(4)} dipped=${dipped.toFixed(4)})`);
  });

  // Serialisation cases share two projects (keeps the OfflineAudioContext count
  // low — the harness's contexts accumulate across the whole suite).
  fxTest('fxTrack + fxSend round-trip + old-save load', async () => {
    const { project } = await makeProject(0.1, { trackCount: 1 });
    const fxId = project.fxTrack.addFX('duck');
    project.fxTrack.getFXBlock(fxId).setParam(`${fxId}.duck.depth`, 0.42);
    project.fxTrack.setFollow(0);
    project.tracks[0].setFXSend(true, project.fxTrack);

    const json = project.toJSON();
    assert.ok(json.fxTrack, 'fxTrack missing from toJSON');

    const { project: p2 } = await makeProject(0.1, { trackCount: 1 });
    p2.fromJSON(json);
    assert.ok(p2.fxTrack.isFXTrack === true, 'restored fxTrack lost isFXTrack');
    assert.ok(p2.fxTrack.followSource === 0, 'restored follow source wrong');
    assert.ok(p2.tracks[0].fxSend === true, 'restored fxSend wrong');
    const rId = p2.fxTrack.getFXOrder().find(id => p2.fxTrack.getFXType(id) === 'duck');
    assert.ok(rId, 'duck block lost on restore');
    assert.ok(Math.abs(p2.fxTrack.getFXBlock(rId).getParam(`${rId}.duck.depth`) - 0.42) < 1e-6,
      'duck.depth not restored');

    // Old save (no fxTrack key) must still load into p2 without losing its FX track.
    delete json.fxTrack;
    p2.fromJSON(json);                  // must not throw
    assert.ok(p2.fxTrack && p2.fxTrack.isFXTrack, 'default FX track lost loading an old save');
  });
});
