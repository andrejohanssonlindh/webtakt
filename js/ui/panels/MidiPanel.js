/**
 * MidiPanel.js
 * ------------
 * Custom SYNTH tab for MidiMachine.
 * Shown instead of DefaultMachinePanel when track.machine.type === 'midi'.
 *
 * Layout:
 *   [Output port dropdown]
 *   [Channel knob]  [Note Offset knob]
 *   [Clock sync section: output port + enable toggle]
 *
 * Receives panel context from SynthPanel._makePanelContext() plus midiEngine.
 */

import { KnobWidget } from '../KnobWidget.js';

export class MidiPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} ctx           — standard panel context
   * @param {import('../../core/MidiEngine.js').MidiEngine} midiEngine
   */
  constructor(container, ctx, midiEngine) {
    this.container  = container;
    this.ctx        = ctx;
    this.midi       = midiEngine;
    this.machine    = ctx.machine;
    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    if (!this.midi?.available) {
      const msg = document.createElement('div');
      msg.className = 'midi-unavailable';
      msg.textContent = 'Web MIDI not available. Use Chrome/Edge and allow MIDI access.';
      this.container.appendChild(msg);
      return;
    }

    const outputs = [...this.midi.outputs.values()];

    // ── Output port ─────────────────────────────────────────────
    const portSection = document.createElement('div');
    portSection.className = 'midi-section';

    const portLabel = document.createElement('div');
    portLabel.className = 'midi-section-label';
    portLabel.textContent = 'MIDI Out Port';
    portSection.appendChild(portLabel);

    const portSel = document.createElement('select');
    portSel.className = 'midi-select';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    portSel.appendChild(noneOpt);

    outputs.forEach(out => {
      const opt = document.createElement('option');
      opt.value = out.id;
      opt.textContent = out.name;
      if (out.id === this.machine.getOutputPort()) opt.selected = true;
      portSel.appendChild(opt);
    });

    portSel.addEventListener('change', () => {
      this.machine.setOutputPort(portSel.value || null);
    });
    portSection.appendChild(portSel);
    this.container.appendChild(portSection);

    // ── Channel + Note Offset knobs ─────────────────────────────
    const knobRow = document.createElement('div');
    knobRow.className = 'midi-knob-row';

    const chKnob = new KnobWidget({
      label:   'Channel',
      min:     1,
      max:     16,
      value:   this.machine.getParam('midi.channel'),
      bipolar: false,
      size:    64,
      fmt:     v => Math.round(v).toString(),
      onChange: v => this.machine.setParam('midi.channel', Math.round(v)),
    });
    knobRow.appendChild(chKnob.el);
    this.ctx.activeWidgets.push(chKnob);

    const offsetKnob = new KnobWidget({
      label:   'Note Offset',
      min:     -24,
      max:     24,
      value:   this.machine.getParam('midi.noteOffset'),
      bipolar: true,
      size:    64,
      fmt:     v => { const n = Math.round(v); return n === 0 ? '0' : (n > 0 ? '+' : '') + n; },
      onChange: v => this.machine.setParam('midi.noteOffset', Math.round(v)),
    });
    knobRow.appendChild(offsetKnob.el);
    this.ctx.activeWidgets.push(offsetKnob);

    this.container.appendChild(knobRow);

    // ── Clock sync ───────────────────────────────────────────────
    const clockSection = document.createElement('div');
    clockSection.className = 'midi-section';

    const clockLabel = document.createElement('div');
    clockLabel.className = 'midi-section-label';
    clockLabel.textContent = 'Clock Sync Out';
    clockSection.appendChild(clockLabel);

    const clockRow = document.createElement('div');
    clockRow.className = 'midi-clock-row';

    const clockSel = document.createElement('select');
    clockSel.className = 'midi-select';

    const clockNone = document.createElement('option');
    clockNone.value = '';
    clockNone.textContent = '— none —';
    clockSel.appendChild(clockNone);

    outputs.forEach(out => {
      const opt = document.createElement('option');
      opt.value = out.id;
      opt.textContent = out.name;
      if (out.id === this.midi._syncOutputId) opt.selected = true;
      clockSel.appendChild(opt);
    });

    clockSel.addEventListener('change', () => {
      this.midi.setSyncOutput(clockSel.value || null);
    });

    clockRow.appendChild(clockSel);
    clockSection.appendChild(clockRow);
    this.container.appendChild(clockSection);
  }
}
