/**
 * FXPipelinePanel.js
 * ------------------
 * The FX pipeline customizer tab. Reorder the per-track FX chain by dragging
 * blocks along a snaking signal path, toggle each block on/off, ADD extra FX
 * instances (incl. new types: distortion / compressor / phaser / filter), and
 * remove added instances. The chain is owned by Track (getFXOrder/setFXOrder/
 * addFX/removeFX); this panel is a view + the param editor for added/new blocks.
 *
 * Layout:
 *   ┌─────────────┬──────────────────────────────────────┐
 *   │  LEFT TRAY  │  SNAKING SIGNAL PATH (INPUT → OUTPUT) │
 *   │  • Add FX ▾ │  [INPUT]→[FX]→[FX]→ … →[OUTPUT]       │
 *   │  • Load     ├──────────────────────────────────────┤
 *   │  • Save     │  selected block's params (knob row)   │
 *   └─────────────┴──────────────────────────────────────┘
 *
 * The path ALWAYS shows the full chain in order (every FX stays wired — see
 * Track._rewireFXChain). A block's ON/OFF is its `enabled` flag (audible bypass
 * without unplugging); bypassed blocks render dimmed. Drag a block onto another
 * to place it before that one, or onto empty path space to move it last.
 *
 * EVERY block (base four + added instances) is edited INLINE below the path via
 * the generic FXPanel — clicking a tile selects it. The base four's old
 * dedicated header tabs were removed; this pane is now their only editor.
 *
 * LOAD / SAVE manage global FX-pipeline presets (FXLibrary, localStorage). SAVE
 * names + tags the current chain; LOAD opens the FX-preset manager popup
 * (FXPresetModal — audition dry vs a pipeline, apply, edit, delete).
 */

import { FXPanel } from './FXPanel.js';
import { FXPresetModal } from './FXPresetModal.js';
import { FX_TYPE_LABELS } from '../../state/Track.js';

// Per-type display glyph. Shared with the header chain mini-outline (SynthPanel).
export const TYPE_GLYPH = {
  delay: '⟳', crush: '▦', chorus: '≈', reverb: '◊',
  distortion: '◢', compressor: '◧', phaser: '∿', filter: '⏚',
  normalizer: '⊿',
};

export class FXPipelinePanel {
  // Selected block id is stored on `state` (this panel is recreated on every
  // re-render, so instance fields wouldn't survive). Accessors keep call sites
  // terse.
  get _selectedId()   { return this._ctx.state.fxSelectedBlockId; }
  set _selectedId(id) { this._ctx.state.fxSelectedBlockId = id; }

  render(ctx) {
    const { container, track } = ctx;
    if (!track) return;

    this._ctx   = ctx;
    this._track = track;
    this._renderContent = ctx.renderContent;

    const wrap = document.createElement('div');
    wrap.className = 'fxpipe-wrap';
    wrap.appendChild(this._renderTray());

    // Right column: path on top, inline param editor below.
    const right = document.createElement('div');
    right.className = 'fxpipe-right';

    const path = document.createElement('div');
    path.className = 'fxpipe-path';
    this._renderPath(path);
    right.appendChild(path);

    this._paramArea = document.createElement('div');
    this._paramArea.className = 'fxpipe-params';
    right.appendChild(this._paramArea);
    this._renderParamArea();

    wrap.appendChild(right);
    container.appendChild(wrap);
  }

  // ── Left tray ──────────────────────────────────────────────

