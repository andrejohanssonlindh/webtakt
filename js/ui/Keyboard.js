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
 * Owns:    key DOM elements, octave state, keyboard event listeners
 * Depends: AppState.js
 * Used by: index.html (mounted to #keyboard and #octave-controls)
 */

import { noteInScale } from '../state/Scales.js';

const WHITE_NOTES = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];
const BLACK_NOTES = [1, 3, -1, 6, 8, 10, -1, 13, 15, -1, 18, 20, 22, -1];

const KB_WHITE = ['a','s','d','f','g','h','j','k','l',';',"'",'\\'];
const KB_BLACK = ['w','e','','t','y','u','','i','o','','p','['];

export class Keyboard {
  /**
   * @param {HTMLElement} keyboardEl
   * @param {HTMLElement} octaveEl
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(keyboardEl, octaveEl, state) {
    this.keyboardEl = keyboardEl;
    this.octaveEl   = octaveEl;
    this.state      = state;
    this.octave     = 4;
    this._heldKeys  = new Set();
    this._audioReady = false;
    // In record mode: track when each key was pressed and which step it wrote to
    this._recordNoteOnTime  = new Map(); // midiNote → AudioContext time of noteOn
    this._recordNoteOnStep  = new Map(); // midiNote → { stepIndex, pageOffset }

    this._buildOctaveControls();
    this._build();
    this._bindKeyboard();

    // Rebuild key colors when scale or selected track changes
    state.on('scaleChanged',  () => this._applyScale());
    state.on('trackSelected', () => this._applyScale());
    // Clear held-note record state when recording stops
    state.on('recordingChanged', ({ recording }) => {
      if (!recording) {
        this._recordNoteOnTime.clear();
        this._recordNoteOnStep.clear();
      }
    });
  }

  get _rootNote() {
    return this.octave * 12;
  }

  /**
   * Ensure AudioContext is running before scheduling notes.
   * Returns a promise that resolves once resume is complete.
   * Calling this repeatedly is safe — resume() is idempotent.
   */
  async _ensureAudio() {
    const ctx = this.state.project.audio.context;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
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

  _build() {
    this.keyboardEl.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'keyboard-inner';

    WHITE_NOTES.forEach((semitone) => {
      const midi = this._rootNote + semitone;
      const key = document.createElement('div');
      key.className = 'key white-key';
      key.dataset.note = midi;

      key.addEventListener('mousedown', () => this._noteOn(midi));
      key.addEventListener('mouseup',   () => this._noteOff(midi));
      key.addEventListener('mouseleave',() => this._noteOff(midi));
      wrapper.appendChild(key);
    });

    BLACK_NOTES.forEach((semitone) => {
      if (semitone === -1) return;
      const midi = this._rootNote + semitone;
      const key = document.createElement('div');
      key.className = 'key black-key';
      key.dataset.note = midi;
      key.style.left = `${this._blackKeyOffset(semitone)}%`;

      key.addEventListener('mousedown', () => this._noteOn(midi));
      key.addEventListener('mouseup',   () => this._noteOff(midi));
      key.addEventListener('mouseleave',() => this._noteOff(midi));
      wrapper.appendChild(key);
    });

    this.keyboardEl.appendChild(wrapper);
    if (this._octaveDisplay) this._octaveDisplay.textContent = `C${this.octave}`;
    this._applyScale();
  }

  _applyScale() {
    this.keyboardEl.querySelectorAll('.key').forEach(key => {
      const midi = parseInt(key.dataset.note, 10);
      const blocked = !this._isInScale(midi);
      key.classList.toggle('scale-blocked', blocked);
    });
  }

  _blackKeyOffset(semitone) {
    const whiteWidth = 100 / WHITE_NOTES.length;
    const whiteBelow = WHITE_NOTES.indexOf(semitone - 1);
    return (whiteBelow + 0.75) * whiteWidth;
  }

  async _noteOn(midiNote) {
    if (!this._isInScale(midiNote)) return;  // blocked by active scale
    if (this._heldKeys.has(midiNote)) return;
    this._heldKeys.add(midiNote);

    // Ensure context is running — on the very first gesture this awaits resume().
    // Subsequent calls return immediately because ctx.state === 'running'.
    await this._ensureAudio();

    const ctx     = this.state.project.audio.context;
    const machine = this.state.selectedTrack.machine;
    const track   = this.state.selectedTrack;

    // Small lookahead so the audio thread always has a valid future slot.
    // 0.015s is enough to avoid glitches without audible delay.
    const time = ctx.currentTime + 0.015;

    machine?.noteOn(midiNote, 100, time);
    track.envelope.noteOn(time);

    // Write into the record-tracked step when recording, else the manually selected step
    const stepIndex = this.state.recording
      ? (this.state.recordStepIndex ?? -1)
      : this.state.selectedStepIndex;
    if (stepIndex >= 0) {
      const step = track.sequencer.getVisibleSteps()[stepIndex];
      if (step) {
        step.note   = midiNote;
        step.active = true;

        // In record mode, capture timing offset as nudge.
        // Compare actual play time to when the step was scheduled to fire.
        // Clamp to ±99% of one step interval.
        if (this.state.recording && this.state.lastStepScheduledTime !== null) {
          const secondsPerTick = track.sequencer.clock._secondsPerTick;
          const offsetTicks    = (ctx.currentTime - this.state.lastStepScheduledTime) / secondsPerTick;
          step.nudge = Math.max(-0.99, Math.min(0.99, offsetTicks));
        }

        // In record mode, remember when this note started so _noteOff can write step.length
        if (this.state.recording) {
          this._recordNoteOnTime.set(midiNote, ctx.currentTime);
          this._recordNoteOnStep.set(midiNote, {
            stepIndex,
            pageOffset: track.sequencer.pageOffset,
          });
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

    await this._ensureAudio();

    const ctx     = this.state.project.audio.context;
    const machine = this.state.selectedTrack.machine;
    const track   = this.state.selectedTrack;
    const time    = ctx.currentTime + 0.015;

    machine?.noteOff(time);
    track.envelope.noteOff(time);

    // In record mode: compute how long the key was held and write to step.length
    if (this.state.recording && this._recordNoteOnTime.has(midiNote)) {
      const onTime    = this._recordNoteOnTime.get(midiNote);
      const info      = this._recordNoteOnStep.get(midiNote);
      this._recordNoteOnTime.delete(midiNote);
      this._recordNoteOnStep.delete(midiNote);

      const holdSec        = ctx.currentTime - onTime;
      const secondsPerTick = track.sequencer.clock._secondsPerTick;
      const lengthTicks    = Math.max(1 / 16, holdSec / secondsPerTick);

      // Only write if the page hasn't changed since noteOn (step is still reachable)
      if (info && info.pageOffset === track.sequencer.pageOffset) {
        const step = track.sequencer.getVisibleSteps()[info.stepIndex];
        if (step) {
          step.length = lengthTicks;
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
      // Don't intercept keyboard when typing in an input/select
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      const wi = KB_WHITE.indexOf(e.key);
      if (wi !== -1) this._noteOn(this._rootNote + WHITE_NOTES[wi]);
      const bi = KB_BLACK.indexOf(e.key);
      if (bi !== -1 && BLACK_NOTES[bi] !== -1) this._noteOn(this._rootNote + BLACK_NOTES[bi]);
    });

    document.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      const wi = KB_WHITE.indexOf(e.key);
      if (wi !== -1) this._noteOff(this._rootNote + WHITE_NOTES[wi]);
      const bi = KB_BLACK.indexOf(e.key);
      if (bi !== -1 && BLACK_NOTES[bi] !== -1) this._noteOff(this._rootNote + BLACK_NOTES[bi]);
    });
  }

  render() {
    if (this._octaveDisplay) this._octaveDisplay.textContent = `C${this.octave}`;
    this._applyScale();
  }
}
