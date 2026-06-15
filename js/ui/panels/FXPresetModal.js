/**
 * FXPresetModal.js
 * ----------------
 * A SOUNDS-window-style overlay for managing FX-pipeline presets (FXLibrary).
 * Opened from the FX pane's LOAD button — replaces the old cramped inline picker
 * that broke down past ~8 presets.
 *
 * Layout (top→bottom):
 *   ┌──────────────────────────────────────────────┐
 *   │ FX PRESETS                               [✕]  │  head
 *   │ [▶ PLAY DRY]   ← non-scrollable audition bar  │  audit dry (no FX)
 *   │ [ ALL | tag | tag | + TAG ]                   │  tag filter chips
 *   ├──────────────────────────────────────────────┤
 *   │  card: name · tags    [▶][APPLY][✎][✕]        │  scrollable list
 *   │  …                                            │
 *   └──────────────────────────────────────────────┘
 *
 * ▶ on a card **auditions** that pipeline on the current track's machine (a
 * one-shot C4, then restores); APPLY commits it. ▶ PLAY DRY auditions the dry
 * signal so you can A/B dry vs a pipeline vs dry again without committing.
 *
 * Self-contained like ManualOverlay: builds its own DOM on demand, Esc / click-
 * outside to close. One instance, reused; `.open()` re-renders and reveals it.
 */

export class FXPresetModal {
  /**
   * @param {import('../../state/AppState.js').AppState} state
   * @param {import('../../state/FXLibrary.js').FXLibrary} fxLibrary
   * @param {Function} openModal — (msg, defaultVal, onConfirm) single-input prompt
   * @param {Function} onApply   — called after a preset is applied (re-render host)
   */
  constructor(state, fxLibrary, openModal, onApply) {
    this.state     = state;
    this.fxLibrary = fxLibrary;
    this.openModal = openModal;
    this.onApply   = onApply;
    this._activeTag = null;            // null = ALL
    this._el = null;
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  open() {
    if (!this._el) this._build();
    this._render();
    this._el.style.display = 'flex';
    document.addEventListener('keydown', this._onKey);
  }

  close() {
    if (!this._el) return;
    this._el.style.display = 'none';
    document.removeEventListener('keydown', this._onKey);
  }

  isOpen() { return !!this._el && this._el.style.display === 'flex'; }

  _build() {
    const overlay = document.createElement('div');
    overlay.className = 'fxpreset-overlay';
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();   // click outside the box closes
    });
    const box = document.createElement('div');
    box.className = 'fxpreset-box';
    overlay.appendChild(box);
    this._box = box;
    this._el  = overlay;
    document.body.appendChild(overlay);
  }

  _render() {
    const box = this._box;
    box.innerHTML = '';

    // ── Head: title + close ───────────────────────────────
    const head = document.createElement('div');
    head.className = 'fxpreset-head';
    const title = document.createElement('div');
    title.className = 'fxpreset-title';
    title.textContent = 'FX PRESETS';
    head.appendChild(title);
    const close = document.createElement('button');
    close.className = 'fxpreset-close';
    close.textContent = '✕';
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    box.appendChild(head);

    // ── Non-scrollable audition bar: PLAY DRY ─────────────
    const auditBar = document.createElement('div');
    auditBar.className = 'fxpreset-audit';
    const dryBtn = document.createElement('button');
    dryBtn.className = 'btn fxpreset-dry-btn';
    dryBtn.textContent = '▶ PLAY DRY';
    dryBtn.title = 'Play the current track\'s sound with NO effects (A/B against a pipeline)';
    dryBtn.addEventListener('click', () => {
      this.state.selectedTrack?.auditionFXPreset(null, { dry: true });
    });
    auditBar.appendChild(dryBtn);
    const hint = document.createElement('span');
    hint.className = 'fxpreset-audit-hint';
    hint.textContent = '▶ on a preset auditions it; APPLY commits it to the track.';
    auditBar.appendChild(hint);
    box.appendChild(auditBar);

    // ── Tag filter chips ──────────────────────────────────
    const chips = document.createElement('div');
    chips.className = 'fxpreset-chips';
    chips.appendChild(this._chip('ALL', this._activeTag === null, () => {
      this._activeTag = null; this._render();
    }));
    this.fxLibrary.allTags().forEach(tag => {
      chips.appendChild(this._chip(tag, this._activeTag === tag, () => {
        this._activeTag = tag; this._render();
      }));
    });
    box.appendChild(chips);

    // ── Preset list ───────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'fxpreset-list';
    const presets = this._activeTag === null
      ? this.fxLibrary.presets
      : this.fxLibrary.presets.filter(p => (p.tags ?? []).includes(this._activeTag));

    if (presets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fxpreset-empty';
      empty.textContent = this._activeTag === null
        ? 'No FX presets saved yet. Use SAVE in the FX pane to store a pipeline.'
        : `No presets tagged "${this._activeTag}".`;
      list.appendChild(empty);
    } else {
      presets.forEach(p => list.appendChild(this._card(p)));
    }
    box.appendChild(list);
  }

  _chip(label, active, onClick) {
    const chip = document.createElement('button');
    chip.className = 'fxpreset-chip' + (active ? ' fxpreset-chip-active' : '');
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  }

  _card(preset) {
    const card = document.createElement('div');
    card.className = 'fxpreset-card';

    const info = document.createElement('div');
    info.className = 'fxpreset-card-info';
    const name = document.createElement('span');
    name.className = 'fxpreset-card-name';
    name.textContent = preset.name;
    info.appendChild(name);
    if ((preset.tags ?? []).length) {
      const tags = document.createElement('span');
      tags.className = 'fxpreset-card-tags';
      tags.textContent = preset.tags.join(' · ');
      info.appendChild(tags);
    }
    // Block-count badge — a quick sense of the chain size.
    const badge = document.createElement('span');
    badge.className = 'fxpreset-card-badge';
    const n = (preset.fx?.fxOrder ?? []).length;
    badge.textContent = `${n} fx`;
    info.appendChild(badge);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'fxpreset-card-actions';

    const auditBtn = document.createElement('button');
    auditBtn.className = 'btn fxpreset-card-btn fxpreset-card-btn-audit';
    auditBtn.textContent = '▶';
    auditBtn.title = 'Audition this pipeline (one-shot, then restores)';
    auditBtn.addEventListener('click', () => {
      this.state.selectedTrack?.auditionFXPreset(preset.fx);
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn fxpreset-card-btn';
    applyBtn.textContent = 'APPLY';
    applyBtn.title = 'Load this pipeline onto the current track';
    applyBtn.addEventListener('click', () => {
      const track = this.state.selectedTrack;
      if (!track) return;
      this.fxLibrary.load(preset.id, track);
      this.close();
      this.onApply?.();
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn fxpreset-card-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit name / tags';
    editBtn.addEventListener('click', () => this._edit(preset));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn fxpreset-card-btn fxpreset-card-btn-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete preset';
    delBtn.addEventListener('click', () => {
      this.fxLibrary.delete(preset.id);
      this._render();
    });

    actions.appendChild(auditBtn);
    actions.appendChild(applyBtn);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    return card;
  }

  _edit(preset) {
    this.openModal('Rename FX preset:', preset.name, (newName) => {
      if (newName) this.fxLibrary.rename(preset.id, newName);
      this.openModal('Tags (comma-separated):', (preset.tags ?? []).join(', '), (tagStr) => {
        const tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);
        this.fxLibrary.setTags(preset.id, tags);
        this._render();
      });
    });
  }
}
