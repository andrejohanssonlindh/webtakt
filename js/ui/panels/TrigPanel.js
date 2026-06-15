/**
 * TrigPanel.js
 * ------------
 * TRIG tab: per-step trig parameters (length, chance, detune, tone, nudge,
 * condition), voice cards, shift buttons, and the no-step section (quantize,
 * note follow). Extracted from SynthPanel.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, step, hasStep, container, activeWidgets, knobByPath, state,
 *     renderContent }
 */

import { KnobWidget } from '../KnobWidget.js';
import { Condition }  from '../../sequencer/Condition.js';

export class TrigPanel {
  /** Convert MIDI note to name like C4, F#3 */
  _noteName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }

  /**
   * Build the ordered length steps list.
   * 1/16 → 16/16 (1/16 each), then coarser increments up to 256 bars.
   * Values are in ticks (1 tick = 1 step at default resolution).
   */
  _buildLengthSteps() {
    const steps = [];
    // 1/16 to 16/16 in increments of 1/16
    for (let n = 1; n <= 16; n++) steps.push(n / 16);
    // 1.25 to 4 in increments of 0.25 (skip 1.0 already added as 16/16)
    for (let n = 1.25; n <= 4.0 + 1e-9; n += 0.25) {
      if (n > 1.0 + 1e-9) steps.push(parseFloat(n.toFixed(2)));
    }
    // 4.5 to 8 in increments of 0.5
    for (let n = 4.5; n <= 8.0 + 1e-9; n += 0.5) steps.push(parseFloat(n.toFixed(1)));
    // 9 to 64 in increments of 1
    for (let n = 9; n <= 64; n++) steps.push(n);
    // 66 to 128 in increments of 2
    for (let n = 66; n <= 128; n += 2) steps.push(n);
    // 132 to 256 in increments of 4
    for (let n = 132; n <= 256; n += 4) steps.push(n);
    return steps;
  }

  render(ctx) {
    const { track, container, activeWidgets, knobByPath, state } = ctx;
    const renderContent = ctx.renderContent;

    const emitStep = () => state.emit('stepChanged', {
      trackIndex: state.selectedTrackIndex,
      stepIndex:  state.selectedStepIndex,
      step,
    });

    const panel = document.createElement('div');
    panel.className = 'trig-panel';

    const step    = ctx.step;
    const hasStep = step !== null;
    const refStep = hasStep ? step : (track.sequencer.steps[0] ?? {});

    const lengthSteps = this._buildLengthSteps();
    const curLen      = hasStep ? step.length : (refStep.length ?? 1);
    const lenIdx      = lengthSteps.reduce((best, v, i) =>
      Math.abs(v - curLen) < Math.abs(lengthSteps[best] - curLen) ? i : best, 0);

    const _fmtLen = v => {
      const val = lengthSteps[Math.round(v)];
      if (val === undefined) return '?';
      if (val < 1) return Math.round(val * 16) + '/16';
      if (Number.isInteger(val)) return val + ' bars';
      return val.toFixed(2) + ' bars';
    };

    const lengthKnob = new KnobWidget({
      label:   'LENGTH',
      min:     0,
      max:     lengthSteps.length - 1,
      value:   lenIdx,
      bipolar: false,
      size:    64,
      fmt:     _fmtLen,
      onChange: v => {
        const val = lengthSteps[Math.round(v)];
        if (hasStep) {
          step.length = val;
        } else {
          track.sequencer.steps.forEach(s => { s.length = val; });
        }
      },
      onRelease: () => { if (hasStep) emitStep(); },
    });

    const chanceKnob = new KnobWidget({
      label:   'CHANCE',
      min:     0,
      max:     100,
      value:   refStep.chance ?? 100,
      bipolar: false,
      size:    64,
      fmt:     v => Math.round(v) + '%',
      onChange: v => {
        const val = Math.round(v);
        if (hasStep) {
          step.chance = val;
        } else {
          track.sequencer.steps.forEach(s => { s.chance = val; });
        }
      },
      onRelease: () => { if (hasStep) emitStep(); },
    });

    const alwaysKnobsRow = document.createElement('div');
    alwaysKnobsRow.className = 'trig-knobs-row';
    alwaysKnobsRow.appendChild(lengthKnob.el);
    alwaysKnobsRow.appendChild(chanceKnob.el);

    // ── Detune knob (universal — p-lockable, LFOable on synth) ──
    const supportsDetune = track.machine.getParam('osc.detune') !== undefined;
    let detuneKnob = null;
    if (supportsDetune) {
      const hasDPLock   = hasStep && step?.plocks.has('osc.detune');
      const detuneVal   = hasDPLock ? step.plocks.get('osc.detune')
                        : (track.machine.getParam('osc.detune') ?? 0);
      detuneKnob = new KnobWidget({
        label:   'DETUNE',
        min:     -100,
        max:     100,
        value:   detuneVal,
        bipolar: true,
        size:    64,
        fmt:     v => (v >= 0 ? '+' : '') + Math.round(v) + '¢',
        onChange: v => {
          if (hasStep) {
            step.setPLock('osc.detune', v);
            detuneKnob.setHasPLock(true);
          } else {
            track.machine.setParam('osc.detune', v);
            track._pool?.syncParams();
          }
        },
        onRelease: () => { if (hasStep) emitStep(); },
      });
      detuneKnob.setHasPLock(hasDPLock);
      alwaysKnobsRow.appendChild(detuneKnob.el);
      activeWidgets.push(detuneKnob);
      knobByPath.set('osc.detune', detuneKnob);
    }

    // ── Tone knob (track-wide semitone transpose, p-lockable per step) ──
    const hasTonePLock = hasStep && step?.plocks.has('trig.tone');
    const toneVal      = hasTonePLock ? step.plocks.get('trig.tone') : (track.trigTone ?? 0);
    const toneKnob = new KnobWidget({
      label:   'TONE',
      min:     -24,
      max:     24,
      value:   toneVal,
      bipolar: true,
      size:    64,
      fmt:     v => {
        const n = Math.round(v);
        return n === 0 ? '0' : (n > 0 ? '+' : '') + n;
      },
      onChange: v => {
        const n = Math.round(v);
        if (hasStep) {
          step.setPLock('trig.tone', n);
          toneKnob.setHasPLock(true);
        } else {
          track.trigTone = n;
        }
      },
      onRelease: () => { if (hasStep) emitStep(); },
    });
    toneKnob.setHasPLock(hasTonePLock);
    alwaysKnobsRow.appendChild(toneKnob.el);

    // ── Velocity knob (track-wide base, p-lockable per step) ──
    const hasVelPLock = hasStep && step?.plocks.has('trig.velocity');
    const velVal      = hasVelPLock ? step.plocks.get('trig.velocity') : (track.trigVelocity ?? 127);
    const velKnob = new KnobWidget({
      label:    'VELOCITY',
      min:      1,
      max:      127,
      value:    velVal,
      bipolar:  false,
      size:     64,
      fmt:      v => Math.round(v),
      onChange: v => {
        const n = Math.max(1, Math.min(127, Math.round(v)));
        if (hasStep) {
          step.setPLock('trig.velocity', n);
          velKnob.setHasPLock(true);
        } else {
          track.trigVelocity = n;
        }
      },
      onRelease: () => { if (hasStep) emitStep(); },
    });
    velKnob.setHasPLock(hasVelPLock);
    alwaysKnobsRow.appendChild(velKnob.el);
    knobByPath.set('trig.velocity', velKnob);

    // ── Nudge knob — step-only, only visible when a step is selected ──
    if (hasStep) {
      const nudgePct = Math.round((step.nudge ?? 0) * 100);
      const nudgeKnob = new KnobWidget({
        label:   'NUDGE',
        min:     -99,
        max:     99,
        value:   nudgePct,
        bipolar: true,
        size:    64,
        fmt:     v => {
          const n = Math.round(v);
          return n === 0 ? '0%' : (n > 0 ? '+' : '') + n + '%';
        },
        onChange: v => {
          step.nudge = Math.round(v) / 100;
        },
        onRelease: () => emitStep(),
      });
      alwaysKnobsRow.appendChild(nudgeKnob.el);
      activeWidgets.push(nudgeKnob);
    }

    // ── Condition knob — step-only but in the top row to avoid scrolling ──
    if (hasStep) {
      const ratioList = Condition.RATIO_LIST;
      let condIdx = 0;
      if (step.condition.type === 'ratio') {
        const h = step.condition.options.hits;
        const o = step.condition.options.of;
        const found = ratioList.findIndex(r => r.hits === h && r.of === o);
        if (found >= 0) condIdx = found + 1;
      }

      const condKnob = new KnobWidget({
        label:   'CONDITION',
        min:     0,
        max:     ratioList.length,
        value:   condIdx,
        bipolar: false,
        size:    64,
        fmt:     v => {
          const i = Math.round(v);
          if (i === 0) return '—';
          const r = ratioList[i - 1];
          return `${r.hits}:${r.of}`;
        },
        onChange: v => {
          const i = Math.round(v);
          step.condition = i === 0
            ? Condition.create('always')
            : Condition.create('ratio', { hits: ratioList[i - 1].hits, of: ratioList[i - 1].of });
        },
        onRelease: () => emitStep(),
      });
      alwaysKnobsRow.appendChild(condKnob.el);
      activeWidgets.push(condKnob);
    }

    panel.appendChild(alwaysKnobsRow);
    activeWidgets.push(lengthKnob, chanceKnob, toneKnob, velKnob);

    // ── Shift buttons (always visible) ──────────────────────
    const shiftRow = document.createElement('div');
    shiftRow.className = 'trig-btn-row';

    const shiftBwd = document.createElement('button');
    shiftBwd.className = 'btn';
    shiftBwd.textContent = '◀ SHIFT';
    shiftBwd.addEventListener('click', () => {
      const seq   = track.sequencer;
      const count = seq.stepCount;
      const first = seq.steps[0];
      for (let i = 0; i < count - 1; i++) {
        seq.steps[i] = seq.steps[i + 1];
        seq.steps[i].index = i;
      }
      seq.steps[count - 1] = first;
      first.index = count - 1;
      state.emit('stepChanged', { trackIndex: state.selectedTrackIndex, stepIndex: -1, step: null });
      renderContent();
    });

    const shiftFwd = document.createElement('button');
    shiftFwd.className = 'btn';
    shiftFwd.textContent = 'SHIFT ▶';
    shiftFwd.addEventListener('click', () => {
      const seq   = track.sequencer;
      const count = seq.stepCount;
      const last  = seq.steps[count - 1];
      for (let i = count - 1; i > 0; i--) {
        seq.steps[i] = seq.steps[i - 1];
        seq.steps[i].index = i;
      }
      seq.steps[0] = last;
      last.index = 0;
      state.emit('stepChanged', { trackIndex: state.selectedTrackIndex, stepIndex: -1, step: null });
      renderContent();
    });

    shiftRow.appendChild(shiftBwd);
    shiftRow.appendChild(shiftFwd);
    panel.appendChild(shiftRow);

    // ── Fill page (always visible) ──────────────────────────
    // Quick drum-fill helper: stamp C4 onto the visible page at a note-division
    // interval. On a 16-step page (1/16 resolution): 1/16 = every step, 1/8 =
    // every 2nd, 1/4 = every 4th (four-on-the-floor), 1/2 = every 8th.
    // Toggle rule: if EVERY target step is already active, the press clears them
    // all; otherwise it fills any that are missing. So fill-all then fill-1/4
    // clears just the quarter-note steps, leaving the rest — exactly the
    // "all but the 4th" behaviour.
    const FILL_NOTE = 60; // C4, matching drum-mode finger-drumming
    const fillDivs  = [
      { label: '1/16', interval: 1 },
      { label: '1/8',  interval: 2 },
      { label: '1/4',  interval: 4 },
      { label: '1/2',  interval: 8 },
    ];

    const fillLabel = document.createElement('span');
    fillLabel.className = 'trig-fill-label label';
    fillLabel.textContent = 'FILL PAGE';
    panel.appendChild(fillLabel);

    const fillRow = document.createElement('div');
    fillRow.className = 'trig-btn-row';
    fillDivs.forEach(({ label, interval }) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', () => {
        const pageSteps = track.sequencer.getVisibleSteps();
        // Target steps = every `interval`-th step on the page (0-based).
        const targets = [];
        for (let i = 0; i < pageSteps.length; i += interval) targets.push(pageSteps[i]);
        const allActive = targets.every(s => s.active);
        targets.forEach(s => {
          if (allActive) {
            // Clear: deactivate (keep a placeholder voice so re-activation works).
            s.active = false;
            s.voices = [{ note: s.voices[0]?.note ?? FILL_NOTE, velocity: 100, length: 1, nudge: 0 }];
          } else if (!s.active) {
            // Fill: stamp a single C4 voice. Leave already-active steps untouched.
            s.active = true;
            s.voices = [{ note: FILL_NOTE, velocity: 100, length: 1, nudge: 0 }];
          }
        });
        // Page-level change — clear step selection and refresh grid + panel.
        state.emit('stepChanged', { trackIndex: state.selectedTrackIndex, stepIndex: -1, step: null });
        renderContent();
      });
      fillRow.appendChild(b);
    });
    panel.appendChild(fillRow);

    // ── No-step section: QUANTIZE knob + Note Follow ────────
    if (!hasStep) {
      const noStepRow = document.createElement('div');
      noStepRow.className = 'trig-knobs-row';

      const quantizePct = Math.round((track.nudgeQuantize ?? 0) * 100);
      const quantizeKnob = new KnobWidget({
        label:   'QUANTIZE',
        min:     0,
        max:     100,
        value:   quantizePct,
        bipolar: false,
        size:    64,
        fmt:     v => Math.round(v) + '%',
        onChange: v => {
          track.nudgeQuantize = Math.round(v) / 100;
        },
      });
      noStepRow.appendChild(quantizeKnob.el);
      activeWidgets.push(quantizeKnob);

      // ── Note Follow delay knob ───────────────────────────
      const followDelay = track.followDelay ?? 0;
      const followDelayKnob = new KnobWidget({
        label:   'FLW DLY',
        min:     0,
        max:     500,
        value:   followDelay,
        bipolar: false,
        size:    64,
        fmt:     v => Math.round(v) + 'ms',
        onChange: v => {
          track.followDelay = Math.round(v);
        },
      });
      noStepRow.appendChild(followDelayKnob.el);
      activeWidgets.push(followDelayKnob);

      panel.appendChild(noStepRow);

      // ── Note Follow dropdown ─────────────────────────────
      const followRow = document.createElement('div');
      followRow.className = 'trig-follow-row';

      const followLabel = document.createElement('span');
      followLabel.className = 'param-label label';
      followLabel.textContent = 'NOTE FOLLOW';

      const followSel = document.createElement('select');
      followSel.className = 'param-select';

      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'OFF';
      followSel.appendChild(noneOpt);

      const allTracks = state.project.tracks;
      allTracks.forEach((t, ti) => {
        if (ti === state.selectedTrackIndex) return;
        const opt = document.createElement('option');
        opt.value = String(ti);
        opt.textContent = `T${ti + 1} (${t.machine?.type ?? '?'})`;
        if (track.followSource === ti) opt.selected = true;
        followSel.appendChild(opt);
      });
      if (track.followSource === null) noneOpt.selected = true;

      followSel.addEventListener('change', () => {
        const val = followSel.value === '' ? null : parseInt(followSel.value, 10);
        track.setFollow(val);
      });

      followRow.appendChild(followLabel);
      followRow.appendChild(followSel);
      panel.appendChild(followRow);

      const msg = document.createElement('div');
      msg.className = 'trig-no-step';
      msg.textContent = 'Select a step to edit note and condition';

      panel.appendChild(msg);
      container.appendChild(panel);
      return;
    }

    // ── Voice cards ──
    const voicesSection = document.createElement('div');
    voicesSection.className = 'trig-voices';

    const _fmtLenShort = ticks => {
      if (ticks < 1) return Math.round(ticks * 16) + '/16';
      if (Number.isInteger(ticks)) return ticks + 'b';
      return ticks.toFixed(1) + 'b';
    };

    const rebuildVoices = () => {
      voicesSection.innerHTML = '';
      // An inactive step still carries a default voice ({note:60/C4}) in its data
      // so that activating it (keyboard / double-click) has something to fill in —
      // but it has no notes yet. Don't render that placeholder as a real voice, or
      // every empty step you select looks like it holds a C4.
      if (!step.active) {
        const empty = document.createElement('div');
        empty.className = 'trig-no-step';
        empty.textContent = 'Empty step — play a note or double-click the step to add one';
        voicesSection.appendChild(empty);
        return;
      }
      step.voices.forEach((sv, vi) => {
        const card = document.createElement('div');
        card.className = 'trig-voice-card';

        const noteSpan = document.createElement('span');
        noteSpan.className = 'trig-voice-note';
        noteSpan.textContent = this._noteName(sv.note);

        const lenSpan = document.createElement('span');
        lenSpan.className = 'trig-voice-len';
        lenSpan.textContent = _fmtLenShort(sv.length);

        const nudgeSpan = document.createElement('span');
        nudgeSpan.className = 'trig-voice-nudge';
        nudgeSpan.textContent = sv.nudge === 0 ? '' : (sv.nudge > 0 ? '+' : '') + sv.nudge.toFixed(2);

        const rmBtn = document.createElement('button');
        rmBtn.className = 'trig-voice-rm';
        rmBtn.textContent = '×';
        rmBtn.title = 'Remove voice';
        rmBtn.addEventListener('click', () => {
          step.removeVoice(vi);
          emitStep();
          renderContent();
        });

        card.appendChild(noteSpan);
        card.appendChild(lenSpan);
        if (sv.nudge !== 0) card.appendChild(nudgeSpan);
        card.appendChild(rmBtn);
        voicesSection.appendChild(card);
      });
    };

    rebuildVoices();
    panel.appendChild(voicesSection);

    // ── Action buttons ──
    const btnRow = document.createElement('div');
    btnRow.className = 'trig-btn-row';

    const rmAllBtn = document.createElement('button');
    rmAllBtn.className = 'btn';
    rmAllBtn.textContent = 'RESET TRIG';
    rmAllBtn.addEventListener('click', () => {
      step.active    = false;
      step.voices    = [{ note: step.voices[0]?.note ?? 60, velocity: 100, length: 1, nudge: 0 }];
      step.retrigger = null;
      step.chance    = 100;
      step.condition = Condition.create('always');
      step.plocks.clear();
      emitStep();
      renderContent();
    });

    btnRow.appendChild(rmAllBtn);
    panel.appendChild(btnRow);

    container.appendChild(panel);
  }
}
