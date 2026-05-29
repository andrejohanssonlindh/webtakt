/**
 * FilterPanel.js
 * --------------
 * FILTER tab: type dropdown, main filter knobs (cutoff/res/gain/env/slope),
 * base LPF/HPF knobs, FilterViz response curve, and the filter-env ADSR.
 * Extracted from SynthPanel.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, step, hasStep, container, activeWidgets, knobByPath, state,
 *     writeValue, getStep, hasStepNow, setActiveViz }
 */

import { KnobWidget } from '../KnobWidget.js';
import { ADSRWidget } from '../ADSRWidget.js';
import { FilterViz }  from '../FilterViz.js';

export class FilterPanel {
  render(ctx) {
    const { track, container, activeWidgets, knobByPath, state,
            writeValue, getStep, hasStepNow, setActiveViz } = ctx;
    const step    = ctx.step;
    const hasStep = step !== null;

    const emitStep = () => {
      if (hasStep) state.emit('stepChanged', {
        trackIndex: state.selectedTrackIndex,
        stepIndex:  state.selectedStepIndex,
        step,
      });
    };

    // Plock-aware param readers — used by viz so it reflects p-locked values
    const getFilterParam = path => (hasStep && step.plocks.has(path)) ? step.plocks.get(path) : track.filter.getParam(path);
    const getEnvParam    = path => (hasStep && step.plocks.has(path)) ? step.plocks.get(path) : track.envelope.getParam(path);

    // ── Outer wrapper ────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-tab-wrapper';
    container.appendChild(wrapper);

    // ── SINGLE ROW: knobs | viz | fenv+base ──────────────────
    const topRow = document.createElement('div');
    topRow.className = 'filter-top-row';
    wrapper.appendChild(topRow);

    const knobSec = document.createElement('div');
    knobSec.className = 'filter-knob-sec';
    topRow.appendChild(knobSec);

    const vizSec = document.createElement('div');
    vizSec.className = 'filter-viz-sec';
    topRow.appendChild(vizSec);

    const mainViz = new FilterViz({
      getFilter:   () => track.filter,
      getEnvelope: () => track.envelope,
      getParam:    getFilterParam,
      getEnvParam: getEnvParam,
      showBase:    true,
      height:      118,
    });
    vizSec.appendChild(mainViz.el);
    activeWidgets.push({ destroy: () => mainViz.destroy() });
    setActiveViz(mainViz);
    requestAnimationFrame(() => mainViz.refresh());

    // Helper: p-lock-aware knob for a filter param
    const mkKnob = (path, label, min, max, defaultVal, bipolar, fmtFn) => {
      const hasPLock = hasStep && step?.plocks.has(path);
      const dispVal  = hasPLock ? step.plocks.get(path) : track.filter.getParam(path);
      const knob = new KnobWidget({
        label, min, max,
        value:   dispVal ?? defaultVal,
        bipolar: bipolar ?? false,
        size:    58,
        fmt:     fmtFn,
        onChange: v => {
          writeValue(track.filter, path, v, false);
          knob.setHasPLock(hasStep);
          mainViz.refresh();
        },
        onRelease: () => {
          emitStep();
          mainViz.refresh();
        },
      });
      knob.setHasPLock(hasPLock);
      return knob;
    };

    // Type dropdown
    const typeRow = document.createElement('div');
    typeRow.className = 'filter-type-row';
    const typeLbl = document.createElement('span');
    typeLbl.className = 'param-label label';
    typeLbl.textContent = 'TYPE';
    const typeSel = document.createElement('select');
    typeSel.className = 'param-select';
    ['lowpass','highpass','bandpass','notch','peaking','allpass'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (track.filter.getParam('filter.type') === opt) o.selected = true;
      typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', () => {
      const newType = typeSel.value;
      writeValue(track.filter, 'filter.type', newType, true);
      gainKnob.el.style.display = newType === 'peaking' ? '' : 'none';
      // Peaking EQ needs non-zero gain for any effect — seed a +6dB default
      if (newType === 'peaking' && track.filter.getParam('filter.gain') === 0) {
        writeValue(track.filter, 'filter.gain', 6, true);
        gainKnob.setValue(6);
      }
      mainViz.refresh();
    });
    typeRow.appendChild(typeLbl);
    typeRow.appendChild(typeSel);
    knobSec.appendChild(typeRow);

    // Cutoff, Res, Gain, Env in a horizontal row
    const mainKnobRow = document.createElement('div');
    mainKnobRow.className = 'filter-knob-row';
    knobSec.appendChild(mainKnobRow);

