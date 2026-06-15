/**
 * SettingsPanel.js
 * ----------------
 * The global-settings hover pane, opened by the ⚙ cog button to the right of the
 * WEBTAKT title. A second 📖 book button is a placeholder for the upcoming
 * manual (tooltip only — no panel yet).
 *
 * The pane is a floating box anchored under the cog. It holds every app-wide
 * preference (see js/state/Settings.js):
 *   - BPM grid: finest synced-knob division (1/32 / 1/64 / 1/128)
 *   - Mod-wheel scroll sensitivity (slider)
 *   - Keybinds: click a row then press a key to rebind play / record / stop-all
 *   - Keyboard layout: computer-key → piano-key preset (QWERTY / AZERTY / …)
 *   - RESET TO DEFAULTS
 *
 * Every control writes straight to `settings` on change — there is no save
 * button; persistence is continuous (localStorage). Settings broadcasts the
 * change so the rest of the app (knobs, keyboard, mod-wheel) reacts live.
 *
 * Owns:    the pane DOM + open/close state + the keybind-capture handler
 * Depends: Settings.js, Keyboard.js (KB_LAYOUTS)
 * Used by: index.html (constructed with the cog + book buttons)
 */

import { settings, GRID_OPTIONS } from '../state/Settings.js';
import { KB_LAYOUTS, CUSTOM_LAYOUT_LABEL } from './Keyboard.js';

// Black-key slots (parallel to Keyboard.BLACK_NOTES): -1 = gap (no key there).
// Used to lay out the custom-layout editor's two rows like a real keyboard.
const EDITOR_BLACK = [1, 3, -1, 6, 8, 10, -1, 13, 15, -1, 18, 20, 22, -1];
const EDITOR_WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];

const KEYBIND_ACTIONS = [
  { id: 'play',     label: 'Play / Stop' },
  { id: 'record',   label: 'Record' },
  { id: 'stopAll',  label: 'Stop All (panic)' },
  { id: 'manual',   label: 'Manual' },
  { id: 'hold',     label: 'Hold (latch notes)' },
  { id: 'arp',      label: 'Arp on/off (sel. track)' },
  // Four generic FX binds. Each track assigns these to FX blocks in the FX pane;
  // the key toggles the assigned block on the selected track. Defaults C/V/B/N.
  { id: 'fx1',      label: 'FX bind 1 (sel. track)' },
  { id: 'fx2',      label: 'FX bind 2 (sel. track)' },
  { id: 'fx3',      label: 'FX bind 3 (sel. track)' },
  { id: 'fx4',      label: 'FX bind 4 (sel. track)' },
];

/** Human label for an event.code (e.g. "Space", "Enter", "KeyR" → "R"). */
function codeLabel(code) {
  if (!code) return '—';
  const m = code.match(/^Key([A-Z])$/);       if (m) return m[1];
  const d = code.match(/^Digit(\d)$/);          if (d) return d[1];
  const n = code.match(/^Numpad(\d)$/);         if (n) return `Num ${n[1]}`;
  const a = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  return a[code] ?? code;
}

