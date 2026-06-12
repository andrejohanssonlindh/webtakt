/**
 * SoundLibrary.js
 * ---------------
 * Manages a persistent library of saved sounds (machine + signal chain snapshots).
 * Each sound captures: name, tags, machine, filter, envelope, FX chain, LFOs, pan, trigTone.
 *
 * Two sources, one list:
 *   - User-saved sounds live in localStorage under 'webtakt_sounds'.
 *   - Factory sounds ship as individual files in sounds/ and are pulled in by
 *     init() (async): sounds/index.json lists the files, each is one Sound JSON.
 *     A factory sound is merged only if its id is not already present, so a
 *     user's edited/renamed copy in localStorage always wins. The browser can't
 *     list a directory, hence the index.json manifest. Regenerate the files via
 *     tools/bake_sounds.py.
 *
 * Does NOT capture sequencer data (steps, step count, page offset).
 */

const STORAGE_KEY = 'webtakt_sounds';
const SOUNDS_DIR  = 'sounds';

export class SoundLibrary {
  constructor() {
    this._sounds = this._load();
  }

  /**
   * Pull factory sounds from the sounds/ folder and merge them in (by id, so a
   * user copy in localStorage wins). Async because it fetches files. Safe to
   * call once at startup; tolerant of fetch failure (e.g. opened via file://) —
   * on error it leaves the localStorage-only list intact.
   * @returns {Promise<boolean>} true if any factory sound was added
   */
  async init() {
    let manifest;
    try {
      const res = await fetch(`${SOUNDS_DIR}/index.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      console.warn('[SoundLibrary] factory sounds unavailable — using localStorage only:', err.message);
      return false;
    }

    const existingIds = new Set(this._sounds.map(s => s.id));
    const loaded = await Promise.all((manifest ?? []).map(async file => {
      try {
        const res = await fetch(`${SOUNDS_DIR}/${file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        console.warn(`[SoundLibrary] failed to load ${file}:`, err.message);
        return null;
      }
    }));

    let added = 0;
    // Preserve manifest order: factory sounds appear after any user sounds.
    // NOT persisted to localStorage — they are re-fetched every load, so preset
    // fixes ship without going stale in the user's storage. localStorage holds
    // only genuinely user-saved sounds. Flagged `factory: true` so the UI can
    // tell them apart (e.g. block delete of a shipped sound).
    loaded.forEach(sound => {
      if (!sound || existingIds.has(sound.id)) return;
      existingIds.add(sound.id);
      sound.factory  = true;
      if (sound.createdAt == null) sound.createdAt = 0;
      this._sounds.push(sound);
      added++;
    });

