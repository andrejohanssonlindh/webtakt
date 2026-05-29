/**
 * SynthPanel.js
 * -------------
 * Tabbed panel showing parameters for the currently selected track.
 * Tabs: TRIG | SYNTH | FILTER | ENV | LFO
 *
 * P-lock behaviour:
 *   - No step selected → writes directly to machine/filter/envelope
 *   - Step selected    → writes to step.plocks for that step only
 *     The stepChanged event is emitted on mouseup (not on every drag tick)
 *     so the panel doesn't rebuild mid-drag and kill the interaction.
 */

import { KnobWidget }              from '../ui/KnobWidget.js';
import { ADSRWidget }              from '../ui/ADSRWidget.js';
import { FilterViz }               from '../ui/FilterViz.js';
import { Condition }               from '../sequencer/Condition.js';
import { SCALE_DEFS, NOTE_NAMES } from '../state/Scales.js';
import { FMPanel }                 from './panels/FMPanel.js';
import { DefaultMachinePanel }     from './panels/DefaultMachinePanel.js';
import { MidiPanel }               from './panels/MidiPanel.js';
import { BPM_DIVISIONS }           from '../signal/LFO.js';
import { SoundLibraryPanel }       from './panels/SoundLibraryPanel.js';
import { SamplerPanel }            from './panels/SamplerPanel.js';
import { WavetableSamplerPanel }   from './panels/WavetableSamplerPanel.js';
import { SampleSwarmPanel }        from './panels/SampleSwarmPanel.js';
import { ArpPanel }                from './panels/ArpPanel.js';

