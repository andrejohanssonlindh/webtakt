/**
 * boot.js
 * -------
 * Application boot + top-level wiring for the desktop surface.
 *
 * Extracted verbatim from the inline <script> that used to live in index.html
 * (Phase 0 of the responsive refactor — see RESPONSIVE.md). The goal of that
 * extraction was purely to get this logic out of the HTML and into a reusable
 * module entry point; behavior is unchanged.
 *
 * Creates the engine (audio, clock, project, decks, state), wires MIDI in,
 * mounts the UI components against the DOM in index.html, and binds the
 * transport / clear / export-import / track-nav / keyboard-shortcut handlers.
 *
 * Owns:    the boot closure (no exports — runs on import)
 * Depends: the full engine + UI module tree; the DOM defined in index.html
 * Used by: index.html (imported as a module)
 *
 * NOTE: import paths are relative to js/ (this file's directory), not to the
 * HTML root — that is the only thing changed during the extraction.
 */

import { AudioEngine }       from './core/AudioEngine.js';
import { GlobalRecorder }    from './core/GlobalRecorder.js';
import { Clock }         from './core/Clock.js';
import { MidiEngine }    from './core/MidiEngine.js';
import { LiveRecorder }  from './sequencer/LiveRecorder.js';
import { AppState }      from './state/AppState.js';
import { Project }       from './state/Project.js';
import { DeckManager }   from './state/DeckManager.js';
import { SoundLibrary }  from './state/SoundLibrary.js';
import { TrackRow }      from './ui/TrackRow.js';
import { StepGrid }      from './ui/StepGrid.js';
import { SynthPanel }    from './ui/SynthPanel.js';
import { ModWheel }      from './ui/ModWheel.js';
import { Keyboard }      from './ui/Keyboard.js';
import { Oscilloscope }  from './ui/Oscilloscope.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { settings }      from './state/Settings.js';
import { setSnapResolution } from './util/BpmSync.js';

// ── Boot ────────────────────────────────────────────────
const audio    = new AudioEngine();
const recorder = new GlobalRecorder(audio);
const clock    = new Clock(audio);
const project = new Project(audio, clock);
// Two-deck DJ layer: deck A is the boot project, deck B starts empty.
// state.project follows whichever deck has control (see DeckManager / AppState).
const decks   = new DeckManager(audio, clock, project);
const state   = new AppState(project, decks);
const library = new SoundLibrary();

