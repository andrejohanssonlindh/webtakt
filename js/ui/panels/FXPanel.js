/**
 * FXPanel.js
 * ----------
 * Generic FX tab renderer for DELAY / BITCRUSH / REVERB. Builds a knob row from
 * fxObj.getParamList(); modulatable params are p-lockable when a step is
 * selected, non-modulatable params are track-level. Enum params render as a
 * labelled button group. Extracted from SynthPanel._renderFXTab.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext) plus the
 * target FX object and optional format overrides:
 *   render(ctx, fxObj, fmtOverrides)
 */

import { KnobWidget } from '../KnobWidget.js';
import { formatCount32, FINE_STEP } from '../../util/BpmSync.js';

export class FXPanel {
  /**
   * @param {object} ctx — panel context
   * @param {object} fxObj — DelayFX | BitcrushFX | ReverbFX
   * @param {Object<string,Function>} [fmtOverrides] — path → formatter
   */
  render(ctx, fxObj, fmtOverrides = {}) {
    const { container, activeWidgets, knobByPath, state, fmtParam, renderContent } = ctx;
    const step    = ctx.step;
    const hasStep = step !== null;

    const wrapper = document.createElement('div');
    wrapper.className = 'fx-tab-wrapper';

    const knobRow = document.createElement('div');
    knobRow.className = 'fx-knob-row';
    wrapper.appendChild(knobRow);

    fxObj.getParamList().forEach(p => {
      if (p.hidden) return;

      const canPLock = p.modulatable;
      const hasPLock = canPLock && hasStep && step.plocks.has(p.path);
      const dispVal  = hasPLock ? step.plocks.get(p.path) : fxObj.getParam(p.path);

      if (p.type === 'sync') {
        this._renderSync(ctx, fxObj, p, knobRow, fmtOverrides);

      } else if (p.type === 'pattern') {
        this._renderPattern(ctx, fxObj, p, knobRow);

      } else if (p.type === 'enum') {
        // Render as a labelled button group inside the knob row
        const cell = document.createElement('div');
        cell.className = 'fx-enum-cell';

        const lbl = document.createElement('div');
        lbl.className = 'fx-enum-label';
        lbl.textContent = p.label;
        cell.appendChild(lbl);

        const btnRow = document.createElement('div');
        btnRow.className = 'fx-enum-btns';

        (p.options ?? []).forEach(opt => {
          const b = document.createElement('button');
          b.className = 'btn fx-enum-btn' + (dispVal === opt ? ' active' : '');
          b.textContent = opt;
          b.addEventListener('click', () => {
            fxObj.setParam(p.path, opt);
            // Rebuild the tab so hidden flags update
            renderContent();
          });
          btnRow.appendChild(b);
        });

        cell.appendChild(btnRow);
        knobRow.appendChild(cell);

      } else if (p.type === 'number') {
        const isBipolar = p.min !== undefined && p.max !== undefined && p.min < 0 && p.max > 0 && p.min === -p.max;
        const fmtFn = fmtOverrides[p.path] ?? (v => fmtParam(p, v));

        const knob = new KnobWidget({
          label:   p.label,
          min:     p.min ?? 0,
          max:     p.max ?? 1,
          value:   dispVal ?? p.default ?? p.min ?? 0,
          bipolar: isBipolar,
          size:    64,
          fmt:     fmtFn,
          onChange: v => {
            if (canPLock && hasStep) {
              step.setPLock(p.path, v);
              knob.setHasPLock(true);
            } else {
              fxObj.setParam(p.path, v);
            }
          },
          onRelease: () => {
            if (canPLock && hasStep) {
              state.emit('stepChanged', {
                trackIndex: state.selectedTrackIndex,
                stepIndex:  state.selectedStepIndex,
                step,
              });
            }
          },
        });
        knob.setHasPLock(hasPLock);
        knobRow.appendChild(knob.el);
        activeWidgets.push(knob);
        knobByPath.set(p.path, knob);
      }
    });

    // Note for non-p-lockable params (exclude enum/sync params from this list)
    const nonLockable = fxObj.getParamList().filter(p => !p.hidden && !p.modulatable && p.type === 'number');
    if (nonLockable.length > 0) {
      const note = document.createElement('div');
      note.className = 'fx-tab-note';
      note.textContent = nonLockable.map(p => p.label).join(', ') + ': track-level only';
      wrapper.appendChild(note);
    }

    container.appendChild(wrapper);
  }

