/**
 * AmpPanel.js
 * -----------
 * AMP tab: pan knob (p-lockable) + amp ADSR widget. Extracted from
 * SynthPanel._renderEnv.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, step, container, activeWidgets, knobByPath, state, getStep, hasStepNow }
 */

import { KnobWidget } from '../KnobWidget.js';
import { ADSRWidget } from '../ADSRWidget.js';

export class AmpPanel {
  render(ctx) {
    const { track, container, activeWidgets, knobByPath, state, getStep, hasStepNow } = ctx;
    const step    = ctx.step;
    const hasStep = step !== null;

    const row = document.createElement('div');
    row.className = 'amp-tab-row';
    container.appendChild(row);

    // ── Pan knob (left) ────────────────────────────────────────
    const panSec = document.createElement('div');
    panSec.className = 'amp-pan-sec';
    row.appendChild(panSec);

    const hasPanPLock = hasStep && step.plocks.has('amp.pan');
    const panVal = () => {
      if (hasStep && step.plocks.has('amp.pan')) return step.plocks.get('amp.pan');
      return track.pannerNode.pan.value;
    };

    const panKnob = new KnobWidget({
      label:   'PAN',
      min:     -1,
      max:     1,
      value:   panVal(),
      bipolar: true,
      size:    64,
      fmt:     v => {
        if (Math.abs(v) < 0.01) return 'C';
        return (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
      },
      onChange: v => {
        if (hasStep) {
          step.setPLock('amp.pan', v);
          panKnob.setHasPLock(true);
        } else {
          track.pannerNode.pan.setTargetAtTime(v, track.audio.context.currentTime, 0.005);
        }
      },
      onRelease: () => {
        if (hasStep) {
          state.emit('stepChanged', {
            trackIndex: state.selectedTrackIndex,
            stepIndex:  state.selectedStepIndex,
            step,
          });
        }
      },
    });
    panKnob.setHasPLock(hasPanPLock);
    panSec.appendChild(panKnob.el);
    activeWidgets.push(panKnob);
    knobByPath.set('amp.pan', panKnob);

    // ── Velocity sensitivity (analogue flow) ───────────────────
    // How much note velocity scales the amp + filter envelope. Only takes effect
    // when the track is in analogue mode; harmless (no-op) otherwise, so it is
    // always shown. p-lockable like pan.
    const hasVelPLock = hasStep && step.plocks.has('env.velSens');
    const velVal = () => {
      if (hasStep && step.plocks.has('env.velSens')) return step.plocks.get('env.velSens');
      return track.envelope.getParam('env.velSens');
    };
    const velKnob = new KnobWidget({
      label:   'VEL',
      min:     0,
      max:     1,
      value:   velVal(),
      bipolar: false,
      size:    64,
      fmt:     v => Math.round(v * 100) + '%',
      onChange: v => {
        if (hasStep) {
          step.setPLock('env.velSens', v);
          velKnob.setHasPLock(true);
        } else {
          track.envelope.setParam('env.velSens', v);
        }
      },
      onRelease: () => {
        if (hasStep) {
          state.emit('stepChanged', {
            trackIndex: state.selectedTrackIndex,
            stepIndex:  state.selectedStepIndex,
            step,
          });
        }
      },
    });
    velKnob.setHasPLock(hasVelPLock);
    panSec.appendChild(velKnob.el);
    activeWidgets.push(velKnob);
    knobByPath.set('env.velSens', velKnob);

    // ── Amp ADSR (right, compact) ──────────────────────────────
    const adsrSec = document.createElement('div');
    adsrSec.className = 'amp-adsr-sec';
    row.appendChild(adsrSec);

    const adsr = new ADSRWidget({
      prefix:   'env',
      canvasH:  80,
      getBpm:       () => track.clock?.bpm ?? 120,
      getParam:     path => track.envelope.getParam(path),
      setParam:     (path, value) => {
        const s = getStep();
        if (s) { s.setPLock(path, value); } else { track.envelope.setParam(path, value); }
      },
      getStepPLock: path => {
        if (!step) return null;
        return step.plocks.has(path) ? step.plocks.get(path) : null;
      },
      setStepPLock: (path, value) => {
        if (!step) return;
        step.setPLock(path, value);
      },
      onRelease: () => {
        const s = getStep();
        if (s) {
          state.emit('stepChanged', {
            trackIndex: state.selectedTrackIndex,
            stepIndex:  state.selectedStepIndex,
            step: s,
          });
        }
      },
      hasStep: () => hasStepNow(),
    });

    adsrSec.appendChild(adsr.el);
    activeWidgets.push(adsr);

    requestAnimationFrame(() => adsr.refresh());
  }
}