export class SettingsPanel {
  /**
   * @param {HTMLElement} cogBtn — the ⚙ button
   */
  constructor(cogBtn) {
    this.cogBtn    = cogBtn;
    this._open     = false;
    this._capturing = null;        // action id currently waiting for a key, or null
    this._conflictWarning = null;  // set after a rebind that cleared a clash

    this._buildPane();

    cogBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });

    // Close on outside click / Escape (but not while capturing a keybind).
    this._outsideClick = (e) => {
      if (this._open && !this.pane.contains(e.target) && e.target !== cogBtn) this.close();
    };
    document.addEventListener('pointerdown', this._outsideClick);
  }

  toggle() { this._open ? this.close() : this.openPane(); }

  openPane() {
    this._open = true;
    this._render();
    this.pane.style.display = 'block';
    // Anchor under the cog, left-aligned to it.
    const r = this.cogBtn.getBoundingClientRect();
    this.pane.style.top  = (r.bottom + 6) + 'px';
    this.pane.style.left = r.left + 'px';
  }

  close() {
    this._open = false;
    this._stopCapture();
    this._closeKeyEditor();
    this.pane.style.display = 'none';
  }

  // ── DOM ────────────────────────────────────────────────────
  _buildPane() {
    const pane = document.createElement('div');
    pane.className = 'settings-pane';
    pane.style.display = 'none';
    pane.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.pane = pane;
    document.body.appendChild(pane);
  }

  _render() {
    const p = this.pane;
    p.innerHTML = '';

    p.appendChild(this._title('SETTINGS'));

    // ── BPM grid resolution ──────────────────────────────────
    {
      const row = this._row('Synced-knob grid', 'Finest BPM division the synced knobs snap to / reach.');
      const sel = document.createElement('select');
      sel.className = 'settings-select';
      GRID_OPTIONS.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.id; opt.textContent = o.label;
        if (o.id === settings.get('bpmGrid')) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => settings.set('bpmGrid', sel.value));
      row.appendChild(sel);
      p.appendChild(row);
    }

    // ── Mod-wheel sensitivity ────────────────────────────────
    {
      const row = this._row('Mod-wheel sensitivity', 'How far a scroll moves the mod wheels.');
      const wrap = document.createElement('div');
      wrap.className = 'settings-slider-wrap';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0.1'; slider.max = '3'; slider.step = '0.05';
      slider.value = String(settings.get('modWheelSensitivity'));
      const out = document.createElement('span');
      out.className = 'settings-slider-val';
      out.textContent = `${(+slider.value).toFixed(2)}×`;
      slider.addEventListener('input', () => {
        out.textContent = `${(+slider.value).toFixed(2)}×`;
        settings.set('modWheelSensitivity', parseFloat(slider.value));
      });
      wrap.appendChild(slider);
      wrap.appendChild(out);
      row.appendChild(wrap);
      p.appendChild(row);
    }

    // ── Keyboard layout ──────────────────────────────────────
    {
      const row = this._row('Keyboard layout', 'Maps computer keys to piano keys for non-QWERTY layouts.');
      const sel = document.createElement('select');
      sel.className = 'settings-select';
      Object.entries(KB_LAYOUTS).forEach(([id, def]) => {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = def.label;
        if (id === settings.get('keyboardLayout')) opt.selected = true;
        sel.appendChild(opt);
      });
      const customOpt = document.createElement('option');
      customOpt.value = 'custom'; customOpt.textContent = CUSTOM_LAYOUT_LABEL;
      if (settings.get('keyboardLayout') === 'custom') customOpt.selected = true;
      sel.appendChild(customOpt);
      sel.addEventListener('change', () => { settings.set('keyboardLayout', sel.value); this._render(); });
      row.appendChild(sel);
      p.appendChild(row);

      // EDIT KEYS button — only when the custom layout is active.
      if (settings.get('keyboardLayout') === 'custom') {
        const edit = document.createElement('button');
        edit.className = 'settings-edit-keys-btn';
        edit.textContent = '✎ EDIT KEYS';
        edit.addEventListener('click', (e) => { e.stopPropagation(); this._openKeyEditor(); });
        p.appendChild(edit);
      }
    }

    // ── Keybinds ─────────────────────────────────────────────
    p.appendChild(this._subtitle('KEYBINDS'));
    if (this._conflictWarning) {
      const warn = document.createElement('div');
      warn.className = 'settings-keybind-conflict';
      warn.textContent = '⚠ ' + this._conflictWarning;
      p.appendChild(warn);
    }
    KEYBIND_ACTIONS.forEach(({ id, label }) => {
      const row = document.createElement('div');
      row.className = 'settings-keybind-row';
      const name = document.createElement('span');
      name.className = 'settings-keybind-name';
      name.textContent = label;
      const btn = document.createElement('button');
      btn.className = 'settings-keybind-btn';
      btn.dataset.action = id;
      btn.textContent = this._capturing === id ? 'press a key…' : codeLabel(settings.getKeybind(id));
      if (this._capturing === id) btn.classList.add('capturing');
      btn.addEventListener('click', (e) => { e.stopPropagation(); this._startCapture(id); });
      row.appendChild(name);
      row.appendChild(btn);
      p.appendChild(row);
    });

    // ── Reset ────────────────────────────────────────────────
    const reset = document.createElement('button');
    reset.className = 'settings-reset-btn';
    reset.textContent = 'RESET TO DEFAULTS';
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      this._stopCapture();
      settings.reset();
      this._render();
    });
    p.appendChild(reset);
  }

  // ── Keybind capture ────────────────────────────────────────
  _startCapture(action) {
    this._stopCapture();
    this._conflictWarning = null;
    this._capturing = action;
    this._render();
    this._captureHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { this._stopCapture(); this._render(); return; }

      // Check if this key is already used by another action — if so, clear it
      // there first and note what happened so we can show a warning.
      const kb = settings.get('keybinds');
      const clash = KEYBIND_ACTIONS.find(a => a.id !== action && kb[a.id] === e.code);
      if (clash) {
        settings.setKeybind(clash.id, '');
        this._conflictWarning = `"${codeLabel(e.code)}" was unbound from "${clash.label}"`;
      } else {
        this._conflictWarning = null;
      }

      settings.setKeybind(action, e.code);
      this._stopCapture();
      this._render();
    };
    // Capture phase so it beats the global transport handler.
    document.addEventListener('keydown', this._captureHandler, { capture: true });
  }

  _stopCapture() {
    if (this._captureHandler) {
      document.removeEventListener('keydown', this._captureHandler, { capture: true });
      this._captureHandler = null;
    }
    this._capturing = null;
  }

  // ── Custom layout key editor ───────────────────────────────
  /**
   * Open the per-key editor: a mini piano where each white key shows its lower
   * char and each black key its chromatic char. Click a key, then press the
   * physical key you want there — its produced character is stored. Esc/blur
   * cancels the in-progress capture. Edits are live (the on-screen keyboard
   * relabels immediately via Settings' change broadcast).
   */
  _openKeyEditor() {
    if (this._editor) this._closeKeyEditor();
    const ed = document.createElement('div');
    ed.className = 'kb-editor-pane';
    ed.addEventListener('pointerdown', (e) => e.stopPropagation());
    this._editor = ed;
    document.body.appendChild(ed);
    this._renderKeyEditor();

    // Anchor to the right of the settings pane; flip to the left side if it
    // would overflow the viewport, and clamp vertically.
    const r  = this.pane.getBoundingClientRect();
    const ew = ed.offsetWidth;
    const eh = ed.offsetHeight;
    let left = r.right + 8;
    if (left + ew > window.innerWidth - 8) left = Math.max(8, r.left - ew - 8);
    let top = r.top;
    if (top + eh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - eh - 8);
    ed.style.left = left + 'px';
    ed.style.top  = top + 'px';

    this._editorOutside = (e) => {
      if (this._editor && !ed.contains(e.target)) this._closeKeyEditor();
    };
    document.addEventListener('pointerdown', this._editorOutside);
  }

  _closeKeyEditor() {
    if (!this._editor) return;
    this._stopKeyCapture();
    if (this._editorOutside) document.removeEventListener('pointerdown', this._editorOutside);
    this._editorOutside = null;
    this._editor.remove();
    this._editor = null;
  }

  _renderKeyEditor() {
    const ed = this._editor;
    ed.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'CUSTOM LAYOUT — CLICK A KEY, PRESS A KEY';
    ed.appendChild(title);

    const layout = settings.getCustomLayout();
    const piano  = document.createElement('div');
    piano.className = 'kb-editor-piano';

    // White-key row — every slot is bindable (even ones the presets leave blank).
    const whiteRow = document.createElement('div');
    whiteRow.className = 'kb-editor-white-row';
    EDITOR_WHITE.forEach((_semitone, wi) => {
      whiteRow.appendChild(this._editorKey('lower', wi, layout.lower[wi] ?? '', false));
    });

    // Black-key row, positioned over the white keys exactly as the real
    // keyboard does (Keyboard._blackKeyOffset): left edge at (whiteBelow+0.75)
    // white-widths, width = one black-key (4% of 14 whites), no centering shift.
    const blackRow = document.createElement('div');
    blackRow.className = 'kb-editor-black-row';
    const whiteWidth = 100 / EDITOR_WHITE.length;
    EDITOR_BLACK.forEach((semitone, bi) => {
      if (semitone === -1) return;
      const wBelow = EDITOR_WHITE.indexOf(semitone - 1);
      const key = this._editorKey('chromatic', bi, layout.chromatic[bi] ?? '', true);
      key.style.left = `${(wBelow + 0.75) * whiteWidth}%`;
      blackRow.appendChild(key);
    });

    piano.appendChild(whiteRow);
    piano.appendChild(blackRow);
    ed.appendChild(piano);

    const reset = document.createElement('button');
    reset.className = 'settings-reset-btn';
    reset.textContent = 'RESET LAYOUT';
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      this._stopKeyCapture();
      settings.resetCustomLayout();
      this._renderKeyEditor();
    });
    ed.appendChild(reset);
  }

  _editorKey(row, idx, char, isBlack) {
    const k = document.createElement('button');
    k.className = 'kb-editor-key ' + (isBlack ? 'kb-editor-black' : 'kb-editor-white');
    const capturing = this._keyCapture && this._keyCapture.row === row && this._keyCapture.idx === idx;
    if (capturing) k.classList.add('capturing');
    k.textContent = capturing ? '…' : (char || '·');
    k.addEventListener('click', (e) => { e.stopPropagation(); this._startKeyCapture(row, idx); });
    return k;
  }

  _startKeyCapture(row, idx) {
    this._stopKeyCapture();
    this._keyCapture = { row, idx };
    this._renderKeyEditor();
    this._keyCaptureHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { this._stopKeyCapture(); this._renderKeyEditor(); return; }
      // Single produced character only (ignore pure modifiers / multi-char keys).
      const ch = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (e.key === 'Backspace' || e.key === 'Delete') {
        settings.setCustomKey(row, idx, '');
      } else if (ch) {
        settings.setCustomKey(row, idx, ch);
      } else {
        return; // ignore Shift/Ctrl/etc — keep waiting
      }
      this._stopKeyCapture();
      this._renderKeyEditor();
    };
    document.addEventListener('keydown', this._keyCaptureHandler, { capture: true });
  }

  _stopKeyCapture() {
    if (this._keyCaptureHandler) {
      document.removeEventListener('keydown', this._keyCaptureHandler, { capture: true });
      this._keyCaptureHandler = null;
    }
    this._keyCapture = null;
  }

  // ── Small DOM helpers ──────────────────────────────────────
  _title(text) {
    const el = document.createElement('div');
    el.className = 'settings-title';
    el.textContent = text;
    return el;
  }
  _subtitle(text) {
    const el = document.createElement('div');
    el.className = 'settings-subtitle';
    el.textContent = text;
    return el;
  }
  _row(label, hint) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const l = document.createElement('label');
    l.className = 'settings-label';
    l.textContent = label;
    if (hint) l.title = hint;
    row.appendChild(l);
    return row;
  }

  destroy() {
    document.removeEventListener('pointerdown', this._outsideClick);
    this._stopCapture();
    this._closeKeyEditor();
    this.pane.remove();
  }
}