export class SynthPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/AppState.js').AppState} state
   * @param {import('../state/SoundLibrary.js').SoundLibrary} library
   * @param {Function} openModal — (msg, defaultVal, onConfirm) prompt helper
   * @param {import('../state/SampleStore.js').SampleStore} sampleStore
   * @param {AudioContext} audioContext
   * @param {import('../core/MidiEngine.js').MidiEngine} [midiEngine]
   */
  constructor(container, state, library, openModal, sampleStore, audioContext, midiEngine) {
    this.container    = container;
    this.state        = state;
    this.library      = library;
    this.openModal    = openModal;
    this.sampleStore  = sampleStore  ?? null;
    this.audioContext = audioContext ?? null;
    this.midiEngine   = midiEngine   ?? null;

    this._activeWidgets = [];
    // path → KnobWidget, rebuilt each time the content area renders
    this._knobByPath    = new Map();
    // FilterViz reference for the currently rendered filter tab, or null
    this._activeViz     = null;

    // Clipboard: { type: 'step'|'machine', data: object }
    this._clipboard = null;

    this._buildShell();

    state.on('trackSelected', () => this.render());
    state.on('tabChanged',    () => this.render());
    state.on('lfoChanged',    () => { if (state.activeTab === 'lfo') this._renderContent(); });
    state.on('stepSelected',  () => this._renderContent());
    // stepChanged: re-render only on trig tab (note display + button state must update).
    // On other tabs we skip — must not rebuild knobs mid-drag.
    state.on('stepChanged',   () => { if (state.activeTab === 'trig') this._renderContent(); });
    // paramChanged: mod wheel (or any external source) changed a param — update knob + viz
    state.on('paramChanged',  ({ path, value }) => {
      const knob = this._knobByPath.get(path);
      if (knob) knob.setValue(value);
      this._activeViz?.refresh();
    });
  }

  _buildShell() {
    this.container.innerHTML = '';

    // ── Header: tab bar (left) + FX toggles (right) ─────────
    const header = document.createElement('div');
    header.className = 'panel-header';

    this._tabBar = document.createElement('div');
    this._tabBar.className = 'tab-bar';

    // Voice tabs only — FX moved to right-side toggles
    const leftTabs = ['machine', 'sounds', 'scales', 'trig', 'synth', 'arp', 'filter', 'amp', 'lfo', 'midi', 'mixer'];
    leftTabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className   = 'tab-btn';
      btn.textContent = tab.toUpperCase();
      btn.dataset.tab = tab;
      btn.addEventListener('click', () => this.state.setTab(tab));
      this._tabBar.appendChild(btn);
    });

    header.appendChild(this._tabBar);

    // Oscilloscope canvas — fills the gap between tab bar and FX block
    this.scopeCanvas = document.createElement('canvas');
    this.scopeCanvas.className = 'oscilloscope';
    this.scopeCanvas.height = 48;
    header.appendChild(this.scopeCanvas);

    // FX toggle block — always visible on the right
    this._fxBar = document.createElement('div');
    this._fxBar.className = 'fx-bar';

    const fxDefs = [
      { tab: 'delay',  label: 'DLY',   getFx: () => this.state.selectedTrack?.delayFX },
      { tab: 'crush',  label: 'CRUSH', getFx: () => this.state.selectedTrack?.bitcrushFX },
      { tab: 'reverb', label: 'REV',   getFx: () => this.state.selectedTrack?.reverbFX },
    ];

    fxDefs.forEach(({ tab, label, getFx }) => {
      const wrap = document.createElement('div');
      wrap.className = 'fx-toggle-wrap';
      wrap.dataset.fxtab = tab;

      const nameBtn = document.createElement('button');
      nameBtn.className = 'fx-toggle-name';
      nameBtn.textContent = label;

      const onOffBtn = document.createElement('button');
      onOffBtn.className = 'fx-toggle-onoff';

      const updateState = () => {
        const fx = getFx();
        const on = fx?.enabled ?? false;
        onOffBtn.textContent = on ? 'ON' : 'OFF';
        onOffBtn.classList.toggle('on', on);
        wrap.classList.toggle('fx-active-tab', this.state.activeTab === tab);
      };

      nameBtn.addEventListener('click', () => {
        this.state.setTab(tab);
      });

      onOffBtn.addEventListener('click', () => {
        const fx = getFx();
        if (!fx) return;
        fx.setEnabled(!fx.enabled);
        updateState();
      });

      wrap.appendChild(nameBtn);
      wrap.appendChild(onOffBtn);
      this._fxBar.appendChild(wrap);

      // Store updater so render() can refresh on track change
      wrap._updateState = updateState;
      updateState();
    });

    header.appendChild(this._fxBar);

    // ── Copy/Paste block — rightmost in header ───────────────
    this._clipBar = document.createElement('div');
    this._clipBar.className = 'clip-bar';

    this._copyBtn = document.createElement('button');
    this._copyBtn.className = 'clip-btn';
    this._copyBtn.textContent = 'COPY';
    this._copyBtn.title = 'Step selected: copy step  |  No step: copy machine';
    this._copyBtn.addEventListener('click', () => this._doCopy());

    this._pasteBtn = document.createElement('button');
    this._pasteBtn.className = 'clip-btn';
    this._pasteBtn.textContent = 'PASTE';
    this._pasteBtn.title = 'Step selected: paste step  |  No step: paste machine';
    this._pasteBtn.addEventListener('click', () => this._doPaste());

    this._clipBar.appendChild(this._copyBtn);
    this._clipBar.appendChild(this._pasteBtn);
    header.appendChild(this._clipBar);

    this.container.appendChild(header);

    this._content = document.createElement('div');
    this._content.className = 'panel-content';
    this.container.appendChild(this._content);

    this.render();
  }

  render() {
    this._tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === this.state.activeTab);
    });
    this._fxBar.querySelectorAll('.fx-toggle-wrap').forEach(wrap => {
      wrap._updateState?.();
    });
    this._updateClipButtons();
    this._renderContent();
  }

  _updateClipButtons() {
    const hasClip = this._clipboard !== null;
    this._pasteBtn.classList.toggle('clip-has-data', hasClip);
  }

  _doCopy() {
    const track = this.state.selectedTrack;
    if (!track) return;
    const step = this._step();
    if (step) {
      // Copy step: voices, chance, condition, length, retrigger, plocks
      this._clipboard = {
        type: 'step',
        data: JSON.parse(JSON.stringify({
          active:    step.active,
          voices:    step.voices,
          chance:    step.chance,
          condition: step.condition.type === 'ratio'
            ? { type: 'ratio', options: { ...step.condition.options } }
            : { type: 'always', options: {} },
          length:    step.length,
          retrigger: step.retrigger,
          nudge:     step.nudge,
          plocks:    [...step.plocks.entries()],
        })),
      };
    } else {
      // Copy machine: full machine JSON + filter + envelope + FX
      this._clipboard = {
        type: 'machine',
        data: JSON.parse(JSON.stringify({
          machine:    track.machine.toJSON(),
          filter:     track.filter.toJSON(),
          envelope:   track.envelope.toJSON(),
          delayFX:    track.delayFX.toJSON(),
          bitcrushFX: track.bitcrushFX.toJSON(),
          reverbFX:   track.reverbFX.toJSON(),
          lfos:       track.lfos.map((lfo, i) => ({
            ...lfo.toJSON(),
            destPath: track._lfoDestPaths[i] ?? '',
          })),
        })),
      };
    }
    this._updateClipButtons();
  }

  _doPaste() {
    if (!this._clipboard) return;
    const track = this.state.selectedTrack;
    if (!track) return;
    const step = this._step();

    if (this._clipboard.type === 'step') {
      if (!step) return;
      const d = this._clipboard.data;
      step.active    = d.active;
      step.voices    = JSON.parse(JSON.stringify(d.voices));
      step.chance    = d.chance ?? 100;
      step.retrigger = d.retrigger ?? null;
      step.plocks    = new Map(d.plocks ?? []);

      // Restore condition object
      if (d.condition?.type === 'ratio') {
        step.condition = Condition.create('ratio', d.condition.options);
      } else {
        step.condition = Condition.create('always');
      }

      this.state.emit('stepChanged', {
        trackIndex: this.state.selectedTrackIndex,
        stepIndex:  this.state.selectedStepIndex,
        step,
      });
      this._renderContent();

    } else if (this._clipboard.type === 'machine') {
      const d = this._clipboard.data;
      if (d.machine?.type) track.setMachine(d.machine.type);
      track.machine.fromJSON(d.machine ?? {});
      track._pool.syncParams();
      track.filter.fromJSON(d.filter ?? {});
      track.envelope.fromJSON(d.envelope ?? {});
      track._pool.syncParams();
      track.delayFX.fromJSON(d.delayFX ?? {});
      track.bitcrushFX.fromJSON(d.bitcrushFX ?? {});
      track.reverbFX.fromJSON(d.reverbFX ?? {});

      // Restore LFOs
      track.lfos.forEach(l => l.stop());
      track.lfos = [];
      track._lfoDestPaths = [];
      (d.lfos ?? []).forEach(lfoObj => {
        const lfo = track.addLFO();
        lfo.fromJSON(lfoObj);
        if (lfoObj.destPath) track.setLFODestination(track.lfos.length - 1, lfoObj.destPath);
      });

      this.state.emit('trackSelected', {
        index: this.state.selectedTrackIndex,
        track,
      });
      this._renderContent();
    }
  }

  _renderContent() {
    this._activeWidgets.forEach(w => w.destroy?.());
    this._activeWidgets = [];
    this._knobByPath.clear();
    this._activeViz = null;

    const track = this.state.selectedTrack;
    this._content.innerHTML = '';

    switch (this.state.activeTab) {
      case 'machine': this._renderMachineTab(track); break;
      case 'mixer':   this._renderMixer();           break;
      case 'sounds':  this._renderSounds(track);  break;
      case 'scales':  this._renderScales(track);  break;
      case 'trig':   this._renderTrig(track);   break;
      case 'synth':  this._renderSynth(track);  break;
      case 'arp':    this._renderArp(track);    break;
      case 'filter': this._renderFilter(track); break;
      case 'amp':    this._renderEnv(track);    break;
      case 'lfo':    this._renderLFO(track);     break;
      case 'midi':   this._renderMidiIn(track); break;
      case 'delay':  this._renderDelay(track);  break;
      case 'crush':  this._renderCrush(track);  break;
      case 'reverb': this._renderReverb(track); break;
    }
  }

  // ── P-lock helpers ──────────────────────────────────────────

  _step() {
    return this.state.selectedStep;
  }

  _hasStep() {
    return this._step() !== null;
  }

  /**
   * Write a value.
   * If a step is selected, writes to step.plocks (p-lock for that step only).
   * Otherwise writes directly to the machine/filter/envelope.
   * @param {boolean} emitChange — set false during drag, true on release
   */
  _writeValue(target, path, value, emitChange = false) {
    const step = this._step();
    if (step) {
      step.setPLock(path, value);
      if (emitChange) {
        this.state.emit('stepChanged', {
          trackIndex: this.state.selectedTrackIndex,
          stepIndex:  this.state.selectedStepIndex,
          step,
        });
      }
    } else {
      target.setParam(path, value);
    }
  }

  // ── Generic param renderer ──────────────────────────────────

  _renderParamList(target, paramList) {
    const step    = this._step();
    const hasStep = step !== null;

    paramList.forEach(p => {
      if (p.hidden) return;
      const plockPath  = p.path;
      const hasPLock   = hasStep && step.plocks.has(plockPath);
      const displayVal = hasPLock ? step.plocks.get(plockPath) : target.getParam(p.path);

      if (p.type === 'number') {
        const isBipolar = (p.min !== undefined && p.max !== undefined && p.min < 0 && p.max > 0 && p.min === -p.max);

        const knob = new KnobWidget({
          label:    p.label,
          min:      p.min     ?? 0,
          max:      p.max     ?? 1,
          value:    displayVal ?? p.default ?? p.min ?? 0,
          bipolar:  isBipolar,
          size:     64,
          fmt:      v => this._fmtParam(p, v),
          // During drag: write value but don't emit stepChanged (avoids rebuild)
          onChange: v => {
            this._writeValue(target, p.path, v, false);
            knob.setHasPLock(hasStep);
          },
          // On release: emit stepChanged so grid dot updates
          onRelease: () => {
            const step = this._step();
            if (step) {
              this.state.emit('stepChanged', {
                trackIndex: this.state.selectedTrackIndex,
                stepIndex:  this.state.selectedStepIndex,
                step,
              });
            }
          },
        });

        knob.setHasPLock(hasPLock);
        this._content.appendChild(knob.el);
        this._activeWidgets.push(knob);
        this._knobByPath.set(p.path, knob);

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
          this._writeValue(target, p.path, sel.value, true);
          label.classList.toggle('has-plock', hasStep);
        });

        row.appendChild(label);
        row.appendChild(sel);
        this._content.appendChild(row);

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
          this._writeValue(target, p.path, cb.checked, true);
          label.classList.toggle('has-plock', hasStep);
        });

        row.appendChild(label);
        row.appendChild(cb);
        this._content.appendChild(row);
      }
    });
  }

  _fmtParam(p, v) {
    if (p.path === 'filter.cutoff')    return Math.round(v) + 'Hz';
    if (p.path === 'filter.resonance') return v.toFixed(1);
    if (p.path === 'filter.gain')      return (v >= 0 ? '+' : '') + v.toFixed(1) + 'dB';
    if (p.path === 'filter.envAmount') return (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
    if (p.path === 'delay.time')       return v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
    if (p.path === 'delay.feedback')   return Math.round(v * 100) + '%';
    if (p.path === 'delay.wet')        return Math.round(v * 100) + '%';
    if (p.path === 'crush.bits')       return Math.round(v) + ' bit';
    if (p.path === 'crush.rate')       return Math.round(v * 100) + '%';
    if (p.path === 'crush.wet')        return Math.round(v * 100) + '%';
    if (p.path === 'reverb.decay')     return v.toFixed(2) + 's';
    if (p.path === 'reverb.predelay')  return v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
    if (p.path === 'reverb.damp')      return Math.round(v) + 'Hz';
    if (p.path === 'reverb.wet')       return Math.round(v * 100) + '%';
    if (p.path === 'base.lpf')         return Math.round(v) + 'Hz';
    if (p.path === 'base.hpf')         return Math.round(v) + 'Hz';
    if (p.path === 'osc.detune')       return (v >= 0 ? '+' : '') + Math.round(v) + '\u00a2';
    if (p.path === 'amp.pan')          return Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
    if (p.path === 'sub.level')        return Math.round(v * 100) + '%';
    if (p.path === 'output.level')     return Math.round(v * 100) + '%';
    if (p.path === 'lfo.speed' || p.path.endsWith('.speed')) return v < 0.1 ? v.toFixed(3) + 'Hz' : v.toFixed(2) + 'Hz';
    if (p.path === 'lfo.speedMult' || p.path.endsWith('.mult')) return Math.round(v) + 'x';
    if (p.path === 'lfo.depth' || p.path.endsWith('.depth')) return Math.round(v) + '%';
    if (p.path === 'lfo.startPhase')   return Math.round(v);
    if (p.path === 'lfo.fade')         return v === 0 ? 'off' : (v > 0 ? '+' : '') + Math.round(v) + '%';
    if (p.path.endsWith('.time'))      return (v * 1000).toFixed(0) + 'ms';
    // Drum machine params
    if (p.path === 'tune')             return Math.round(v) + 'Hz';
    if (p.path === 'decay')            return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'open.decay')       return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'sweep')            return 'x' + v.toFixed(1);
    if (p.path === 'punch')            return Math.round(v * 100) + '%';
    if (p.path === 'punch.decay')      return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'snap')             return Math.round(v * 100) + '%';
    if (p.path === 'tone')             return p.max > 1 ? Math.round(v) + 'Hz' : Math.round(v * 100) + '%';
    if (p.path === 'noise.cutoff')     return Math.round(v) + 'Hz';
    if (p.path === 'cutoff')           return Math.round(v) + 'Hz';
    // NoiseMachine
    if (p.path === 'color')            return Math.round(v * 100) + '%';
    if (p.path === 'color.freq')       return Math.round(v) + 'Hz';
    if (p.path === 'body.freq')        return Math.round(v) + 'Hz';
    if (p.path === 'body.level')       return Math.round(v * 100) + '%';
    if (p.path === 'crush')            return Math.round(v * 100) + '%';
    // TransientMachine
    if (p.path === 'pitch')            return v === 0 ? 'NOTE' : Math.round(v) + 'Hz';
    if (p.path === 'pitch.end')        return Math.round(v * 100) + '%';
    if (p.path === 'body.decay')       return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'click.freq')       return Math.round(v) + 'Hz';
    if (p.path === 'click.decay')      return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'noise.click')      return Math.round(v * 100) + '%';
    // SwarmMachine / SampleSwarmMachine
    if (p.path === 'spread')           return Math.round(v) + '¢';
    if (p.path === 'swarm.detune')     return Math.round(v) + '¢';
    if (p.path === 'noise.amount')     return Math.round(v) + '¢';
    if (p.path === 'noise.color')      return Math.round(v * 100) + '%';
    // CymbalMachine
    if (p.path === 'tune')             return Math.round(v) + 'Hz';
    if (p.path === 'mid.decay')        return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'open.decay')       return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'resonance')        return v.toFixed(1);
    // WoodMachine
    if (p.path === 'freq1')            return Math.round(v) + 'Hz';
    if (p.path === 'freq2')            return Math.round(v) + 'Hz';
    if (p.path === 'ring')             return v.toFixed(1);
    if (p.path === 'click')            return Math.round(v * 100) + '%';
    // WavetableMachine
    if (p.path === 'pos') {
      const names = ['Sine','Tri','Saw','Sqr','Pls25','BrtSaw','Hollow','Vocal'];
      const i = Math.floor(Math.min(v, names.length - 1));
      const f = v - Math.floor(v);
      if (f < 0.01) return names[i] ?? v.toFixed(2);
      const next = names[Math.min(i + 1, names.length - 1)];
      return names[i] + '→' + next;
    }
    // KarplusMachine
    if (p.path === 'damping')          return Math.round(v) + 'Hz';
    if (p.path === 'feedback' && p.max <= 1) return Math.round(v * 100) + '%';
    if (p.path === 'excite')           return Math.round(v) + 'ms';
    if (p.path === 'excite.tone')      return Math.round(v) + 'Hz';
    if (p.path === 'stretch')          return (v >= 0 ? '+' : '') + Math.round(v) + '¢';
    // MarimbaMachine
    if (p.path === 'decay1' || p.path === 'decay2' || p.path === 'decay3') return (v * 1000).toFixed(0) + 'ms';
    if (p.path === 'p2ratio' || p.path === 'p3ratio') return 'x' + v.toFixed(2);
    if (p.path === 'mallet.tone')      return Math.round(v) + 'Hz';
    // BassMachine
    if (p.path === 'glide')            return Math.round(v) + 'ms';
    if (p.path === 'accent')           return Math.round(v);
    if (p.path === 'drive')            return Math.round(v * 100) + '%';
    // CombMachine
    if (p.path === 'excite.level')     return Math.round(v * 100) + '%';
    // ChordMachine
    if (p.path === 'inversion')        return Math.round(v);
    // FMMachine
    if (p.path.endsWith('.ratio'))     return 'x' + v.toFixed(2);
    if (p.path.endsWith('.feedback'))  return Math.round(v * 100) + '%';
    if (p.path.endsWith('.detune') && p.path.startsWith('op')) return (v >= 0 ? '+' : '') + Math.round(v) + '¢';
    if (p.max !== undefined && p.max <= 1) return Math.round(v * 100) + '%';
    return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v);
  }

  // ── Tab renderers ───────────────────────────────────────────

  // ── Trig helpers ────────────────────────────────────────────

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

  _renderTrig(track) {
    const panel = document.createElement('div');
    panel.className = 'trig-panel';

    const step    = this._step();
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
      onRelease: () => {
        if (hasStep) {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        }
      },
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
      onRelease: () => {
        if (hasStep) {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        }
      },
    });

    const alwaysKnobsRow = document.createElement('div');
    alwaysKnobsRow.className = 'trig-knobs-row';
    alwaysKnobsRow.appendChild(lengthKnob.el);
    alwaysKnobsRow.appendChild(chanceKnob.el);

    // ── Detune knob (universal — p-lockable, LFOable on synth) ──
    const supportsDetune = track.machine.getParam('osc.detune') !== undefined;
    let detuneKnob = null;
    if (supportsDetune) {
      const detuneStep  = hasStep;
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
        fmt:     v => (v >= 0 ? '+' : '') + Math.round(v) + '\u00a2',
        onChange: v => {
          if (hasStep) {
            step.setPLock('osc.detune', v);
            detuneKnob.setHasPLock(true);
          } else {
            track.machine.setParam('osc.detune', v);
          }
        },
        onRelease: () => {
          if (hasStep) {
            this.state.emit('stepChanged', {
              trackIndex: this.state.selectedTrackIndex,
              stepIndex:  this.state.selectedStepIndex,
              step,
            });
          }
        },
      });
      detuneKnob.setHasPLock(hasDPLock);
      alwaysKnobsRow.appendChild(detuneKnob.el);
      this._activeWidgets.push(detuneKnob);
      this._knobByPath.set('osc.detune', detuneKnob);
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
      onRelease: () => {
        if (hasStep) {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        }
      },
    });
    toneKnob.setHasPLock(hasTonePLock);
    alwaysKnobsRow.appendChild(toneKnob.el);

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
        onRelease: () => {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        },
      });
      alwaysKnobsRow.appendChild(nudgeKnob.el);
      this._activeWidgets.push(nudgeKnob);
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
        onRelease: () => {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        },
      });
      alwaysKnobsRow.appendChild(condKnob.el);
      this._activeWidgets.push(condKnob);
    }

    panel.appendChild(alwaysKnobsRow);
    this._activeWidgets.push(lengthKnob, chanceKnob, toneKnob);

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
      this.state.emit('stepChanged', { trackIndex: this.state.selectedTrackIndex, stepIndex: -1, step: null });
      this._renderContent();
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
      this.state.emit('stepChanged', { trackIndex: this.state.selectedTrackIndex, stepIndex: -1, step: null });
      this._renderContent();
    });

    shiftRow.appendChild(shiftBwd);
    shiftRow.appendChild(shiftFwd);
    panel.appendChild(shiftRow);

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
      this._activeWidgets.push(quantizeKnob);

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
      this._activeWidgets.push(followDelayKnob);

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

      const allTracks = this.state.project.tracks;
      allTracks.forEach((t, ti) => {
        if (ti === this.state.selectedTrackIndex) return;
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
      this._content.appendChild(panel);
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
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
          this._renderContent();
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
      this.state.emit('stepChanged', {
        trackIndex: this.state.selectedTrackIndex,
        stepIndex:  this.state.selectedStepIndex,
        step,
      });
      this._renderContent();
    });

    btnRow.appendChild(rmAllBtn);
    panel.appendChild(btnRow);

    this._content.appendChild(panel);
  }

  // ── Scales tab ──────────────────────────────────────────────

  _renderScales(track) {
    const wrapper = document.createElement('div');
    wrapper.className = 'scales-tab-wrapper';

    // ── Top row: dropdown + root picker side by side ─────────
    const topRow = document.createElement('div');
    topRow.className = 'scales-top-row';
    wrapper.appendChild(topRow);

    // ── Scale dropdown ───────────────────────────────────────
    const dropWrap = document.createElement('div');
    dropWrap.className = 'wt-select-wrap scales-drop-wrap';

    const dropLabel = document.createElement('div');
    dropLabel.className = 'wt-select-label';
    dropLabel.textContent = 'Scale';
    dropWrap.appendChild(dropLabel);

    const btnEl   = document.createElement('button');
    btnEl.className = 'wt-select-btn has-value';

    const valEl   = document.createElement('span');
    valEl.className = 'wt-select-value';
    valEl.textContent = SCALE_DEFS[track.scaleIndex]?.label ?? 'Chromatic';

    const arrowEl = document.createElement('span');
    arrowEl.className = 'wt-select-arrow';

    const listEl  = document.createElement('div');
    listEl.className = 'wt-select-list';

    const searchEl = document.createElement('input');
    searchEl.className = 'wt-select-search';
    searchEl.type = 'text';
    searchEl.placeholder = 'search…';
    searchEl.autocomplete = 'off';

    const itemsEl = document.createElement('div');
    itemsEl.className = 'wt-select-items';

    const noneEl  = document.createElement('div');
    noneEl.className = 'wt-select-none';
    noneEl.textContent = 'no match';

    btnEl.appendChild(valEl);
    btnEl.appendChild(arrowEl);
    listEl.appendChild(searchEl);
    listEl.appendChild(itemsEl);
    listEl.appendChild(noneEl);
    dropWrap.appendChild(btnEl);
    dropWrap.appendChild(listEl);

    SCALE_DEFS.forEach((def, i) => {
      const opt = document.createElement('div');
      opt.className = 'wt-select-option' + (i === track.scaleIndex ? ' selected' : '');
      opt.textContent = def.label;
      opt.dataset.label = def.label.toLowerCase();
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        track.scaleIndex = i;
        valEl.textContent = def.label;
        itemsEl.querySelectorAll('.wt-select-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        closeDropdown();
        this.state.emit('scaleChanged', { track });
      });
      itemsEl.appendChild(opt);
    });

    function openDropdown() {
      listEl.classList.add('open');
      btnEl.classList.add('open');
      searchEl.value = '';
      filterItems('');
      searchEl.focus();
    }

    function closeDropdown() {
      listEl.classList.remove('open');
      btnEl.classList.remove('open');
    }

    function filterItems(q) {
      const query = q.toLowerCase().trim();
      let anyVisible = false;
      itemsEl.querySelectorAll('.wt-select-option').forEach(opt => {
        const match = !query || opt.dataset.label.includes(query);
        opt.classList.toggle('hidden', !match);
        if (match) anyVisible = true;
      });
      noneEl.style.display = anyVisible ? 'none' : 'block';
    }

    btnEl.addEventListener('click', () =>
      listEl.classList.contains('open') ? closeDropdown() : openDropdown()
    );
    searchEl.addEventListener('input', () => filterItems(searchEl.value));

    const outsideClick = e => {
      if (!btnEl.contains(e.target) && !listEl.contains(e.target)) closeDropdown();
    };
    const escKey = e => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', outsideClick);
    document.addEventListener('keydown', escKey);
    this._activeWidgets.push({
      destroy: () => {
        document.removeEventListener('mousedown', outsideClick);
        document.removeEventListener('keydown', escKey);
      }
    });

    topRow.appendChild(dropWrap);

    // ── Root note button strip ───────────────────────────────
    const rootWrap = document.createElement('div');
    rootWrap.className = 'scales-root-wrap';

    const rootLabel = document.createElement('div');
    rootLabel.className = 'wt-select-label';
    rootLabel.textContent = 'Root';
    rootWrap.appendChild(rootLabel);

    const rootStrip = document.createElement('div');
    rootStrip.className = 'scales-root-strip';

    const rootBtns = NOTE_NAMES.map((name, pc) => {
      const btn = document.createElement('button');
      btn.className = 'scales-root-btn' + (pc === track.leadNote ? ' active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        track.leadNote = pc;
        rootBtns.forEach((b, j) => b.classList.toggle('active', j === pc));
        this.state.emit('scaleChanged', { track });
      });
      rootStrip.appendChild(btn);
      return btn;
    });

    rootWrap.appendChild(rootStrip);
    topRow.appendChild(rootWrap);

    // ── Scale degree preview ─────────────────────────────────
    const preview = document.createElement('div');
    preview.className = 'scales-preview';

    const updatePreview = () => {
      preview.innerHTML = '';
      const def = SCALE_DEFS[track.scaleIndex];
      if (!def || track.scaleIndex === 0) {
        const all = document.createElement('span');
        all.className = 'scales-preview-note';
        all.textContent = 'All notes active';
        preview.appendChild(all);
        return;
      }
      NOTE_NAMES.forEach((name, pc) => {
        const inScale = def.intervals.includes(((pc - track.leadNote) % 12 + 12) % 12);
        const dot = document.createElement('span');
        dot.className = 'scales-preview-note' + (inScale ? ' in-scale' : ' out-scale');
        dot.textContent = name;
        preview.appendChild(dot);
      });
    };

    const onScaleChange = () => {
      updatePreview();
      rootBtns.forEach((b, j) => b.classList.toggle('active', j === track.leadNote));
    };
    this.state.on('scaleChanged', onScaleChange);
    this._activeWidgets.push({ destroy: () => this.state.off('scaleChanged', onScaleChange) });

    updatePreview();
    wrapper.appendChild(preview);

    // ── Keyboard folding toggle ──────────────────────────────
    const foldRow = document.createElement('div');
    foldRow.className = 'scales-fold-row';

    const foldLabel = document.createElement('span');
    foldLabel.className = 'scales-fold-label';
    foldLabel.textContent = 'KEYBOARD FOLD';

    const foldBtn = document.createElement('button');
    foldBtn.className = 'btn scales-fold-btn' + (this.state.keyFolding ? ' active' : '');
    foldBtn.textContent = this.state.keyFolding ? 'ON' : 'OFF';
    foldBtn.addEventListener('click', () => {
      this.state.keyFolding = !this.state.keyFolding;
      foldBtn.textContent = this.state.keyFolding ? 'ON' : 'OFF';
      foldBtn.classList.toggle('active', this.state.keyFolding);
      this.state.emit('keyFoldingChanged', { on: this.state.keyFolding });
    });

    const foldDesc = document.createElement('span');
    foldDesc.className = 'scales-fold-desc';
    foldDesc.textContent = 'a–\' / q–¨ map in-scale notes in series';

    foldRow.appendChild(foldLabel);
    foldRow.appendChild(foldBtn);
    foldRow.appendChild(foldDesc);
    wrapper.appendChild(foldRow);

    this._content.appendChild(wrapper);
  }

  _renderSounds(_track) {
    new SoundLibraryPanel(
      this._content,
      this.library,
      this.state,
      this.openModal,
      () => {
        // After loading a sound: re-render everything
        this.state.emit('trackSelected', {
          index: this.state.selectedTrackIndex,
          track: this.state.selectedTrack,
        });
        this._renderContent();
      },
      async (soundId) => {
        const track = this.state.selectedTrack;
        if (!track) return;
        const audio = this.state.project.audio;
        const ctx   = audio.context;

        // Snapshot current track state so we can restore after preview
        const snapshot = track.toJSON();

        // Load the preview sound onto the track
        this.library.load(soundId, track);

        // For samplers the buffer restore is async — wait for it before triggering.
        if (track.machine.type === 'sampler' && track.machine.sampleId) {
          const sampleStore = this.state.project.sampleStore;
          const buf = await sampleStore?.load(track.machine.sampleId, ctx);
          if (buf) track.machine.setBuffer(buf, track.machine.sampleId, track.machine.sampleName);
        }
        if (track.machine.type === 'wt-sampler') {
          const sampleStore = this.state.project.sampleStore;
          if (track.machine.sampleIdA) {
            const buf = await sampleStore?.load(track.machine.sampleIdA, ctx);
            if (buf) track.machine.setBufferA(buf, track.machine.sampleIdA, track.machine.sampleNameA);
          }
          if (track.machine.sampleIdB) {
            const buf = await sampleStore?.load(track.machine.sampleIdB, ctx);
            if (buf) track.machine.setBufferB(buf, track.machine.sampleIdB, track.machine.sampleNameB);
          }
        }

        const time = ctx.currentTime + 0.015;
        let restoreDelay;

        if (track.machine.type === 'sampler' && track.machine.hasBuffer) {
          const buf     = track.machine._buffer;
          const start   = track.machine.getParam('sample.start');
          const end     = track.machine.getParam('sample.end');
          const speed   = track.machine.getParam('sample.speed') || 1;
          const trimSec = Math.min((end - start) * buf.duration / speed, 8);
          restoreDelay  = (trimSec + 0.1) * 1000;

          // Hold amp envelope open — buffer source stops itself at end of region.
          track.envelope.noteOn(ctx.currentTime);
          track.machine.noteOn(60, 100, time);
        } else {
          const offTime = time + 0.5;
          const release = track.envelope._params['env.release'] ?? 0.3;
          restoreDelay  = (offTime - ctx.currentTime + release + 0.05) * 1000;

          track.machine.noteOn(60, 100, time);
          track.envelope.noteOn(time);
          track.machine.noteOff(offTime);
          track.envelope.noteOff(offTime);
        }

        setTimeout(() => {
          // Close the envelope and wait for the full release tail before
          // restoring — otherwise the new synth oscillator bleeds through.
          const release = track.envelope._params['env.release'] ?? 0.3;
          track.envelope.noteOff(ctx.currentTime);
          setTimeout(() => track.fromJSON(snapshot), (release + 0.05) * 1000);
        }, restoreDelay);
      }
    );
  }

  _renderMixer() {
    const tracks = this.state.project.tracks;

    const wrapper = document.createElement('div');
    wrapper.className = 'mixer-wrapper';

    tracks.forEach((track, i) => {
      const strip = document.createElement('div');
      strip.className = 'mixer-strip';
      strip.classList.toggle('mixer-strip-selected', i === this.state.selectedTrackIndex);

      // Track label
      const label = document.createElement('div');
      label.className = 'mixer-strip-label';
      label.textContent = `T${i + 1}`;
      strip.appendChild(label);

      const typeLbl = document.createElement('div');
      typeLbl.className = 'mixer-strip-type';
      typeLbl.textContent = track.machine?.type?.toUpperCase().replace('.', ' ') ?? '';
      strip.appendChild(typeLbl);

      // ── LEVEL knob (linked to output.level on the machine) ──
      const levelVal = track.machine.getParam('output.level') ?? 0.8;
      const levelKnob = new KnobWidget({
        label:   'LEVEL',
        min:     0,
        max:     1,
        value:   levelVal,
        bipolar: false,
        size:    44,
        fmt:     v => Math.round(v * 100) + '%',
        onChange: v => {
          track.machine.setParam('output.level', v);
          // Keep SynthPanel knob in sync when this track is selected
          if (i === this.state.selectedTrackIndex) {
            const linked = this._knobByPath.get('output.level');
            if (linked) linked.setValue(v);
          }
        },
      });
      strip.appendChild(levelKnob.el);
      this._activeWidgets.push(levelKnob);

      // ── 2×2 grid: DLY, CRUSH, REV, DJ FILT ──
      const grid = document.createElement('div');
      grid.className = 'mixer-knob-grid';
      strip.appendChild(grid);

      const fxDefs = [
        { obj: track.delayFX,    path: 'delay.wet',  label: 'DLY',     bipolar: false },
        { obj: track.bitcrushFX, path: 'crush.wet',  label: 'CRUSH',   bipolar: false },
        { obj: track.reverbFX,   path: 'reverb.wet', label: 'REV',     bipolar: false },
        { obj: null,             path: 'dj',         label: 'DJ FILT', bipolar: true  },
      ];
      fxDefs.forEach(({ obj, path, label: fxLabel, bipolar }) => {
        const val = path === 'dj' ? (track.djFilter ?? 0) : (obj.getParam(path) ?? 0);
        const knob = new KnobWidget({
          label:   fxLabel,
          min:     bipolar ? -1 : 0,
          max:     1,
          value:   val,
          bipolar,
          size:    44,
          fmt:     v => {
            if (path === 'dj') {
              if (Math.abs(v) < 0.02) return 'FLAT';
              return v < 0 ? 'LPF ' + Math.round(-v * 100) + '%' : 'HPF ' + Math.round(v * 100) + '%';
            }
            return Math.round(v * 100) + '%';
          },
          onChange: v => {
            if (path === 'dj') {
              track.applyDJFilter(v);
            } else {
              obj.setParam(path, v);
              if (i === this.state.selectedTrackIndex) {
                const linked = this._knobByPath.get(path);
                if (linked) linked.setValue(v);
              }
            }
          },
        });
        grid.appendChild(knob.el);
        this._activeWidgets.push(knob);
      });

      // ── FX on/off toggles ──
      const fxToggles = document.createElement('div');
      fxToggles.className = 'mixer-fx-toggles';

      [
        { fx: track.delayFX,    label: 'DLY'   },
        { fx: track.bitcrushFX, label: 'CRUSH' },
        { fx: track.reverbFX,   label: 'REV'   },
      ].forEach(({ fx, label: fxLabel }) => {
        const btn = document.createElement('button');
        btn.className = 'mixer-fx-toggle';
        const update = () => {
          const on = fx.enabled ?? false;
          btn.textContent = fxLabel;
          btn.classList.toggle('on', on);
        };
        update();
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          fx.setEnabled(!fx.enabled);
          update();
          // Keep the header FX bar in sync when this is the selected track
          if (i === this.state.selectedTrackIndex) {
            this._fxBar.querySelectorAll('._updateState').forEach(el => el._updateState?.());
            this._fxBar.querySelectorAll('[data-fxtab]').forEach(wrap => wrap._updateState?.());
          }
        });
        fxToggles.appendChild(btn);
      });

      strip.appendChild(fxToggles);

      // Click strip to select track
      strip.addEventListener('click', (e) => {
        if (e.target.closest('.knob-canvas')) return;
        this.state.selectTrack(i);
        // Re-render to update selection highlight
        wrapper.querySelectorAll('.mixer-strip').forEach((s, j) => {
          s.classList.toggle('mixer-strip-selected', j === i);
        });
      });

      wrapper.appendChild(strip);
    });

    this._content.appendChild(wrapper);
  }

  // Machine definitions shown in the machine tab, grouped
  static MACHINE_GROUPS = [
    {
      label: 'Drums',
      defs: [
        { type: 'kick.silk', label: 'Kick Silk', desc: 'Clean sine + pitch sweep' },
        { type: 'kick.hard', label: 'Kick Hard', desc: 'Sub + saturation + drive' },
        { type: 'snare',     label: 'Snare',     desc: 'Tone + noise' },
        { type: 'hihat',     label: 'HiHat',     desc: 'Inharmonic oscs' },
        { type: 'cymbal',    label: 'Cymbal',    desc: 'Crash / ride cymbal' },
        { type: 'clapp',     label: 'Clapp',     desc: '808-style layered clap' },
        { type: 'wood',      label: 'Wood',      desc: 'Clave / rimshot / cowbell' },
        { type: 'transient', label: 'Transient', desc: 'Click + body sweep' },
        { type: 'noise',     label: 'Noise',     desc: 'Shaped noise + crush' },
      ],
    },
    {
      label: 'Melodic',
      defs: [
        { type: 'synth',     label: 'Synth',     desc: 'Dual osc + sub' },
        { type: 'bass',      label: 'Bass',      desc: 'Bassline + glide + drive' },
        { type: 'chord',     label: 'Chord',     desc: '4-voice chord sequencer' },
        { type: 'wavetable', label: 'Wavetable', desc: 'Morphing wavetable osc' },
        { type: 'swarm',     label: 'Swarm',     desc: '7 saws + drift' },
        { type: 'fm',        label: 'FM',        desc: '4-op FM synth' },
        { type: 'karplus',   label: 'Karplus',   desc: 'Plucked string' },
        { type: 'marimba',   label: 'Marimba',   desc: 'Inharmonic bar percussion' },
        { type: 'comb',      label: 'Comb',      desc: 'Resonator / comb filter' },
      ],
    },
    {
      label: 'Sampler',
      defs: [
        { type: 'sampler',      label: 'Sampler',    desc: 'Load file or record mic' },
        { type: 'wt-sampler',   label: 'WT Sampler', desc: 'Morph between two samples' },
        { type: 'sample-swarm', label: 'Smp Swarm',  desc: '7-voice sample swarm cluster' },
      ],
    },
    {
      label: 'MIDI',
      defs: [
        { type: 'midi', label: 'MIDI Out', desc: 'Send notes to external MIDI device' },
      ],
    },
  ];

  // Flat list for backward-compat (MACHINE_DEFS referenced from tests / external code)
  static get MACHINE_DEFS() {
    return SynthPanel.MACHINE_GROUPS.flatMap(g => g.defs);
  }

  _renderMachineTab(track) {
    const current = track.machine?.type ?? 'synth';

    // ── Search input ──────────────────────────────────────────
    const searchWrap = document.createElement('div');
    searchWrap.className = 'machine-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type        = 'text';
    searchInput.placeholder = 'Filter machines…';
    searchInput.className   = 'machine-search';
    searchWrap.appendChild(searchInput);
    this._content.appendChild(searchWrap);

    // ── Grid container ────────────────────────────────────────
    const gridWrap = document.createElement('div');
    gridWrap.className = 'machine-grid-wrap';
    this._content.appendChild(gridWrap);

    const allCards = []; // { el, def, groupColEl }

    SynthPanel.MACHINE_GROUPS.forEach(group => {
      const col = document.createElement('div');
      col.className = 'machine-group';
      gridWrap.appendChild(col);

      const heading = document.createElement('div');
      heading.className   = 'machine-group-heading';
      heading.textContent = group.label;
      col.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'machine-grid';
      col.appendChild(grid);

      group.defs.forEach(def => {
        const btn = document.createElement('button');
        btn.className = 'machine-card btn';
        btn.classList.toggle('selected', def.type === current);
        btn.innerHTML = `
          <span class="machine-card-label">${def.label}</span>
          <span class="machine-card-desc">${def.desc}</span>
        `;

        btn.addEventListener('click', () => {
          if (def.type === current) return;
          track.setMachine(def.type);
          this.state.emit('trackSelected', {
            index: this.state.selectedTrackIndex,
            track,
          });
          this._renderContent();
        });

        grid.appendChild(btn);
        allCards.push({ el: btn, def, colEl: col });
      });
    });

    // ── Filter logic ──────────────────────────────────────────
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      allCards.forEach(({ el, def }) => {
        const match = !q
          || def.label.toLowerCase().includes(q)
          || def.desc.toLowerCase().includes(q)
          || def.type.toLowerCase().includes(q);
        el.style.display = match ? '' : 'none';
      });
      // Hide entire group column when all its cards are hidden
      SynthPanel.MACHINE_GROUPS.forEach(group => {
        const cards = allCards.filter(c => group.defs.some(d => d.type === c.def.type));
        const anyVisible = cards.some(c => c.el.style.display !== 'none');
        if (cards[0]?.colEl) cards[0].colEl.style.display = anyVisible ? '' : 'none';
      });
    });
  }

  /**
   * Build the context object passed to machine panel renderers.
   * Panels receive everything they need to build knobs + wire p-locks
   * without importing AppState directly.
   */
  _makePanelContext(track) {
    return {
      machine:       track.machine,
      step:          this._step(),
      hasStep:       this._hasStep(),
      container:     this._content,
      activeWidgets: this._activeWidgets,
      knobByPath:    this._knobByPath,
      state:         this.state,
      getTrack:      () => this.state.selectedTrack,
      writeValue:    (target, path, value, emitChange) => this._writeValue(target, path, value, emitChange),
      emitStep:      () => {
        const s = this._step();
        if (s) this.state.emit('stepChanged', {
          trackIndex: this.state.selectedTrackIndex,
          stepIndex:  this.state.selectedStepIndex,
          step:       s,
        });
      },
      fmtParam: (p, v) => this._fmtParam(p, v),
    };
  }

  _renderSynth(track) {
    if (track.machine.type === 'sampler') {
      const ctx = this._makePanelContext(track);
      new SamplerPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'wt-sampler') {
      const ctx = this._makePanelContext(track);
      new WavetableSamplerPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'sample-swarm') {
      const ctx = this._makePanelContext(track);
      new SampleSwarmPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'midi') {
      const ctx = this._makePanelContext(track);
      new MidiPanel(this._content, ctx, this.midiEngine);
      return;
    }
    const ctx = this._makePanelContext(track);
    const panel = track.machine.type === 'fm'
      ? new FMPanel()
      : new DefaultMachinePanel();
    panel.render(ctx);
  }

  _renderArp(track) {
    const panel = new ArpPanel(
      this._content,
      track,
      () => this._renderContent(),   // rebuildArp — re-renders the whole content area
    );
    this._activeWidgets.push(panel);
  }

  _renderFilter(track) {
    const step    = this._step();
    const hasStep = step !== null;

    // Plock-aware param readers — used by viz so it reflects p-locked values
    const getFilterParam = path => (hasStep && step.plocks.has(path)) ? step.plocks.get(path) : track.filter.getParam(path);
    const getEnvParam    = path => (hasStep && step.plocks.has(path)) ? step.plocks.get(path) : track.envelope.getParam(path);

    // ── Outer wrapper ────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-tab-wrapper';
    this._content.appendChild(wrapper);

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
    this._activeWidgets.push({ destroy: () => mainViz.destroy() });
    this._activeViz = mainViz;
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
          this._writeValue(track.filter, path, v, false);
          knob.setHasPLock(hasStep);
          mainViz.refresh();
        },
        onRelease: () => {
          if (hasStep) this.state.emit('stepChanged', { trackIndex: this.state.selectedTrackIndex, stepIndex: this.state.selectedStepIndex, step });
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
      this._writeValue(track.filter, 'filter.type', newType, true);
      gainKnob.el.style.display = newType === 'peaking' ? '' : 'none';
      // Peaking EQ needs non-zero gain for any effect — seed a +6dB default
      if (newType === 'peaking' && track.filter.getParam('filter.gain') === 0) {
        this._writeValue(track.filter, 'filter.gain', 6, true);
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
    this._activeWidgets.push(cutoffKnob, resKnob, gainKnob, envAmtKnob, slopeKnob);
    this._knobByPath.set('filter.cutoff',    cutoffKnob);
    this._knobByPath.set('filter.resonance', resKnob);
    this._knobByPath.set('filter.gain',      gainKnob);
    this._knobByPath.set('filter.envAmount', envAmtKnob);
    this._knobByPath.set('filter.slope',     slopeKnob);

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
          this._writeValue(track.filter, p.path, v, false);
          knob.setHasPLock(hasStep);
          mainViz.refresh();
        },
        onRelease: () => {
          if (hasStep) this.state.emit('stepChanged', { trackIndex: this.state.selectedTrackIndex, stepIndex: this.state.selectedStepIndex, step });
          mainViz.refresh();
        },
      });
      knob.setHasPLock(hasPLock);
      baseKnobRow.appendChild(knob.el);
      this._activeWidgets.push(knob);
      this._knobByPath.set(p.path, knob);
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
        const s = this._step();
        if (s) { s.setPLock(path, value); } else { track.envelope.setParam(path, value); }
        mainViz.refresh();
      },
      getStepPLock: path => step ? (step.plocks.has(path) ? step.plocks.get(path) : null) : null,
      setStepPLock: (path, value) => { if (step) { step.setPLock(path, value); mainViz.refresh(); } },
      onRelease: () => {
        const s = this._step();
        if (s) this.state.emit('stepChanged', { trackIndex: this.state.selectedTrackIndex, stepIndex: this.state.selectedStepIndex, step: s });
        mainViz.refresh();
      },
      hasStep: () => this._hasStep(),
    });
    fenvSec.appendChild(fenv.el);
    this._activeWidgets.push(fenv);
    requestAnimationFrame(() => fenv.refresh());
  }

  _renderEnv(track) {
    const step = this._step();
    const hasStep = step !== null;

    const row = document.createElement('div');
    row.className = 'amp-tab-row';
    this._content.appendChild(row);

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
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step,
          });
        }
      },
    });
    panKnob.setHasPLock(hasPanPLock);
    panSec.appendChild(panKnob.el);
    this._activeWidgets.push(panKnob);
    this._knobByPath.set('amp.pan', panKnob);

    // ── Amp ADSR (right, compact) ──────────────────────────────
    const adsrSec = document.createElement('div');
    adsrSec.className = 'amp-adsr-sec';
    row.appendChild(adsrSec);

    const adsr = new ADSRWidget({
      prefix:   'env',
      canvasH:  80,
      getParam:     path => track.envelope.getParam(path),
      setParam:     (path, value) => {
        const s = this._step();
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
        const s = this._step();
        if (s) {
          this.state.emit('stepChanged', {
            trackIndex: this.state.selectedTrackIndex,
            stepIndex:  this.state.selectedStepIndex,
            step: s,
          });
        }
      },
      hasStep: () => this._hasStep(),
    });

    adsrSec.appendChild(adsr.el);
    this._activeWidgets.push(adsr);

    requestAnimationFrame(() => adsr.refresh());
  }

  // ── FX tab helpers ──────────────────────────────────────────

  /**
   * Render a generic FX tab: section label + knob row.
   * Non-modulatable params (like crush.bits, reverb.decay) are always track-level.
   * Modulatable params are p-lockable when a step is selected.
   */
  _renderFXTab(track, fxObj, sectionLabel, fmtOverrides = {}) {
    const step    = this._step();
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

      if (p.type === 'enum') {
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
            this._renderContent();
          });
          btnRow.appendChild(b);
        });

        cell.appendChild(btnRow);
        knobRow.appendChild(cell);

      } else if (p.type === 'number') {
        const isBipolar = p.min !== undefined && p.max !== undefined && p.min < 0 && p.max > 0 && p.min === -p.max;
        const fmtFn = fmtOverrides[p.path] ?? (v => this._fmtParam(p, v));

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
              this.state.emit('stepChanged', {
                trackIndex: this.state.selectedTrackIndex,
                stepIndex:  this.state.selectedStepIndex,
                step,
              });
            }
          },
        });
        knob.setHasPLock(hasPLock);
        knobRow.appendChild(knob.el);
        this._activeWidgets.push(knob);
        this._knobByPath.set(p.path, knob);
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

    this._content.appendChild(wrapper);
  }

  _renderMidiIn(track) {
    const midi = this.midiEngine;

    if (!midi?.available) {
      const msg = document.createElement('div');
      msg.className = 'midi-unavailable';
      msg.textContent = 'Web MIDI not available. Use Chrome/Edge and allow MIDI access.';
      this._content.appendChild(msg);
      return;
    }

    const inputs = [...midi.inputs.values()];

    // ── Input port ───────────────────────────────────────────────
    const portSection = document.createElement('div');
    portSection.className = 'midi-section';

    const portLabel = document.createElement('div');
    portLabel.className = 'midi-section-label';
    portLabel.textContent = 'MIDI In Source';
    portSection.appendChild(portLabel);

    const portSel = document.createElement('select');
    portSel.className = 'midi-select';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— off —';
    portSel.appendChild(noneOpt);

    inputs.forEach(inp => {
      const opt = document.createElement('option');
      opt.value = inp.id;
      opt.textContent = inp.name;
      if (inp.id === track.midiIn.inputId) opt.selected = true;
      portSel.appendChild(opt);
    });

    portSel.addEventListener('change', () => {
      track.midiIn.inputId = portSel.value || null;
    });
    portSection.appendChild(portSel);
    this._content.appendChild(portSection);

    // ── Channel filter ───────────────────────────────────────────
    const chSection = document.createElement('div');
    chSection.className = 'midi-section';

    const chLabel = document.createElement('div');
    chLabel.className = 'midi-section-label';
    chLabel.textContent = 'Channel Filter';
    chSection.appendChild(chLabel);

    const chSel = document.createElement('select');
    chSel.className = 'midi-select';

    const allOpt = document.createElement('option');
    allOpt.value = '0';
    allOpt.textContent = 'All channels';
    chSel.appendChild(allOpt);

    for (let c = 1; c <= 16; c++) {
      const opt = document.createElement('option');
      opt.value = String(c);
      opt.textContent = `Ch ${c}`;
      if (c === track.midiIn.channel) opt.selected = true;
      chSel.appendChild(opt);
    }
    if (track.midiIn.channel === 0) chSel.value = '0';

    chSel.addEventListener('change', () => {
      track.midiIn.channel = parseInt(chSel.value, 10);
    });
    chSection.appendChild(chSel);
    this._content.appendChild(chSection);

    // ── CC mappings ──────────────────────────────────────────────
    const ccSection = document.createElement('div');
    ccSection.className = 'midi-section';

    const ccTitle = document.createElement('div');
    ccTitle.className = 'midi-section-label';
    ccTitle.textContent = 'CC → Param Mappings';
    ccSection.appendChild(ccTitle);

    const rebuildMappings = () => {
      // Remove all mapping rows (leave the title)
      ccSection.querySelectorAll('.midi-cc-row, .midi-cc-add').forEach(el => el.remove());

      track.midiIn.ccMappings.forEach((mapping, i) => {
        const row = document.createElement('div');
        row.className = 'midi-cc-row';

        const ccInput = document.createElement('input');
        ccInput.type      = 'number';
        ccInput.min       = 0;
        ccInput.max       = 127;
        ccInput.value     = mapping.cc;
        ccInput.className = 'midi-cc-num';
        ccInput.title     = 'CC number (0–127)';
        ccInput.addEventListener('change', () => {
          mapping.cc = Math.max(0, Math.min(127, parseInt(ccInput.value, 10) || 0));
        });

        const arrow = document.createElement('span');
        arrow.className   = 'midi-cc-arrow';
        arrow.textContent = '→';

        const paramSel = document.createElement('select');
        paramSel.className = 'midi-select midi-cc-param';

        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '— none —';
        paramSel.appendChild(emptyOpt);

        const groups = track.getAssignableParams();
        groups.forEach(g => {
          const optgroup = document.createElement('optgroup');
          optgroup.label = g.group;
          g.items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.path;
            opt.textContent = item.label;
            if (item.path === mapping.param) opt.selected = true;
            optgroup.appendChild(opt);
          });
          paramSel.appendChild(optgroup);
        });

        paramSel.addEventListener('change', () => {
          mapping.param = paramSel.value;
        });

        const rmBtn = document.createElement('button');
        rmBtn.className   = 'btn midi-cc-rm';
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', () => {
          track.midiIn.ccMappings.splice(i, 1);
          rebuildMappings();
        });

        row.appendChild(ccInput);
        row.appendChild(arrow);
        row.appendChild(paramSel);
        row.appendChild(rmBtn);
        ccSection.appendChild(row);
      });

      const addBtn = document.createElement('button');
      addBtn.className   = 'btn midi-cc-add';
      addBtn.textContent = '+ Add CC';
      addBtn.addEventListener('click', () => {
        track.midiIn.ccMappings.push({ cc: 1, param: '' });
        rebuildMappings();
      });
      ccSection.appendChild(addBtn);
    };

    rebuildMappings();
    this._content.appendChild(ccSection);
  }

  _renderDelay(track) {
    this._renderFXTab(track, track.delayFX, 'DELAY');
  }

  _renderCrush(track) {
    this._renderFXTab(track, track.bitcrushFX, 'BITCRUSH');
  }

  _renderReverb(track) {
    this._renderFXTab(track, track.reverbFX, 'REVERB');
  }

  _renderLFO(track) {
    // ── Sub-tab bar (LFO 1, LFO 2, …, +, ✕) ────────────────
    const subBar = document.createElement('div');
    subBar.className = 'lfo-sub-bar';

    track.lfos.forEach((_, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn lfo-sub-btn';
      btn.textContent = `LFO ${i + 1}`;
      btn.classList.toggle('active', i === this.state.activeLFOIndex);
      btn.addEventListener('click', () => this.state.setActiveLFO(i));
      subBar.appendChild(btn);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      track.addLFO();
      this.state.setActiveLFO(track.lfos.length - 1);
      this._renderContent();
    });
    subBar.appendChild(addBtn);

    if (track.lfos.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn lfo-remove-btn';
      rmBtn.textContent = '✕';
      rmBtn.title = `Remove LFO ${this.state.activeLFOIndex + 1}`;
      rmBtn.addEventListener('click', () => {
        const idx = this.state.activeLFOIndex;
        track.removeLFO(idx);
        this.state.setActiveLFO(Math.min(idx, track.lfos.length - 1));
        this._renderContent();
      });
      subBar.appendChild(rmBtn);
    }
    this._content.appendChild(subBar);

    const lfo = track.lfos[this.state.activeLFOIndex];
    if (!lfo) return;

    // ── Destination dropdown (unchanged logic) ───────────────
    this._renderLFODestination(track, lfo);

    // ── Simple / Advanced toggle ─────────────────────────────
    const modeRow = document.createElement('div');
    modeRow.className = 'lfo-mode-row';

    ['simple', 'advanced'].forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'btn lfo-mode-btn' + (lfo.getParam('lfo.mode') === m ? ' active' : '');
      btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      btn.addEventListener('click', () => {
        lfo.setParam('lfo.mode', m);
        this._renderContent();
      });
      modeRow.appendChild(btn);
    });
    this._content.appendChild(modeRow);

    // ── Two-column body: simple (left) + advanced (right) ───
    const body = document.createElement('div');
    body.className = 'lfo-body';
    this._content.appendChild(body);

    const simpleCol = document.createElement('div');
    simpleCol.className = 'lfo-col lfo-col-simple';
    body.appendChild(simpleCol);

    this._renderLFOSimple(lfo, simpleCol);

    if (lfo.getParam('lfo.mode') === 'advanced') {
      const advCol = document.createElement('div');
      advCol.className = 'lfo-col lfo-col-advanced';
      body.appendChild(advCol);
      this._renderLFOAdvanced(lfo, advCol);
    }
  }

  _renderLFODestination(track, lfo) {
    const destWrap = document.createElement('div');
    destWrap.className = 'wt-select-wrap lfo-dest-wrap';

    const destLabel = document.createElement('div');
    destLabel.className = 'wt-select-label';
    destLabel.textContent = 'Destination';
    destWrap.appendChild(destLabel);

    const currentDestPath = track._lfoDestPaths[this.state.activeLFOIndex] ?? '';

    const btnEl  = document.createElement('button');
    btnEl.className = 'wt-select-btn' + (currentDestPath ? ' has-value' : '');
    const valEl  = document.createElement('span');
    valEl.className = 'wt-select-value' + (currentDestPath ? '' : ' placeholder');
    const listEl = document.createElement('div');
    listEl.className = 'wt-select-list';
    const searchEl = document.createElement('input');
    searchEl.className = 'wt-select-search';
    searchEl.type = 'text';
    searchEl.placeholder = 'search…';
    searchEl.autocomplete = 'off';
    const itemsEl = document.createElement('div');
    itemsEl.className = 'wt-select-items';
    const noneEl  = document.createElement('div');
    noneEl.className = 'wt-select-none';
    noneEl.textContent = 'no match';
    const arrowEl = document.createElement('span');
    arrowEl.className = 'wt-select-arrow';

    btnEl.appendChild(valEl);
    btnEl.appendChild(arrowEl);
    listEl.appendChild(searchEl);
    listEl.appendChild(itemsEl);
    listEl.appendChild(noneEl);
    destWrap.appendChild(btnEl);
    destWrap.appendChild(listEl);

    const groups = track.getAssignableParams();
    let foundLabel = '';
    groups.forEach(group => {
      const hdr = document.createElement('div');
      hdr.className = 'wt-select-group';
      hdr.textContent = group.group;
      itemsEl.appendChild(hdr);
      group.items.forEach(item => {
        const opt = document.createElement('div');
        opt.className = 'wt-select-option';
        opt.textContent = item.label;
        opt.dataset.value = item.path;
        opt.dataset.label = item.label;
        opt.dataset.group = group.group.toLowerCase();
        if (item.path === currentDestPath) { opt.classList.add('selected'); foundLabel = item.label; }
        opt.addEventListener('mousedown', e => { e.preventDefault(); selectDest(item, opt); closeDropdown(); });
        itemsEl.appendChild(opt);
      });
    });

    const noneOpt = document.createElement('div');
    noneOpt.className = 'wt-select-option wt-select-clear';
    noneOpt.textContent = '— none —';
    noneOpt.dataset.value = '';
    noneOpt.dataset.label = '';
    noneOpt.dataset.group = '';
    if (!currentDestPath) noneOpt.classList.add('selected');
    noneOpt.addEventListener('mousedown', e => { e.preventDefault(); selectDest({ path: '', label: '' }, noneOpt); closeDropdown(); });
    itemsEl.prepend(noneOpt);

    valEl.textContent = foundLabel || '— none —';
    if (!foundLabel) valEl.classList.add('placeholder');

    function selectDest(item, optEl) {
      itemsEl.querySelectorAll('.wt-select-option.selected').forEach(o => o.classList.remove('selected'));
      if (optEl) optEl.classList.add('selected');
      if (item.path) {
        valEl.textContent = item.label;
        valEl.classList.remove('placeholder');
        btnEl.classList.add('has-value');
      } else {
        valEl.textContent = '— none —';
        valEl.classList.add('placeholder');
        btnEl.classList.remove('has-value');
      }
      track.setLFODestination(track.lfos.indexOf(lfo), item.path);
    }
    function openDropdown() { listEl.classList.add('open'); btnEl.classList.add('open'); searchEl.value = ''; filterItems(''); searchEl.focus(); }
    function closeDropdown() { listEl.classList.remove('open'); btnEl.classList.remove('open'); }
    function filterItems(q) {
      const query = q.toLowerCase().trim();
      let anyVisible = false;
      const groupVis = {};
      itemsEl.querySelectorAll('.wt-select-option').forEach(opt => {
        if (opt.classList.contains('wt-select-clear')) { opt.classList.remove('hidden'); return; }
        const match = !query || opt.dataset.label.toLowerCase().includes(query) || opt.dataset.group.includes(query);
        opt.classList.toggle('hidden', !match);
        if (match) { anyVisible = true; groupVis[opt.dataset.group] = true; }
      });
      itemsEl.querySelectorAll('.wt-select-group').forEach(g => {
        g.style.display = groupVis[g.textContent.toLowerCase()] ? '' : 'none';
      });
      noneEl.style.display = anyVisible ? 'none' : 'block';
    }

    btnEl.addEventListener('click', () => listEl.classList.contains('open') ? closeDropdown() : openDropdown());
    searchEl.addEventListener('input', () => filterItems(searchEl.value));
    const outsideClick = e => { if (!btnEl.contains(e.target) && !listEl.contains(e.target)) closeDropdown(); };
    const escKey = e => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', outsideClick);
    document.addEventListener('keydown', escKey);
    this._activeWidgets.push({ destroy: () => {
      document.removeEventListener('mousedown', outsideClick);
      document.removeEventListener('keydown', escKey);
    }});

    this._content.appendChild(destWrap);
  }

  _renderLFOSimple(lfo, container) {
    // ── Row 1: Waveform + Trig mode buttons ──────────────────
    const row1 = document.createElement('div');
    row1.className = 'lfo-row';

    // Waveform selector
    const wfGroup = document.createElement('div');
    wfGroup.className = 'lfo-btn-group';
    const wfLabel = document.createElement('span');
    wfLabel.className = 'lfo-group-label';
    wfLabel.textContent = 'Wave';
    wfGroup.appendChild(wfLabel);
    const wfBtns = document.createElement('div');
    wfBtns.className = 'lfo-btn-row';
    ['sine','square','sawtooth','triangle'].forEach(w => {
      const b = document.createElement('button');
      b.className = 'btn lfo-wave-btn' + (lfo.getParam('lfo.waveform') === w ? ' active' : '');
      b.textContent = w === 'sawtooth' ? 'saw' : w === 'triangle' ? 'tri' : w;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.waveform', w);
        wfBtns.querySelectorAll('.lfo-wave-btn').forEach(x => x.classList.toggle('active', x === b));
      });
      wfBtns.appendChild(b);
    });
    wfGroup.appendChild(wfBtns);
    row1.appendChild(wfGroup);

    // Trig mode selector
    const tgGroup = document.createElement('div');
    tgGroup.className = 'lfo-btn-group';
    const tgLabel = document.createElement('span');
    tgLabel.className = 'lfo-group-label';
    tgLabel.textContent = 'Trig';
    tgGroup.appendChild(tgLabel);
    const tgBtns = document.createElement('div');
    tgBtns.className = 'lfo-btn-row';
    [['free','FRE'],['trig','TRG']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-trig-btn' + (lfo.getParam('lfo.trigMode') === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.trigMode', val);
        tgBtns.querySelectorAll('.lfo-trig-btn').forEach(x => x.classList.toggle('active', x === b));
      });
      tgBtns.appendChild(b);
    });
    tgGroup.appendChild(tgBtns);
    row1.appendChild(tgGroup);

    container.appendChild(row1);

    // ── Row 2: Speed knobs + BPM sync toggle ─────────────────
    const row2 = document.createElement('div');
    row2.className = 'lfo-row';

    const syncMode = lfo.getParam('lfo.syncMode');

    // BPM / Hz toggle
    const syncGroup = document.createElement('div');
    syncGroup.className = 'lfo-btn-group';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'lfo-group-label';
    syncLabel.textContent = 'Sync';
    syncGroup.appendChild(syncLabel);
    const syncBtns = document.createElement('div');
    syncBtns.className = 'lfo-btn-row';
    [['hz','Hz'],['bpm','BPM']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-sync-btn' + (syncMode === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.syncMode', val);
        this._renderContent();
      });
      syncBtns.appendChild(b);
    });
    syncGroup.appendChild(syncBtns);
    row2.appendChild(syncGroup);

    if (syncMode === 'hz') {
      // Speed Hz knob
      const speedP = { path: 'lfo.speed', label: 'Speed', min: 0.001, max: 20, default: 0.1 };
      const speedKnob = new KnobWidget({
        label: 'Speed', min: 0.001, max: 20,
        value: lfo.getParam('lfo.speed'),
        size: 56, fmt: v => this._fmtParam(speedP, v),
        onChange: v => lfo.setParam('lfo.speed', v),
      });
      row2.appendChild(speedKnob.el);
      this._activeWidgets.push(speedKnob);

      // Mult knob
      const multP = { path: 'lfo.speedMult', label: 'Mult', min: 1, max: 32, default: 1 };
      const multKnob = new KnobWidget({
        label: 'Mult', min: 1, max: 32,
        value: lfo.getParam('lfo.speedMult'),
        size: 56, fmt: v => this._fmtParam(multP, v),
        onChange: v => lfo.setParam('lfo.speedMult', v),
      });
      row2.appendChild(multKnob.el);
      this._activeWidgets.push(multKnob);
    } else {
      // BPM division selector
      const divGroup = document.createElement('div');
      divGroup.className = 'lfo-btn-group';
      const divLabel = document.createElement('span');
      divLabel.className = 'lfo-group-label';
      divLabel.textContent = 'Division';
      divGroup.appendChild(divLabel);
      const divBtns = document.createElement('div');
      divBtns.className = 'lfo-btn-row lfo-div-row';
      BPM_DIVISIONS.forEach(div => {
        const b = document.createElement('button');
        b.className = 'btn lfo-div-btn' + (lfo.getParam('lfo.bpmDiv') === div ? ' active' : '');
        b.textContent = div;
        b.addEventListener('click', () => {
          lfo.setParam('lfo.bpmDiv', div);
          divBtns.querySelectorAll('.lfo-div-btn').forEach(x => x.classList.toggle('active', x === b));
        });
        divBtns.appendChild(b);
      });
      divGroup.appendChild(divBtns);
      row2.appendChild(divGroup);
    }

    container.appendChild(row2);

    // ── Row 3: Depth + Phase + Fade knobs ────────────────────
    const row3 = document.createElement('div');
    row3.className = 'lfo-knobs-wrap';

    const depthP = { path: 'lfo.depth', label: 'Depth', min: 0, max: 100 };
    const depthKnob = new KnobWidget({
      label: 'Depth', min: 0, max: 100,
      value: lfo.getParam('lfo.depth'),
      size: 64, fmt: v => this._fmtParam(depthP, v),
      onChange: v => lfo.setParam('lfo.depth', v),
    });
    row3.appendChild(depthKnob.el);
    this._activeWidgets.push(depthKnob);

    const phaseP = { path: 'lfo.startPhase', label: 'Phase', min: 0, max: 127 };
    const phaseKnob = new KnobWidget({
      label: 'Phase', min: 0, max: 127,
      value: lfo.getParam('lfo.startPhase'),
      size: 64, fmt: v => this._fmtParam(phaseP, v),
      onChange: v => lfo.setParam('lfo.startPhase', v),
    });
    row3.appendChild(phaseKnob.el);
    this._activeWidgets.push(phaseKnob);

    const fadeP = { path: 'lfo.fade', label: 'Fade', min: -100, max: 100 };
    const fadeKnob = new KnobWidget({
      label: 'Fade', min: -100, max: 100,
      value: lfo.getParam('lfo.fade'),
      bipolar: true,
      size: 64, fmt: v => this._fmtParam(fadeP, v),
      onChange: v => lfo.setParam('lfo.fade', v),
    });
    row3.appendChild(fadeKnob.el);
    this._activeWidgets.push(fadeKnob);

    container.appendChild(row3);
  }

  _renderLFOAdvanced(lfo, container) {
    // ── ADSR source toggle ───────────────────────────────────
    const srcRow = document.createElement('div');
    srcRow.className = 'lfo-row lfo-adsr-source-row';
    const srcLabel = document.createElement('span');
    srcLabel.className = 'lfo-group-label';
    srcLabel.textContent = 'ADSR source';
    srcRow.appendChild(srcLabel);
    const srcBtns = document.createElement('div');
    srcBtns.className = 'lfo-btn-row';
    [['own','Own'],['amp','Amp sync']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'btn lfo-src-btn' + (lfo.getParam('lfo.adsrSource') === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        lfo.setParam('lfo.adsrSource', val);
        this._renderContent();
      });
      srcBtns.appendChild(b);
    });
    srcRow.appendChild(srcBtns);
    container.appendChild(srcRow);

    // ── Per-section panels: 2×2 grid (A D / S R) ────────────
    const ownMode = lfo.getParam('lfo.adsrSource') === 'own';
    const syncMode = lfo.getParam('lfo.syncMode');

    const grid = document.createElement('div');
    grid.className = 'lfo-adsr-grid';
    container.appendChild(grid);

    ['a','d','s','r'].forEach(sec => {
      const cell = document.createElement('div');
      cell.className = 'lfo-adsr-cell';

      const hdr = document.createElement('div');
      hdr.className = 'lfo-adsr-sec-header';
      hdr.textContent = sec.toUpperCase();
      cell.appendChild(hdr);

      const knobRow = document.createElement('div');
      knobRow.className = 'lfo-knobs-wrap';

      // Time knob (own source, A/D/R only — S is gate-length)
      if (ownMode && sec !== 's') {
        const timeP = { path: `lfo.adsr.${sec}.time` };
        const timeKnob = new KnobWidget({
          label: 'Time', min: 0.001, max: 8,
          value: lfo.getParam(`lfo.adsr.${sec}.time`),
          size: 44, fmt: v => this._fmtParam(timeP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.time`, v),
        });
        knobRow.appendChild(timeKnob.el);
        this._activeWidgets.push(timeKnob);
      }

      // Depth knob
      const depthP = { path: `lfo.adsr.${sec}.depth` };
      const depthKnob = new KnobWidget({
        label: 'Depth', min: 0, max: 100,
        value: lfo.getParam(`lfo.adsr.${sec}.depth`),
        size: 44, fmt: v => this._fmtParam(depthP, v),
        onChange: v => lfo.setParam(`lfo.adsr.${sec}.depth`, v),
      });
      knobRow.appendChild(depthKnob.el);
      this._activeWidgets.push(depthKnob);

      // Speed knob (Hz) or div selector (BPM)
      if (syncMode === 'hz') {
        const speedP = { path: `lfo.adsr.${sec}.speed` };
        const speedKnob = new KnobWidget({
          label: 'Speed', min: 0.001, max: 20,
          value: lfo.getParam(`lfo.adsr.${sec}.speed`),
          size: 44, fmt: v => this._fmtParam(speedP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.speed`, v),
        });
        knobRow.appendChild(speedKnob.el);
        this._activeWidgets.push(speedKnob);

        const multP = { path: `lfo.adsr.${sec}.mult` };
        const multKnob = new KnobWidget({
          label: 'Mult', min: 1, max: 32,
          value: lfo.getParam(`lfo.adsr.${sec}.mult`),
          size: 44, fmt: v => this._fmtParam(multP, v),
          onChange: v => lfo.setParam(`lfo.adsr.${sec}.mult`, v),
        });
        knobRow.appendChild(multKnob.el);
        this._activeWidgets.push(multKnob);
      } else {
        const divSel = document.createElement('select');
        divSel.className = 'param-select lfo-div-sel';
        BPM_DIVISIONS.forEach(div => {
          const o = document.createElement('option');
          o.value = div; o.textContent = div;
          if (lfo.getParam(`lfo.adsr.${sec}.speed`) === div) o.selected = true;
          divSel.appendChild(o);
        });
        divSel.addEventListener('change', () => lfo.setParam(`lfo.adsr.${sec}.speed`, divSel.value));
        const divWrap = document.createElement('div');
        divWrap.className = 'param-row';
        const divLbl = document.createElement('span');
        divLbl.className = 'param-label label';
        divLbl.textContent = 'Div';
        divWrap.appendChild(divLbl);
        divWrap.appendChild(divSel);
        knobRow.appendChild(divWrap);
      }

      cell.appendChild(knobRow);
      grid.appendChild(cell);
    });
  }
}
