/**
 * DefaultMachinePanel.js
 * ----------------------
 * Generic SYNTH tab layout for all machines that don't need a custom layout.
 * Renders the machine's getParamList() as a flat row of knobs/selects/checkboxes.
 *
 * Receives a panel context object from SynthPanel:
 *   { machine, step, hasStep, container, activeWidgets, writeValue, emitStep, fmtParam }
 */

import { KnobWidget } from '../KnobWidget.js';

export class DefaultMachinePanel {
  /**
   * @param {object} ctx
   * @param {object}   ctx.machine       — the track's machine instance
   * @param {object|null} ctx.step       — selected Step or null
   * @param {boolean}  ctx.hasStep       — true when a step is selected
   * @param {HTMLElement} ctx.container  — element to append DOM into
   * @param {Array}    ctx.activeWidgets — push destroyable widgets here
   * @param {Function} ctx.writeValue    — (target, path, value, emitChange)
   * @param {Function} ctx.emitStep      — emit stepChanged for the current step
   * @param {Function} ctx.fmtParam      — (paramDescriptor, value) → string
   */
  render(ctx) {
    const { machine, step, hasStep, container, activeWidgets, knobByPath, writeValue, emitStep, fmtParam } = ctx;

    machine.getParamList().forEach(p => {
      if (p.hidden) return;

      const hasPLock   = hasStep && step.plocks.has(p.path);
      const displayVal = hasPLock ? step.plocks.get(p.path) : machine.getParam(p.path);

      if (p.type === 'number') {
        const isBipolar = p.min < 0 && p.max > 0 && p.min === -p.max;
        const knob = new KnobWidget({
          label:   p.label,
          min:     p.min ?? 0,
          max:     p.max ?? 1,
          value:   displayVal ?? p.default ?? p.min ?? 0,
          bipolar: isBipolar,
          size:    64,
          fmt:     v => fmtParam(p, v),
          onChange: v => {
            writeValue(machine, p.path, v, false);
            knob.setHasPLock(hasStep);
          },
          onRelease: () => { if (hasStep) emitStep(); },
        });
        knob.setHasPLock(hasPLock);
        container.appendChild(knob.el);
        activeWidgets.push(knob);
        knobByPath?.set(p.path, knob);

      } else if (p.type === 'enum') {
        const row = document.createElement('div');
        row.className = 'param-row';

        const label = document.createElement('span');
        label.className = 'param-label label' + (hasPLock ? ' has-plock' : '');
        label.textContent = p.label;

        const sel = document.createElement('select');
        sel.className = 'param-select';
        (p.options ?? []).forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (displayVal === opt) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
          writeValue(machine, p.path, sel.value, true);
          label.classList.toggle('has-plock', hasStep);
        });

        row.appendChild(label);
        row.appendChild(sel);
        container.appendChild(row);

      } else if (p.type === 'boolean') {
        const row = document.createElement('div');
        row.className = 'param-row';

        const label = document.createElement('span');
        label.className = 'param-label label' + (hasPLock ? ' has-plock' : '');
        label.textContent = p.label;

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = !!displayVal;
        cb.addEventListener('change', () => {
          writeValue(machine, p.path, cb.checked, true);
          label.classList.toggle('has-plock', hasStep);
        });

        row.appendChild(label);
        row.appendChild(cb);
        container.appendChild(row);
      }
    });
  }
}
