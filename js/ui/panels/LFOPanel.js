/**
 * LFOPanel.js
 * -----------
 * LFO tab: sub-tab bar (LFO 1..N, add/remove), destination dropdown, simple /
 * advanced mode toggle, and the simple + advanced parameter layouts.
 * Extracted from SynthPanel.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, container, activeWidgets, state, renderContent, fmtParam }
 */

import { KnobWidget }                  from '../KnobWidget.js';
import { formatCount32, MUSICAL_SNAP_32 } from '../../util/BpmSync.js';

export class LFOPanel {
  render(ctx) {
    const { track, container, activeWidgets, state, renderContent, fmtParam } = ctx;
    this._ctx = ctx;

    // ── Sub-tab bar (LFO 1, LFO 2, …, +, ✕) ────────────────
    const subBar = document.createElement('div');
    subBar.className = 'lfo-sub-bar';

    track.lfos.forEach((_, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn lfo-sub-btn';
      btn.textContent = `LFO ${i + 1}`;
      btn.classList.toggle('active', i === state.activeLFOIndex);
      btn.addEventListener('click', () => state.setActiveLFO(i));
      subBar.appendChild(btn);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      track.addLFO();
      state.setActiveLFO(track.lfos.length - 1);
      renderContent();
    });
    subBar.appendChild(addBtn);

    if (track.lfos.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn lfo-remove-btn';
      rmBtn.textContent = '✕';
      rmBtn.title = `Remove LFO ${state.activeLFOIndex + 1}`;
      rmBtn.addEventListener('click', () => {
        const idx = state.activeLFOIndex;
        track.removeLFO(idx);
        state.setActiveLFO(Math.min(idx, track.lfos.length - 1));
        renderContent();
      });
      subBar.appendChild(rmBtn);
    }
    container.appendChild(subBar);

    const lfo = track.lfos[state.activeLFOIndex];
    if (!lfo) return;

    // ── Destination dropdown ─────────────────────────────────
    this._renderDestination(track, lfo);

    // ── Simple / Advanced toggle ─────────────────────────────
    const modeRow = document.createElement('div');
    modeRow.className = 'lfo-mode-row';

    ['simple', 'advanced'].forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'btn lfo-mode-btn' + (lfo.getParam('lfo.mode') === m ? ' active' : '');
      btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      btn.addEventListener('click', () => {
        lfo.setParam('lfo.mode', m);
        renderContent();
      });
      modeRow.appendChild(btn);
    });
    container.appendChild(modeRow);

    // ── Two-column body: simple (left) + advanced (right) ───
    const body = document.createElement('div');
    body.className = 'lfo-body';
    container.appendChild(body);

    const simpleCol = document.createElement('div');
    simpleCol.className = 'lfo-col lfo-col-simple';
    body.appendChild(simpleCol);

    this._renderSimple(lfo, simpleCol);

    if (lfo.getParam('lfo.mode') === 'advanced') {
      const advCol = document.createElement('div');
      advCol.className = 'lfo-col lfo-col-advanced';
      body.appendChild(advCol);
      this._renderAdvanced(lfo, advCol);
    }
  }

  _renderDestination(track, lfo) {
    const { container, activeWidgets, state } = this._ctx;

    const destWrap = document.createElement('div');
    destWrap.className = 'wt-select-wrap lfo-dest-wrap';

    const destLabel = document.createElement('div');
    destLabel.className = 'wt-select-label';
    destLabel.textContent = 'Destination';
    destWrap.appendChild(destLabel);

    const currentDestPath = track._lfoDestPaths[state.activeLFOIndex] ?? '';

    const btnEl  = document.createElement('button');
    btnEl.className = 'wt-select-btn' + (currentDestPath ? ' has-value' : '');
    const valEl  = document.createElement('span');
    valEl.className = 'wt-select-value' + (currentDestPath ? '' : ' placeholder');
    const listEl = document.createElement('div');
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
    const arrowEl = document.createElement('span');
    arrowEl.className = 'wt-select-arrow';

    btnEl.appendChild(valEl);
    btnEl.appendChild(arrowEl);
    listEl.appendChild(searchEl);
    listEl.appendChild(itemsEl);
    listEl.appendChild(noneEl);
    destWrap.appendChild(btnEl);
    destWrap.appendChild(listEl);

    const groups = track.getLFOAssignableParams();
    let foundLabel = '';
    groups.forEach(group => {
      const hdr = document.createElement('div');
      hdr.className = 'wt-select-group';
      hdr.textContent = group.group;
      itemsEl.appendChild(hdr);
      group.items.forEach(item => {
        const opt = document.createElement('div');
        opt.className = 'wt-select-option';
        opt.textContent = item.label;
        opt.dataset.value = item.path;
        opt.dataset.label = item.label;
        opt.dataset.group = group.group.toLowerCase();
        if (item.path === currentDestPath) { opt.classList.add('selected'); foundLabel = item.label; }
        opt.addEventListener('mousedown', e => { e.preventDefault(); selectDest(item, opt); closeDropdown(); });
        itemsEl.appendChild(opt);
      });
    });

    const noneOpt = document.createElement('div');
    noneOpt.className = 'wt-select-option wt-select-clear';
    noneOpt.textContent = '— none —';
    noneOpt.dataset.value = '';
    noneOpt.dataset.label = '';
    noneOpt.dataset.group = '';
    if (!currentDestPath) noneOpt.classList.add('selected');
    noneOpt.addEventListener('mousedown', e => { e.preventDefault(); selectDest({ path: '', label: '' }, noneOpt); closeDropdown(); });
    itemsEl.prepend(noneOpt);

    valEl.textContent = foundLabel || '— none —';
    if (!foundLabel) valEl.classList.add('placeholder');

    function selectDest(item, optEl) {
      itemsEl.querySelectorAll('.wt-select-option.selected').forEach(o => o.classList.remove('selected'));
      if (optEl) optEl.classList.add('selected');
      if (item.path) {
        valEl.textContent = item.label;
        valEl.classList.remove('placeholder');
        btnEl.classList.add('has-value');
      } else {
        valEl.textContent = '— none —';
        valEl.classList.add('placeholder');
        btnEl.classList.remove('has-value');
      }
      track.setLFODestination(track.lfos.indexOf(lfo), item.path);
    }
    function openDropdown() { listEl.classList.add('open'); btnEl.classList.add('open'); searchEl.value = ''; filterItems(''); searchEl.focus(); }
    function closeDropdown() { listEl.classList.remove('open'); btnEl.classList.remove('open'); }
    function filterItems(q) {
      const query = q.toLowerCase().trim();
      let anyVisible = false;
      const groupVis = {};
      itemsEl.querySelectorAll('.wt-select-option').forEach(opt => {
        if (opt.classList.contains('wt-select-clear')) { opt.classList.remove('hidden'); return; }
        const match = !query || opt.dataset.label.toLowerCase().includes(query) || opt.dataset.group.includes(query);
        opt.classList.toggle('hidden', !match);
        if (match) { anyVisible = true; groupVis[opt.dataset.group] = true; }
      });
      itemsEl.querySelectorAll('.wt-select-group').forEach(g => {
        g.style.display = groupVis[g.textContent.toLowerCase()] ? '' : 'none';
      });
      noneEl.style.display = anyVisible ? 'none' : 'block';
    }

    btnEl.addEventListener('click', () => listEl.classList.contains('open') ? closeDropdown() : openDropdown());
    searchEl.addEventListener('input', () => filterItems(searchEl.value));
    const outsideClick = e => { if (!btnEl.contains(e.target) && !listEl.contains(e.target)) closeDropdown(); };
    const escKey = e => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', outsideClick);
    document.addEventListener('keydown', escKey);
    activeWidgets.push({ destroy: () => {
      document.removeEventListener('mousedown', outsideClick);
      document.removeEventListener('keydown', escKey);
    }});

    container.appendChild(destWrap);
  }

  /**
   * Build a unified MS↔BPM (here Hz↔BPM) rate knob for an LFO. Clicking the
   * knob centre toggles lfo.syncMode for the whole LFO; the body shows the
   * current mode ('HZ'/'BPM'). In BPM mode the knob sweeps the 1/32 grid
   * continuously, and shift-drag/scroll snaps to musical divisions. See
   * design/audio-signal-chain.md (Unified Sync-Knob Model).
   *
   * @param {LFO} lfo
   * @param {object} cfg
   * @param {string} cfg.label   knob label
   * @param {number} cfg.size    knob px size
   * @param {string} cfg.hzPath  param path holding the Hz value
   * @param {string} cfg.bpmPath param path holding the 1/32 count
   * @returns {KnobWidget}
   */
  _makeSyncKnob(lfo, { label, size, hzPath, bpmPath }) {
    const { activeWidgets, renderContent, fmtParam } = this._ctx;
    const isBpm = lfo.getParam('lfo.syncMode') === 'bpm';

    const activePath = isBpm ? bpmPath : hzPath;
    const min  = isBpm ? 1   : 0.001;
    const max  = isBpm ? 128 : 20;
    const fmt  = isBpm
      ? (v => formatCount32(v))
      : (v => fmtParam({ path: hzPath }, v));

    const knob = new KnobWidget({
      label, min, max,
      value: lfo.getParam(activePath),
      size,
      fmt,
      // Continuous in BPM mode; shift-drag/scroll snaps to musical divisions.
      snapPoints: isBpm ? MUSICAL_SNAP_32 : null,
      centerLabel: isBpm ? 'BPM' : 'HZ',
      onCenterClick: () => {
        lfo.setParam('lfo.syncMode', isBpm ? 'hz' : 'bpm');
        renderContent();   // rebuild so the knob picks up the new range/value
      },
      onChange: v => lfo.setParam(activePath, v),
    });
    activeWidgets.push(knob);
    return knob;
  }

  _renderSimple(lfo, container) {
    const { activeWidgets, renderContent, fmtParam } = this._ctx;

    // ── Row 1: Waveform + Trig mode buttons ──────────────────
    const row1 = document.createElement('div');
    row1.className = 'lfo-row';

    // Waveform selector
    const wfGroup = document.createElement('div');
    wfGroup.className = 'lfo-btn-group';
    const wfLabel = document.createElement('span');
    wfLabel.className = 'lfo-group-label';
    wfLabel.textContent = 'Wave';
    wfGroup.appendChild(wfLabel);
    const wfBtns = document.createElement('div');
    wfBtns.className = 'lfo-btn-row';
    ['sine','square','sawtooth','triangle'].forEach(w => {
      const b = document.createElement('button');
      b.className = 'btn lfo-wave-btn' + (lfo.getParam('lfo.waveform') === w ? ' active' : '');
      b.textContent = w === 'sawtooth' ? 'saw' : w === 'triangle' ? 'tri' : w;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.waveform', w);
        wfBtns.querySelectorAll('.lfo-wave-btn').forEach(x => x.classList.toggle('active', x === b));
      });
      wfBtns.appendChild(b);
    });
    wfGroup.appendChild(wfBtns);
    row1.appendChild(wfGroup);

    // Trig mode selector
    const tgGroup = document.createElement('div');
    tgGroup.className = 'lfo-btn-group';
    const tgLabel = document.createElement('span');
    tgLabel.className = 'lfo-group-label';
    tgLabel.textContent = 'Trig';
    tgGroup.appendChild(tgLabel);
    const tgBtns = document.createElement('div');
    tgBtns.className = 'lfo-btn-row';
    [['free','FRE'],['trig','TRG']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-trig-btn' + (lfo.getParam('lfo.trigMode') === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.trigMode', val);
        tgBtns.querySelectorAll('.lfo-trig-btn').forEach(x => x.classList.toggle('active', x === b));
      });
      tgBtns.appendChild(b);
    });
    tgGroup.appendChild(tgBtns);
    row1.appendChild(tgGroup);

    container.appendChild(row1);

    // ── Row 2: unified Hz/BPM rate knob (click centre to toggle) ─────────
    const row2 = document.createElement('div');
    row2.className = 'lfo-row';

    const rateKnob = this._makeSyncKnob(lfo, {
      label: 'Rate', size: 64, hzPath: 'lfo.speed', bpmPath: 'lfo.bpmCount32',
    });
    row2.appendChild(rateKnob.el);

    container.appendChild(row2);

    // ── Row 3: Depth + Phase + Fade knobs ────────────────────
    const row3 = document.createElement('div');
    row3.className = 'lfo-knobs-wrap';

    const depthP = { path: 'lfo.depth', label: 'Depth', min: 0, max: 100 };
    const depthKnob = new KnobWidget({
      label: 'Depth', min: 0, max: 100,
      value: lfo.getParam('lfo.depth'),
      size: 64, fmt: v => fmtParam(depthP, v),
      onChange: v => lfo.setParam('lfo.depth', v),
    });
    row3.appendChild(depthKnob.el);
    activeWidgets.push(depthKnob);

    const phaseP = { path: 'lfo.startPhase', label: 'Phase', min: 0, max: 127 };
    const phaseKnob = new KnobWidget({
      label: 'Phase', min: 0, max: 127,
      value: lfo.getParam('lfo.startPhase'),
      size: 64, fmt: v => fmtParam(phaseP, v),
      onChange: v => lfo.setParam('lfo.startPhase', v),
    });
    row3.appendChild(phaseKnob.el);
    activeWidgets.push(phaseKnob);

    const fadeP = { path: 'lfo.fade', label: 'Fade', min: -100, max: 100 };
    const fadeKnob = new KnobWidget({
      label: 'Fade', min: -100, max: 100,
      value: lfo.getParam('lfo.fade'),
      bipolar: true,
      size: 64, fmt: v => fmtParam(fadeP, v),
      onChange: v => lfo.setParam('lfo.fade', v),
    });
    row3.appendChild(fadeKnob.el);
    activeWidgets.push(fadeKnob);

    // Bias — pushes the modulation window up/down by the depth amount, so the
    // LFO modulates only above (+) or only below (-) the base value. See LFO.md.
    const biasP = { path: 'lfo.bias', label: 'Bias', min: -100, max: 100 };
    const biasKnob = new KnobWidget({
      label: 'Bias', min: -100, max: 100,
      value: lfo.getParam('lfo.bias'),
      bipolar: true,
      size: 64, fmt: v => fmtParam(biasP, v),
      onChange: v => lfo.setParam('lfo.bias', v),
    });
    row3.appendChild(biasKnob.el);
    activeWidgets.push(biasKnob);

    container.appendChild(row3);
  }

  _renderAdvanced(lfo, container) {
    const { activeWidgets, renderContent, fmtParam } = this._ctx;

    // ── ADSR source toggle ───────────────────────────────────
    const srcRow = document.createElement('div');
    srcRow.className = 'lfo-row lfo-adsr-source-row';
    const srcLabel = document.createElement('span');
    srcLabel.className = 'lfo-group-label';
    srcLabel.textContent = 'ADSR source';
    srcRow.appendChild(srcLabel);
    const srcBtns = document.createElement('div');
    srcBtns.className = 'lfo-btn-row';
    [['own','Own'],['amp','Amp sync']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-src-btn' + (lfo.getParam('lfo.adsrSource') === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.adsrSource', val);
        renderContent();
      });
      srcBtns.appendChild(b);
    });
    srcRow.appendChild(srcBtns);
    container.appendChild(srcRow);

    // ── Per-section panels: 2×2 grid (A D / S R) ────────────
    const ownMode = lfo.getParam('lfo.adsrSource') === 'own';

    const grid = document.createElement('div');
    grid.className = 'lfo-adsr-grid';
    container.appendChild(grid);

    ['a','d','s','r'].forEach(sec => {
      const cell = document.createElement('div');
      cell.className = 'lfo-adsr-cell';

      const hdr = document.createElement('div');
      hdr.className = 'lfo-adsr-sec-header';
      hdr.textContent = sec.toUpperCase();
      cell.appendChild(hdr);

      const knobRow = document.createElement('div');
      knobRow.className = 'lfo-knobs-wrap';

      // Time knob (own source, A/D/R only — S is gate-length)
      if (ownMode && sec !== 's') {
        const timeP = { path: `lfo.adsr.${sec}.time` };
        const timeKnob = new KnobWidget({
          label: 'Time', min: 0.001, max: 8,
          value: lfo.getParam(`lfo.adsr.${sec}.time`),
          size: 44, fmt: v => fmtParam(timeP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.time`, v),
        });
        knobRow.appendChild(timeKnob.el);
        activeWidgets.push(timeKnob);
      }

      // Depth knob
      const depthP = { path: `lfo.adsr.${sec}.depth` };
      const depthKnob = new KnobWidget({
        label: 'Depth', min: 0, max: 100,
        value: lfo.getParam(`lfo.adsr.${sec}.depth`),
        size: 44, fmt: v => fmtParam(depthP, v),
        onChange: v => lfo.setParam(`lfo.adsr.${sec}.depth`, v),
      });
      knobRow.appendChild(depthKnob.el);
      activeWidgets.push(depthKnob);

      // Per-section rate: unified Hz/BPM sync knob (click centre toggles the
      // whole LFO's sync mode). In Hz mode the Mult knob is gone (rate is the
      // single Speed value); in BPM mode it sweeps the 1/32 grid.
      const rateKnob = this._makeSyncKnob(lfo, {
        label: 'Rate', size: 44,
        hzPath:  `lfo.adsr.${sec}.speed`,
        bpmPath: `lfo.adsr.${sec}.bpmCount32`,
      });
      knobRow.appendChild(rateKnob.el);

      cell.appendChild(knobRow);
      grid.appendChild(cell);
    });
  }
}
