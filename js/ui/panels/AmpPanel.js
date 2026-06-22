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
    const writeValue = ctx.writeValue;

    // ── AMP section (pan + velocity knobs) ─────────────────────
    // `.param-group` sections (same idiom as DefaultMachinePanel / FMPanel):
    // sit side-by-side in .panel-content and reflow 3-up desktop → 2-up iPad →
    // 1-up phone via the shared `.param-group` media queries. No bespoke layout.
    const panSec = document.createElement('div');
    panSec.className = 'param-group amp-group';
    const panLbl = document.createElement('div');
    panLbl.className = 'param-group-label';
    panLbl.textContent = 'AMP';
    panSec.appendChild(panLbl);
    const panBody = document.createElement('div');
    panBody.className = 'param-group-body';
    panSec.appendChild(panBody);
    container.appendChild(panSec);

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
    panBody.appendChild(panKnob.el);
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
    panBody.appendChild(velKnob.el);
    activeWidgets.push(velKnob);
    knobByPath.set('env.velSens', velKnob);

    // ── Master output LEVEL (the machine's overall out level) ──
    // Every machine's "overall out level" now lives here on the AMP page rather
    // than in its own panel (per-oscillator / per-operator / sub levels stay in
    // the synth). The actual param is the machine's master-level path (usually
    // 'output.level'), found via Machine.ampLevelPath(); writes go through the
    // same p-lock-aware path the machine panel used (ctx.writeValue → step p-lock
    // when a step is selected, else machine.setParam + pool sync). Machines with
    // no master level (e.g. MIDI) skip the knob entirely.
    const levelPath = track.machine.ampLevelPath?.();
    if (levelPath) {
      const hasLvlPLock = hasStep && step.plocks.has(levelPath);
      const lvlVal = () => {
        if (hasStep && step.plocks.has(levelPath)) return step.plocks.get(levelPath);
        return track.machine.getParam(levelPath);
      };
      const levelKnob = new KnobWidget({
        label:   'LEVEL',
        min:     0,
        max:     1,
        value:   lvlVal(),
        bipolar: false,
        size:    64,
        fmt:     v => Math.round(v * 100) + '%',
        onChange: v => {
          writeValue(track.machine, levelPath, v, false);
          levelKnob.setHasPLock(hasStep);
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
      levelKnob.setHasPLock(hasLvlPLock);
      panBody.appendChild(levelKnob.el);
      activeWidgets.push(levelKnob);
      knobByPath.set(levelPath, levelKnob);
    }

    // ── → FX TRACK send ────────────────────────────────────────
    // Route this track through the global FX track (insert) before output. Shown
    // on every normal track; the FX track itself has no send-to-self.
    const fxTrack = state.project.fxTrack;
    if (fxTrack && track !== fxTrack) {
      const sendWrap = document.createElement('div');
      sendWrap.className = 'amp-send-wrap';
      const sendBtn = document.createElement('button');
      sendBtn.className = 'amp-send-btn';
      const syncSend = () => {
        sendBtn.textContent = track.fxSend ? '→ FX TRACK: ON' : '→ FX TRACK';
        sendBtn.classList.toggle('on', !!track.fxSend);
      };
      syncSend();
      sendBtn.addEventListener('click', () => {
        track.setFXSend(!track.fxSend, fxTrack);
        syncSend();
        state.emit('fxSendChanged', { track });
      });
      sendWrap.appendChild(sendBtn);
      panBody.appendChild(sendWrap);
    }

    // ── ENVELOPE section (amp ADSR) ────────────────────────────
    const adsrSec = document.createElement('div');
    adsrSec.className = 'param-group amp-adsr-group';
    const adsrLbl = document.createElement('div');
    adsrLbl.className = 'param-group-label';
    adsrLbl.textContent = 'ENVELOPE';
    adsrSec.appendChild(adsrLbl);
    const adsrBody = document.createElement('div');
    adsrBody.className = 'param-group-body';
    adsrSec.appendChild(adsrBody);
    container.appendChild(adsrSec);

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

    adsrBody.appendChild(adsr.el);
    activeWidgets.push(adsr);

    requestAnimationFrame(() => adsr.refresh());
  }
}
