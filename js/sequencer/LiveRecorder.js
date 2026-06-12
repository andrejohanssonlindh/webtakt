/**
 * LiveRecorder.js
 * ---------------
 * Captures live note input (on-screen keyboard or MIDI In) into the sequencer
 * while record mode is armed. Single source of truth for "print this note into
 * the step under the playhead, then close out its length when the key lifts."
 *
 * Recording model:
 *   - On note-on: ask the track's OWN sequencer where its playhead is at this
 *     moment via Sequencer.stepIndexAtTime() — returns { absStep, nudge } from
 *     that sequencer's last scheduled tick. The note is written into absStep with
 *     the fractional nudge. First note fills voice 0; subsequent notes in the same
 *     step append voices.
 *   - On note-off: measure how long the note was held and write that back as the
 *     voice `length` in ticks.
 *
 * Why per-track playhead (not state.recordStepIndex): MIDI In records onto every
 * armed track at once, and those tracks may differ in stepCount/page/playhead from
 * the selected track that state.recordStepIndex tracks. Each Sequencer keeps its
 * own lastScheduledTime, so stepIndexAtTime() places the note correctly on every
 * track independently — and the nudge is computed against that track's own tick.
 *
 * Keyed per (track, note): each armed track records independently, so the same
 * incoming MIDI note can print into several tracks at once.
 *
 * This does NOT handle edit-mode step writes (overwriting voice 0 of a selected
 * step) — that stays caller-side, since it's specific to the keyboard's UX.
 *
 * Used by: index.html (MIDI In wiring).
 */

export class LiveRecorder {
  /**
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(state) {
    this.state = state;
    // (track, note) → { onTime, absStep, voiceIndex }
    this._inFlight = new Map();
  }

  _key(track, note) {
    return `${track.index}:${note}`;
  }

  /** True when record mode is armed. */
  get armed() {
    return !!this.state.recording;
  }

  /**
   * Print a note-on into the step under the track's own playhead. No-op unless
   * record mode is armed and the track's clock has ticked at least once.
   * @param {import('../state/Track.js').Track} track — track to record onto
   * @param {number} note     — MIDI note
   * @param {number} velocity — 0-127
   * @param {number} nowSec   — AudioContext.currentTime at the moment of input
   */
  noteOn(track, note, velocity, nowSec) {
    if (!this.armed) return;

    const seq = track.sequencer;
    const pos = seq.stepIndexAtTime(nowSec);
    if (!pos) return;                       // clock hasn't ticked yet
    const { absStep, nudge } = pos;

    const step = seq.steps[absStep];
    if (!step) return;

    let voiceIndex;
    if (!step.active) {
      // First note: fill voice 0
      step.voices[0] = { note, velocity, length: 1, nudge };
      step.active = true;
      voiceIndex = 0;
    } else {
      // Subsequent notes: append a new voice
      step.addVoice(note, velocity, 1, nudge);
      voiceIndex = step.voices.length - 1;
    }

    this._inFlight.set(this._key(track, note), {
      onTime: nowSec,
      absStep,
      voiceIndex,
    });

    this._emitStepChanged(track, absStep, step);
  }

  /**
   * Close out a recorded note's length on key release. No-op if the note wasn't
   * captured on the way down.
   * @param {import('../state/Track.js').Track} track
   * @param {number} note
   * @param {number} nowSec — AudioContext.currentTime at release
   */
  noteOff(track, note, nowSec) {
    const key  = this._key(track, note);
    const info = this._inFlight.get(key);
    if (!info) return;
    this._inFlight.delete(key);

    const seq            = track.sequencer;
    const holdSec        = nowSec - info.onTime;
    const secondsPerTick = seq.clock._secondsPerTick;
    const lengthTicks    = Math.max(1 / 16, holdSec / secondsPerTick);

    const step = seq.steps[info.absStep];
    if (step && step.voices[info.voiceIndex]) {
      step.voices[info.voiceIndex].length = lengthTicks;
      this._emitStepChanged(track, info.absStep, step);
    }
  }

  /**
   * Emit a stepChanged event with the page-relative index, so the grid only
   * redraws when the changed step is on the visible page of that track.
   */
  _emitStepChanged(track, absStep, step) {
    const seq      = track.sequencer;
    const pageStart = seq.pageOffset * 16;
    const visIdx    = absStep - pageStart;
    this.state.emit('stepChanged', {
      trackIndex: track.index,
      stepIndex:  visIdx >= 0 && visIdx < 16 ? visIdx : -1,
      step,
    });
  }

  /** Drop all in-flight captures (e.g. on record-off or panic). */
  reset() {
    this._inFlight.clear();
  }
}
