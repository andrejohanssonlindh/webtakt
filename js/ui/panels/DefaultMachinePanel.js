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
import { formatCount32, MUSICAL_SNAP_32 } from '../../util/BpmSync.js';

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

    // Path set including hidden params, used to detect MS↔BPM sync trios:
    // a visible rate knob `<base>.<x>` whose machine also exposes
    // `<base>.syncMode` + `<base>.bpmCount32` is rendered as one mode-aware knob.
    const allPaths = new Set(machine.getParamList().map(p => p.path));

    machine.getParamList().forEach(p => {
      if (p.hidden) return;

      const base = p.path.includes('.') ? p.path.slice(0, p.path.lastIndexOf('.')) : null;
      if (p.type === 'number' && base
          && allPaths.has(`${base}.syncMode`) && allPaths.has(`${base}.bpmCount32`)) {
        this._renderSyncKnob(ctx, p, base);
        return;
      }

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

  /**
   * Render a unified MS↔BPM (here Hz↔BPM) sync knob for a machine rate param.
   * Double-clicking the knob centre toggles `<base>.syncMode`; the body shows
   * the current mode ('HZ'/'BPM'). In Hz mode the knob drives `<rateP>.path`
   * (the raw Hz value); in BPM mode it drives `<base>.bpmCount32` (1/32 period
   * count), shift-snapping to musical divisions. Both modes are p-lockable —
   * `writeValue` routes to step.plocks when a step is selected, exactly like the
   * FX delay sync knob. See design/audio-signal-chain.md (Unified Sync-Knob Model).
   */
  _renderSyncKnob(ctx, rateP, base) {
    const { machine, track, step, hasStep, container, activeWidgets, knobByPath,
            writeValue, emitStep, fmtParam, renderContent } = ctx;

    const modePath  = `${base}.syncMode`;
    const countPath = `${base}.bpmCount32`;
    const countP    = machine.getParamList().find(x => x.path === countPath);
    const isBpm     = machine.getParam(modePath) === 'bpm';

    const activePath = isBpm ? countPath : rateP.path;
    const min  = isBpm ? (countP?.min ?? 1)   : (rateP.min ?? 0);
    const max  = isBpm ? (countP?.max ?? 128) : (rateP.max ?? 1);
    const fmt  = isBpm ? (v => formatCount32(v)) : (v => fmtParam(rateP, v));

    const hasPLock   = hasStep && step.plocks.has(activePath);
    const displayVal = hasPLock ? step.plocks.get(activePath) : machine.getParam(activePath);

    const knob = new KnobWidget({
      label:   rateP.label,
      min, max,
      value:   displayVal ?? min,
      size:    64,
      fmt,
      snapPoints:  isBpm ? MUSICAL_SNAP_32 : null,
      centerLabel: isBpm ? 'BPM' : 'HZ',
      onCenterClick: () => {
        // Toggle on the machine directly (mode is a setting, not a per-step lock,
        // matching FXPanel) and mirror to the non-canonical voice slots, then
        // rebuild so the knob picks up the new range/value/label.
        machine.setParam(modePath, isBpm ? 'hz' : 'bpm');
        if (track && machine === track.machine) track._pool?.syncParams();
        renderContent();
      },
      onChange: v => {
        writeValue(machine, activePath, v, false);
        knob.setHasPLock(hasStep);
      },
      onRelease: () => { if (hasStep) emitStep(); },
    });
    knob.setHasPLock(hasPLock);
    container.appendChild(knob.el);
    activeWidgets.push(knob);
    knobByPath?.set(activePath, knob);
  }
}
