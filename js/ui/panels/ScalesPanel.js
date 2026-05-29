/**
 * ScalesPanel.js
 * --------------
 * SCALES tab: scale dropdown (searchable), root-note strip, scale-degree
 * preview, and keyboard-fold toggle. Extracted from SynthPanel.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, container, activeWidgets, state }
 */

import { SCALE_DEFS, NOTE_NAMES } from '../../state/Scales.js';

export class ScalesPanel {
  render(ctx) {
    const { track, container, activeWidgets, state } = ctx;

    const wrapper = document.createElement('div');
    wrapper.className = 'scales-tab-wrapper';

    // ── Top row: dropdown + root picker side by side ─────────
    const topRow = document.createElement('div');
    topRow.className = 'scales-top-row';
    wrapper.appendChild(topRow);

    // ── Scale dropdown ───────────────────────────────────────
    const dropWrap = document.createElement('div');
    dropWrap.className = 'wt-select-wrap scales-drop-wrap';

    const dropLabel = document.createElement('div');
    dropLabel.className = 'wt-select-label';
    dropLabel.textContent = 'Scale';
    dropWrap.appendChild(dropLabel);

    const btnEl   = document.createElement('button');
    btnEl.className = 'wt-select-btn has-value';

    const valEl   = document.createElement('span');
    valEl.className = 'wt-select-value';
    valEl.textContent = SCALE_DEFS[track.scaleIndex]?.label ?? 'Chromatic';

    const arrowEl = document.createElement('span');
    arrowEl.className = 'wt-select-arrow';

    const listEl  = document.createElement('div');
    listEl.className = 'wt-select-list';

    const searchEl = document.createElement('input');
    searchEl.className = 'wt-select-search';
    searchEl.type = 'text';
    searchEl.placeholder = 'search…';
    searchEl.autocomplete = 'off';

    const itemsEl = document.createElement('div');
    itemsEl.className = 'wt-select-items';

    const noneEl  = document.createElement('div');
    noneEl.className = 'wt-select-none';
    noneEl.textContent = 'no match';

    btnEl.appendChild(valEl);
    btnEl.appendChild(arrowEl);
    listEl.appendChild(searchEl);
    listEl.appendChild(itemsEl);
    listEl.appendChild(noneEl);
    dropWrap.appendChild(btnEl);
    dropWrap.appendChild(listEl);

    SCALE_DEFS.forEach((def, i) => {
      const opt = document.createElement('div');
      opt.className = 'wt-select-option' + (i === track.scaleIndex ? ' selected' : '');
      opt.textContent = def.label;
      opt.dataset.label = def.label.toLowerCase();
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        track.scaleIndex = i;
        valEl.textContent = def.label;
        itemsEl.querySelectorAll('.wt-select-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        closeDropdown();
        state.emit('scaleChanged', { track });
      });
      itemsEl.appendChild(opt);
    });

    function openDropdown() {
      listEl.classList.add('open');
      btnEl.classList.add('open');
      searchEl.value = '';
      filterItems('');
      searchEl.focus();
    }

    function closeDropdown() {
      listEl.classList.remove('open');
      btnEl.classList.remove('open');
    }

    function filterItems(q) {
      const query = q.toLowerCase().trim();
      let anyVisible = false;
      itemsEl.querySelectorAll('.wt-select-option').forEach(opt => {
        const match = !query || opt.dataset.label.includes(query);
        opt.classList.toggle('hidden', !match);
        if (match) anyVisible = true;
      });
      noneEl.style.display = anyVisible ? 'none' : 'block';
    }

    btnEl.addEventListener('click', () =>
      listEl.classList.contains('open') ? closeDropdown() : openDropdown()
    );
    searchEl.addEventListener('input', () => filterItems(searchEl.value));

    const outsideClick = e => {
      if (!btnEl.contains(e.target) && !listEl.contains(e.target)) closeDropdown();
    };
    const escKey = e => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', outsideClick);
    document.addEventListener('keydown', escKey);
    activeWidgets.push({
      destroy: () => {
        document.removeEventListener('mousedown', outsideClick);
        document.removeEventListener('keydown', escKey);
      }
    });

    topRow.appendChild(dropWrap);

    // ── Root note button strip ───────────────────────────────
    const rootWrap = document.createElement('div');
    rootWrap.className = 'scales-root-wrap';

    const rootLabel = document.createElement('div');
    rootLabel.className = 'wt-select-label';
    rootLabel.textContent = 'Root';
    rootWrap.appendChild(rootLabel);

    const rootStrip = document.createElement('div');
    rootStrip.className = 'scales-root-strip';

    const rootBtns = NOTE_NAMES.map((name, pc) => {
      const btn = document.createElement('button');
      btn.className = 'scales-root-btn' + (pc === track.leadNote ? ' active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        track.leadNote = pc;
        rootBtns.forEach((b, j) => b.classList.toggle('active', j === pc));
        state.emit('scaleChanged', { track });
      });
      rootStrip.appendChild(btn);
      return btn;
    });

    rootWrap.appendChild(rootStrip);
    topRow.appendChild(rootWrap);

    // ── Scale degree preview ─────────────────────────────────
    const preview = document.createElement('div');
    preview.className = 'scales-preview';

    const updatePreview = () => {
      preview.innerHTML = '';
      const def = SCALE_DEFS[track.scaleIndex];
      if (!def || track.scaleIndex === 0) {
        const all = document.createElement('span');
        all.className = 'scales-preview-note';
        all.textContent = 'All notes active';
        preview.appendChild(all);
        return;
      }
      NOTE_NAMES.forEach((name, pc) => {
        const inScale = def.intervals.includes(((pc - track.leadNote) % 12 + 12) % 12);
        const dot = document.createElement('span');
        dot.className = 'scales-preview-note' + (inScale ? ' in-scale' : ' out-scale');
        dot.textContent = name;
        preview.appendChild(dot);
      });
    };

    const onScaleChange = () => {
      updatePreview();
      rootBtns.forEach((b, j) => b.classList.toggle('active', j === track.leadNote));
    };
    state.on('scaleChanged', onScaleChange);
    activeWidgets.push({ destroy: () => state.off('scaleChanged', onScaleChange) });

    updatePreview();
    wrapper.appendChild(preview);

    // ── Keyboard folding toggle ──────────────────────────────
    const foldRow = document.createElement('div');
    foldRow.className = 'scales-fold-row';

    const foldLabel = document.createElement('span');
    foldLabel.className = 'scales-fold-label';
    foldLabel.textContent = 'KEYBOARD FOLD';

    const foldBtn = document.createElement('button');
    foldBtn.className = 'btn scales-fold-btn' + (state.keyFolding ? ' active' : '');
    foldBtn.textContent = state.keyFolding ? 'ON' : 'OFF';
    foldBtn.addEventListener('click', () => {
      state.keyFolding = !state.keyFolding;
      foldBtn.textContent = state.keyFolding ? 'ON' : 'OFF';
      foldBtn.classList.toggle('active', state.keyFolding);
      state.emit('keyFoldingChanged', { on: state.keyFolding });
    });

    const foldDesc = document.createElement('span');
    foldDesc.className = 'scales-fold-desc';
    foldDesc.textContent = 'a–\' / q–¨ map in-scale notes in series';

    foldRow.appendChild(foldLabel);
    foldRow.appendChild(foldBtn);
    foldRow.appendChild(foldDesc);
    wrapper.appendChild(foldRow);

    container.appendChild(wrapper);
  }
}