// ── MIDI ─────────────────────────────────────────────────
const midiEngine = new MidiEngine();
// Records live MIDI-In notes into the sequencer while record mode is armed.
const midiRecorder = new LiveRecorder(state);
state.on('recordingChanged', ({ recording }) => { if (!recording) midiRecorder.reset(); });
state.on('panic', () => midiRecorder.reset());
midiEngine.init().then(() => {
  if (midiEngine.available) {
    midiEngine.connectClock(clock, audio.context);
    decks.setMidiEngine(midiEngine);
    // Route incoming CC to mapped track params
    midiEngine.onCC((inputId, channel, cc, value) => {
      state.project.tracks.forEach(track => {
        const cfg = track.midiIn;
        if (!cfg.inputId || cfg.inputId !== inputId) return;
        if (cfg.channel !== 0 && cfg.channel !== channel) return;
        cfg.ccMappings.forEach(m => {
          if (m.cc !== cc || !m.param) return;
          // Normalise 0-127 → param range. Include FX blocks (base + added
          // instances) via fxObjForPath so namespaced FX params map too.
          const sources = [
            track.machine,
            track.filter,
            track.envelope,
            track.fxObjForPath?.(m.param),
          ].filter(Boolean);
          for (const src of sources) {
            const desc = src.getParamList?.().find(p => p.path === m.param);
            if (desc) {
              const mapped = desc.min + (value / 127) * (desc.max - desc.min);
              src.setParam(m.param, mapped);
              state.emit('paramChanged', { path: m.param, value: mapped });
              break;
            }
          }
        });
      });

      // CC1 (mod wheel) from any input → MW1 on the selected track.
      if (cc === 1 && modWheel) {
        const norm = value / 127;
        modWheel._wheels[0]?.setValue(norm);
        modWheel._applyWheel(0, norm);
      }
    });

    // Pitch bend from any input → MW1. Covers keyboards whose left wheel
    // sends pitch bend rather than CC1 (e.g. Casio CTK-3500).
    midiEngine.onPitchBend((_inputId, _ch, norm) => {
      if (!modWheel) return;
      modWheel._wheels[0]?.setValue(norm);
      modWheel._applyWheel(0, norm);
    });

    // Route incoming MIDI notes to every armed track (those whose MIDI In is
    // mapped to this port/channel) + fire followers. Held voices are tracked
    // per-track in track._midiInVoices (Map<note, voice>) so the matching
    // note-off can release the right voice slot.
    midiEngine.onNoteOn((inputId, channel, note, velocity) => {
      const ctx = audio.context;
      const time = ctx.currentTime + 0.015;
      state.project.tracks.forEach(track => {
        const cfg = track.midiIn;
        if (!cfg.inputId || cfg.inputId !== inputId) return;
        if (cfg.channel !== 0 && cfg.channel !== channel) return;

        const finalNote = Math.max(0, Math.min(127, note + (cfg.noteTranspose ?? 0)));

        // Live-input arp mode: the held note set IS the chord — feed LiveArp,
        // which fans it out and (when recording) prints each fired note via its
        // own record hook. No direct note trigger and no recorder write here,
        // exactly as the on-screen keyboard does in this mode.
        const liveArp = track.arp?.enabled && track.arp.isLiveInputMode();
        if (liveArp) {
          track.liveArp.noteOn(finalNote, velocity);
        } else {
          // Play note on the track that has MIDI In mapped to this port/channel
          const voice    = track._pool?.nextVoice() ?? null;
          const machine  = voice?.machine  ?? track.machine;
          const envelope = voice?.envelope ?? track.envelope;
          // Claim the slot for the duration the note is held; note-off re-claims
          // it for just the release tail. The generous ceiling guards against a
          // dropped note-off stealing the voice mid-hold.
          if (voice) voice.claim(time + 30);
          if (!track._midiInVoices) track._midiInVoices = new Map();
          // Key original note so note-off can find the right voice slot.
          track._midiInVoices.set(note, voice);
          machine?.noteOn(finalNote, velocity, time);
          envelope?.scheduleNote(time, time + 30, { note: finalNote, velocity });
          // Record into the playhead step (no-op unless record mode is armed)
          midiRecorder.noteOn(track, finalNote, velocity, ctx.currentTime);
        }

        // Fire followers
        state.project.tracks.forEach(follower => {
          if (follower.followSource !== track.index) return;
          follower.fireFollowNote(finalNote, velocity, time, time + 0.5);
        });
      });
    });

    // Release the note when the key is lifted (or note-on velocity 0).
    midiEngine.onNoteOff((inputId, channel, note) => {
      const ctx = audio.context;
      const time = ctx.currentTime + 0.015;
      state.project.tracks.forEach(track => {
        const cfg = track.midiIn;
        if (!cfg.inputId || cfg.inputId !== inputId) return;
        if (cfg.channel !== 0 && cfg.channel !== channel) return;

        const finalNoteOff = Math.max(0, Math.min(127, note + (cfg.noteTranspose ?? 0)));

        if (track.held) return;   // hold active on this track — suppress note-off

        // Live-input arp mode: remove the note from the held chord; LiveArp
        // stops the runner when nothing is held. No direct release or recorder
        // writeback (the arp owns both).
        const liveArp = track.arp?.enabled && track.arp.isLiveInputMode();
        if (liveArp) {
          track.liveArp.noteOff(finalNoteOff);
          return;
        }

        const voice    = track._midiInVoices?.get(note) ?? null;
        const machine  = voice?.machine  ?? track.machine;
        const envelope = voice?.envelope ?? track.envelope;
        track._midiInVoices?.delete(note);
        // Re-claim the slot for just the release tail so the pool can reuse it.
        if (voice) {
          const release = envelope?.getParam('env.release') ?? 0.3;
          voice.claim(time + release);
        }
        machine?.noteOff(time);
        envelope?.noteOff(time);
        // Close out the recorded note's length (no-op if not captured)
        midiRecorder.noteOff(track, note, ctx.currentTime);
      });
    });
  }
});

