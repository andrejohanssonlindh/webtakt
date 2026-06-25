/**
 * AppState.js
 * -----------
 * Global UI state. Tracks which track is selected, which LFO is visible,
 * which synth panel tab is active, and so on.
 * Also serves as a lightweight event bus so UI components can react to
 * state changes without direct references to each other.
 *
 * Owns:    selected track index, active tab, active LFO index, event listeners
 * Depends: Project.js
 * Used by: all UI components
 *
 * Public:
 *   .project              — Project instance
 *   .selectedTrackIndex   — number (0–7)
 *   .selectedTrack        — Track shorthand getter
 *   .activeTab            — 'trig' | 'synth' | 'filter' | 'env' | 'lfo'
 *   .activeLFOIndex       — which LFO is shown in the LFO sub-panel
 *   .selectedStepIndex    — number or -1 (no step selected)
 *   .selectedStep         — Step instance or null
 *   selectTrack(index)
 *   setTab(tab)
 *   setActiveLFO(index)
 *   selectStep(index)     — select a step (-1 to deselect)
 *   on(event, callback)   — subscribe to a named event
 *   onAny(callback)       — subscribe to every event (wildcard); cb(event, data)
 *   off(event, callback)  — unsubscribe
 *   emit(event, data)     — fire an event
 *
 * Events emitted:
 *   'trackSelected'   — { index, track }
 *   'tabChanged'      — { tab }
 *   'lfoChanged'      — { index }
 *   'stepSelected'    — { index, step }   (step = null when deselected)
 *   'stepChanged'     — { trackIndex, stepIndex, step }
 *   'playStateChanged'— { playing }
 */

export class AppState {
  /**
   * @param {import('./Project.js').Project} project — boot project (deck A)
   * @param {import('./DeckManager.js').DeckManager} [decks] — two-deck manager.
   *   When present, `.project` follows the controlled deck.
   */
  constructor(project, decks = null) {
    this.decks              = decks;
    this._project           = project;
    this.selectedTrackIndex = 0;
    // When true, the global FX track is selected instead of tracks[selectedTrackIndex].
    // Kept as a separate flag so all existing code that treats selectedTrackIndex as a
    // raw tracks[] index stays correct — that path only runs for normal tracks.
    this.fxTrackSelected    = false;
    this.activeTab          = 'synth';
    this.activeLFOIndex     = 0;
    this.fxSelectedBlockId  = null;   // FX pipeline pane: block being edited inline
    this.selectedStepIndex  = -1;
    this.recording              = false;
    this.drumMode               = false;
    this.lastStepScheduledTime  = null;   // AudioContext time of the most recently fired step
    this._listeners             = new Map();  // event → Set<callback>
    this._anyListeners          = new Set();  // wildcard subscribers (see onAny)
  }

  /** Toggle record mode on/off. */
  setRecording(on) {
    this.recording = on;
    this.emit('recordingChanged', { recording: on });
  }

  /** Toggle drum mode on/off. */
  setDrumMode(on) {
    this.drumMode = on;
    this.emit('drumModeChanged', { drumMode: on });
  }

  /**
   * Hold is per-track. `holdMode` reads the selected track's held flag so
   * index.html and Keyboard can check a single property. `setHoldMode` writes
   * to the selected track and emits 'holdModeChanged' so the button + TrackRow
   * can update. Keyboard listens to flush held notes when hold turns off.
   */
  get holdMode() {
    return this.selectedTrack?.held ?? false;
  }

  setHoldMode(on) {
    const track = this.selectedTrack;
    if (!track) return;
    track.setHold(on);
    this.emit('holdModeChanged', { holdMode: on, track });
  }

  /**
   * The active Project. When a DeckManager is attached this follows the
   * controlled deck (so the whole UI re-points on "take control"); otherwise
   * it's the fixed boot project.
   */
  get project() {
    return this.decks ? this.decks.activeProject : this._project;
  }

  get selectedTrack() {
    if (this.fxTrackSelected && this.project.fxTrack) return this.project.fxTrack;
    const tracks = this.project.tracks;
    if (!tracks.length) return null;
    const i = Math.max(0, Math.min(this.selectedTrackIndex, tracks.length - 1));
    return tracks[i];
  }

  get selectedStep() {
    if (this.selectedStepIndex < 0) return null;
    return this.selectedTrack.sequencer.getVisibleSteps()[this.selectedStepIndex] ?? null;
  }

  /** @param {number} index */
  selectTrack(index) {
    const prevTrack = this.selectedTrack;
    this.fxTrackSelected    = false;
    this.selectedTrackIndex = index;
    this.selectedStepIndex  = -1;  // clear step selection on track change
    this.emit('trackSelected', { index, track: this.selectedTrack, prevTrack });
    this.emit('stepSelected',  { index: -1, step: null });
  }

  /**
   * Select the global FX track (pinned first in the track row). Leaves
   * selectedTrackIndex untouched so returning to a normal track restores it.
   */
  selectFXTrack() {
    if (!this.project.fxTrack) return;
    const prevTrack = this.selectedTrack;
    this.fxTrackSelected   = true;
    this.selectedStepIndex = -1;
    this.emit('trackSelected', { index: -1, track: this.selectedTrack, prevTrack, fxTrack: true });
    this.emit('stepSelected',  { index: -1, step: null });
  }

  /** @param {string} tab */
  setTab(tab) {
    this.activeTab = tab;
    this.emit('tabChanged', { tab });
  }

  /** @param {number} index */
  setActiveLFO(index) {
    this.activeLFOIndex = index;
    this.emit('lfoChanged', { index });
  }

  /**
   * Select a step by index. Pass -1 to deselect.
   * Clicking the already-selected step deselects it.
   * @param {number} index
   */
  selectStep(index) {
    if (this.selectedStepIndex === index) {
      // toggle off
      this.selectedStepIndex = -1;
      this.emit('stepSelected', { index: -1, step: null });
    } else {
      this.selectedStepIndex = index;
      const step = this.selectedStep;
      this.emit('stepSelected', { index, step });
    }
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {function} callback
   */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
  }

  /**
   * Subscribe to EVERY emitted event (wildcard). The callback gets
   * (event, data). Used by the auto-cache to persist on any mutation without
   * having to enumerate event names.
   * @param {function} callback
   */
  onAny(callback) {
    if (!this._anyListeners) this._anyListeners = new Set();
    this._anyListeners.add(callback);
  }

  /** @param {string} event @param {function} callback */
  off(event, callback) {
    this._listeners.get(event)?.delete(callback);
  }

  /** @param {string} event @param {*} data */
  emit(event, data) {
    this._listeners.get(event)?.forEach(cb => cb(data));
    this._anyListeners?.forEach(cb => cb(event, data));
  }
}