  _renderTray() {
    const tray = document.createElement('div');
    tray.className = 'fxpipe-tray';

    // Add-FX dropdown.
    const addWrap = document.createElement('div');
    addWrap.className = 'fxpipe-add';
    const addBtn = document.createElement('button');
    addBtn.className = 'fxpipe-tray-btn fxpipe-add-btn';
    addBtn.textContent = '+ ADD FX';
    const menu = document.createElement('div');
    menu.className = 'fxpipe-add-menu hidden';

    // Detached base blocks (dragged out of the chain) re-join with their original
    // id + existing params; everything else spawns a fresh added instance.
    const detached = new Set(this._track.getDetachedBaseIds());
    detached.forEach((id) => {
      const type = this._track.getFXType(id);
      const item = document.createElement('button');
      item.className = 'fxpipe-add-item fxpipe-add-item-restore';
      item.textContent = `${TYPE_GLYPH[type] ?? ''} ${FX_TYPE_LABELS[type] ?? type} (re-add)`.trim();
      item.addEventListener('click', () => {
        this._track.reattachBaseFX(id);
        menu.classList.add('hidden');
        this._selectedId = id;
        this._renderContent();
      });
      menu.appendChild(item);
    });

    Object.entries(FX_TYPE_LABELS).forEach(([type, label]) => {
      const item = document.createElement('button');
      item.className = 'fxpipe-add-item';
      item.textContent = `${TYPE_GLYPH[type] ?? ''} ${label}`.trim();
      item.addEventListener('click', () => {
        const id = this._track.addFX(type);
        menu.classList.add('hidden');
        if (id) this._selectedId = id;     // select the new block for editing
        this._renderContent();
      });
      menu.appendChild(item);
    });
    addBtn.addEventListener('click', () => menu.classList.toggle('hidden'));
    addWrap.appendChild(addBtn);
    addWrap.appendChild(menu);
    tray.appendChild(addWrap);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'fxpipe-tray-btn';
    loadBtn.textContent = 'LOAD';
    loadBtn.title = 'Browse, audition, and apply saved FX pipeline presets';
    loadBtn.addEventListener('click', () => this._openPresetManager());
    tray.appendChild(loadBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'fxpipe-tray-btn';
    saveBtn.textContent = 'SAVE';
    saveBtn.title = 'Save the current FX pipeline as a preset';
    saveBtn.addEventListener('click', () => this._savePreset());
    tray.appendChild(saveBtn);

    // Bin: drag a block here to remove it from the chain. Added instances are
    // deleted; base blocks are detached (re-addable from + ADD FX).
    tray.appendChild(this._renderBin());

    return tray;
  }

  /**
   * The bin — a drop target under SAVE. Dragging an FX block onto it removes the
   * block from the chain (Track.removeFX: deletes added instances, detaches base
   * blocks so they can be re-added). Highlights while a block hovers over it.
   */
  _renderBin() {
    const bin = document.createElement('div');
    bin.className = 'fxpipe-bin';
    bin.innerHTML = '<span class="fxpipe-bin-icon">🗑</span><span class="fxpipe-bin-label">DROP TO REMOVE</span>';

    bin.addEventListener('dragover', (e) => {
      // Only react to FX-block drags (not preset/file drags).
      if (![...e.dataTransfer.types].includes('text/fxid')) return;
      e.preventDefault();
      bin.classList.add('over');
    });
    bin.addEventListener('dragleave', () => bin.classList.remove('over'));
    bin.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bin.classList.remove('over');
      const id = e.dataTransfer.getData('text/fxid');
      if (!id) return;
      if (this._selectedId === id) this._selectedId = null;
      this._track.removeFX(id);
      this._syncFXBar();          // chain shape changed → refresh header outline
      this._renderContent();
    });
    return bin;
  }

  // ── Presets (FXLibrary) ────────────────────────────────────

  /** Prompt for a name then tags, and store the current chain as a global FX preset. */
  _savePreset() {
    const lib = this._ctx.fxLibrary;
    if (!lib || !this._ctx.openModal) return;
    this._ctx.openModal('FX preset name:', 'New FX', (name) => {
      if (name == null || !name.trim()) return;
      this._ctx.openModal('Tags (comma-separated):', '', (tagStr) => {
        const tags = (tagStr ?? '').split(',').map(t => t.trim()).filter(Boolean);
        lib.save(name, tags, this._track);
      });
    });
  }

  /** Open the FX-preset manager popup (browse / audition / apply / edit). */
  _openPresetManager() {
    const lib   = this._ctx.fxLibrary;
    const state = this._ctx.state;
    if (!lib || !this._ctx.openModal) return;
    // The panel is rebuilt on every _renderContent, so the single modal instance
    // lives on `state` (one overlay in the DOM, reused; preserves its tag filter).
    if (!state._fxPresetModal) {
      state._fxPresetModal = new FXPresetModal(state, lib, this._ctx.openModal, null);
    }
    const modal = state._fxPresetModal;
    // Rebind onApply each open — it closes over THIS panel's renderContent.
    modal.onApply = () => {
      this._selectedId = null;         // chain replaced; clear inline selection
      this._syncFXBar();               // base-four enable flags may have changed
      this._renderContent();
    };
    modal.open();
  }

  // ── Signal path ────────────────────────────────────────────

  /**
   * Build the snaking row: INPUT → [all blocks in order] → OUTPUT. CSS
   * `flex-wrap` makes it snake as tiles wrap. Bypassed blocks render dimmed but
   * stay on the path and remain reorderable.
   */
  _renderPath(path) {
    const track = this._track;

    path.appendChild(this._terminal('INPUT'));
    track.getFXOrder().forEach((id) => {
      path.appendChild(this._arrow());
      path.appendChild(this._block(id));
    });
    path.appendChild(this._arrow());
    path.appendChild(this._terminal('OUTPUT'));

    // Drop on empty path space → move the dragged block to the end.
    path.addEventListener('dragover', (e) => e.preventDefault());
    path.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/fxid');
      if (!id) return;
      const next = track.getFXOrder().filter(x => x !== id);
      next.push(id);
      track.setFXOrder(next);
      this._renderContent();
    });
  }

  _terminal(label) {
    const el = document.createElement('div');
    el.className = 'fxpipe-terminal';
    el.textContent = label;
    return el;
  }

  _arrow() {
    const el = document.createElement('div');
    el.className = 'fxpipe-arrow';
    el.textContent = '→';
    return el;
  }

  _block(id) {
    const track = this._track;
    const type  = track.getFXType(id);
    const fx    = track.getFXBlock(id);
    const on    = fx?.enabled ?? false;
    const removable = track.isFXRemovable(id);

    const el = document.createElement('div');
    el.className = 'fxpipe-block'
      + (on ? '' : ' off')
      + (this._selectedId === id ? ' selected' : '');
    el.dataset.fxid = id;
    el.draggable = true;

    // Remove ✕ — on every in-chain block (the BIN is the drag alternative).
    // Added instances are deleted; base blocks are detached (re-addable).
    if (removable) {
      const x = document.createElement('button');
      x.className = 'fxpipe-block-x';
      x.textContent = '✕';
      x.title = track.isFXBase(id)
        ? 'Remove from chain (re-add from + ADD FX)'
        : 'Remove this effect';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._selectedId === id) this._selectedId = null;
        track.removeFX(id);
        this._syncFXBar();          // chain shape changed → refresh header outline
        this._renderContent();
      });
      el.appendChild(x);
    }

    const glyph = document.createElement('div');
    glyph.className = 'fxpipe-block-glyph';
    glyph.textContent = TYPE_GLYPH[type] ?? '●';
    el.appendChild(glyph);

    const name = document.createElement('div');
    name.className = 'fxpipe-block-name';
    name.textContent = FX_TYPE_LABELS[type] ?? type;
    el.appendChild(name);

    const toggle = document.createElement('button');
    toggle.className = 'fxpipe-block-toggle' + (on ? ' on' : '');
    toggle.textContent = on ? 'ON' : 'OFF';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      fx?.setEnabled?.(!fx.enabled);
      this._syncFXBar();
      this._renderContent();
    });
    el.appendChild(toggle);

    // FX-bind dropdown: assign one of the four global FX keybinds to this block
    // (on this track only). 'None' clears it. Assigning steals the bind from any
    // other block (enforced in Track.setFXBind).
    const bindSel = document.createElement('select');
    bindSel.className = 'fxpipe-block-bind';
    bindSel.title = 'Assign an FX keybind (toggles this effect on the selected track)';
    const cur = track.getFXBindFor(id);
    [['', 'No bind'], ['1', 'FX 1'], ['2', 'FX 2'], ['3', 'FX 3'], ['4', 'FX 4']]
      .forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if (String(cur ?? '') === val) opt.selected = true;
        bindSel.appendChild(opt);
      });
    bindSel.addEventListener('click', (e) => e.stopPropagation());
    bindSel.addEventListener('change', (e) => {
      e.stopPropagation();
      const n = parseInt(bindSel.value, 10);
      // Clear: pass null on the block's current bind. Assign: set bind n → id.
      if (!bindSel.value) {
        if (cur) track.setFXBind(cur, null);
      } else {
        track.setFXBind(n, id);
      }
      this._renderContent();      // other tiles' dropdowns may have lost the bind
    });
    el.appendChild(bindSel);

    // Click body: select this block (edit its params inline below the path), or
    // DESELECT it if it's already selected. With nothing selected the inline
    // editor clears and the manual key shows the FX-pane overview; with a block
    // selected the manual shows that effect's own page.
    el.addEventListener('click', () => {
      this._selectedId = (this._selectedId === id) ? null : id;
      this._renderContent();
    });

    this._wireBlockDrag(el, id);
    return el;
  }

  // ── Inline param editor (every selected block) ─────────────

  _renderParamArea() {
    const area = this._paramArea;
    area.innerHTML = '';
    const id = this._selectedId;
    if (!id) {
      // Nothing selected: tell the user how to reach a card's params + manual.
      const hint = document.createElement('div');
      hint.className = 'fxpipe-params-hint';
      hint.textContent = 'Click a block to edit its params. With a block selected, '
        + 'the 📖 manual shows that effect\'s page; with none selected it shows the '
        + 'FX-pipeline overview.';
      area.appendChild(hint);
      return;
    }
    const fx = this._track.getFXBlock(id);
    if (!fx) { this._selectedId = null; return; }

    const type = this._track.getFXType(id);
    const head = document.createElement('div');
    head.className = 'fxpipe-params-head';
    head.textContent = (FX_TYPE_LABELS[type] ?? type).toUpperCase() + ' — PARAMS';
    area.appendChild(head);

    // Reuse the generic FX knob renderer — the same one the base FX's old
    // dedicated tabs used. It reads getParamList() and calls setParam/getParam
    // on the block; bare FX (base four) and the FXInstance proxy (added, with
    // namespaced paths) both satisfy that interface, and p-locks key off those
    // same paths, so step p-locks Just Work here for every block.
    const subCtx = { ...this._ctx, container: area };
    new FXPanel().render(subCtx, fx);
  }

  // ── Drag & drop ────────────────────────────────────────────

  _wireBlockDrag(el, id) {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/fxid', id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));

    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      const dragged = e.dataTransfer.getData('text/fxid');
      if (!dragged || dragged === id) return;
      this._moveBefore(dragged, id);
    });
  }

  /** Drop `dragged` immediately before `target` in the chain (reorder only). */
  _moveBefore(dragged, target) {
    const order = this._track.getFXOrder().filter(x => x !== dragged);
    const i = order.indexOf(target);
    order.splice(i < 0 ? order.length : i, 0, dragged);
    this._track.setFXOrder(order);
    this._renderContent();
  }

  /** Keep the header FX on/off toggles in sync after enable/disable here. */
  _syncFXBar() {
    this._ctx.state.emit?.('fxEnabledChanged', { trackIndex: this._ctx.state.selectedTrackIndex });
  }
}