// ── Mount UI ─────────────────────────────────────────────
const trackRow   = new TrackRow(document.getElementById('track-row'), state);
const synthPanel = new SynthPanel(document.getElementById('synth-panel'), state, library, _openModal, project.sampleStore, audio.context, midiEngine);
// Pull in factory sounds from the sounds/ folder (async fetch). Re-render the
// SOUNDS tab once they arrive so the list isn't empty on first paint. Tolerant
// of failure (e.g. file://) — the library just shows user sounds.
library.init().then(added => { if (added && state.activeTab === 'sounds') synthPanel.render(); });
const stepGrid   = new StepGrid(document.getElementById('step-grid'), state);
const oscilloscope = new Oscilloscope(synthPanel.scopeCanvas, audio.analyser);
oscilloscope.start();
const modWheel   = new ModWheel(document.getElementById('mod-wheels'), state);
const keyboard   = new Keyboard(
  document.getElementById('keyboard'),
  document.getElementById('octave-controls'),
  state
);

// ── Settings (global prefs: BPM grid, mod-wheel sensitivity, keybinds, layout) ──
// Apply the persisted finest-division snap resolution at boot, and re-render
// open panels whenever a setting changes (so synced knobs pick up new snaps).
setSnapResolution(settings.gridBase);
const settingsPanel = new SettingsPanel(
  document.getElementById('btn-settings'),
);

// 📖 Manual: toggles the overlay for whichever tab is currently active.
document.getElementById('btn-manual').addEventListener('click', (e) => {
  e.stopPropagation();
  synthPanel.toggleManual();
});
settings.on(() => {
  setSnapResolution(settings.gridBase);
  synthPanel.render();   // refresh any open synced knobs with new snap points
});

// ── Wire clock tick → step highlight + record-mode step advance ──
let _lastHighlight = -1;

clock.register((_tickIndex, scheduledTime) => {
  const seq = state.selectedTrack?.sequencer;
  if (!seq) return;
  const justFired = (seq._stepIndex - 1 + seq.stepCount) % seq.stepCount;
  if (justFired !== _lastHighlight) {
    _lastHighlight = justFired;
    // Always record the scheduled time of the most recently fired step.
    // Keyboard._noteOn reads this to compute nudge during record mode.
    state.lastStepScheduledTime = scheduledTime;
    requestAnimationFrame(() => {
      // In record mode, follow the playhead across pages automatically.
      // Guard: justFired must still be within the current stepCount (a clear
      // may have reset stepCount while this rAF was queued).
      if (state.recording && justFired < seq.stepCount) {
        const playPage = Math.floor(justFired / 16);
        if (seq.pageOffset !== playPage) {
          seq.pageOffset = playPage;
          _updatePageCounter();
          stepGrid._build();
          _lastHighlight = -1;
        }
      }
      const pageStart = seq.pageOffset * 16;
      const visIdx    = justFired - pageStart;
      stepGrid.highlightStep(visIdx >= 0 && visIdx < 16 ? visIdx : -1);
      // Record mode: track which step the keyboard should write into.
      // Use a dedicated field so selectedStepIndex stays at -1 and the grid
      // shows no selection highlight while recording.
      if (state.recording && visIdx >= 0 && visIdx < 16) {
        state.recordStepIndex = visIdx;
      }
    });
  }
});

