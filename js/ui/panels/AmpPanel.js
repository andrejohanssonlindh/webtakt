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

    // ── Amp ADSR (right, compact) ──────────────────────────────
    const adsrSec = document.createElement('div');
    adsrSec.className = 'amp-adsr-sec';
    row.appendChild(adsrSec);

    const adsr = new ADSRWidget({
      prefix:   'env',
      canvasH:  80,
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
