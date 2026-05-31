/**
 * Project.js
 * ----------
 * Owns all 8 tracks. Handles project-level save and load.
 * Save targets: localStorage (auto-save) and JSON file export/import.
 *
 * Owns:    Track[] (8 instances)
 * Depends: Track.js, AudioEngine.js, Clock.js
 * Used by: AppState.js, index.html boot sequence
 *
 * Public:
 *   .tracks           — Track[] array (8 items)
 *   .bpm              — current BPM (delegates to Clock)
 *   setBPM(bpm)
 *   start()           — start all sequencers (via clock)
 *   stop()            — stop all sequencers
 *   toJSON()          — full project serialization
 *   fromJSON(obj)     — full project restore
 *   save()            — serialize to localStorage
 *   load()            — restore from localStorage (returns false if nothing saved)
 *   exportFile()      — trigger browser download of .json file
 *   importFile(file)  — read a .json File object and restore
 */

import { Track }       from './Track.js';
import { SampleStore } from './SampleStore.js';

const TRACK_COUNT_DEFAULT = 8;
const TRACK_COUNT_MIN     = 1;
const TRACK_COUNT_MAX     = 12;
const STORAGE_KEY         = 'webtakt_project';

export class Project {
  /**
   * @param {import('../core/AudioEngine.js').AudioEngine} audio
   * @param {import('../core/Clock.js').Clock} clock
   */
  /**
   * @param {import('../core/AudioEngine.js').AudioEngine} audio
   * @param {import('../core/Clock.js').Clock} clock
   * @param {object} [opts]
   * @param {number}  [opts.trackCount]  — initial track count (default 8)
   * @param {GainNode} [opts.outputBus]  — node the deck bus feeds into (default audio.fxBus)
   */
  constructor(audio, clock, opts = {}) {
    this.audio  = audio;
    this.clock  = clock;
    this.sampleStore = new SampleStore();

    this._midiEngine = null;

    // Per-deck sub-bus: every track in this project funnels here, then this bus
    // feeds the shared master FX bus. A DeckManager rides busGain.gain to
    // crossfade / silence the whole deck as a unit. See design/audio-signal-chain.md.
    this.busGain = audio.context.createGain();
    this.busGain.gain.value = 1.0;
    this.busGain.connect(opts.outputBus ?? audio.fxBus);

    const count = opts.trackCount ?? TRACK_COUNT_DEFAULT;
    this.tracks = Array.from(
      { length: count },
      (_, i) => this._makeTrack(i)
    );
    this._wireFollowTracks();
  }

  /** Build a Track wired to this deck's bus + sample store. */
  _makeTrack(i) {
    const t = new Track(i, this.audio, this.clock, this.busGain);
    t.sampleStore = this.sampleStore;
    if (this._midiEngine) t.setMidiEngine(this._midiEngine);
    return t;
  }

  /** Give every sequencer a live reference to the project's tracks array. */
  _wireFollowTracks() {
    this.tracks.forEach(t => {
      t.sequencer._projectTracks = this.tracks;
    });
  }

  get trackCount() {
    return this.tracks.length;
  }

  /**
   * Add or remove tracks to reach the target count.
   * @param {number} n
   */
  /** @param {import('../core/MidiEngine.js').MidiEngine} engine */
  setMidiEngine(engine) {
    this._midiEngine = engine;
    this.tracks.forEach(t => t.setMidiEngine(engine));
  }

  setTrackCount(n) {
    n = Math.max(TRACK_COUNT_MIN, Math.min(TRACK_COUNT_MAX, n));
    if (n === this.tracks.length) return;

    if (n > this.tracks.length) {
      // Add tracks — start sequencer immediately if clock is already running
      while (this.tracks.length < n) {
        const t = this._makeTrack(this.tracks.length);
        this.tracks.push(t);
        if (this.clock.isPlaying) t.sequencer.start();
      }
    } else {
      // Remove tracks from the end — stop their sequencers first
      while (this.tracks.length > n) {
        const t = this.tracks.pop();
        t.dispose();
      }
    }
    this._wireFollowTracks();
  }