// ── Transport ─────────────────────────────────────────────
const btnPlay    = document.getElementById('btn-play');
const btnStopAll = document.getElementById('btn-stop-all');
const btnRec     = document.getElementById('btn-rec');
const btnHold    = document.getElementById('btn-hold');
const bpmSlider  = document.getElementById('bpm-slider');
const bpmDisplay = document.getElementById('bpm-display');
let playing = false;

// ── HOLD ─────────────────────────────────────────────────
// Toggles hold on the SELECTED TRACK. Each track has its own hold state so
// switching tracks reflects that track's hold. The button syncs on toggle,
// track-switch, and holdModeChanged events.
const _syncHoldBtn = () => btnHold.classList.toggle('active', state.holdMode);
const _toggleHold  = () => { state.setHoldMode(!state.holdMode); _syncHoldBtn(); };
btnHold.addEventListener('click', _toggleHold);
state.on('trackSelected',   _syncHoldBtn);
state.on('holdModeChanged', _syncHoldBtn);

btnPlay.addEventListener('click', () => {
  audio.resume();
  if (!playing) {
    decks.startAll();
    playing = true;
    btnPlay.textContent = '▮▮ STOP';
    btnPlay.classList.add('playing');
  } else {
    decks.stopAll();
    playing = false;
    btnPlay.textContent = '▶ PLAY';
    btnPlay.classList.remove('playing');
    stepGrid.highlightStep(-1);
    stepGrid.render();        // clear sustain dots now that playback stopped
    _lastHighlight = -1;
    state.selectStep(-1);
  }
});

// ── STOP ALL (panic) ──────────────────────────────────────
// Stops the transport, kills every ringing/looping/stuck voice, and exits
// record mode. A hard reset of the audible state.
btnStopAll.addEventListener('click', () => {
  audio.resume();
  decks.silenceAll();
  if (state.recording) state.setRecording(false);
  state.project.tracks.forEach(t => t.setHold(false));
  btnHold.classList.remove('active');
  state.emit('holdModeChanged', { holdMode: false });  // re-render TrackRow H badges
  state.emit('panic', {});
  playing = false;
  btnPlay.textContent = '▶ PLAY';
  btnPlay.classList.remove('playing');
  stepGrid.highlightStep(-1);
  stepGrid.render();          // clear sustain dots on panic/stop
  _lastHighlight = -1;
  state.selectStep(-1);
});

btnRec.addEventListener('click', () => {
  const wasRecording = state.recording;
  state.setRecording(!wasRecording);
  // Turning record ON always starts playback
  if (!wasRecording && !playing) {
    btnPlay.click();
  }
});

state.on('recordingChanged', ({ recording }) => {
  if (!recording) { state.selectStep(-1); state.recordStepIndex = -1; }
  btnRec.classList.toggle('recording', recording);
});

// ── Global tape recorder ──────────────────────────────────
const btnTape = document.getElementById('btn-tape');

btnTape.addEventListener('click', async () => {
  audio.resume();
  if (!recorder.recording) {
    recorder.start();
    btnTape.textContent = '⏹ STOP TAPE';
    btnTape.classList.add('taping');
  } else {
    btnTape.textContent = '⏺ TAPE';
    btnTape.classList.remove('taping');
    await recorder.stop();
    // Prompt for filename then save
    promptFilename('webtakt-recording', (name) => {
      recorder.save(name.trim() || 'webtakt-recording');
    });
  }
});

// ── Transport overflow (⋯) ────────────────────────────────
// At phone width the rarely-used controls (clear, track-count, export/import)
// collapse behind the ⋯ toggle. CSS hides the toggle on desktop and shows the
// group inline; here we just flip an .open class the phone CSS reads. Clicking
// outside closes it.
const btnOverflow      = document.getElementById('btn-overflow');
const transportOverflow = document.getElementById('transport-overflow');
btnOverflow.addEventListener('click', (e) => {
  e.stopPropagation();
  transportOverflow.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!transportOverflow.contains(e.target) && e.target !== btnOverflow) {
    transportOverflow.classList.remove('open');
  }
});

