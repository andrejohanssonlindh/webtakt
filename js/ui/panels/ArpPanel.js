/**
 * ArpPanel.js
 * -----------
 * ARP tab UI. Renders controls for the track's Arpeggiator instance.
 *
 * Four sub-layouts toggled by an ARP MODE selector:
 *   Chord  — chord type, pattern (Up/Down/UpDown/Random), speed/BPM-sync, variance
 *   Manual — scrollable list of steps: semitone, speed/sync, gate. + Add / × Remove.
 *   Random — note count, range, speed/sync, variance
 *   Input  — LIVE keyboard-driven: hold keys to arp them (pattern/rate/gate/variance).
 *            No chord type — the held keys are the chord. RECORD captures them to steps.
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
   * @param {object} [ctx]  — SynthPanel tab context; enables p-locking the
   *                          rate/gate/variance knobs (arp.rate/gate/variance).
   */
  constructor(container, track, rebuildArp, ctx = null) {
    this.container  = container;
    this.track      = track;
    this.rebuildArp = rebuildArp;
    this.ctx        = ctx;
    this._widgets   = [];
    this._render();
  }

  /** Currently-selected step (for p-locking), or null. */
  get _step() {
    return this.ctx?.getStep?.() ?? null;
  }

  /**
   * Make a knob's onChange/onRelease p-lock-aware for an arp mod param. When a
   * step is selected the value is written as a p-lock on that step; otherwise it
   * sets the arp param live. Returns { value, hasPLock } for the knob's initial
   * state. Mirrors the trig.tone knob pattern in TrigPanel.
   *
   * @param {string} path  one of 'arp.rate' | 'arp.gate' | 'arp.variance'
   * @param {() => void} [setLive]  custom live setter (defaults to arp.setParam)
   */
  _plockState(path) {
    const step    = this._step;
    const hasPLock = !!(step && step.plocks.has(path));
    const value    = hasPLock ? step.plocks.get(path) : this.track.arp.getParam(path);
    return { value, hasPLock };
  }

  _writeMod(path, value, knob, setLive) {
    const step = this._step;
    if (step) {
      step.setPLock(path, value);
      knob.setHasPLock(true);
    } else if (setLive) {
      setLive(value);
    } else {
      this.track.arp.setParam(path, value);
    }
  }

  _emitMod() {
    const step = this._step;
    if (step) this.ctx?.emitStep?.();
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
      if (!arp.enabled) this.track.liveArp?.releaseAll();
      this.rebuildArp();
    });
    headerRow.appendChild(onBtn);

    const modeWrap = document.createElement('div');
    modeWrap.className = 'arp-mode-wrap';

    ['chord', 'manual', 'random', 'input'].forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'arp-mode-btn' + (arp.getParam('mode') === m ? ' active' : '');
      btn.textContent = m.toUpperCase();
      btn.addEventListener('click', () => {
        arp.setParam('mode', m);
        // Stop any free-running live arp when leaving input mode mid-hold.
        if (m !== 'input') this.track.liveArp?.releaseAll();
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
    if (mode === 'input')  this._renderInput();
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
    body.appendChild(this._makeVarianceRow());

    this.container.appendChild(body);
  }

  // ── Input mode (live keyboard-driven) ───────────────────────────────────────

  _renderInput() {
    const arp  = this.track.arp;
    const body = document.createElement('div');
    body.className = 'arp-body';

    // Hint: explains the live model + recording capture.
    const hint = document.createElement('div');
    hint.className = 'arp-input-hint';
    hint.textContent =
      'Hold keys to arp them live. The held keys are the chord — ' +
      'no step needed. Turn on RECORD to capture what you play into the pattern.';
    body.appendChild(hint);

    // Pattern buttons (same as chord mode, minus the chord selector).
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
    body.appendChild(patWrap);

    // Rate + gate, then variance — identical controls to chord mode.
    body.appendChild(this._makeSpeedGateRow(arp, 'speed', 'bpmCount32', 'syncMode', 'gate'));
    body.appendChild(this._makeVarianceRow());

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
    body.appendChild(this._makeVarianceRow());

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
  _makeSyncKnob({ label, size, getMode, toggleMode, getMs, setMs, getCount, setCount,
                  hasPLock = false, onRelease = null, msMin = 1, msFmt = null }) {
    const isBpm = getMode() === 'bpm';
    const knob = new KnobWidget({
      label,
      min:   isBpm ? 1   : msMin,
      max:   isBpm ? 64  : 2000,
      value: isBpm ? getCount() : getMs(),
      size,
      fmt:   isBpm ? (v => formatCount32(v)) : (msFmt ?? (v => Math.round(v) + 'ms')),
      // Continuous in BPM mode; shift-drag/scroll snaps to musical divisions.
      snapPoints:  isBpm ? MUSICAL_SNAP_32 : null,
      centerLabel: isBpm ? 'BPM' : 'MS',
      onCenterClick: () => toggleMode(),
      // setMs/setCount receive (value, knob) so p-lock-aware callers can flag the
      // knob's p-lock highlight on write.
      onChange: v => isBpm ? setCount(Math.round(v), knob) : setMs(Math.round(v), knob),
      onRelease: onRelease ?? undefined,
    });
    knob.setHasPLock?.(hasPLock);
    this._widgets.push(knob);
    return knob;
  }

  /**
   * Build a rate + gate row: [unified MS/BPM rate knob] [GATE knob].
   *
   * Rate is always p-lockable/LFO-able via the virtual `arp.rate` (maps to
   * speed/bpmCount32 in the current sync mode). Gate is p-lockable via `arp.gate`
   * only when gatePath === 'gate' (chord/input). Random mode's separate `rGate`
   * is live-only (the virtual gate param aliases `gate`, not `rGate`).
   */
  _makeSpeedGateRow(arp, speedPath, countPath, syncModePath, gatePath) {
    const row = document.createElement('div');
    row.className = 'arp-row';

    // ── Rate (p-lock-aware via arp.rate) ──
    // When the selected step p-locks arp.rate, show the p-locked value (it's
    // stored in the current sync mode's unit); otherwise show the live value.
    const rateState = this._plockState('arp.rate');
    const rateKnob = this._makeSyncKnob({
      label: 'RATE', size: 64, hasPLock: rateState.hasPLock,
      getMode:    () => arp.getParam(syncModePath),
      toggleMode: () => {
        // Switching sync mode changes what arp.rate means — clear any rate p-lock
        // on the selected step so a stale ms/count value can't apply in the wrong unit.
        this._step?.plocks.delete('arp.rate');
        arp.setParam(syncModePath, arp.getParam(syncModePath) === 'bpm' ? 'ms' : 'bpm');
        this.rebuildArp();
      },
      getMs:    () => rateState.hasPLock ? rateState.value : arp.getParam(speedPath),
      setMs:    (v, knob) => this._writeMod('arp.rate', v, knob, x => arp.setParam(speedPath, x)),
      getCount: () => rateState.hasPLock ? rateState.value : arp.getParam(countPath),
      setCount: (v, knob) => this._writeMod('arp.rate', v, knob, x => arp.setParam(countPath, x)),
      onRelease: () => this._emitMod(),
    });
    row.appendChild(rateKnob.el);

    // ── Gate (unified MS/BPM, click centre to toggle) ──
    // Gate length has its own sync (gateSyncMode), independent of rate sync. In
    // MS mode it shows ms (0 = LEGATO); in BPM mode it's a 1/32 count (always an
    // explicit length, so no LEGATO). The ms value lives in the per-mode field
    // (gate/rGate); the BPM count is the shared gateBpmCount32.
    const gatePLockable = gatePath === 'gate';
    const gateState = gatePLockable
      ? this._plockState('arp.gate')
      : { value: arp.getParam(gatePath), hasPLock: false };
    const setGateMs = gatePLockable
      ? (v, knob) => this._writeMod('arp.gate', v, knob)
      : (v)        => arp.setParam(gatePath, v);
    const setGateCount = gatePLockable
      ? (v, knob) => this._writeMod('arp.gate', v, knob)
      : (v)        => arp.setParam('gateBpmCount32', v);
    const gateKnob = this._makeSyncKnob({
      label: 'GATE', size: 64, hasPLock: gateState.hasPLock,
      msMin: 0,
      msFmt: v => v < 1 ? 'LEGATO' : Math.round(v) + 'ms',
      getMode:    () => arp.getParam('gateSyncMode'),
      toggleMode: () => {
        // Switching gate sync changes what arp.gate means — clear any gate p-lock
        // on the selected step so a stale ms/count value can't apply in the wrong unit.
        this._step?.plocks.delete('arp.gate');
        arp.setParam('gateSyncMode', arp.getParam('gateSyncMode') === 'bpm' ? 'ms' : 'bpm');
        this.rebuildArp();
      },
      getMs:    () => gatePLockable && gateState.hasPLock ? gateState.value : arp.getParam(gatePath),
      setMs:    setGateMs,
      getCount: () => gatePLockable && gateState.hasPLock ? gateState.value : arp.getParam('gateBpmCount32'),
      setCount: setGateCount,
      onRelease: () => { if (gatePLockable) this._emitMod(); },
    });
    row.appendChild(gateKnob.el);

    return row;
  }

  /** Build a variance row (p-lock-aware via arp.variance). */
  _makeVarianceRow() {
    const row = document.createElement('div');
    row.className = 'arp-row';
    const st = this._plockState('arp.variance');
    const varKnob = new KnobWidget({
      label:   'VARIANCE',
      min:     0,
      max:     1,
      value:   st.value,
      size:    64,
      fmt:     v => Math.round(v * 100) + '%',
      onChange: v => this._writeMod('arp.variance', v, varKnob),
      onRelease: () => this._emitMod(),
    });
    varKnob.setHasPLock(st.hasPLock);
    this._widgets.push(varKnob);
    row.appendChild(varKnob.el);
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
