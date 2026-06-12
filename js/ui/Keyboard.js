/**
 * Keyboard.js
 * -----------
 * 2-octave piano keyboard at the bottom of the UI.
 * Mouse clicks and computer keyboard keys trigger notes on the selected track.
 *
 * Latency fix:
 *   AudioContext starts suspended in browsers until a user gesture.
 *   We call ctx.resume() directly inside _noteOn (it's a no-op if already running)
 *   and schedule notes at currentTime + 0.015s to give the audio thread a guaranteed
 *   slot even on the very first gesture. This eliminates the cold-start delay.
 *
 * If a step is selected in the grid, playing a note writes it into that step
 * (step.active = true, step.note = midiNote) and emits stepChanged.
 *
 * Swedish keyboard support:
 *   Keys ö, ä, ', å, ¨ replace the US-layout ; ' \ [ ] at the same physical positions.
 *
 * Keyboard folding (keyFolding = true):
 *   Bottom row (a s d f g h j k l ö ä ') → in-scale notes 0–11 ascending
 *   Top row    (q w e r t y u i o p å ¨) → same notes +1 octave
 *   Key labels on each piano key show "lower/upper" (e.g. "a/q").
 *   When no folding, labels show just the lower-row key for white keys.
 *
 * Owns:    key DOM elements, octave state, keyboard event listeners
 * Depends: AppState.js
 * Used by: index.html (mounted to #keyboard and #octave-controls)
 */

import { noteInScale } from '../state/Scales.js';

const WHITE_NOTES = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];
const BLACK_NOTES = [1, 3, -1, 6, 8, 10, -1, 13, 15, -1, 18, 20, 22, -1];

// Swedish keyboard — bottom row (a–') and top row (q–¨)
// In chromatic mode: bottom row = white keys, top row = black keys
// In folded mode:    bottom row = in-scale notes, top row = same notes +12
const KB_LOWER = ['a','s','d','f','g','h','j','k','l','ö','ä',"'"];
const KB_UPPER = ['q','w','e','r','t','y','u','i','o','p','å',''];

// Chromatic mode: top-row keys at their natural positions above black keys.
// Standard piano layout — q, r, i, å, ¨ are unused:
//    w  e     t  y  u     o  p
//   a  s  d  f  g  h  j  k  l  ö  ä  '
// Indexed in parallel with BLACK_NOTES ('' = gap or unbound):
const KB_UPPER_CHROMATIC = ['w','e','','t','y','u','','o','p','','','','',''];