// ── Drum mode ─────────────────────────────────────────────
const btnDrum = document.getElementById('btn-drum');

btnDrum.addEventListener('click', () => {
  audio.resume();
  state.setDrumMode(!state.drumMode);
});

state.on('drumModeChanged', ({ drumMode }) => {
  btnDrum.classList.toggle('drum-active', drumMode);
});

bpmSlider.addEventListener('input', () => {
  const bpm = parseInt(bpmSlider.value);
  decks.setBPM(bpm);
  bpmDisplay.textContent = bpm;
});

// ── Confirm / prompt modal (replaces window.confirm to avoid audio pause) ──
function _openModal(msg, inputDefault, onConfirm) {
  const modal     = document.getElementById('confirm-modal');
  const msgEl     = document.getElementById('confirm-msg');
  const inputEl   = document.getElementById('confirm-input');
  const okBtn     = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  msgEl.textContent = msg;
  if (inputDefault !== null) {
    inputEl.value = inputDefault;
    inputEl.style.display = 'block';
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 0);
  } else {
    inputEl.style.display = 'none';
  }
  modal.style.display = 'flex';
  function close() {
    modal.style.display = 'none';
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    inputEl.removeEventListener('keydown', handleKey);
  }
  function handleOk()     { close(); onConfirm(inputEl.value); }
  function handleCancel() { close(); }
  function handleKey(e)   { if (e.key === 'Enter') handleOk(); if (e.key === 'Escape') handleCancel(); }
  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
  inputEl.addEventListener('keydown', handleKey);
}
function confirmAction(msg, onConfirm) { _openModal(msg, null, onConfirm); }
function promptFilename(defaultName, onConfirm) { _openModal('Export filename:', defaultName, onConfirm); }

// ── Track count +/- ──────────────────────────────────────
const trackCountDisplay = document.getElementById('track-count-display');

function _setTrackCount(n) {
  state.project.setTrackCount(n);
  trackCountDisplay.textContent = state.project.tracks.length;
  // Clamp selected track if it no longer exists
  if (state.selectedTrackIndex >= state.project.tracks.length) {
    state.selectTrack(state.project.tracks.length - 1);
  }
  trackRow._build();
  synthPanel.render();
  _updatePageCounter();
}

document.getElementById('btn-tracks-minus').addEventListener('click', () => {
  _setTrackCount(state.project.tracks.length - 1);
});
document.getElementById('btn-tracks-plus').addEventListener('click', () => {
  _setTrackCount(state.project.tracks.length + 1);
});

// ── Clear ─────────────────────────────────────────────────
function _afterClear() {
  _lastHighlight = -1;
  state.selectStep(-1);
  stepGrid._build();
  synthPanel.render();
  trackRow.render();
  _updatePageCounter();
  // Re-sync hold button in case resetTrack() cleared a track's hold state.
  _syncHoldBtn();
}

document.getElementById('btn-clear-notes').addEventListener('click', () => {
  confirmAction('Clear notes on this track?', () => {
    state.selectedTrack.clearNotes();
    _afterClear();
  });
});

document.getElementById('btn-clear-track').addEventListener('click', () => {
  confirmAction('Reset this track to defaults?\nAll params, LFOs and notes will be cleared.', () => {
    state.selectedTrack.resetTrack();
    _afterClear();
  });
});

document.getElementById('btn-clear-notes-all').addEventListener('click', () => {
  confirmAction('Clear notes on ALL tracks?', () => {
    state.project.tracks.forEach(t => t.clearNotes());
    _afterClear();
  });
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  confirmAction('Reset ALL tracks to defaults?\nEverything will be cleared.', () => {
    state.project.tracks.forEach(t => t.resetTrack());
    _afterClear();
  });
});

