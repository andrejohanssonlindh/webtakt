/**
 * SoundLibraryPanel.js
 * --------------------
 * Renders the SOUNDS tab content in SynthPanel.
 *
 * Layout (top→bottom):
 *   [SAVE SOUND button]
 *   [filter chips: ALL + one per tag + + ADD TAG]
 *   [scrollable list of sound cards]
 *
 * Called by SynthPanel._renderSounds(track).
 */

import { bufferToWav } from '../../state/SampleStore.js';

export class SoundLibraryPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../../state/SoundLibrary.js').SoundLibrary} library
   * @param {import('../../state/AppState.js').AppState} state
   * @param {Function} openModal   — (msg, defaultVal, onConfirm) for single-input prompt
   * @param {Function} onLoad      — () called after loading a sound (to re-render panel)
   * @param {Function} onPreview   — (soundId) play a one-shot preview of the sound
   */
  constructor(container, library, state, openModal, onLoad, onPreview) {
    this.container = container;
    this.library   = library;
    this.state     = state;
    this.openModal = openModal;
    this.onLoad    = onLoad;
    this.onPreview = onPreview;

    this._activeTag = null; // null = ALL
    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'sl-wrap';

    // ── Top bar: Save button ──────────────────────────────
    const topBar = document.createElement('div');
    topBar.className = 'sl-topbar';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn sl-save-btn';
    saveBtn.textContent = '+ SAVE SOUND';
    saveBtn.addEventListener('click', () => this._startSave());
    topBar.appendChild(saveBtn);

    wrap.appendChild(topBar);

    // ── Tag filter chips ──────────────────────────────────
    const chipBar = document.createElement('div');
    chipBar.className = 'sl-chips';

    const allChip = this._makeChip('ALL', this._activeTag === null, () => {
      this._activeTag = null;
      this._render();
    });
    chipBar.appendChild(allChip);

    this.library.allTags().forEach(tag => {
      const chip = this._makeChip(tag, this._activeTag === tag, () => {
        this._activeTag = tag;
        this._render();
      });
      chipBar.appendChild(chip);
    });

    const addTagBtn = document.createElement('button');
    addTagBtn.className = 'sl-chip sl-chip-add';
    addTagBtn.textContent = '+ TAG';
    addTagBtn.addEventListener('click', () => this._addTag());
    chipBar.appendChild(addTagBtn);

    wrap.appendChild(chipBar);

    // ── Sound list ────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'sl-list';

    const sounds = this._activeTag === null
      ? this.library.sounds
      : this.library.sounds.filter(s => s.tags.includes(this._activeTag));

    if (sounds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sl-empty';
      empty.textContent = this._activeTag === null
        ? 'No sounds saved yet. Hit + SAVE SOUND to save the current track.'
        : `No sounds tagged "${this._activeTag}".`;
      list.appendChild(empty);
    } else {
      sounds.forEach(sound => list.appendChild(this._makeCard(sound)));
    }

    wrap.appendChild(list);
    this.container.appendChild(wrap);
  }

  _makeChip(label, active, onClick) {
    const chip = document.createElement('button');
    chip.className = 'sl-chip' + (active ? ' sl-chip-active' : '');
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  }

  _makeCard(sound) {
    const card = document.createElement('div');
    card.className = 'sl-card';

    // Left: name + tags
    const info = document.createElement('div');
    info.className = 'sl-card-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'sl-card-name';
    nameEl.textContent = sound.name;
    info.appendChild(nameEl);

    if (sound.tags.length) {
      const tagsEl = document.createElement('span');
      tagsEl.className = 'sl-card-tags';
      tagsEl.textContent = sound.tags.join(' · ');
      info.appendChild(tagsEl);
    }

    // Machine type badge
    const badge = document.createElement('span');
    badge.className = 'sl-card-badge';
    badge.textContent = sound.machine?.type ?? 'synth';
    info.appendChild(badge);

    card.appendChild(info);

    // Right: action buttons
    const actions = document.createElement('div');
    actions.className = 'sl-card-actions';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn sl-card-btn sl-card-btn-preview';
    previewBtn.textContent = '▶';
    previewBtn.title = 'Preview sound (C4)';
    previewBtn.addEventListener('click', () => this.onPreview?.(sound.id));

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn sl-card-btn';
    loadBtn.textContent = 'LOAD';
    loadBtn.addEventListener('click', () => {
      const track = this.state.selectedTrack;
      if (!track) return;
      this.library.load(sound.id, track);
      this.onLoad();
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn sl-card-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit name / tags';
    editBtn.addEventListener('click', () => this._editSound(sound));

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn sl-card-btn';
    exportBtn.textContent = '⤓';
    exportBtn.title = 'Export to file (sounds/ + samples/)';
    exportBtn.addEventListener('click', () => this._exportSound(sound));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn sl-card-btn sl-card-btn-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete sound';
    delBtn.addEventListener('click', () => {
      this.library.delete(sound.id);
      this._render();
    });

    actions.appendChild(previewBtn);
    actions.appendChild(loadBtn);
    actions.appendChild(editBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    return card;
  }

  /**
   * Export a sound to committable files: a sounds/<slug>.json plus a
   * samples/<id>.wav for every sample the sound references. Drop the .json into
   * sounds/, add its filename to sounds/index.json, drop any .wav into samples/,
   * and commit — it then loads as a factory sound. Reuses the project-export
   * Blob download pattern.
   */
  async _exportSound(sound) {
    // Collect referenced sample ids from the machine (sampler / wt-sampler).
    const m = sound.machine ?? {};
    const sampleIds = [m.sampleId, m.sampleIdA, m.sampleIdB].filter(Boolean);

    // Build the file payload: strip runtime-only fields, record sample filenames.
    const { factory, createdAt, ...rest } = sound;
    const payload = { ...rest };
    if (sampleIds.length) payload.samples = sampleIds.map(id => `${id}.wav`);

    const slug = (sound.name || 'sound').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
    _download(`${slug}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));

    // Export each referenced sample as a real .wav (named by its id, matching
    // the samples/<id>.wav path the loader fetches).
    const sampleStore = this.state.project?.sampleStore;
    const audioCtx    = this.state.project?.audio?.context;
    for (const id of sampleIds) {
      if (!sampleStore || !audioCtx) break;
      const buf = await sampleStore.load(id, audioCtx);
      if (buf) _download(`${id}.wav`, new Blob([bufferToWav(buf)], { type: 'audio/wav' }));
    }
  }

  _startSave() {
    // Step 1: ask for name
    this.openModal('Sound name:', 'New Sound', name => {
      if (!name) return;
      // Step 2: ask for tags (comma-separated)
      this.openModal('Tags (comma-separated):', '', tagStr => {
        const tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);
        const track = this.state.selectedTrack;
        if (!track) return;
        this.library.save(name, tags, track);
        this._activeTag = null;
        this._render();
      });
    });
  }

  _editSound(sound) {
    // Edit name
    this.openModal('Rename sound:', sound.name, newName => {
      if (newName) this.library.rename(sound.id, newName);
      // Edit tags
      this.openModal('Tags (comma-separated):', sound.tags.join(', '), tagStr => {
        const tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);
        this.library.setTags(sound.id, tags);
        this._render();
      });
    });
  }

  _addTag() {
    // Adding a tag creates a new category; it becomes usable when a sound is tagged with it.
    // For discoverability, we allow filtering by any tag that exists, so we just prompt.
    this.openModal('New tag name:', '', tag => {
      if (!tag.trim()) return;
      // Tag is created by saving it on the first sound via edit — for now,
      // just switch the active filter to the new tag so it's visible on next save.
      this._activeTag = tag.trim();
      this._render();
    });
  }
}

/** Trigger a browser download of a Blob under the given filename. */
function _download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
