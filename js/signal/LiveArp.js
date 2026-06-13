/**
 * LiveArp.js
 * ----------
 * Keyboard-driven arpeggiator runner for the Arpeggiator's 'input' mode.
 *
 * Unlike the other arp modes (which are triggered by the sequencer firing a
 * step), input mode is driven directly by the keys the user holds on the
 * keyboard. Holding a set of keys starts a free-running, BPM-synced cycle
 * through those absolute notes; releasing the last key stops it. This works
 * whether or not the transport is playing.
 *
 * Scheduling uses the same ahead-of-time lookahead pattern as Clock.js — a
 * setTimeout loop that schedules note events onto AudioContext.currentTime so
 * timing stays sample-accurate and free of audio-thread jitter. (The master
 * Clock loop only runs while the transport plays, so LiveArp owns its own loop
 * to support jamming with the transport stopped.)
 *
 * Voice firing mirrors Track.fireFollowNote: claim a pool voice, drive its
 * machine + envelope + LFOs. Owned by Track; fed key on/off by Keyboard.js.
 *
 * Owns:    held-note set, its own setTimeout scheduler, current cycle anchor
 * Depends: Track (pool/machine/envelope/lfos/arp), AudioContext
 */

const LOOKAHEAD_SEC   = 0.1;    // schedule this far ahead of currentTime
const SCHEDULE_MS      = 25;    // scheduler tick interval
const FIRST_NOTE_DELAY = 0.02;  // small slot for the very first note after a gesture

export class LiveArp {
  /**
   * @param {import('../state/Track.js').Track} track
   */
  constructor(track) {
    this.track = track;

    /** Held notes in press order: [{note, velocity}] */
    this._held = [];
    /** AudioContext time the next cycle should begin. */
    this._nextCycleTime = 0;
    this._timerID = null;
    /** Latest oscOffTime scheduled — used to decide if the pool needs silencing on stop. */
    this._lastOffTime = 0;
    /**
     * Optional capture hook: (note, velocity, lengthTicks) => void. Set by the
     * Keyboard so each fired note can be printed into the pattern while
     * recording. The hook itself decides whether recording is active.
     */
    this._recordHook = null;
  }

  /** @param {(note:number, velocity:number, lengthTicks:number) => void} fn */
  setRecordHook(fn) {
    this._recordHook = fn;
  }

  get _ctx() {
    return this.track.audio.context;
  }

  /** True while a cycle scheduler is active. */
  get running() {
    return this._timerID !== null;
  }

  /**
   * A key was pressed. Adds it to the held set and (re)starts the runner.
   * @param {number} midiNote
   * @param {number} [velocity=100]
   */
  noteOn(midiNote, velocity = 100) {
    if (this._held.some(h => h.note === midiNote)) return;
    this._held.push({ note: midiNote, velocity });
    if (!this.running) this._start();
  }

  /**
   * Update the velocity of a held note live (e.g. aftertouch or re-press).
   * No-op if the note isn't held.
   * @param {number} midiNote
   * @param {number} velocity
   */
  updateVelocity(midiNote, velocity) {
    const entry = this._held.find(h => h.note === midiNote);
    if (entry) entry.velocity = velocity;
  }

  /**
   * A key was released. Removes it; stops the runner when nothing is held.
   * @param {number} midiNote
   */
  noteOff(midiNote) {
    const i = this._held.findIndex(h => h.note === midiNote);
    if (i >= 0) this._held.splice(i, 1);
    if (this._held.length === 0) this._stop();
  }

  /** Release everything (e.g. on track switch / arp disable). */
  releaseAll() {
    this._held = [];
    this._stop();
  }

  // ── Internal scheduler ──────────────────────────────────────────────────────

  _start() {
    // Anchor the first cycle a hair ahead so the very first note has an audio slot.
    this._nextCycleTime = this._ctx.currentTime + FIRST_NOTE_DELAY;
    this._schedule();
  }

  _stop() {
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
    // Cancel all lookahead-scheduled notes by silencing the pool immediately.
    // Without this, notes scheduled up to LOOKAHEAD_SEC (100ms) ahead keep playing
    // after keys are released, making the arp feel unresponsive. The pool's silence()
    // ramps to zero in ~5ms to avoid a click.
    this.track._pool?.silence(this._ctx.currentTime);
  }