// ── Export / Import ───────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', () => {
  promptFilename('webtakt-project', (name) => {
    const filename = name.trim() || 'webtakt-project';
    const json = JSON.stringify(state.project.toJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename.endsWith('.json') ? filename : filename + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });
});
document.getElementById('btn-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await state.project.importFile(file);
  // IMPORT loads into the controlled deck; mark it loaded + name it for the DECK tab.
  decks._loaded[decks.active] = true;
  decks.setName(decks.active, file.name);
  trackCountDisplay.textContent = state.project.tracks.length;
  if (state.selectedTrackIndex >= state.project.tracks.length) {
    state.selectedTrackIndex = state.project.tracks.length - 1;
  }
  bpmSlider.value = clock.bpm;
  bpmDisplay.textContent = clock.bpm;
  trackRow._build();
  synthPanel.render();
  stepGrid._build();
});

// ── Track nav: page counter + next page + length popup ───
const pageCounter  = document.getElementById('track-nav-page-counter');
const btnNavNext   = document.getElementById('track-nav-next');
const btnNavLength = document.getElementById('track-nav-length');
const lengthPopup  = document.getElementById('length-popup');
const lpSteps      = document.getElementById('length-popup-steps');

function _pageCount(seq) {
  return Math.max(1, Math.ceil(seq.stepCount / 16));
}

// Highest page number (1-based) that has any data — active or inactive.
// Always >= _pageCount(seq). Never returns 0.
function _maxUsedPages(seq) {
  const activePages = _pageCount(seq);
  let maxPage = activePages;
  for (let i = seq.stepCount; i < seq.steps.length; i++) {
    const s = seq.steps[i];
    if (s.active || s.hasPLocks || s.hasCondition) {
      maxPage = Math.max(maxPage, Math.floor(i / 16) + 1);
    }
  }
  return maxPage;
}

function _updatePageCounter() {
  const seq         = state.selectedTrack.sequencer;
  const page        = seq.pageOffset + 1;
  const activePages = _pageCount(seq);
  const maxPages    = _maxUsedPages(seq);
  // Show "1/2(4)" only when inactive pages actually have step data
  pageCounter.textContent = maxPages > activePages
    ? `${page}/${activePages}(${maxPages})`
    : `${page}/${activePages}`;
}

function _goToPage(pageIndex) {
  const seq = state.selectedTrack.sequencer;
  seq.pageOffset = Math.max(0, pageIndex);
  _updatePageCounter();
  state.selectStep(-1);
  stepGrid._build();
  _lastHighlight = -1;
}

function _setStepCount(n) {
  const seq = state.selectedTrack.sequencer;
  seq.stepCount = Math.max(1, n);
  _updatePageCounter();
  lpSteps.textContent = seq.stepCount;
  state.selectStep(-1);
  stepGrid._build();
}

// ── SHIFT one step in `dir` — scope depends on selection (TRIG buttons + ←→) ──
// Shared coordinator for both scopes:
//   No step selected → rotate the WHOLE pattern (Sequencer.shiftAll, wrap-around).
//   Step selected     → MOVE just that trigger (Sequencer.moveStep — collision-
//     push + pattern-wide wrap), following it across a page boundary and keeping
//     it selected so repeated presses keep nudging the same note.
function _shiftSelected(dir) {
  const seq = state.selectedTrack.sequencer;

  if (state.selectedStepIndex < 0) {
    // Whole-track rotation.
    seq.shiftAll(dir);
    stepGrid._build();
    state.emit('stepChanged', { trackIndex: state.selectedTrackIndex, stepIndex: -1, step: null });
    return;
  }

  // Per-trigger move.
  const fromAbs = seq.pageOffset * 16 + state.selectedStepIndex;
  if (!seq.steps[fromAbs]?.active) return;     // nothing to move (empty slot)
  const toAbs   = seq.moveStep(fromAbs, dir);
  if (toAbs === fromAbs) return;               // no-op (pattern full that way)

  const newPage = Math.floor(toAbs / 16);
  if (newPage !== seq.pageOffset) {
    seq.pageOffset = newPage;
    _updatePageCounter();
    _lastHighlight = -1;
  }
  stepGrid._build();
  // Reselect the moved trigger at its new visible index (emits stepSelected →
  // grid + TRIG panel re-render). Clear first so selectStep never sees the new
  // index as "same as current" and toggles the selection off (can happen when a
  // cross-page move lands on the same visible slot it left).
  state.selectedStepIndex = -1;
  state.selectStep(toAbs - newPage * 16);
}
state.on('moveSelectedStep', ({ dir }) => _shiftSelected(dir));