  /**
   * Render a unified MS/BPM sync control: one mode-aware knob + an MS/BPM
   * toggle. In MS mode the knob drives the seconds param (p-lockable); in BPM
   * mode it sweeps the 1/32-note grid (track-level), shift snapping to musical
   * divisions. See design/audio-signal-chain.md (Unified Sync-Knob Model).
   */
  _renderSync(ctx, fxObj, p, knobRow, fmtOverrides) {
    const { activeWidgets, knobByPath, state, fmtParam, renderContent } = ctx;
    const step    = ctx.step;
    const hasStep = step !== null;

    const isBpm   = fxObj.getParam(p.modePath) === 'bpm';
    const list    = fxObj.getParamList();
    const msDesc  = list.find(x => x.path === p.msPath);
    const bpmDesc = list.find(x => x.path === p.bpmPath);

    // Active path + value. Both modes are p-lockable when their underlying
    // param is modulatable (ms → audioParam p-lock, bpm count → js p-lock).
    const activePath = isBpm ? p.bpmPath : p.msPath;
    const canPLock   = (isBpm ? bpmDesc : msDesc)?.modulatable;
    const hasPLock   = canPLock && hasStep && step.plocks.has(activePath);
    const dispVal    = hasPLock ? step.plocks.get(activePath) : fxObj.getParam(activePath);

    const min  = isBpm ? p.bpmMin : (msDesc?.min ?? 0);
    const max  = isBpm ? p.bpmMax : (msDesc?.max ?? 1);
    const fmt  = isBpm
      ? (v => formatCount32(v))
      : (fmtOverrides[p.msPath] ?? (v => fmtParam(msDesc ?? { path: p.msPath }, v)));

    const cell = document.createElement('div');
    cell.className = 'fx-sync-cell knob-cell';

    const knob = new KnobWidget({
      label:   p.label,
      min, max,
      value:   dispVal ?? min,
      size:    64,
      fmt,
      snapPoints: isBpm ? p.bpmSnap : null,
      // Double-click the knob center to toggle modes. Center shows the current
      // mode; offLabel lets rate-style sync knobs read 'HZ' instead of 'MS'.
      centerLabel: isBpm ? 'BPM' : (p.offLabel ?? 'MS'),
      // `noToggle` sync knobs are BPM-only (gate/stutter slice size) — there is no
      // MS mode to switch to, so the center double-click is suppressed.
      onCenterClick: p.noToggle ? null : () => {
        fxObj.setParam(p.modePath, isBpm ? 'ms' : 'bpm');
        renderContent();   // rebuild so the knob picks up the new range/value
      },
      onChange: v => {
        // BPM mode steps on the fine sub-grid (1/FINE_STEP of a base grid unit)
        // so the knob lands BETWEEN musical divisions, not only on integers.
        const val = isBpm ? Math.round(v * FINE_STEP) / FINE_STEP : v;
        if (canPLock && hasStep) {
          step.setPLock(activePath, val);
          knob.setHasPLock(true);
        } else {
          fxObj.setParam(activePath, val);
        }
      },
      onRelease: () => {
        if (canPLock && hasStep) {
          state.emit('stepChanged', {
            trackIndex: state.selectedTrackIndex,
            stepIndex:  state.selectedStepIndex,
            step,
          });
        }
      },
    });
    knob.setHasPLock(hasPLock);
    cell.appendChild(knob.el);

    knobRow.appendChild(cell);
    activeWidgets.push(knob);
    knobByPath.set(activePath, knob);
  }

  /**
   * Render a step on/off pattern (GateFX): a row of toggle cells whose '1'/'0'
   * mask is the param value. Track-level (no p-lock) — clicking a cell flips it
   * and writes the whole mask back via setParam.
   */
  _renderPattern(ctx, fxObj, p, knobRow) {
    const slots = p.slots ?? 16;
    let mask = String(fxObj.getParam(p.path) ?? p.default ?? '').padEnd(slots, '0').slice(0, slots);

    const cell = document.createElement('div');
    cell.className = 'fx-pattern-cell';

    const lbl = document.createElement('div');
    lbl.className = 'fx-enum-label';
    lbl.textContent = p.label;
    cell.appendChild(lbl);

    const grid = document.createElement('div');
    grid.className = 'fx-pattern-grid';

    const cells = [];
    for (let i = 0; i < slots; i++) {
      const b = document.createElement('button');
      b.className = 'btn fx-pattern-step' + (mask[i] === '1' ? ' active' : '');
      b.addEventListener('click', () => {
        const arr = mask.split('');
        arr[i] = arr[i] === '1' ? '0' : '1';
        mask = arr.join('');
        b.classList.toggle('active', mask[i] === '1');
        fxObj.setParam(p.path, mask);
      });
      grid.appendChild(b);
      cells.push(b);
    }

    cell.appendChild(grid);
    knobRow.appendChild(cell);
  }
}