  static get trackCountMin() { return TRACK_COUNT_MIN; }
  static get trackCountMax() { return TRACK_COUNT_MAX; }

  get bpm() {
    return this.clock.bpm;
  }

  /** @param {number} bpm */
  setBPM(bpm) {
    this.clock.setBPM(bpm);
    this.tracks.forEach(t => t.onBpmChanged(this.clock.bpm));
  }

  start() {
    this.tracks.forEach(t => t.sequencer.start());
    this.clock.start();
  }

  stop() {
    this.clock.stop();
    this.tracks.forEach(t => t.sequencer.stop());
  }

  /**
   * Global panic: stop the transport and hard-kill all sound on every track
   * (notes ringing out, loops, stuck voices). Wired to the STOP-ALL button.
   */
  silence() {
    this.stop();
    const t = this.audio.context.currentTime;
    this.tracks.forEach(track => track.silence(t));
  }

  toJSON() {
    return {
      version:    1,
      bpm:        this.clock.bpm,
      trackCount: this.tracks.length,
      tracks:     this.tracks.map(t => t.toJSON()),
    };
  }

  /** @param {object} obj */
  fromJSON(obj) {
    if (obj.bpm) {
      this.clock.setBPM(obj.bpm);
      this.tracks.forEach(t => t.onBpmChanged(this.clock.bpm));
    }
    if (obj.trackCount) this.setTrackCount(obj.trackCount);
    (obj.tracks ?? []).forEach((trackObj, i) => {
      if (this.tracks[i]) this.tracks[i].fromJSON(trackObj);
    });
  }

  /**
   * Load a project JSON into this deck *without* changing the shared transport
   * tempo (beatmatch: the deck adopts the current clock BPM, its saved BPM is
   * ignored). If the clock is already running, the newly-loaded sequencers are
   * started immediately so the deck plays in the background. Used by DeckManager.
   * @param {object} obj
   */
  loadDeckJSON(obj) {
    // Beatmatch: keep the shared clock BPM. Restore tracks only.
    if (obj.trackCount) this.setTrackCount(obj.trackCount);
    (obj.tracks ?? []).forEach((trackObj, i) => {
      if (this.tracks[i]) this.tracks[i].fromJSON(trackObj);
    });
    this.tracks.forEach(t => t.onBpmChanged(this.clock.bpm));
    if (this.clock.isPlaying) {
      this.tracks.forEach(t => t.sequencer.start());
    }
  }

  /** Load a File into this deck (beatmatched). @param {File} file */
  async loadDeckFile(file) {
    const text = await file.text();
    this.loadDeckJSON(JSON.parse(text));
  }

  /**
   * Tear the whole deck out of the audio graph and reset it to EMPTY (0 tracks).
   * Stops + disposes every track. Used when a deck is unloaded to free CPU; the
   * next loadDeckJSON() repopulates tracks via setTrackCount(). The deck bus is
   * kept (cheap, still connected) so the deck is instantly reusable.
   */
  reset() {
    this.tracks.forEach(t => t.dispose());
    this.tracks = [];
    this._wireFollowTracks();
  }

  /** Persist to localStorage. */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
    } catch (e) {
      console.warn('Webtakt: could not save project to localStorage', e);
    }
  }

  /**
   * Restore from localStorage.
   * @returns {boolean} — true if a saved project was found and loaded
   */
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.fromJSON(JSON.parse(raw));
      return true;
    } catch (e) {
      console.warn('Webtakt: could not load project from localStorage', e);
      return false;
    }
  }

  /** Trigger a browser file download of the current project as JSON. */
  exportFile() {
    const json = JSON.stringify(this.toJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'webtakt-project.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Load a project from a File object (from <input type="file">).
   * @param {File} file
   * @returns {Promise<void>}
   */
  async importFile(file) {
    const text = await file.text();
    this.fromJSON(JSON.parse(text));
  }
}