export class Keyboard {
  /**
   * @param {HTMLElement} keyboardEl
   * @param {HTMLElement} octaveEl
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(keyboardEl, octaveEl, state) {
    this.keyboardEl  = keyboardEl;
    this.octaveEl    = octaveEl;
    this.state       = state;
    this.octave      = 4;
    this.keyFolding  = false;
    this._heldKeys   = new Set();
    // Per-note voice slot claimed from the pool, for matching noteOff to the right slot
    this._heldSlots  = new Map(); // midiNote → VoiceSlot
    // In record mode: track when each key was pressed and which step it wrote to
    this._recordNoteOnTime = new Map(); // midiNote → AudioContext time of noteOn
    this._recordNoteOnStep = new Map(); // midiNote → { stepIndex, pageOffset }
    // Dynamic key → midiNote map (rebuilt on folding/scale/octave change)
    this._keyMap = new Map();
    // Physical key → the MIDI note actually triggered at key-down time. Read on
    // key-up so that an octave/scale switch mid-hold (which rebuilds _keyMap)
    // still releases the original note instead of leaking a stuck voice.
    this._keyToNote = new Map();

    this._buildOctaveControls();
    this._build();
    this._bindKeyboard();
    this._attachLiveArpHooks();

    // Ensure state has the folding flag (may not exist on first load)
    if (state.keyFolding === undefined) state.keyFolding = false;

    state.on('scaleChanged',     () => { this._applyScale(); this._updateKeyLabels(); });
    state.on('trackSelected',    () => {
      // Release any held live-input arp on every track so a track switch mid-hold
      // can't leave an arp free-running with no key to stop it.
      this.state.project.tracks.forEach(t => t.liveArp?.releaseAll());
      this._heldKeys.clear();
      this._keyToNote.clear();
      this.keyboardEl.querySelectorAll('.key.held').forEach(k => k.classList.remove('held'));
      this._attachLiveArpHooks();  // cover any tracks added at runtime
      this._applyScale(); this._updateKeyLabels();
    });
    state.on('keyFoldingChanged',({ on }) => { this.keyFolding = on; this._applyScale(); this._updateKeyLabels(); });
    state.on('recordingChanged', ({ recording }) => {
      if (!recording) {
        this._recordNoteOnTime.clear();
        this._recordNoteOnStep.clear();
        this._heldSlots.clear();
        this._heldKeys.clear();
        this._keyToNote.clear();
      }
    });

    // Global STOP-ALL / panic — drop all held-key state + visual highlights.
    state.on('panic', () => {
      this.state.project.tracks.forEach(t => t.liveArp?.releaseAll());
      this._recordNoteOnTime.clear();
      this._recordNoteOnStep.clear();
      this._heldSlots.clear();
      this._heldKeys.clear();
      this._keyToNote.clear();
      this.keyboardEl.querySelectorAll('.key.held').forEach(k => k.classList.remove('held'));
    });
  }

  get _rootNote() {
    return this.octave * 12;
  }

  async _ensureAudio() {
    const ctx = this.state.project.audio.context;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  _buildOctaveControls() {
    this.octaveEl.innerHTML = '';

    const up = document.createElement('button');
    up.className = 'btn octave-btn';
    up.textContent = 'OCT+';
    up.addEventListener('click', () => { this.octave = Math.min(8, this.octave + 1); this._build(); });

    const display = document.createElement('div');
    display.className = 'octave-display label';
    this._octaveDisplay = display;

    const down = document.createElement('button');
    down.className = 'btn octave-btn';
    down.textContent = 'OCT-';
    down.addEventListener('click', () => { this.octave = Math.max(0, this.octave - 1); this._build(); });

    this.octaveEl.appendChild(up);
    this.octaveEl.appendChild(display);
    this.octaveEl.appendChild(down);
  }

  _isInScale(midiNote) {
    const track = this.state.selectedTrack;
    if (!track) return true;
    return noteInScale(midiNote, track.scaleIndex ?? 0, track.leadNote ?? 0);
  }

  /** Returns ascending in-scale MIDI notes starting from rootNote, enough to fill both rows. */
  _getScaleNotes() {
    const notes = [];
    for (let i = 0; i < 36 && notes.length < KB_LOWER.length; i++) {
      const midi = this._rootNote + i;
      if (this._isInScale(midi)) notes.push(midi);
    }
    return notes;
  }

  _build() {
    this.keyboardEl.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'keyboard-inner';

    WHITE_NOTES.forEach((semitone, wi) => {
      const midi = this._rootNote + semitone;
      const key  = document.createElement('div');
      key.className = 'key white-key';
      key.dataset.note = midi;
      key.dataset.whiteIndex = wi;

      const lbl = document.createElement('span');
      lbl.className = 'key-label';
      key.appendChild(lbl);

      key.addEventListener('mousedown', () => this._noteOn(midi));
      key.addEventListener('mouseup',   () => this._noteOff(midi));
      key.addEventListener('mouseleave',() => this._noteOff(midi));
      wrapper.appendChild(key);
    });

    BLACK_NOTES.forEach((semitone, bi) => {
      if (semitone === -1) return;
      const midi = this._rootNote + semitone;
      const key  = document.createElement('div');
      key.className = 'key black-key';
      key.dataset.note = midi;
      key.dataset.blackIndex = bi;
      key.style.left = `${this._blackKeyOffset(semitone)}%`;

      const lbl = document.createElement('span');
      lbl.className = 'key-label';
      key.appendChild(lbl);

      key.addEventListener('mousedown', () => this._noteOn(midi));
      key.addEventListener('mouseup',   () => this._noteOff(midi));
      key.addEventListener('mouseleave',() => this._noteOff(midi));
      wrapper.appendChild(key);
    });

    this.keyboardEl.appendChild(wrapper);
    if (this._octaveDisplay) this._octaveDisplay.textContent = `C${this.octave}`;
    this._applyScale();
    this._updateKeyLabels();
  }

