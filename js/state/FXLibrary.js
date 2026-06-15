/**
 * FXLibrary.js
 * ------------
 * A persistent, track-agnostic library of FX-pipeline presets. Each preset is
 * the FX subset of a track — the four base-block param sets, the chain order,
 * and any added FX instances (see Track.exportFXPreset / applyFXPreset).
 *
 * Presets are GLOBAL: saved from any track, loadable onto any track. They live
 * in localStorage under 'webtakt_fx_presets'. There are no factory presets —
 * unlike SoundLibrary, this store is localStorage-only.
 *
 * A preset deliberately captures ONLY the FX chain: not the machine, filter,
 * envelope, or LFOs. (Saved sounds already carry the full FX chain too, so
 * folding an FX setup into a sound is the other half of "presets" — that path
 * lives in SoundLibrary.)
 */

const STORAGE_KEY = 'webtakt_fx_presets';

export class FXLibrary {
  constructor() {
    this._presets = this._load();
  }

  /** @returns {Array<{id:string,name:string,tags:string[],createdAt:number,fx:object}>} */
  get presets() { return this._presets; }

  /** All unique tags across all saved presets, sorted. */
  allTags() {
    const set = new Set();
    this._presets.forEach(p => (p.tags ?? []).forEach(t => set.add(t)));
    return [...set].sort();
  }

  /**
   * Save a track's current FX pipeline as a named, tagged preset (newest first).
   * @param {string} name
   * @param {string[]} tags
   * @param {import('./Track.js').Track} track
   * @returns {object} the saved preset
   */
  save(name, tags, track) {
    const preset = {
      id:        Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name:      (name ?? '').trim() || 'Untitled',
      tags:      (tags ?? []).map(t => t.trim()).filter(Boolean),
      createdAt: Date.now(),
      fx:        track.exportFXPreset(),
    };
    this._presets.unshift(preset);
    this._persist();
    return preset;
  }

  /**
   * Apply a preset's FX pipeline onto a track (replaces the current chain).
   * @param {string} id
   * @param {import('./Track.js').Track} track
   */
  load(id, track) {
    const preset = this._presets.find(p => p.id === id);
    if (!preset) return;
    track.applyFXPreset(preset.fx);
  }

  /** @param {string} id */
  delete(id) {
    this._presets = this._presets.filter(p => p.id !== id);
    this._persist();
  }

  /** Rename a preset in place. */
  rename(id, newName) {
    const p = this._presets.find(p => p.id === id);
    if (p) { p.name = (newName ?? '').trim() || p.name; this._persist(); }
  }

  /** Replace a preset's tags. */
  setTags(id, tags) {
    const p = this._presets.find(p => p.id === id);
    if (p) { p.tags = (tags ?? []).map(t => t.trim()).filter(Boolean); this._persist(); }
  }

  // ── Persistence ────────────────────────────────────────────

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      // Migrate presets saved before tags existed.
      list.forEach(p => { if (!Array.isArray(p.tags)) p.tags = []; });
      return list;
    } catch (err) {
      console.warn('[FXLibrary] failed to read presets:', err.message);
      return [];
    }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._presets));
    } catch (err) {
      console.warn('[FXLibrary] failed to persist presets:', err.message);
    }
  }
}
