/**
 * DeckManager.js
 * --------------
 * Two-deck DJ layer. Owns two independent Project instances ("A" and "B") that
 * share the one AudioEngine and the one Clock (beatmatch: both run at the same
 * BPM). Each deck's tracks funnel into that deck's Project.busGain; this manager
 * rides the two bus gains to crossfade and silence each deck as a unit.
 *
 *   deck A tracks → projectA.busGain ┐
 *                                    ├→ audio.fxBus → masterGain → destination
 *   deck B tracks → projectB.busGain ┘
 *
 * Crossfader x∈[0,1] (0 = full A / left, 1 = full B / right) uses a constant-power
 * law: gainA = cos(x·π/2), gainB = sin(x·π/2) — perceived loudness stays roughly
 * constant across the sweep with no centre dip. Per-deck "silence" multiplies that
 * deck's bus by 0 independently of the fader.
 *
 * "Control" is which deck the editing UI edits. It is independent of the fader —
 * you can ride the filter on the incoming deck before you fade to it. AppState
 * reads the active deck's project through DeckManager (see AppState.project).
 *
 * Owns:    projectA, projectB (Project), crossfade position, silence flags,
 *          active control deck ('A' | 'B')
 * Depends: Project.js
 * Used by: AppState.js, index.html (DECK tab, transport, boot)
 *
 * Public:
 *   .a / .b              — the two Project instances
 *   .active              — 'A' | 'B' (which deck the UI controls)
 *   .activeProject       — the controlled deck's Project
 *   .crossfade           — 0..1 current fader position
 *   deck(id)             — Project for 'A' | 'B'
 *   isLoaded(id)         — has the deck got user content (true once a song loaded)
 *   isAudible(id)        — is the deck contributing audible level right now
 *   setCrossfade(x)      — 0..1, applies constant-power gains
 *   setControl(id)       — switch edited deck; fires 'controlChanged'
 *   setSilenced(id, on)  — per-deck mute (independent of fader)
 *   isSilenced(id)
 *   loadFile(id, file)   — load a song JSON file into a deck (beatmatched)
 *   unload(id)           — tear deck out of graph, reset blank, free CPU
 *   startAll() / stopAll() — start/stop both decks on the shared transport
 *   on/off/emit          — tiny event bus ('crossfadeChanged' | 'controlChanged' | 'deckChanged')
 */

import { Project } from './Project.js';

export class DeckManager {
  /**
   * @param {import('../core/AudioEngine.js').AudioEngine} audio
   * @param {import('../core/Clock.js').Clock} clock
   * @param {Project} [primary] — existing Project to adopt as deck A (boot project)
   */
  constructor(audio, clock, primary = null) {
    this.audio = audio;
    this.clock = clock;

    // Deck A is the boot project (already has the user's starting song). Deck B
    // starts blank/unloaded.
    this.a = primary ?? new Project(audio, clock);
    // Deck B boots empty (0 tracks) — no voices/sequencers until a song loads,
    // so an unloaded deck costs ~nothing.
    this.b = new Project(audio, clock, { trackCount: 0 });

    this.active = 'A';        // which deck the editing UI controls
    this.crossfade = 0;       // 0 = full A, 1 = full B
    this._silenced = { A: false, B: false };
    this._loaded   = { A: true, B: false };  // A boots with the user's song
    this._name     = { A: null, B: null };   // loaded filename per deck (A may have none)

    this._listeners = new Map();

    this._applyGains();
  }

  // ── Deck access ─────────────────────────────────────────────
  /** @param {'A'|'B'} id */
  deck(id) { return id === 'A' ? this.a : this.b; }

  get activeProject() { return this.deck(this.active); }

  /** @param {'A'|'B'} id */
  isLoaded(id) { return !!this._loaded[id]; }

  /** Is this deck currently passing audible level (loaded, not silenced, fader open)? */
  isAudible(id) {
    if (!this._loaded[id] || this._silenced[id]) return false;
    return this._faderGain(id) > 0.001;
  }

  // ── Crossfader (constant-power) ─────────────────────────────
  /** @param {'A'|'B'} id — fader-only gain (ignores silence) */
  _faderGain(id) {
    const x = this.crossfade;
    return id === 'A' ? Math.cos(x * Math.PI / 2) : Math.sin(x * Math.PI / 2);
  }