function _closeLengthPopup() {
  lengthPopup.style.display = 'none';
  document.removeEventListener('pointerdown', _popupOutsideClick);
}

function _popupOutsideClick(e) {
  if (!lengthPopup.contains(e.target) && e.target !== btnNavLength) {
    _closeLengthPopup();
  }
}

btnNavNext.addEventListener('click', () => {
  const seq      = state.selectedTrack.sequencer;
  const maxPages = _maxUsedPages(seq);
  _goToPage((seq.pageOffset + 1) % maxPages);
});

btnNavLength.addEventListener('click', (e) => {
  if (lengthPopup.style.display !== 'none') {
    _closeLengthPopup();
    return;
  }
  const seq = state.selectedTrack.sequencer;
  lpSteps.textContent = seq.stepCount;
  // Position popup above the button
  const rect = btnNavLength.getBoundingClientRect();
  lengthPopup.style.right = (window.innerWidth - rect.right) + 'px';
  lengthPopup.style.top   = (rect.top - lengthPopup.offsetHeight - 4) + 'px';
  lengthPopup.style.display = 'flex';
  // Need to measure after display:flex
  requestAnimationFrame(() => {
    const pr = lengthPopup.getBoundingClientRect();
    lengthPopup.style.top = (rect.top - pr.height - 4) + 'px';
  });
  setTimeout(() => document.addEventListener('pointerdown', _popupOutsideClick), 0);
});

document.getElementById('lp-minus16').addEventListener('click', () => {
  _setStepCount(state.selectedTrack.sequencer.stepCount - 16);
});
document.getElementById('lp-minus1').addEventListener('click', () => {
  _setStepCount(state.selectedTrack.sequencer.stepCount - 1);
});
document.getElementById('lp-plus1').addEventListener('click', () => {
  _setStepCount(state.selectedTrack.sequencer.stepCount + 1);
});
document.getElementById('lp-plus16').addEventListener('click', () => {
  _setStepCount(state.selectedTrack.sequencer.stepCount + 16);
});

// Update page counter whenever the selected track changes
state.on('trackSelected', _updatePageCounter);
_updatePageCounter();

// ── Deck (DJ) wiring ──────────────────────────────────────
// Re-point the whole UI at the controlled deck. selectedTrackIndex is
// clamped to the new deck's track count; everything reads state.project.
function _refreshControlledDeck() {
  if (state.selectedTrackIndex >= state.project.tracks.length) {
    state.selectedTrackIndex = state.project.tracks.length - 1;
  }
  state.selectStep(-1);
  trackCountDisplay.textContent = state.project.tracks.length;
  trackRow._build();
  stepGrid._build();
  synthPanel.render();
  _updatePageCounter();
  // Notify listeners (page counter, etc.) that the active track changed.
  state.emit('trackSelected', { index: state.selectedTrackIndex, track: state.selectedTrack });
}

// Control switch: full UI re-point.
decks.on('controlChanged', () => _refreshControlledDeck());
// Deck load/unload/silence: if it touched the controlled deck, re-render;
// always refresh the DECK tab so its state labels/buttons stay current.
decks.on('deckChanged', () => {
  _refreshControlledDeck();
});

