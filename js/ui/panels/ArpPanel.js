/**
 * ArpPanel.js
 * -----------
 * ARP tab UI. Renders controls for the track's Arpeggiator instance.
 *
 * Three sub-layouts toggled by an ARP MODE selector:
 *   Chord  — chord type, pattern (Up/Down/UpDown/Random), speed/BPM-sync, variance
 *   Manual — scrollable list of steps: semitone, speed/sync, gate. + Add / × Remove.
 *   Random — note count, range, speed/sync, variance
 *
 * An ON/OFF toggle at the top enables/disables the arp without clearing its settings.
 *
 * Receives a reduced context from SynthPanel:
 *   { track, state, rebuildArp }
 *   rebuildArp() — called whenever any param changes to re-render reactive controls.
 */

import { KnobWidget }  from '../KnobWidget.js';
import { ARP_CHORD_NAMES, ARP_PATTERNS } from '../../signal/Arpeggiator.js';
import { formatCount32, MUSICAL_SNAP_32 } from '../../util/BpmSync.js';

const PATTERN_LABELS = { up: 'Up', down: 'Down', updown: 'UpDown', random: 'Rand' };

export class ArpPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../../state/Track.js').Track} track
   * @param {Function} rebuildArp  — call to re-render this panel in place
   */
  constructor(container, track, rebuildArp) {
    this.container  = container;
    this.track      = track;
    this.rebuildArp = rebuildArp;
    this._widgets   = [];
    this._render();
  }

  destroy() {
    this._widgets.forEach(w => w.destroy?.());
    this._widgets = [];
  }

  _render() {
    this.container.innerHTML = '';
    this._widgets = [];

    const arp = this.track.arp;

    // ── Header row: ON/OFF + mode selector ──────────────────────────────────
    const headerRow = document.createElement('div');
    headerRow.className = 'arp-header-row';

    const onBtn = document.createElement('button');
    onBtn.className = 'arp-onoff-btn' + (arp.enabled ? ' active' : '');
    onBtn.textContent = arp.enabled ? 'ARP ON' : 'ARP OFF';
    onBtn.addEventListener('click', () => {
      arp.enabled = !arp.enabled;
      this.rebuildArp();
    });
    headerRow.appendChild(onBtn);

    const modeWrap = document.createElement('div');
    modeWrap.className = 'arp-mode-wrap';

    ['chord', 'manual', 'random'].forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'arp-mode-btn' + (arp.getParam('mode') === m ? ' active' : '');
      btn.textContent = m.toUpperCase();
      btn.addEventListener('click', () => {
        arp.setParam('mode', m);
        this.rebuildArp();
      });
      modeWrap.appendChild(btn);
    });

    headerRow.appendChild(modeWrap);
    this.container.appendChild(headerRow);

    // ── Mode content ────────────────────────────────────────────────────────
    const mode = arp.getParam('mode');
    if (mode === 'chord')  this._renderChord();
    if (mode === 'manual') this._renderManual();
    if (mode === 'random') this._renderRandom();
  }

  // ── Chord mode ─────────────────────────────────────────────────────────────

  _renderChord() {
    const arp  = this.track.arp;
    const body = document.createElement('div');
    body.className = 'arp-body';

    // Row 1: chord selector + pattern buttons
    const row1 = document.createElement('div');
    row1.className = 'arp-row';

    const chordSel = this._makeSelect('Chord', ARP_CHORD_NAMES, arp.getParam('chord'), v => {
      arp.setParam('chord', v);
    });
    row1.appendChild(chordSel);

    const patWrap = document.createElement('div');
    patWrap.className = 'arp-pattern-wrap';
    const patLabel = document.createElement('div');
    patLabel.className = 'arp-small-label';
    patLabel.textContent = 'PATTERN';
    patWrap.appendChild(patLabel);
    const patBtns = document.createElement('div');
    patBtns.className = 'arp-pattern-btns';
    ARP_PATTERNS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'arp-pat-btn' + (arp.getParam('pattern') === p ? ' active' : '');
      btn.textContent = PATTERN_LABELS[p] ?? p;
      btn.addEventListener('click', () => {
        arp.setParam('pattern', p);
        patBtns.querySelectorAll('.arp-pat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      patBtns.appendChild(btn);
    });
    patWrap.appendChild(patBtns);
    row1.appendChild(patWrap);
    body.appendChild(row1);

    // Row 2: rate + gate
    body.appendChild(this._makeSpeedGateRow(arp, 'speed', 'bpmCount32', 'syncMode', 'gate'));

    // Row 3: variance
    const row3 = document.createElement('div');
    row3.className = 'arp-row';
    const varKnob = new KnobWidget({
      label:   'VARIANCE',
      min:     0,
      max:     1,
      value:   arp.getParam('variance'),
      size:    64,
      fmt:     v => Math.round(v * 100) + '%',
      onChange: v => arp.setParam('variance', v),
    });
    this._widgets.push(varKnob);
    row3.appendChild(varKnob.el);
    body.appendChild(row3);

    this.container.appendChild(body);
  }

  // ── Manual mode ────────────────────────────────────────────────────────────

  _renderManual() {
    const arp  = this.track.arp;
    const body = document.createElement('div');
    body.className = 'arp-body';

    const steps = arp.getParam('steps');

    const list = document.createElement('div');
    list.className = 'arp-manual-list';

    steps.forEach((step, idx) => {
      const row = document.createElement('div');
      row.className = 'arp-manual-row';

      // Semitone offset knob
      const semKnob = new KnobWidget({
        label:   idx === 0 ? 'NOTE' : '+/−',
        min:     -24,
        max:     24,
        value:   step.semitone,
        bipolar: true,
        size:    52,
        fmt:     v => {
          const n = Math.round(v);
          return n === 0 ? '0' : (n > 0 ? '+' : '') + n;
        },
        onChange: v => {
          step.semitone = Math.round(v);
        },
      });
      this._widgets.push(semKnob);
      row.appendChild(semKnob.el);

      // Per-step unified MS↔BPM rate knob (click centre toggles this step's mode).
      const speedWrap = document.createElement('div');
      speedWrap.className = 'arp-manual-speed';

      const rateKnob = this._makeSyncKnob({
        label: 'RATE', size: 52,
        getMode:    () => step.syncMode,
        toggleMode: () => { step.syncMode = step.syncMode === 'bpm' ? 'ms' : 'bpm'; this.rebuildArp(); },
        getMs:    () => step.speed,      setMs:    v => { step.speed = v; },
        getCount: () => step.bpmCount32, setCount: v => { step.bpmCount32 = v; },
      });
      speedWrap.appendChild(rateKnob.el);

      row.appendChild(speedWrap);

      // Gate knob (0 = inherit step length)
      const gateKnob = new KnobWidget({
        label:   'GATE',
        min:     0,
        max:     1000,
        value:   step.gate,
        size:    52,
        fmt:     v => v < 1 ? 'STEP' : Math.round(v) + 'ms',
        onChange: v => { step.gate = Math.max(0, Math.round(v)); },
      });
      this._widgets.push(gateKnob);
      row.appendChild(gateKnob.el);

      // Remove button (hidden if only one step)
      if (steps.length > 1) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'arp-step-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          arp.removeManualStep(idx);
          this.rebuildArp();
        });
        row.appendChild(removeBtn);
      }

      list.appendChild(row);
    });

    body.appendChild(list);

    // Add step button
    const addBtn = document.createElement('button');
    addBtn.className = 'arp-add-step-btn';
    addBtn.textContent = '+ ADD STEP';
    addBtn.addEventListener('click', () => {
      arp.addManualStep();
      this.rebuildArp();
    });
    body.appendChild(addBtn);

    this.container.appendChild(body);
  }

  // ── Random mode ────────────────────────────────────────────────────────────

  _renderRandom() {
    const arp  = this.track.arp;
    const body = document.createElement('div');
    body.className = 'arp-body';

    const row1 = document.createElement('div');
    row1.className = 'arp-row';

    const countKnob = new KnobWidget({
      label:   'NOTES',
      min:     2,
      max:     8,
      value:   arp.getParam('noteCount'),
      size:    64,
      fmt:     v => Math.round(v).toString(),
      onChange: v => arp.setParam('noteCount', Math.round(v)),
    });
    this._widgets.push(countKnob);
    row1.appendChild(countKnob.el);

    const rangeKnob = new KnobWidget({
      label:   'RANGE ±',
      min:     1,
      max:     24,
      value:   arp.getParam('range'),
      size:    64,
      fmt:     v => '±' + Math.round(v),
      onChange: v => arp.setParam('range', Math.round(v)),
    });
    this._widgets.push(rangeKnob);
    row1.appendChild(rangeKnob.el);

    body.appendChild(row1);

    body.appendChild(this._makeSpeedGateRow(arp, 'speed', 'bpmCount32', 'syncMode', 'rGate'));

    const row3 = document.createElement('div');
    row3.className = 'arp-row';
    const varKnob = new KnobWidget({
      label:   'VARIANCE',
      min:     0,
      max:     1,
      value:   arp.getParam('variance'),
      size:    64,
      fmt:     v => Math.round(v * 100) + '%',
      onChange: v => arp.setParam('variance', v),
    });
    this._widgets.push(varKnob);
    row3.appendChild(varKnob.el);
    body.appendChild(row3);

    this.container.appendChild(body);
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  /**
   * Unified MS↔BPM rate knob. Clicking the knob centre toggles the sync mode;
   * the body shows the current mode ('MS'/'BPM'). In BPM mode the knob sweeps
   * the 1/32 grid and shift-drag/scroll snaps to musical divisions. Works for
   * both arp-level params and per-step objects via a small accessor bundle.
   * See design/sync-knob-rollout.md.
   *
   * @param {object} acc
   * @param {string} acc.label        knob label
   * @param {number} acc.size         knob px size
   * @param {() => string} acc.getMode  @param {() => void} acc.toggleMode
   * @param {() => number} acc.getMs    @param {(v:number)=>void} acc.setMs
   * @param {() => number} acc.getCount @param {(v:number)=>void} acc.setCount
   * @returns {KnobWidget}
   */
  _makeSyncKnob({ label, size, getMode, toggleMode, getMs, setMs, getCount, setCount }) {
    const isBpm = getMode() === 'bpm';
    const knob = new KnobWidget({
      label,
      min:   1,
      max:   isBpm ? 64  : 2000,
      value: isBpm ? getCount() : getMs(),
      size,
      fmt:   isBpm ? (v => formatCount32(v)) : (v => Math.round(v) + 'ms'),
      // Continuous in BPM mode; shift-drag/scroll snaps to musical divisions.
      snapPoints:  isBpm ? MUSICAL_SNAP_32 : null,
      centerLabel: isBpm ? 'BPM' : 'MS',
      onCenterClick: () => toggleMode(),
      onChange: v => isBpm ? setCount(Math.round(v)) : setMs(Math.round(v)),
    });
    this._widgets.push(knob);
    return knob;
  }

  /** Build a rate + gate row: [unified MS/BPM rate knob] [GATE knob] */
  _makeSpeedGateRow(arp, speedPath, countPath, syncModePath, gatePath) {
    const row = document.createElement('div');
    row.className = 'arp-row';

    const rateKnob = this._makeSyncKnob({
      label: 'RATE', size: 64,
      getMode:    () => arp.getParam(syncModePath),
      toggleMode: () => { arp.setParam(syncModePath, arp.getParam(syncModePath) === 'bpm' ? 'ms' : 'bpm'); this.rebuildArp(); },
      getMs:    () => arp.getParam(speedPath), setMs:    v => arp.setParam(speedPath, v),
      getCount: () => arp.getParam(countPath), setCount: v => arp.setParam(countPath, v),
    });
    row.appendChild(rateKnob.el);

    const gateKnob = new KnobWidget({
      label:   'GATE',
      min:     0,
      max:     2000,
      value:   arp.getParam(gatePath),
      size:    64,
      fmt:     v => v < 1 ? 'LEGATO' : Math.round(v) + 'ms',
      onChange: v => arp.setParam(gatePath, Math.max(0, Math.round(v))),
    });
    this._widgets.push(gateKnob);
    row.appendChild(gateKnob.el);

    return row;
  }

  _makeSelect(label, options, currentVal, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'arp-select-wrap';

    const lbl = document.createElement('div');
    lbl.className = 'arp-small-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const sel = document.createElement('select');
    sel.className = 'arp-select';
    options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o.toUpperCase();
      if (o === currentVal) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }
}
