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

import { Condition }               from '../sequencer/Condition.js';
import { FMPanel }                 from './panels/FMPanel.js';
import { DefaultMachinePanel }     from './panels/DefaultMachinePanel.js';
import { MidiPanel }               from './panels/MidiPanel.js';
import { SamplerPanel }            from './panels/SamplerPanel.js';
import { WavetableSamplerPanel }   from './panels/WavetableSamplerPanel.js';
import { SampleSwarmPanel }        from './panels/SampleSwarmPanel.js';
import { ArpPanel }                from './panels/ArpPanel.js';
import { formatParam }             from './panels/formatParam.js';
import { TrigPanel }            from './panels/TrigPanel.js';
import { LFOPanel }             from './panels/LFOPanel.js';
import { ScalesPanel }          from './panels/ScalesPanel.js';
import { FilterPanel }          from './panels/FilterPanel.js';
import { MidiInPanel }          from './panels/MidiInPanel.js';
import { MixerPanel }           from './panels/MixerPanel.js';
import { DeckPanel }            from './panels/DeckPanel.js';
import { AmpPanel }             from './panels/AmpPanel.js';
import { FXPanel }              from './panels/FXPanel.js';
import { SoundsPanel }          from './panels/SoundsPanel.js';
import { MachinePickerPanel, MACHINE_GROUPS, MACHINE_DEFS } from './panels/MachinePickerPanel.js';
import { ManualOverlay }        from './manual.js';

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
    // Fallback only; the live store follows the controlled deck (see getter below).
    this._sampleStore = sampleStore  ?? null;
    this.audioContext = audioContext ?? null;
    this.midiEngine   = midiEngine   ?? null;

    this._activeWidgets = [];
    // path → KnobWidget, rebuilt each time the content area renders
    this._knobByPath    = new Map();
    // FilterViz reference for the currently rendered filter tab, or null
    this._activeViz     = null;

    // Clipboard: { type: 'step'|'machine', data: object }
    this._clipboard = null;

    // In-app manual (Tier 1): 📖 transport button opens the overlay for the
    // currently active tab. No modal mode — just a direct open.
    this._manual = new ManualOverlay();

    this._buildShell();

    state.on('trackSelected', () => this.render());
    state.on('tabChanged',    () => this.render());
    state.on('lfoChanged',    () => { if (state.activeTab === 'lfo') this._renderContent(); });
    state.on('stepSelected',  () => { this._renderPLockTabIndicators(); this._renderContent(); });
    // stepChanged: re-render only on trig tab (note display + button state must update).
    // On other tabs we skip — must not rebuild knobs mid-drag. Always refresh the
    // p-lock tab indicators (a p-lock may have been added/removed on this step).
    state.on('stepChanged',   () => {
      this._renderPLockTabIndicators();
      if (state.activeTab === 'trig') this._renderContent();
    });
    // paramChanged: mod wheel (or any external source) changed a param — update knob + viz
    state.on('paramChanged',  ({ path, value }) => {
      const knob = this._knobByPath.get(path);
      if (knob) knob.setValue(value);
      this._activeViz?.refresh();
    });
  }

  /** Sample store of the controlled deck (so sampler tabs hit the right store). */
  get sampleStore() {
    return this.state.project?.sampleStore ?? this._sampleStore;
  }

  /** Open the manual overlay for the currently active tab. */
  openManual() {
    const machineType = this.state.selectedTrack?.machine?.type;
    this._manual.show(this.state.activeTab, machineType);
  }

  /** Toggle the manual overlay (open if closed, close if open). */
  toggleManual() {
    if (this._manual.isOpen()) {
      this._manual.hide();
    } else {
      this.openManual();
    }
  }

  _buildShell() {
    this.container.innerHTML = '';

    // ── Header: tab bar (left) + FX toggles (right) ─────────
    const header = document.createElement('div');
    header.className = 'panel-header';

    this._tabBar = document.createElement('div');
    this._tabBar.className = 'tab-bar';

    // Voice tabs only — FX moved to right-side toggles
    const leftTabs = ['machine', 'sounds', 'scales', 'trig', 'synth', 'arp', 'filter', 'amp', 'lfo', 'midi', 'mixer', 'deck'];
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
      { tab: 'delay',  label: 'DLY',    getFx: () => this.state.selectedTrack?.delayFX },
      { tab: 'crush',  label: 'CRUSH',  getFx: () => this.state.selectedTrack?.bitcrushFX },
      { tab: 'chorus', label: 'CHORUS', getFx: () => this.state.selectedTrack?.chorusFX },
      { tab: 'reverb', label: 'REV',    getFx: () => this.state.selectedTrack?.reverbFX },
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
    this._renderPLockTabIndicators();
    this._renderContent();
  }

  /**
   * Map a p-locked param path to the tab/FX-toggle that edits it. Returns a
   * `data-tab` / `data-fxtab` key, or null if the path has no home tab.
   */
  _tabForPLockPath(path) {
    if (path.startsWith('filter.') || path.startsWith('fenv.') ||
        path === 'base.lpf' || path === 'base.hpf')          return 'filter';
    if (path.startsWith('env.') || path === 'amp.pan')        return 'amp';
    if (path.startsWith('arp.'))                              return 'arp';
    if (path.startsWith('lfo.'))                              return 'lfo';
    if (path.startsWith('delay.'))                            return 'delay';
    if (path.startsWith('crush.'))                            return 'crush';
    if (path.startsWith('chorus.'))                           return 'chorus';
    if (path.startsWith('reverb.'))                           return 'reverb';
    if (path === 'trig.tone' || path === 'osc.detune')        return 'trig';
    // Everything else is a machine param → SYNTH tab.
    return 'synth';
  }

  /**
   * Light up the tabs (and FX toggles) that own a p-locked param on the
   * currently-selected step. Refreshed on render + step (de)selection/change.
   */
  _renderPLockTabIndicators() {
    const step = this._step();
    const tabs = new Set();
    if (step) {
      for (const path of step.plocks.keys()) {
        const tab = this._tabForPLockPath(path);
        if (tab) tabs.add(tab);
      }
    }
    this._tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('has-plock', tabs.has(btn.dataset.tab));
    });
    this._fxBar.querySelectorAll('.fx-toggle-wrap').forEach(wrap => {
      wrap.classList.toggle('has-plock', tabs.has(wrap.dataset.fxtab));
    });
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
          chorusFX:   track.chorusFX.toJSON(),
          reverbFX:   track.reverbFX.toJSON(),
          analogue:   track.analogue,
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
      track.chorusFX.fromJSON(d.chorusFX ?? {});
      track.reverbFX.fromJSON(d.reverbFX ?? {});
      track.setAnalogue(d.analogue ?? (track.filter.getParam('filter.engine') === 'analogue'));

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
      case 'deck':    this._renderDeck();            break;
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
      case 'chorus': this._renderChorus(track); break;
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
      // Propagate the change to all non-canonical voice slots so every slot in
      // the round-robin plays the updated params, not just slot 0.
      const track = this.state.selectedTrack;
      if (track && target === track.machine) track._pool?.syncParams();
    }
  }

  _fmtParam(p, v) {
    return formatParam(p, v);
  }

  // ── Tab renderers ───────────────────────────────────────────

  _renderTrig(track) {
    new TrigPanel().render(this._makeTabContext(track));
  }

  _renderScales(track) {
    new ScalesPanel().render(this._makeTabContext(track));
  }

  _renderSounds(track) {
    new SoundsPanel().render(this._makeTabContext(track));
  }

  _renderMixer() {
    new MixerPanel().render(this._makeTabContext(this.state.selectedTrack));
  }

  _renderDeck() {
    new DeckPanel().render(this._makeTabContext(this.state.selectedTrack));
  }

  // Machine list re-exported from MachinePickerPanel for backward compat.
  static get MACHINE_GROUPS() { return MACHINE_GROUPS; }
  static get MACHINE_DEFS()   { return MACHINE_DEFS; }

  _renderMachineTab(track) {
    new MachinePickerPanel().render(this._makeTabContext(track));
  }

  /**
   * Build the context object passed to tab + machine panel renderers.
   * Panels receive everything they need to build knobs + wire p-locks
   * without importing AppState directly.
   *
   * Tab panels (TrigPanel, LFOPanel, …) use `track` / `renderContent` and the
   * pass-through service refs (library, sampleStore, …). Machine panels use the
   * `machine` + write/emit helpers. One context shape serves both.
   */
  _makeTabContext(track) {
    return {
      track,
      machine:       track.machine,
      step:          this._step(),
      hasStep:       this._hasStep(),
      container:     this._content,
      activeWidgets: this._activeWidgets,
      knobByPath:    this._knobByPath,
      state:         this.state,
      getTrack:      () => this.state.selectedTrack,
      // Late step read — ADSR/widget callbacks re-check the selected step at
      // interaction time (it can't change mid-render, but keeps parity).
      getStep:       () => this._step(),
      hasStepNow:    () => this._hasStep(),
      // Register the tab's FilterViz so paramChanged (mod wheel) refreshes it.
      setActiveViz:  viz => { this._activeViz = viz; },
      // Re-render the whole content area (tab panels call this after structural
      // changes — adding an LFO, removing a voice, switching sync mode, etc.)
      renderContent: () => this._renderContent(),
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
      // Header FX bar — MixerPanel keeps its toggles in sync with mixer strips.
      fxBar:        this._fxBar,
      // Service references used by specific tab panels
      library:      this.library,
      openModal:    this.openModal,
      sampleStore:  this.sampleStore,
      audioContext: this.audioContext,
      midiEngine:   this.midiEngine,
    };
  }

  /** Back-compat alias for machine-panel call sites. */
  _makePanelContext(track) {
    return this._makeTabContext(track);
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
      this._makeTabContext(track),   // p-lock-aware write path for arp mod params
    );
    this._activeWidgets.push(panel);
  }

  _renderFilter(track) {
    new FilterPanel().render(this._makeTabContext(track));
  }

  _renderEnv(track) {
    new AmpPanel().render(this._makeTabContext(track));
  }

  _renderMidiIn(track) {
    const cleanup = new MidiInPanel().render(this._makeTabContext(track));
    if (cleanup) this._activeWidgets.push({ destroy: cleanup });
  }

  _renderDelay(track) {
    new FXPanel().render(this._makeTabContext(track), track.delayFX);
  }

  _renderCrush(track) {
    new FXPanel().render(this._makeTabContext(track), track.bitcrushFX);
  }

  _renderChorus(track) {
    new FXPanel().render(this._makeTabContext(track), track.chorusFX);
  }

  _renderReverb(track) {
    new FXPanel().render(this._makeTabContext(track), track.reverbFX);
  }

  _renderLFO(track) {
    new LFOPanel().render(this._makeTabContext(track));
  }
}
