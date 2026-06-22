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
import { InputPanel }              from './panels/InputPanel.js';
import { SamplerPanel }            from './panels/SamplerPanel.js';
import { WavetableSamplerPanel }   from './panels/WavetableSamplerPanel.js';
import { SampleSwarmPanel }        from './panels/SampleSwarmPanel.js';
import { GranularPanel }           from './panels/GranularPanel.js';
import { SlicerPanel }             from './panels/SlicerPanel.js';
import { TimeStretchPanel }        from './panels/TimeStretchPanel.js';
import { BeatRepeatPanel }         from './panels/BeatRepeatPanel.js';
import { MultiSamplerPanel }       from './panels/MultiSamplerPanel.js';
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
import { FXPipelinePanel, TYPE_GLYPH } from './panels/FXPipelinePanel.js';
import { SoundsPanel }          from './panels/SoundsPanel.js';
import { FXLibrary }            from '../state/FXLibrary.js';
import { MachinePickerPanel, MACHINE_GROUPS, MACHINE_DEFS } from './panels/MachinePickerPanel.js';
import { ManualOverlay }        from './manual.js';
import { PianoRollPanel }       from './panels/PianoRollPanel.js';
import { AllTracksPanel }       from './panels/AllTracksPanel.js';

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

    // Global FX-pipeline preset store (localStorage; shared across all tracks).
    this.fxLibrary    = new FXLibrary();

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
    // A block's enabled flag was toggled (FX pane, mixer, or keybind) — refresh
    // the header chain mini-outline so bypassed blocks dim/undim in sync.
    state.on('fxEnabledChanged', () => this._renderFXChainOutline());
    state.on('lfoChanged',    () => { if (state.activeTab === 'lfo') this._renderContent(); });
    // Track length changed — the roll draws all stepCount columns, so rebuild it.
    state.on('stepCountChanged', () => { if (state.activeTab === 'roll' || state.activeTab === 'all') this._renderContent(); });
    state.on('stepSelected',  () => {
      this._renderPLockTabIndicators();
      // The roll redraws its own note tints in place (keeps scroll position); a
      // full _renderContent would rebuild the grid and reset the view.
      if (state.activeTab === 'roll') { this._roll?.refreshTints(); return; }
      this._renderContent();
    });
    // stepChanged: re-render only on trig tab (note display + button state must update).
    // On other tabs we skip — must not rebuild knobs mid-drag. Always refresh the
    // p-lock tab indicators (a p-lock may have been added/removed on this step).
    state.on('stepChanged',   () => {
      this._renderPLockTabIndicators();
      if (state.activeTab === 'trig') this._renderContent();
      else if (state.activeTab === 'roll') this._roll?.refresh();
      else if (state.activeTab === 'all') this._allTracks?.refresh();
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

  /**
   * Open the manual overlay for the currently active tab. On the FX tab, if a
   * block is selected its OWN manual entry is shown (keyed by FX type); with no
   * block selected, the FX-pane overview is shown. Lets each FX card surface its
   * own docs — select the card, hit the manual key; deselect (click it again) for
   * the pane overview.
   */
  openManual() {
    const track = this.state.selectedTrack;
    const machineType = track?.machine?.type;

    // On phone the STEPS pseudo-tab is a surface driven by a body class, not
    // state.activeTab (which still holds the last real tab). When that surface is
    // up the user is looking at the step grid, so show its manual rather than the
    // stale active tab's. Desktop never sets the class, so this is phone-only.
    if (document.body.classList.contains('phone-show-steps')) {
      this._manual.show('steps', machineType, null);
      return;
    }

    let fxType = null;
    if (this.state.activeTab === 'fx' && this.state.fxSelectedBlockId && track) {
      fxType = track.getFXType(this.state.fxSelectedBlockId);
    }
    this._manual.show(this.state.activeTab, machineType, fxType);
  }

  /** Toggle the manual overlay (open if closed, close if open). */
  toggleManual() {
    if (this._manual.isOpen()) {
      this._manual.hide();
    } else {
      this.openManual();
    }
  }

  /**
   * Toggle the arp on/off for the selected track (keybind entry point). Mirrors
   * the ArpPanel ON/OFF button, including the input-mode hand-off so live-held
   * keys aren't left stuck. Refreshes the panel if the ARP tab is showing.
   */
  toggleArp() {
    const track = this.state.selectedTrack;
    const arp = track?.arp;
    if (!arp) return;
    arp.enabled = !arp.enabled;
    if (!arp.enabled) {
      const wasInput = arp.isLiveInputMode();
      track.liveArp?.releaseAll();
      if (wasInput) this.state.emit('arpInputInactive', { track });
    } else if (arp.isLiveInputMode()) {
      this.state.emit('arpInputActive', { track });
    }
    if (this.state.activeTab === 'arp') this._renderContent();
  }

  /**
   * Toggle the FX block that the selected track maps to FX bind `n` (1–4), the
   * generic FX keybind entry point. Each track assigns the four binds to its own
   * blocks in the FX pane, so the same key hits a different effect per track. A
   * no-op when the bind is unassigned. Keeps the header outline + FX tab in sync.
   * @param {number} n
   */
  toggleFxBind(n) {
    const track = this.state.selectedTrack;
    const fx = track?.toggleFXBind(n);
    if (!fx) return;
    this._renderFXChainOutline();             // bypassed blocks dim in the outline
    // The FX pane and the MIXER both show per-block ON/OFF state — re-render the
    // active tab if it's one of them so its toggle reflects the keybind change.
    if (this.state.activeTab === 'fx' || this.state.activeTab === 'mixer') this._renderContent();
  }

  /**
   * (Re)build the header FX chain mini-outline: the selected track's FX in chain
   * order as clickable glyph icons (bypassed blocks dimmed). Click an icon →
   * open the FX pane with that block selected. The FX button itself is preserved
   * by _buildShell; this only repopulates the icon row after it.
   */
  _renderFXChainOutline() {
    const out = this._fxOutline;
    if (!out) return;
    out.innerHTML = '';
    const track = this.state.selectedTrack;
    if (!track) return;

    track.getFXOrder().forEach((id) => {
      const type = track.getFXType(id);
      const fx   = track.getFXBlock(id);
      const on   = fx?.enabled ?? false;

      const icon = document.createElement('button');
      icon.className = 'fx-chain-icon' + (on ? '' : ' off');
      icon.textContent = TYPE_GLYPH[type] ?? '●';
      icon.title = `${type}${on ? '' : ' (bypassed)'} — click to edit, double-click to toggle`;
      // Single click → open the FX pane with this block selected. Double click →
      // toggle the block's ON/OFF in place. The single click navigates (which
      // re-renders the header and destroys this button), so we can't rely on the
      // browser's `dblclick` pairing — instead we defer the single-click action
      // and cancel it if a second click lands inside the double-click window.
      icon.addEventListener('click', () => {
        if (this._fxIconClickTimer) {
          // Second click → it's a double-click: cancel the pending navigation and
          // toggle this block instead.
          clearTimeout(this._fxIconClickTimer);
          this._fxIconClickTimer = null;
          fx?.setEnabled?.(!fx.enabled);
          this._renderFXChainOutline();        // refresh this row's dimming
          if (this.state.activeTab === 'fx') this._renderContent();
          this.state.emit('fxEnabledChanged', { trackIndex: this.state.selectedTrackIndex });
          return;
        }
        this._fxIconClickTimer = setTimeout(() => {
          this._fxIconClickTimer = null;
          this.state.fxSelectedBlockId = id;   // FX pane selects this block inline
          this.state.setTab('fx');
        }, 220);
      });
      out.appendChild(icon);
    });
  }

  _buildShell() {
    this.container.innerHTML = '';

    // ── Header: tab bar (left) + FX toggles (right) ─────────
    const header = document.createElement('div');
    header.className = 'panel-header';

    this._tabBar = document.createElement('div');
    this._tabBar.className = 'tab-bar';

    // STEPS pseudo-tab — phone only (CSS-hidden on desktop). On a phone the step
    // grid and the synth panel can't both be on screen (the 4×4 grid crushes the
    // flex:1 synth panel), so they become mutually-exclusive surfaces toggled
    // here. This drives a body class rather than state.activeTab, so desktop
    // semantics + the _renderContent switch stay untouched. Default surface on
    // phone is STEPS (set in boot.js).
    const stepsBtn = document.createElement('button');
    stepsBtn.className   = 'tab-btn tab-steps';
    stepsBtn.textContent = 'STEPS';
    stepsBtn.dataset.tab = 'steps';
    stepsBtn.addEventListener('click', () => {
      document.body.classList.add('phone-show-steps');
      this._syncTabActive();        // no tabChanged event fires for the pseudo-tab
    });
    this._tabBar.appendChild(stepsBtn);

    // Voice tabs only — FX moved to right-side toggles
    const leftTabs = ['machine', 'sounds', 'scales', 'trig', 'synth', 'roll', 'arp', 'filter', 'amp', 'lfo', 'midi', 'all', 'mixer', 'deck'];
    leftTabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className   = 'tab-btn';
      btn.textContent = tab.toUpperCase();
      btn.dataset.tab = tab;
      // Selecting a real tab leaves the STEPS surface (phone); on desktop the
      // class is never set so this is a harmless no-op.
      btn.addEventListener('click', () => {
        document.body.classList.remove('phone-show-steps');
        this.state.setTab(tab);
      });
      this._tabBar.appendChild(btn);
    });

    // FX tab — phone only (CSS-hidden on desktop, where the header FX bar owns
    // the entry point). FX is already a real tab in the _renderContent switch
    // (activeTab === 'fx'); on phone the whole FX bar is hidden, so the strip
    // needs its own way in. Mirrors the STEPS pseudo-tab pattern. dataset.tab
    // is 'fx' so _syncTabActive highlights it via the normal activeTab path.
    const fxBtn = document.createElement('button');
    fxBtn.className   = 'tab-btn tab-fx';
    fxBtn.textContent = 'FX';
    fxBtn.dataset.tab = 'fx';
    fxBtn.addEventListener('click', () => {
      document.body.classList.remove('phone-show-steps');
      this.state.setTab('fx');
    });
    this._tabBar.appendChild(fxBtn);

    header.appendChild(this._tabBar);

    // Oscilloscope canvas — fills the gap between tab bar and FX block
    this.scopeCanvas = document.createElement('canvas');
    this.scopeCanvas.className = 'oscilloscope';
    this.scopeCanvas.height = 48;
    header.appendChild(this.scopeCanvas);

    // FX toggle block — always visible on the right
    this._fxBar = document.createElement('div');
    this._fxBar.className = 'fx-bar';

    // FX pipeline button — leftmost in the FX bar, opens the FX pipeline
    // customizer. Single button (no on/off), styled like a tab.
    const fxPipeWrap = document.createElement('div');
    fxPipeWrap.className = 'fx-toggle-wrap fx-pipe-wrap';
    fxPipeWrap.dataset.fxtab = 'fx';
    const fxPipeBtn = document.createElement('button');
    fxPipeBtn.className = 'fx-pipe-btn';
    fxPipeBtn.textContent = 'FX';
    fxPipeBtn.title = 'FX pipeline — reorder the effect chain';
    fxPipeBtn.addEventListener('click', () => this.state.setTab('fx'));
    fxPipeWrap.appendChild(fxPipeBtn);
    fxPipeWrap._updateState = () => {
      fxPipeWrap.classList.toggle('fx-active-tab', this.state.activeTab === 'fx');
    };
    this._fxBar.appendChild(fxPipeWrap);

    // Chain mini-outline — a compact, read-at-a-glance row of the track's FX in
    // chain order. The dedicated CRUSH/REV/DLY/CHORUS tabs + on/off buttons were
    // retired; editing and bypassing now live in the FX pane. Each icon here is
    // a fast jump: click → open the FX pane with that block selected. Built by
    // _renderFXChainOutline (rebuilt on every render + order/enable change).
    this._fxOutline = document.createElement('div');
    this._fxOutline.className = 'fx-chain-outline';
    this._fxBar.appendChild(this._fxOutline);
    this._renderFXChainOutline();

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

  /**
   * Sync the tab-bar `.active` highlight. On phone, the STEPS surface is its own
   * active state (a body class, not activeTab): when it's showing, STEPS is the
   * active tab and no voice tab is; otherwise the normal activeTab highlight
   * applies (and STEPS is never active). On desktop the class is never set, so
   * STEPS is simply never highlighted (and it's CSS-hidden anyway).
   */
  _syncTabActive() {
    const showingSteps = document.body.classList.contains('phone-show-steps');
    this._tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      const isSteps = btn.dataset.tab === 'steps';
      btn.classList.toggle('active',
        showingSteps ? isSteps : (!isSteps && btn.dataset.tab === this.state.activeTab));
    });
  }

  render() {
    this._syncTabActive();
    // Only the FX-pipe button remains as a `.fx-toggle-wrap` (its active-tab
    // highlight). The per-FX toggles were replaced by the chain mini-outline.
    this._fxBar.querySelectorAll('.fx-toggle-wrap').forEach(wrap => {
      wrap._updateState?.();
    });
    this._renderFXChainOutline();
    this._updateClipButtons();
    this._renderPLockTabIndicators();
    this._renderContent();
  }

  /**
   * Map a p-locked param path to the tab/FX-toggle that edits it. Returns a
   * `data-tab` / `data-fxtab` key, or null if the path has no home tab.
   */
  _tabForPLockPath(path) {
    // All FX params — base four ('delay.'/'crush.'/'chorus.'/'reverb.') and added
    // instances ('fxN.<type>.<param>') — are edited in the FX pipeline pane now,
    // so they all light the FX button.
    if (/^fx\d+\./.test(path))                                return 'fx';
    if (path.startsWith('delay.')  || path.startsWith('crush.') ||
        path.startsWith('chorus.') || path.startsWith('reverb.')) return 'fx';
    if (path.startsWith('filter.') || path.startsWith('fenv.') ||
        path === 'base.lpf' || path === 'base.hpf')          return 'filter';
    if (path.startsWith('env.') || path === 'amp.pan')        return 'amp';
    if (path.startsWith('arp.'))                              return 'arp';
    if (path.startsWith('lfo.'))                              return 'lfo';
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
          fxOrder:    track.getFXOrder(),
          fxInstances: track.getFXOrder()
            .filter(id => track.isFXRemovable(id) && !track.isFXBase(id))
            .map(id => track.getFXBlock(id).toJSON()),
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
      track._restoreFXInstances(d.fxInstances ?? []);
      track.setFXOrder(d.fxOrder ?? track.getFXOrder());
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

    // Keep the header chain mini-outline current — FX add/remove/reorder/enable
    // all route through _renderContent (the FX pane calls it), so refresh here.
    this._renderFXChainOutline();

    switch (this.state.activeTab) {
      case 'machine': this._renderMachineTab(track); break;
      case 'all':     this._renderAllTracks();       break;
      case 'mixer':   this._renderMixer();           break;
      case 'deck':    this._renderDeck();            break;
      case 'sounds':  this._renderSounds(track);  break;
      case 'scales':  this._renderScales(track);  break;
      case 'trig':   this._renderTrig(track);   break;
      case 'synth':  this._renderSynth(track);  break;
      case 'roll':   this._renderRoll(track);   break;
      case 'arp':    this._renderArp(track);    break;
      case 'filter': this._renderFilter(track); break;
      case 'amp':    this._renderEnv(track);    break;
      case 'lfo':    this._renderLFO(track);     break;
      case 'midi':   this._renderMidiIn(track); break;
      case 'fx':     this._renderFXPipeline(track); break;
    }
  }

  _renderFXPipeline(track) {
    new FXPipelinePanel().render(this._makeTabContext(track));
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

  _renderRoll(track) {
    this._roll = new PianoRollPanel();
    this._roll.render(this._makeTabContext(track));
  }

  _renderAllTracks() {
    this._allTracks = new AllTracksPanel();
    this._allTracks.render(this._makeTabContext(this.state.selectedTrack));
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
      // Service references used by specific tab panels
      library:      this.library,
      fxLibrary:    this.fxLibrary,
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
    if (track.machine.type === 'granular') {
      const ctx = this._makePanelContext(track);
      new GranularPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'slicer') {
      const ctx = this._makePanelContext(track);
      new SlicerPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'stretch') {
      const ctx = this._makePanelContext(track);
      new TimeStretchPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'beat-repeat') {
      const ctx = this._makePanelContext(track);
      new BeatRepeatPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'multi-sampler') {
      const ctx = this._makePanelContext(track);
      new MultiSamplerPanel(this._content, ctx, this.sampleStore, this.audioContext);
      return;
    }
    if (track.machine.type === 'midi') {
      const ctx = this._makePanelContext(track);
      new MidiPanel(this._content, ctx, this.midiEngine);
      return;
    }
    if (track.machine.type === 'input') {
      const ctx = this._makePanelContext(track);
      new InputPanel(this._content, ctx);
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

  _renderLFO(track) {
    new LFOPanel().render(this._makeTabContext(track));
  }
}