// ── Keyboard shortcuts ────────────────────────────────────
// Transport keys are user-rebindable (Settings). Each bind is an event.code
// (layout-independent). play/record/stopAll map to the transport buttons.
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const kb = settings.get('keybinds');
  if (e.code === kb.play) {
    e.preventDefault();
    // Capture-Play: when on, blur whatever button/control has focus first so
    // the browser's native "Space activates the focused element" never also
    // fires alongside our play/stop toggle. Off = leave focus untouched.
    if (settings.get('capturePlay') && document.activeElement?.blur) {
      document.activeElement.blur();
    }
    btnPlay.click();
    return;
  }
  if (e.code === kb.record) {
    e.preventDefault();
    btnRec.click();
    return;
  }
  if (e.code === kb.stopAll) {
    e.preventDefault();
    btnStopAll.click();
    return;
  }
  if (e.code === kb.manual) {
    e.preventDefault();
    synthPanel.toggleManual();
    return;
  }
  if (e.code === kb.hold) {
    e.preventDefault();
    _toggleHold();
    return;
  }
  // Selected-track toggles: arp + the four generic FX binds.
  if (e.code === kb.arp) {
    e.preventDefault();
    synthPanel.toggleArp();
    return;
  }
  // On-screen keyboard octave shift (mirrors OCT+/OCT-).
  if (e.code === kb.octaveUp) {
    e.preventDefault();
    keyboard.shiftOctave(+1);
    return;
  }
  if (e.code === kb.octaveDown) {
    e.preventDefault();
    keyboard.shiftOctave(-1);
    return;
  }
  // Shift one step left/right: moves the selected trigger, or rotates the whole
  // pattern when no step is selected.
  if (e.code === kb.moveLeft) {
    e.preventDefault();
    _shiftSelected(-1);
    return;
  }
  if (e.code === kb.moveRight) {
    e.preventDefault();
    _shiftSelected(+1);
    return;
  }
  // FX binds 1–4: toggle whichever FX block the SELECTED track maps each bind
  // to (assigned per-track in the FX pane). Unassigned binds do nothing.
  const fxBindNum = { [kb.fx1]: 1, [kb.fx2]: 2, [kb.fx3]: 3, [kb.fx4]: 4 }[e.code];
  if (fxBindNum) {
    e.preventDefault();
    synthPanel.toggleFxBind(fxBindNum);
    return;
  }
  // Track digit shortcuts. e.code is layout-independent and unaffected by
  // Shift, so 1–N work the same on every keyboard layout:
  //   Shift + digit → select (switch to) that track
  //   Alt   + digit → jump to that pattern page on the current track
  //   bare  digit   → mute / unmute that track (skipped in drum mode, where
  //                   digits finger-drum — handled in Keyboard.js)
  const digitMatch = e.code.match(/^Digit(\d)$/);
  const num = digitMatch ? parseInt(digitMatch[1]) : NaN;
  if (isNaN(num)) return;
  if (e.shiftKey) {
    // Shift+1..N → select that track
    if (num >= 1 && num <= state.project.tracks.length) {
      e.preventDefault();
      state.selectTrack(num - 1);
    }
    return;
  }
  if (e.altKey) {
    // Alt+1..N → jump to that page on the current track
    e.preventDefault();
    _goToPage(num - 1);
    return;
  }
  if (num >= 1 && num <= state.project.tracks.length && !state.drumMode) {
    // bare digit → mute / unmute
    const track = state.project.tracks[num - 1];
    track.muted ? track.unmute() : track.mute();
    trackRow.render();
  }
});

// ── Resume AudioContext on first user gesture ─────────────
document.addEventListener('click', () => audio.resume(), { once: true });

// No auto-load — always start fresh. Use IMPORT to load a saved project.