  _schedule() {
    const ctx = this._ctx;

    // If we fell far behind (e.g. backgrounded tab throttled setTimeout), snap the
    // cursor forward so we don't burst-schedule a pile of catch-up cycles.
    if (this._nextCycleTime < ctx.currentTime) {
      this._nextCycleTime = ctx.currentTime + FIRST_NOTE_DELAY;
    }

    // Schedule any cycle whose start falls within the lookahead window.
    while (this._held.length > 0 &&
           this._nextCycleTime < ctx.currentTime + LOOKAHEAD_SEC) {
      // Snapshot held set; sort by note for consistent ordering.
      const held = this._held.slice().sort((a, b) => a.note - b.note);
      // Sample-and-hold any arp-rate/gate/variance LFOs once per cycle (input mode
      // has no step-fire to sample on — same limitation as the step-triggered path).
      const { events, cycleSec } =
        this._withArpLfo(() => this.track.arp.buildInputCycle(held, this._nextCycleTime));
      events.forEach(ev => this._fireEvent(ev));
      // Advance by the cycle length so the next cycle butts up against this one.
      this._nextCycleTime += Math.max(0.01, cycleSec);
    }

    if (this._held.length > 0) {
      this._timerID = setTimeout(() => this._schedule(), SCHEDULE_MS);
    } else {
      this._timerID = null;
    }
  }

  /**
   * Run fn with arp rate/gate/variance offset by the current value of any LFO
   * assigned to those paths, then restore. Sample-and-hold per cycle — arp timing
   * is plain JS, not an AudioParam, so continuous modulation isn't possible.
   */
  _withArpLfo(fn) {
    const arp  = this.track.arp;
    const lfos = this.track.lfos;
    const dest = this.track._lfoDestPaths;
    if (!lfos?.length) return fn();

    const offset = {};
    lfos.forEach((lfo, i) => {
      const p = dest?.[i];
      if (p === 'arp.rate' || p === 'arp.gate' || p === 'arp.variance') {
        offset[p] = (offset[p] ?? 0) + lfo.getCurrentValue();
      }
    });
    const paths = Object.keys(offset);
    if (paths.length === 0) return fn();

    const saved = {};
    for (const p of paths) {
      saved[p] = arp.getParam(p);
      arp.setParam(p, saved[p] + offset[p]);
    }
    try { return fn(); }
    finally { for (const p of paths) arp.setParam(p, saved[p]); }
  }

  /**
   * Fire a single arp note through the track's voice pool.
   * Mirrors Track.fireFollowNote / Sequencer arp dispatch.
   */
  _fireEvent(ev) {
    const track = this.track;
    // NB: no `track.muted` gate here — the live arp is driven by held keys /
    // MIDI-in (Keyboard.js only), i.e. live play, which stays audible on a muted
    // track. Mute silences the SEQUENCER, not live input. See Track.mute().

    const release    = track.envelope?.getParam('env.release') ?? 0.3;
    const oscOffTime = ev.offTime + release;
    if (oscOffTime > this._lastOffTime) this._lastOffTime = oscOffTime;

    const voice    = track._pool?.nextVoice(ev.time) ?? null;
    const machine  = voice?.machine  ?? track.machine;
    const envelope = voice?.envelope ?? track.envelope;
    if (voice) voice.claim(oscOffTime);

    machine?.syncParamsAt?.(ev.time);
    machine?.noteOn(ev.note, ev.velocity, ev.time, ev.offTime);
    machine?.noteOff(oscOffTime);
    envelope?.scheduleNote(ev.time, ev.offTime, { note: ev.note, velocity: ev.velocity });
    const ampParams = envelope?._params ?? {};
    track.lfos?.forEach(lfo => {
      lfo.noteOn(ev.time, ev.offTime, ampParams);
      lfo.noteOff(ev.offTime);
    });

    // Capture this note into the pattern (no-op unless recording + playing).
    // Pass the note's SCHEDULED time so capture lands it on the step playing at
    // that moment — a whole arp cycle is scheduled in one synchronous burst, so
    // capturing against "now" would pile every note onto a single step (a chord).
    if (this._recordHook) {
      const secPerTick  = track.clock?._secondsPerTick ?? (60 / (120 * 4));
      const lengthTicks = (ev.offTime - ev.time) / secPerTick;
      this._recordHook(ev.note, ev.velocity, lengthTicks, ev.time);
    }
  }
}