    const cutoffKnob = mkKnob('filter.cutoff',    'CUTOFF', 20,  20000, 8000, false, v => Math.round(v) + 'Hz');
    const resKnob    = mkKnob('filter.resonance',  'RES',   0.1, 20,    1,    false, v => v.toFixed(1));
    const gainKnob   = mkKnob('filter.gain',       'GAIN',  -30, 30,    0,    true,  v => (v >= 0 ? '+' : '') + v.toFixed(1) + 'dB');
    const envAmtKnob = mkKnob('filter.envAmount',  'ENV',   -1,  1,     0.3,  true,  v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%');
    const slopeKnob  = mkKnob('filter.slope',      'SLOPE', 0,   1,     0,    false, v => {
      const poles = 1 + Math.round(v * 7);
      return poles + 'P/' + (poles * 12) + 'dB';
    });

    gainKnob.el.style.display = getFilterParam('filter.type') === 'peaking' ? '' : 'none';

    mainKnobRow.appendChild(cutoffKnob.el);
    mainKnobRow.appendChild(resKnob.el);
    mainKnobRow.appendChild(gainKnob.el);
    mainKnobRow.appendChild(envAmtKnob.el);
    mainKnobRow.appendChild(slopeKnob.el);
    activeWidgets.push(cutoffKnob, resKnob, gainKnob, envAmtKnob, slopeKnob);
    knobByPath.set('filter.cutoff',    cutoffKnob);
    knobByPath.set('filter.resonance', resKnob);
    knobByPath.set('filter.gain',      gainKnob);
    knobByPath.set('filter.envAmount', envAmtKnob);
    knobByPath.set('filter.slope',     slopeKnob);

    // ── Base filter knobs — below main knobs in the left column
    const baseKnobRow = document.createElement('div');
    baseKnobRow.className = 'filter-knob-row';
    knobSec.appendChild(baseKnobRow);

    [
      { path:'base.lpf', label:'LPF', min:200, max:20000, default:20000 },
      { path:'base.hpf', label:'HPF', min:20,  max:8000,  default:20   },
    ].forEach(p => {
      const hasPLock = hasStep && step?.plocks.has(p.path);
      const dispVal  = hasPLock ? step.plocks.get(p.path) : track.filter.getParam(p.path);
      const knob = new KnobWidget({
        label: p.label, min: p.min, max: p.max,
        value:   dispVal ?? p.default,
        bipolar: false, size: 58,
        fmt:     v => Math.round(v) + 'Hz',
        onChange: v => {
          writeValue(track.filter, p.path, v, false);
          knob.setHasPLock(hasStep);
          mainViz.refresh();
        },
        onRelease: () => {
          emitStep();
          mainViz.refresh();
        },
      });
      knob.setHasPLock(hasPLock);
      baseKnobRow.appendChild(knob.el);
      activeWidgets.push(knob);
      knobByPath.set(p.path, knob);
    });

    // ── Right column: filter env ADSR only ───────────────────
    const rightCol = document.createElement('div');
    rightCol.className = 'filter-right-col';
    topRow.appendChild(rightCol);

    const fenvSec = document.createElement('div');
    fenvSec.className = 'filter-fenv-sec';
    rightCol.appendChild(fenvSec);

    const fenvLabel = document.createElement('div');
    fenvLabel.className = 'filter-env-label';
    fenvLabel.textContent = 'FILTER ENV';
    fenvSec.appendChild(fenvLabel);

    const fenv = new ADSRWidget({
      prefix:   'fenv',
      canvasH:  80,
      getParam:     path => track.envelope.getParam(path),
      setParam:     (path, value) => {
        const s = getStep();
        if (s) { s.setPLock(path, value); } else { track.envelope.setParam(path, value); }
        mainViz.refresh();
      },
      getStepPLock: path => step ? (step.plocks.has(path) ? step.plocks.get(path) : null) : null,
      setStepPLock: (path, value) => { if (step) { step.setPLock(path, value); mainViz.refresh(); } },
      onRelease: () => {
        const s = getStep();
        if (s) state.emit('stepChanged', { trackIndex: state.selectedTrackIndex, stepIndex: state.selectedStepIndex, step: s });
        mainViz.refresh();
      },
      hasStep: () => hasStepNow(),
    });
    fenvSec.appendChild(fenv.el);
    activeWidgets.push(fenv);
    requestAnimationFrame(() => fenv.refresh());
  }
}
