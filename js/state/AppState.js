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
  /** @param {import('./Project.js').Project} project */
  constructor(project) {
    this.project            = project;
    this.selectedTrackIndex = 0;
    this.activeTab          = 'synth';
    this.activeLFOIndex     = 0;
    this.selectedStepIndex  = -1;
    this.recording              = false;
    this.lastStepScheduledTime  = null;   // AudioContext time of the most recently fired step
    this._listeners             = new Map();  // event → Set<callback>
  }

  /** Toggle record mode on/off. */
  setRecording(on) {
    this.recording = on;
    this.emit('recordingChanged', { recording: on });
  }

  get selectedTrack() {
    return this.project.tracks[this.selectedTrackIndex];
  }

  get selectedStep() {
    if (this.selectedStepIndex < 0) return null;
    return this.selectedTrack.sequencer.getVisibleSteps()[this.selectedStepIndex] ?? null;
  }

  /** @param {number} index */
  selectTrack(index) {
    this.selectedTrackIndex = index;
    this.selectedStepIndex  = -1;  // clear step selection on track change
    this.emit('trackSelected', { index, track: this.selectedTrack });
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

  /** @param {string} event @param {function} callback */
  off(event, callback) {
    this._listeners.get(event)?.delete(callback);
  }

  /** @param {string} event @param {*} data */
  emit(event, data) {
    this._listeners.get(event)?.forEach(cb => cb(data));
  }
}
