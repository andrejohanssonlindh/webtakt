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

import { KnobWidget }    from '../KnobWidget.js';
import { BPM_DIVISIONS } from '../../signal/LFO.js';

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

    const groups = track.getAssignableParams();
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

    // ── Row 2: Speed knobs + BPM sync toggle ─────────────────
    const row2 = document.createElement('div');
    row2.className = 'lfo-row';

    const syncMode = lfo.getParam('lfo.syncMode');

    // BPM / Hz toggle
    const syncGroup = document.createElement('div');
    syncGroup.className = 'lfo-btn-group';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'lfo-group-label';
    syncLabel.textContent = 'Sync';
    syncGroup.appendChild(syncLabel);
    const syncBtns = document.createElement('div');
    syncBtns.className = 'lfo-btn-row';
    [['hz','Hz'],['bpm','BPM']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-sync-btn' + (syncMode === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.syncMode', val);
        renderContent();
      });
      syncBtns.appendChild(b);
    });
    syncGroup.appendChild(syncBtns);
    row2.appendChild(syncGroup);

    if (syncMode === 'hz') {
      // Speed Hz knob
      const speedP = { path: 'lfo.speed', label: 'Speed', min: 0.001, max: 20, default: 0.1 };
      const speedKnob = new KnobWidget({
        label: 'Speed', min: 0.001, max: 20,
        value: lfo.getParam('lfo.speed'),
        size: 56, fmt: v => fmtParam(speedP, v),
        onChange: v => lfo.setParam('lfo.speed', v),
      });
      row2.appendChild(speedKnob.el);
      activeWidgets.push(speedKnob);

      // Mult knob
      const multP = { path: 'lfo.speedMult', label: 'Mult', min: 1, max: 32, default: 1 };
      const multKnob = new KnobWidget({
        label: 'Mult', min: 1, max: 32,
        value: lfo.getParam('lfo.speedMult'),
        size: 56, fmt: v => fmtParam(multP, v),
        onChange: v => lfo.setParam('lfo.speedMult', v),
      });
      row2.appendChild(multKnob.el);
      activeWidgets.push(multKnob);
    } else {
      // BPM division selector
      const divGroup = document.createElement('div');
      divGroup.className = 'lfo-btn-group';
      const divLabel = document.createElement('span');
      divLabel.className = 'lfo-group-label';
      divLabel.textContent = 'Division';
      divGroup.appendChild(divLabel);
      const divBtns = document.createElement('div');
      divBtns.className = 'lfo-btn-row lfo-div-row';
      BPM_DIVISIONS.forEach(div => {
        const b = document.createElement('button');
        b.className = 'btn lfo-div-btn' + (lfo.getParam('lfo.bpmDiv') === div ? ' active' : '');
        b.textContent = div;
        b.addEventListener('click', () => {
          lfo.setParam('lfo.bpmDiv', div);
          divBtns.querySelectorAll('.lfo-div-btn').forEach(x => x.classList.toggle('active', x === b));
        });
        divBtns.appendChild(b);
      });
      divGroup.appendChild(divBtns);
      row2.appendChild(divGroup);
    }

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
    const syncMode = lfo.getParam('lfo.syncMode');

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

      // Speed knob (Hz) or div selector (BPM)
      if (syncMode === 'hz') {
        const speedP = { path: `lfo.adsr.${sec}.speed` };
        const speedKnob = new KnobWidget({
          label: 'Speed', min: 0.001, max: 20,
          value: lfo.getParam(`lfo.adsr.${sec}.speed`),
          size: 44, fmt: v => fmtParam(speedP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.speed`, v),
        });
        knobRow.appendChild(speedKnob.el);
        activeWidgets.push(speedKnob);

        const multP = { path: `lfo.adsr.${sec}.mult` };
        const multKnob = new KnobWidget({
          label: 'Mult', min: 1, max: 32,
          value: lfo.getParam(`lfo.adsr.${sec}.mult`),
          size: 44, fmt: v => fmtParam(multP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.mult`, v),
        });
        knobRow.appendChild(multKnob.el);
        activeWidgets.push(multKnob);
      } else {
        const divSel = document.createElement('select');
        divSel.className = 'param-select lfo-div-sel';
        BPM_DIVISIONS.forEach(div => {
          const o = document.createElement('option');
          o.value = div; o.textContent = div;
          if (lfo.getParam(`lfo.adsr.${sec}.speed`) === div) o.selected = true;
          divSel.appendChild(o);
        });
        divSel.addEventListener('change', () => lfo.setParam(`lfo.adsr.${sec}.speed`, divSel.value));
        const divWrap = document.createElement('div');
        divWrap.className = 'param-row';
        const divLbl = document.createElement('span');
        divLbl.className = 'param-label label';
        divLbl.textContent = 'Div';
        divWrap.appendChild(divLbl);
        divWrap.appendChild(divSel);
        knobRow.appendChild(divWrap);
      }

      cell.appendChild(knobRow);
      grid.appendChild(cell);
    });
  }
}
