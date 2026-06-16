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

    // ── Sections ─────────────────────────────────────────────
    // The FILTER tab is built from `.param-group` sections placed directly in
    // .panel-content (same idiom as DefaultMachinePanel / FMPanel), so they
    // reflow 3-up desktop → 2-up iPad → 1-up phone via the shared `.param-group`
    // media queries. Sections: FILTER (type + main knobs) · RESPONSE (viz) ·
    // BASE (LPF/HPF) · FILTER ENV (ADSR).
    //
    // Small helper to spin up a labelled section with a body row.
    const mkSection = (label, extraClass) => {
      const sec = document.createElement('div');
      sec.className = 'param-group' + (extraClass ? ' ' + extraClass : '');
      const lbl = document.createElement('div');
      lbl.className = 'param-group-label';
      lbl.textContent = label;
      sec.appendChild(lbl);
      const body = document.createElement('div');
      body.className = 'param-group-body';
      sec.appendChild(body);
      container.appendChild(sec);
      return body;
    };

    // FILTER section: engine/type dropdowns + the main knob row. Dropdowns sit
    // above the knobs, so this body stacks vertically (filter-controls).
    const filterBody = mkSection('FILTER', 'filter-group');
    const knobSec = document.createElement('div');
    knobSec.className = 'filter-controls';
    filterBody.appendChild(knobSec);

    // RESPONSE section: the FilterViz curve.
    const vizSec = mkSection('RESPONSE', 'filter-viz-group');

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

    // Engine dropdown — the track ANALOGUE switch. Selecting 'analogue' drives
    // the whole analogue flow via Track.setAnalogue: the Moog ladder filter, RC
    // envelope curves, filter keytrack, velocity sensitivity, and the BBD chorus.
    // 'digital' is the clean default path. We label it ANALOGUE (not ENGINE) to
    // reflect that it is more than just the filter engine now.
    const engineRow = document.createElement('div');
    engineRow.className = 'filter-type-row';
    const engineLbl = document.createElement('span');
    engineLbl.className = 'param-label label';
    engineLbl.textContent = 'ANALOGUE';
    const engineSel = document.createElement('select');
    engineSel.className = 'param-select';
    ['digital','analogue'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (getFilterParam('filter.engine') === opt) o.selected = true;
      engineSel.appendChild(o);
    });
    engineSel.addEventListener('change', () => {
      // setAnalogue sets filter.engine (mirrored to all voice slots) + the chorus
      // enable as a unit, keeping the flow consistent.
      track.setAnalogue(engineSel.value === 'analogue');
      applyEngineVisibility(engineSel.value);
      mainViz.refresh();
    });
    engineRow.appendChild(engineLbl);
    engineRow.appendChild(engineSel);
    knobSec.appendChild(engineRow);

    // Type dropdown
    const typeRow = document.createElement('div');
    typeRow.className = 'filter-type-row';
    const typeLbl = document.createElement('span');
    typeLbl.className = 'param-label label';
    typeLbl.textContent = 'TYPE';
    const typeSel = document.createElement('select');
    typeSel.className = 'param-select';
    // The analogue ladder has no peaking response (it maps to LP), so 'peaking'
    // is offered on the digital engine only. Rebuilt on engine change below.
    const ALL_TYPES = ['lowpass','highpass','bandpass','notch','peaking','allpass'];
    function buildTypeOptions(engine) {
      const types = engine === 'analogue'
        ? ALL_TYPES.filter(t => t !== 'peaking')
        : ALL_TYPES;
      const current = track.filter.getParam('filter.type');
      typeSel.innerHTML = '';
      types.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (current === opt) o.selected = true;
        typeSel.appendChild(o);
      });
    }
    buildTypeOptions(getFilterParam('filter.engine'));
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
    // Analogue-ladder-only knobs (shown when engine = analogue).
    const driveKnob  = mkKnob('filter.drive',      'DRIVE', 0.1, 12,    2.0,  false, v => v.toFixed(1));
    const driftKnob  = mkKnob('filter.drift',      'DRIFT', 0,   0.08,  0.01, false, v => Math.round(v / 0.08 * 100) + '%');
    const keytrkKnob = mkKnob('filter.keytrack',   'KEYTRK', 0,   1,     0.0,  false, v => Math.round(v * 100) + '%');

    gainKnob.el.style.display = getFilterParam('filter.type') === 'peaking' ? '' : 'none';

    mainKnobRow.appendChild(cutoffKnob.el);
    mainKnobRow.appendChild(resKnob.el);
    mainKnobRow.appendChild(gainKnob.el);
    mainKnobRow.appendChild(envAmtKnob.el);
    mainKnobRow.appendChild(slopeKnob.el);
    mainKnobRow.appendChild(driveKnob.el);
    mainKnobRow.appendChild(driftKnob.el);
    mainKnobRow.appendChild(keytrkKnob.el);
    activeWidgets.push(cutoffKnob, resKnob, gainKnob, envAmtKnob, slopeKnob, driveKnob, driftKnob, keytrkKnob);
    knobByPath.set('filter.cutoff',    cutoffKnob);
    knobByPath.set('filter.resonance', resKnob);
    knobByPath.set('filter.gain',      gainKnob);
    knobByPath.set('filter.envAmount', envAmtKnob);
    knobByPath.set('filter.slope',     slopeKnob);
    knobByPath.set('filter.drive',     driveKnob);
    knobByPath.set('filter.drift',     driftKnob);
    knobByPath.set('filter.keytrack',  keytrkKnob);

    // Engine-dependent visibility: the analogue ladder is a fixed 24 dB/oct
    // (4-pole) filter, so SLOPE is N/A there; DRIVE + DRIFT are ladder-only.
    // TYPE (filter shape) IS supported on the ladder via Oberheim pole-mixing
    // (LP/HP/BP/notch/allpass — 'peaking' has no ladder response, maps to LP).
    function applyEngineVisibility(engine) {
      const analogue = engine === 'analogue';
      slopeKnob.el.style.opacity       = analogue ? '0.4' : '';
      slopeKnob.el.style.pointerEvents = analogue ? 'none' : '';
      driveKnob.el.style.display = analogue ? '' : 'none';
      driftKnob.el.style.display = analogue ? '' : 'none';
      keytrkKnob.el.style.display = analogue ? '' : 'none';
      // Switching to analogue while 'peaking' is selected: the ladder has no peak
      // response, so fall the type back to lowpass (and hide the gain knob).
      if (analogue && track.filter.getParam('filter.type') === 'peaking') {
        writeValue(track.filter, 'filter.type', 'lowpass', true);
        gainKnob.el.style.display = 'none';
      }
      buildTypeOptions(engine);
    }
    applyEngineVisibility(getFilterParam('filter.engine'));

    // ── BASE section: fixed LPF/HPF that bracket the main filter ──
    const baseKnobRow = mkSection('BASE', 'filter-base-group');

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

    // ── FILTER ENV section: the filter-envelope ADSR ──────────
    const fenvSec = mkSection('FILTER ENV', 'filter-fenv-group');

    const fenv = new ADSRWidget({
      prefix:   'fenv',
      canvasH:  80,
      getBpm:       () => track.clock?.bpm ?? 120,
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