  _applyScale() {
    this.keyboardEl.querySelectorAll('.key').forEach(key => {
      const midi    = parseInt(key.dataset.note, 10);
      const blocked = !this._isInScale(midi);
      key.classList.toggle('scale-blocked', blocked);
    });
  }

  _updateKeyLabels() {
    this._keyMap.clear();
    this.keyboardEl.querySelectorAll('.key-label').forEach(l => { l.textContent = ''; });

    if (this.keyFolding) {
      this._applyFoldedMap();
    } else {
      this._applyChromaticMap();
    }
  }

  _applyChromaticMap() {
    // Bottom row → white keys in order
    for (let i = 0; i < KB_LOWER.length && i < WHITE_NOTES.length; i++) {
      const midi = this._rootNote + WHITE_NOTES[i];
      this._keyMap.set(KB_LOWER[i], midi);
    }

    // Top row → black keys at their natural positions (aligned with BLACK_NOTES slots)
    for (let i = 0; i < KB_UPPER_CHROMATIC.length; i++) {
      const key = KB_UPPER_CHROMATIC[i];
      if (!key || BLACK_NOTES[i] === -1) continue;
      this._keyMap.set(key, this._rootNote + BLACK_NOTES[i]);
    }

    // Label white keys with their lower-row key
    this.keyboardEl.querySelectorAll('.key.white-key').forEach(key => {
      const wi  = parseInt(key.dataset.whiteIndex, 10);
      const lbl = key.querySelector('.key-label');
      if (lbl && wi < KB_LOWER.length) lbl.textContent = KB_LOWER[wi];
    });

    // Label black keys with their upper-row key (look up by semitone offset)
    const semitoneToUpperKey = new Map();
    for (let i = 0; i < KB_UPPER_CHROMATIC.length; i++) {
      const k = KB_UPPER_CHROMATIC[i];
      if (k && BLACK_NOTES[i] !== -1) semitoneToUpperKey.set(BLACK_NOTES[i], k);
    }
    this.keyboardEl.querySelectorAll('.key.black-key').forEach(key => {
      const semitone = parseInt(key.dataset.note, 10) - this._rootNote;
      const lbl      = key.querySelector('.key-label');
      if (lbl) lbl.textContent = semitoneToUpperKey.get(semitone) ?? '';
    });
  }

  _applyFoldedMap() {
    const scaleNotes = this._getScaleNotes();

    // Lower row → in-scale notes 0..N
    for (let i = 0; i < KB_LOWER.length && i < scaleNotes.length; i++) {
      this._keyMap.set(KB_LOWER[i], scaleNotes[i]);
    }
    // Upper row → same notes +24 (2 octaves up)
    for (let i = 0; i < KB_UPPER.length && i < scaleNotes.length; i++) {
      if (KB_UPPER[i]) this._keyMap.set(KB_UPPER[i], scaleNotes[i] + 24);
    }

    // Build label map: keys that share the same scale degree show "lower/upper" on their
    // respective piano keys so the mirroring is obvious.
    const pairByMidi = new Map();
    for (let i = 0; i < KB_LOWER.length && i < scaleNotes.length; i++) {
      const lo = scaleNotes[i];
      const hi = lo + 24;
      const lk = KB_LOWER[i];
      const uk = i < KB_UPPER.length ? KB_UPPER[i] : null;
      const label = uk ? `${lk}/${uk}` : lk;
      pairByMidi.set(lo, label);
      pairByMidi.set(hi, label);
    }
    // Upper-row-only notes beyond the lower row's reach
    for (let i = KB_LOWER.length; i < KB_UPPER.length && i < scaleNotes.length; i++) {
      pairByMidi.set(scaleNotes[i] + 24, KB_UPPER[i]);
    }

    this.keyboardEl.querySelectorAll('.key').forEach(key => {
      const midi = parseInt(key.dataset.note, 10);
      const lbl  = key.querySelector('.key-label');
      if (lbl) lbl.textContent = pairByMidi.get(midi) ?? '';
    });
  }