  _applyGains() {
    const t = this.audio.context.currentTime;
    ['A', 'B'].forEach(id => {
      const g = this._silenced[id] ? 0 : this._faderGain(id);
      this.deck(id).busGain.gain.setTargetAtTime(g, t, 0.012);
    });
  }

  /** @param {number} x — 0..1 */
  setCrossfade(x) {
    this.crossfade = Math.max(0, Math.min(1, x));
    this._applyGains();
    this.emit('crossfadeChanged', { crossfade: this.crossfade });
  }

  // ── Per-deck silence ────────────────────────────────────────
  /** @param {'A'|'B'} id @param {boolean} on */
  setSilenced(id, on) {
    this._silenced[id] = !!on;
    this._applyGains();
    this.emit('deckChanged', { id });
  }

  /** @param {'A'|'B'} id */
  isSilenced(id) { return !!this._silenced[id]; }

  // ── Control (which deck the UI edits) ───────────────────────
  /** @param {'A'|'B'} id */
  setControl(id) {
    if (id !== 'A' && id !== 'B') return;
    if (this.active === id) return;
    // Never hand control to an empty (unloaded, 0-track) deck — the editing UI
    // would have nothing to point at. Load a song into it first.
    if (!this._loaded[id]) return false;
    this.active = id;
    this.emit('controlChanged', { active: id });
    return true;
  }

  // ── Load / unload ───────────────────────────────────────────
  /**
   * Load a song file into a deck (beatmatched to the shared clock). Does not
   * move the fader — the new song plays silently until faded toward.
   * @param {'A'|'B'} id @param {File} file
   */
  async loadFile(id, file) {
    await this.deck(id).loadDeckFile(file);
    this._loaded[id] = true;
    this._name[id]   = file?.name ?? null;
    this.emit('deckChanged', { id });
  }

  /** Loaded filename for a deck, or null. @param {'A'|'B'} id */
  name(id) { return this._name[id]; }

  /** Set the displayed filename for a deck (used by the IMPORT path). */
  setName(id, name) {
    this._name[id] = name ?? null;
    this.emit('deckChanged', { id });
  }

  /**
   * Unload a deck: tear it out of the graph, reset to blank, free CPU. If the
   * unloaded deck currently has UI control, control switches to the other deck.
   * @param {'A'|'B'} id
   */
  unload(id) {
    const other = id === 'A' ? 'B' : 'A';
    // Refuse to unload the last loaded deck — there'd be nothing to control/edit.
    if (!this._loaded[other]) return false;
    // Switch control to the surviving deck *before* tearing this one down, so the
    // UI never points at an empty (0-track) deck.
    if (this.active === id) this.setControl(other);
    this.deck(id).reset();
    this._loaded[id] = false;
    this._silenced[id] = false;
    this._name[id] = null;
    this._applyGains();
    this.emit('deckChanged', { id });
    return true;
  }

  // ── Shared transport ────────────────────────────────────────
  startAll() {
    this.a.start();
    // start() on a Project also (re)starts the clock; start B's sequencers too.
    this.b.tracks.forEach(t => t.sequencer.start());
  }

  stopAll() {
    this.a.stop();
    this.b.tracks.forEach(t => t.sequencer.stop());
  }

  /** Hard panic: stop transport + kill all sound on both decks. */
  silenceAll() {
    this.a.silence();
    const t = this.audio.context.currentTime;
    this.b.tracks.forEach(track => track.silence(t));
  }

  /** @param {import('../core/MidiEngine.js').MidiEngine} engine */
  setMidiEngine(engine) {
    this.a.setMidiEngine(engine);
    this.b.setMidiEngine(engine);
  }

  /** @param {number} bpm — apply to both decks (shared clock). */
  setBPM(bpm) {
    this.a.setBPM(bpm);
    // a.setBPM already set the clock; mirror per-track BPM onto deck B.
    this.b.tracks.forEach(t => t.onBpmChanged(this.clock.bpm));
  }

  // ── Tiny event bus ──────────────────────────────────────────
  on(event, cb)  { (this._listeners.get(event) ?? this._listeners.set(event, new Set()).get(event)).add(cb); }
  off(event, cb) { this._listeners.get(event)?.delete(cb); }
  emit(event, data) { this._listeners.get(event)?.forEach(cb => cb(data)); }
}