    return added > 0;
  }

  /** @returns {Sound[]} */
  get sounds() { return this._sounds; }

  /** All unique tags across all saved sounds. */
  allTags() {
    const set = new Set();
    this._sounds.forEach(s => s.tags.forEach(t => set.add(t)));
    return [...set].sort();
  }

  /**
   * Save current track state as a named sound.
   * @param {string} name
   * @param {string[]} tags
   * @param {import('./Track.js').Track} track
   * @returns {Sound} the saved sound
   */
  save(name, tags, track) {
    const json = track.toJSON();
    const sound = {
      id:          Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name:        name.trim() || 'Untitled',
      tags:        tags.map(t => t.trim()).filter(Boolean),
      createdAt:   Date.now(),
      // Capture voice + signal chain — NOT sequencer
      machine:     json.machine,
      filter:      json.filter,
      envelope:    json.envelope,
      delayFX:     json.delayFX,
      bitcrushFX:  json.bitcrushFX,
      chorusFX:    json.chorusFX,
      reverbFX:    json.reverbFX,
      analogue:    json.analogue,
      lfos:        json.lfos,
      pan:         json.pan,
      trigTone:    json.trigTone,
    };
    this._sounds.unshift(sound);
    this._persist();
    return sound;
  }

  /**
   * Load a sound onto a track. Restores machine + signal chain, leaves sequencer intact.
   * @param {string} id
   * @param {import('./Track.js').Track} track
   */
  load(id, track) {
    const sound = this._sounds.find(s => s.id === id);
    if (!sound) return;

    if (sound.machine?.type) track.setMachine(sound.machine.type);
    track.loadedSoundName = sound.name;
    track.machine.fromJSON(sound.machine ?? {});
    track.filter.fromJSON(sound.filter ?? {});
    track.envelope.fromJSON(sound.envelope ?? {});
    track.delayFX.fromJSON(sound.delayFX ?? {});
    track.bitcrushFX.fromJSON(sound.bitcrushFX ?? {});
    track.chorusFX.fromJSON(sound.chorusFX ?? {});
    track.reverbFX.fromJSON(sound.reverbFX ?? {});
    // Analogue flow: derive from the saved flag, or fall back to the restored
    // filter engine for sounds saved before the flag existed. setAnalogue keeps
    // the chorus enable + filter engine consistent.
    track.setAnalogue(sound.analogue ?? (track.filter.getParam('filter.engine') === 'analogue'));
    // Restore sampler buffer via SampleStore if present on the track
    if (track.machine.type === 'sampler' && track.machine.sampleId && track.sampleStore) {
      track.sampleStore.load(track.machine.sampleId, track.audio.context).then(buf => {
        if (buf) track.machine.setBuffer(buf, track.machine.sampleId, track.machine.sampleName);
      });
    }
    if (track.machine.type === 'wt-sampler' && track.sampleStore) {
      if (track.machine.sampleIdA) {
        track.sampleStore.load(track.machine.sampleIdA, track.audio.context).then(buf => {
          if (buf) track.machine.setBufferA(buf, track.machine.sampleIdA, track.machine.sampleNameA);
        });
      }
      if (track.machine.sampleIdB) {
        track.sampleStore.load(track.machine.sampleIdB, track.audio.context).then(buf => {
          if (buf) track.machine.setBufferB(buf, track.machine.sampleIdB, track.machine.sampleNameB);
        });
      }
    }

    // Restore pan
    track.pannerNode.pan.setTargetAtTime(sound.pan ?? 0, track.audio.context.currentTime, 0.005);
    track.trigTone = sound.trigTone ?? 0;

    // Restore LFOs
    track.lfos.forEach(l => l.stop());
    track.lfos = [];
    track._lfoDestPaths = [];
    (sound.lfos ?? []).forEach(lfoObj => {
      const lfo = track.addLFO();
      lfo.fromJSON(lfoObj);
      if (lfoObj.destPath) track.setLFODestination(track.lfos.length - 1, lfoObj.destPath);
    });
  }

  /** @param {string} id */
  delete(id) {
    this._sounds = this._sounds.filter(s => s.id !== id);
    this._persist();
  }

  /** Rename a sound in place. */
  rename(id, newName) {
    const s = this._sounds.find(s => s.id === id);
    if (s) { s.name = newName.trim() || s.name; this._persist(); }
  }

  /** Update tags for a sound. */
  setTags(id, tags) {
    const s = this._sounds.find(s => s.id === id);
    if (s) { s.tags = tags.map(t => t.trim()).filter(Boolean); this._persist(); }
  }

  _persist() {
    // Only user sounds go to localStorage; factory sounds are re-fetched from
    // sounds/ each load (see init()), so never write them back.
    try {
      const userSounds = this._sounds.filter(s => !s.factory);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userSounds));
    } catch {}
  }

  _load() {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      // Migration: older builds persisted factory seeds (id 'seed_*') into
      // localStorage. Drop them so the current sounds/ files take over and
      // preset fixes aren't shadowed by a stale baked-in copy.
      return all.filter(s => !(typeof s.id === 'string' && s.id.startsWith('seed_')));
    } catch { return []; }
  }
}