  _blackKeyOffset(semitone) {
    const whiteWidth = 100 / WHITE_NOTES.length;
    const whiteBelow = WHITE_NOTES.indexOf(semitone - 1);
    return (whiteBelow + 0.75) * whiteWidth;
  }

  async _noteOn(midiNote) {
    if (!this._isInScale(midiNote)) return;
    if (this._heldKeys.has(midiNote)) return;
    this._heldKeys.add(midiNote);

    const keyEl = this.keyboardEl.querySelector(`.key[data-note="${midiNote}"]`);
    if (keyEl) keyEl.classList.add('held');

    await this._ensureAudio();

    const ctx   = this.state.project.audio.context;
    const track = this.state.selectedTrack;
    const time  = ctx.currentTime + 0.015;

    // ── Live-input arp: keys drive the arp directly (no direct note trigger) ──
    // The held key set IS the chord; LiveArp fans it out and (when recording)
    // prints each fired note into the step it lands on via captureArpNote().
    // Key-down does NOT write to a step here — the arp output is what's captured.
    const vel     = track.trigVelocity ?? 100;
    const liveArp = track.arp?.enabled && track.arp.getParam('mode') === 'input';
    if (liveArp) {
      track.liveArp.noteOn(midiNote, vel);
    } else {
      const voice    = track._pool?.nextVoice() ?? null;
      const machine  = voice?.machine  ?? track.machine;
      const envelope = voice?.envelope ?? track.envelope;
      if (voice) voice.claim(time + 30);
      this._heldSlots.set(midiNote, voice);

      machine?.noteOn(midiNote, vel, time);
      envelope.noteOn(time, midiNote);
    }

    // ── Fire followers (live keyboard note) ────────────────
    this._fireFollowers(track, midiNote, vel, time);

    // In input-arp mode the step write happens per arp-fired note (captureArpNote),
    // not on key-down — so skip the normal record/edit step write here.
    const stepIndex = liveArp
      ? -1
      : (this.state.recording
          ? (this.state.recordStepIndex ?? -1)
          : this.state.selectedStepIndex);
    if (stepIndex >= 0) {
      const step = track.sequencer.getVisibleSteps()[stepIndex];
      if (step) {
        if (this.state.recording) {
          // Append mode: add a new voice (or reuse voice 0 if step was empty)
          let nudge = 0;
          if (this.state.lastStepScheduledTime !== null) {
            const secondsPerTick = track.sequencer.clock._secondsPerTick;
            const offsetTicks    = (ctx.currentTime - this.state.lastStepScheduledTime) / secondsPerTick;
            nudge = Math.max(-0.99, Math.min(0.99, offsetTicks));
          }

          let voiceIndex;
          if (!step.active) {
            // First note: fill voice 0
            step.voices[0] = { note: midiNote, velocity: vel, length: 1, nudge };
            step.active = true;
            voiceIndex = 0;
          } else {
            // Subsequent notes: append a new voice
            step.addVoice(midiNote, vel, 1, nudge);
            voiceIndex = step.voices.length - 1;
          }

          this._recordNoteOnTime.set(midiNote, ctx.currentTime);
          this._recordNoteOnStep.set(midiNote, {
            stepIndex,
            voiceIndex,
            pageOffset: track.sequencer.pageOffset,
          });
        } else {
          // Edit mode: overwrite voice 0
          step.voices[0].note = midiNote;
          step.active = true;
        }

        this.state.emit('stepChanged', {
          trackIndex: this.state.selectedTrackIndex,
          stepIndex,
          step,
        });
      }
    }
  }

  async _noteOff(midiNote) {
    if (!this._heldKeys.has(midiNote)) return;
    this._heldKeys.delete(midiNote);

    const keyEl = this.keyboardEl.querySelector(`.key[data-note="${midiNote}"]`);
    if (keyEl) keyEl.classList.remove('held');

    await this._ensureAudio();

    const ctx   = this.state.project.audio.context;
    const track = this.state.selectedTrack;
    const time  = ctx.currentTime + 0.015;

    const liveArp = track.arp?.enabled && track.arp.getParam('mode') === 'input';
    if (liveArp) {
      track.liveArp.noteOff(midiNote);
    } else {
      const voice    = this._heldSlots.get(midiNote) ?? null;
      const machine  = voice?.machine  ?? track.machine;
      const envelope = voice?.envelope ?? track.envelope;
      this._heldSlots.delete(midiNote);

      if (voice) {
        const release = envelope.getParam('env.release') ?? 0.3;
        voice.claim(time + release);
      }

      machine?.noteOff(time);
      envelope.noteOff(time);
    }

    if (this.state.recording && this._recordNoteOnTime.has(midiNote)) {
      const onTime    = this._recordNoteOnTime.get(midiNote);
      const info      = this._recordNoteOnStep.get(midiNote);
      this._recordNoteOnTime.delete(midiNote);
      this._recordNoteOnStep.delete(midiNote);

      const holdSec        = ctx.currentTime - onTime;
      const secondsPerTick = track.sequencer.clock._secondsPerTick;
      const lengthTicks    = Math.max(1 / 16, holdSec / secondsPerTick);

      if (info && info.pageOffset === track.sequencer.pageOffset) {
        const step = track.sequencer.getVisibleSteps()[info.stepIndex];
        if (step && step.voices[info.voiceIndex]) {
          step.voices[info.voiceIndex].length = lengthTicks;
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  info.stepIndex,
            step,
          });
        }
      }
    }
  }

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      // Drum mode: digit keys 1–N trigger that track at C4
      if (this.state.drumMode && !e.shiftKey) {
        const m = e.code.match(/^Digit(\d)$/);
        if (m) {
          const trackIndex = parseInt(m[1]) - 1;
          const track = this.state.project.tracks[trackIndex];
          if (track) { this._drumNoteOn(trackIndex); return; }
        }
      }

      const midi = this._keyMap.get(e.key);
      if (midi !== undefined) {
        // Remember which note this physical key fired, so key-up releases the
        // same note even if the octave/scale changed while it was held.
        this._keyToNote.set(e.key, midi);
        this._noteOn(midi);
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      if (this.state.drumMode && !e.shiftKey) {
        const m = e.code.match(/^Digit(\d)$/);
        if (m) {
          const trackIndex = parseInt(m[1]) - 1;
          const track = this.state.project.tracks[trackIndex];
          if (track) { this._drumNoteOff(trackIndex); return; }
        }
      }

      // Release the exact note this key fired at key-down, falling back to the
      // current map for keys pressed before this tracking existed.
      const midi = this._keyToNote.get(e.key) ?? this._keyMap.get(e.key);
      if (midi !== undefined) {
        this._keyToNote.delete(e.key);
        this._noteOff(midi);
      }
    });
  }

  /** Fire a note on a specific track at C4 (drum finger-drumming). */
  async _drumNoteOn(trackIndex) {
    const track = this.state.project.tracks[trackIndex];
    if (!track) return;
    const drumKey = `drum_${trackIndex}`;
    if (this._heldKeys.has(drumKey)) return;
    this._heldKeys.add(drumKey);

    await this._ensureAudio();
    const ctx  = this.state.project.audio.context;
    const time = ctx.currentTime + 0.015;

    const voice    = track._pool?.nextVoice() ?? null;
    const machine  = voice?.machine  ?? track.machine;
    const envelope = voice?.envelope ?? track.envelope;
    if (voice) voice.claim(time + 30);
    this._heldSlots.set(drumKey, { voice, track });

    machine?.noteOn(60, 100, time);
    envelope.noteOn(time);

    // Fire followers for drum-mode note
    this._fireFollowers(track, 60, 100, time);

    // Record mode: write C4 into the step currently playing on this track
    if (this.state.recording) {
      const seq = track.sequencer;
      const justFired = (seq._stepIndex - 1 + seq.stepCount) % seq.stepCount;
      const pageStart = seq.pageOffset * 16;
      const visIdx    = justFired - pageStart;
      if (visIdx >= 0 && visIdx < 16) {
        const step = seq.getVisibleSteps()[visIdx];
        if (step) {
          let nudge = 0;
          if (seq.lastScheduledTime !== null) {
            const secondsPerTick = seq.clock._secondsPerTick;
            const offsetTicks    = (ctx.currentTime - seq.lastScheduledTime) / secondsPerTick;
            nudge = Math.max(-0.99, Math.min(0.99, offsetTicks));
          }

          let voiceIndex;
          if (!step.active) {
            step.voices[0] = { note: 60, velocity: 100, length: 1, nudge };
            step.active = true;
            voiceIndex = 0;
          } else {
            step.addVoice(60, 100, 1, nudge);
            voiceIndex = step.voices.length - 1;
          }

          this._recordNoteOnTime.set(drumKey, ctx.currentTime);
          this._recordNoteOnStep.set(drumKey, {
            stepIndex: visIdx,
            voiceIndex,
            pageOffset: seq.pageOffset,
            trackIndex,
          });

          this.state.emit('stepChanged', {
            trackIndex,
            stepIndex: visIdx,
            step,
          });
        }
      }
    }
  }

  async _drumNoteOff(trackIndex) {
    const drumKey = `drum_${trackIndex}`;
    if (!this._heldKeys.has(drumKey)) return;
    this._heldKeys.delete(drumKey);

    await this._ensureAudio();
    const ctx  = this.state.project.audio.context;
    const time = ctx.currentTime + 0.015;

    const slot = this._heldSlots.get(drumKey);
    this._heldSlots.delete(drumKey);
    if (!slot) return;

    const { voice, track } = slot;
    const machine  = voice?.machine  ?? track.machine;
    const envelope = voice?.envelope ?? track.envelope;

    if (voice) {
      const release = envelope.getParam('env.release') ?? 0.3;
      voice.claim(time + release);
    }
    machine?.noteOff(time);
    envelope.noteOff(time);

    // Record mode: write note length back into the step
    if (this.state.recording && this._recordNoteOnTime.has(drumKey)) {
      const onTime = this._recordNoteOnTime.get(drumKey);
      const info   = this._recordNoteOnStep.get(drumKey);
      this._recordNoteOnTime.delete(drumKey);
      this._recordNoteOnStep.delete(drumKey);

      const seq            = track.sequencer;
      const holdSec        = ctx.currentTime - onTime;
      const secondsPerTick = seq.clock._secondsPerTick;
      const lengthTicks    = Math.max(1 / 16, holdSec / secondsPerTick);

      if (info && info.pageOffset === seq.pageOffset) {
        const step = seq.getVisibleSteps()[info.stepIndex];
        if (step && step.voices[info.voiceIndex]) {
          step.voices[info.voiceIndex].length = lengthTicks;
          this.state.emit('stepChanged', {
            trackIndex: info.trackIndex,
            stepIndex:  info.stepIndex,
            step,
          });
        }
      }
    }
  }

  /**
   * Fire the same note on all tracks that follow the given source track.
   * Used for live keyboard notes and drum-mode notes.
   * @param {import('../state/Track.js').Track} sourceTrack
   * @param {number} note
   * @param {number} velocity
   * @param {number} audioTime — AudioContext.currentTime + lookahead
   */
  _fireFollowers(sourceTrack, note, velocity, audioTime) {
    const allTracks = this.state.project.tracks;
    allTracks.forEach(follower => {
      if (follower.followSource !== sourceTrack.index) return;
      const release = follower.envelope?.getParam('env.release') ?? 0.3;
      const offTime = audioTime + 0.5;  // hold gate 0.5s for live notes
      follower.fireFollowNote(note, velocity, audioTime, offTime);
    });
  }

  /**
   * Wire each track's LiveArp to capture its fired notes into that track's
   * pattern via captureArpNote(). Idempotent — re-run when tracks are added.
   */
  _attachLiveArpHooks() {
    this.state.project.tracks.forEach(track => {
      track.liveArp?.setRecordHook(
        (note, velocity, lengthTicks, scheduledTime) =>
          this.captureArpNote(track, note, velocity, lengthTicks, scheduledTime)
      );
    });
  }

  /**
   * Capture a single live-input-arp note into the step it lands on. Called by
   * LiveArp for each note it fires while recording, so the running arp gets
   * "printed" across the pattern as real notes (no re-arping on playback). Only
   * writes when the transport is recording and playing.
   *
   * Crucially, capture maps the note to the step playing at its SCHEDULED audio
   * time, not "now": LiveArp schedules a whole cycle (often several) in one
   * synchronous burst, so every note shares the same `currentTime`/`_stepIndex`.
   * Capturing against those would pile the whole chord onto a single step. We
   * instead project forward from the last scheduled tick:
   *   stepAtSchedule = lastFiredStep + round((schedTime - lastScheduledTime)/tick)
   * and take the fractional remainder as the nudge.
   *
   * @param {import('../state/Track.js').Track} track
   * @param {number} note          absolute MIDI note the arp emitted
   * @param {number} velocity
   * @param {number} lengthTicks    note length in ticks (from the arp gate)
   * @param {number} scheduledTime  AudioContext time the note is scheduled to play
   */
  captureArpNote(track, note, velocity, lengthTicks, scheduledTime) {
    if (!this.state.recording || !this.state.project.clock.isPlaying) return;

    const seq = track.sequencer;
    const at  = seq.stepIndexAtTime(scheduledTime);
    if (!at) return;
    const { absStep, nudge } = at;

    // Write directly by absolute index — notes may land on a page other than the
    // visible one. The steps array always covers [0, stepCount) (grown by the
    // stepCount setter), and absStep is taken mod stepCount, so this is in range.
    const step = seq.steps[absStep];
    if (!step) return;

    const length = Math.max(1 / 16, lengthTicks);
    if (!step.active) {
      step.voices[0] = { note, velocity, length, nudge };
      step.active = true;
    } else {
      step.addVoice(note, velocity, length, nudge);
    }

    // Emit with a visible-page-relative index when this step is on the current
    // page, so StepGrid/SynthPanel refresh; otherwise the absolute index is fine.
    const visIdx = absStep - seq.pageOffset * 16;
    this.state.emit('stepChanged', {
      trackIndex: track.index,
      stepIndex:  visIdx >= 0 && visIdx < 16 ? visIdx : absStep,
      step,
    });
  }

  /** Toggle keyboard folding on/off. Called from the SCALES tab. */
  setKeyFolding(on) {
    this.keyFolding = on;
    this._applyScale();
    this._updateKeyLabels();
  }

  render() {
    if (this._octaveDisplay) this._octaveDisplay.textContent = `C${this.octave}`;
    this._applyScale();
    this._updateKeyLabels();
  }
}
