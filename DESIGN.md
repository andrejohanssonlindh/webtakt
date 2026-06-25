# Webtakt — Design Overview

> **Maintenance rule:** Any feature addition, rename, or architectural change **must be documented** in the relevant sub-document before the session is considered done. Keep tables, diagrams, and section text current — stale docs are treated as bugs. This rule applies to sub-documents too.

---

## Sub-Documents

| Document | What it covers |
|---|---|
| [`design/audio-signal-chain.md`](design/audio-signal-chain.md) | Per-track signal chain, filter architecture, FilterViz, envelope architecture, voice pool/selection, pan, DJ filter, audio constraints |
| [`design/sequencer.md`](design/sequencer.md) | Clock/sequencer architecture, step data model, p-lock architecture, track nav/page control, record mode, drum mode, double-click step |
| [`design/machines.md`](design/machines.md) | All machine types: drum machines, melodic synths, samplers (sampler, wavetable sampler, sample swarm, granular, slicer, time-stretch, beat-repeat, multi-sampler + the shared single-buffer protocol); drum architecture; hidden param pattern |
| [`design/creating-machines.md`](design/creating-machines.md) | **Authoring guide** — read before adding a machine: every registration point, the Machine contract, SPEC vs hand-written, single/multi-buffer + worklet skeletons, panel & test conventions, doc checklist |
| [`design/fx.md`](design/fx.md) | DelayFX, BitcrushFX, ChorusFX, ReverbFX — parameters, signal routing, reorderable FX pipeline pane, UI, p-lock behaviour |
| [`design/ui.md`](design/ui.md) | SynthPanel tabs, mixer tab, transport controls, scale quantisation, LFO destination groups, state/event flow |
| [`design/state.md`](design/state.md) | Save/load (Project JSON), sound library, sample store |
| [`design/sample-browser.md`](design/sample-browser.md) | 🔍 BROWSE on samplers: curated CC0 list + live archive.org search (CORS-open, no auth), the shared addBrowseButton wiring, and the local curate-server curator mode (tools/curate_server.py) |
| [`design/tests.md`](design/tests.md) | Audio test suite architecture, coverage, how the Clock shim works |

---

## Overview

A browser-based modular step sequencer / synthesizer inspired by Elektron Syntakt and Moog Mother-32.
Built in vanilla HTML5 + JavaScript. No build step, no framework, no package manager.
Served via `python3 -m http.server 8000` and opened in Chrome.

**Current scope:** 8–12 tracks (configurable at runtime via TRACKS +/− in the transport bar, default 8), unlimited steps per track (configurable per track, 16 visible per page), SynthMachine as primary voice, full suite of synthesis drum voices and melodic machines. A fresh project ships a mixed starter kit rather than 8 identical synths — `Project.DEFAULT_MACHINES` sets tracks 1-8 to analogue kick/snare/hihat, bass, moogish, synth, sampler, granular (indices past the list fall back to synth); `fromJSON()` overrides the type on load. MIDI out (MidiMachine per track), MIDI In note + CC routing per track (live play, record-to-pattern, and live-arp input), MIDI clock sync out (24 PPQN).

---

## File Structure

```
index.html
favicon.svg              — knob-motif app icon (amber pointer on a dark dial)
css/
  style.css
js/
  core/
    AudioEngine.js      — AudioContext, master gain, FX bus, AnalyserNode (master output tap); preloads the analogue ladder worklet (ladderReady/ladderLoaded)
    Clock.js            — BPM clock, tick scheduling via AudioContext.currentTime
    GlobalRecorder.js   — MediaRecorder wrapper tapping masterGain
    MidiEngine.js       — Web MIDI singleton: port enumeration, note/CC out, note-on/note-off + CC in routing, 24-PPQN clock sync out. Note-off dispatches on 0x80 and on 0x90 velocity-0 (running status).
  sequencer/
    Sequencer.js        — Per-track step runner, polyrhythm, page logic, p-lock dispatch
    Step.js             — Single step: note, vel, length, nudge, retrigger, chance, condition, plocks
    Condition.js        — Condition objects: ratio-based (hits:of) and always
    algos.js            — Pure, DOM-free pattern generators for the GEN tab: euclid (Bjorklund),
                          turingBits (shift register), markovNotes (+defaultMarkovTable), cellularRow
                          (elementary CA) + seed/mulberry32, and makeDefaultGen() (per-track gen config
                          shape). No audio/state deps → deterministic unit tests (tests/gen_algos.js).
    genRunner.js        — Headless glue: runGen(track, evolve) builds TWO independent layers —
                          RHYTHM (gen.rhythm: off/manual/all/euclid/turing/cellular → which steps
                          fire; manual = re-pitch the user's hand-placed steps, never toggle active) ×
                          PITCH (gen.pitch: fixed/scale/markov → note per ACTIVE step; walks advance
                          per active step, not per slot) — and maps the result onto the track's Step[]
                          (sets active + voices[0], preserves p-locks/condition/chance on steps that
                          stay on, clears them on switched-off ones). Freshly-activated steps inherit
                          the pattern's note length (first already-active step's length) rather than the
                          empty-slot default of 1, so extending/regenerating a pattern keeps the user's
                          set note length; already-active steps keep their own per-step length. Called by GenPanel (every param
                          change) AND by Sequencer at each bar boundary when gen.regen is on (evolving
                          state on track._genState, runtime-only). Sequencer.onGenRegen hook (set in
                          boot.js) refreshes the UI off the audio callback.
    LiveRecorder.js     — Records live MIDI-In notes into the pattern while armed. Per (track,note); uses each track's own Sequencer.stepIndexAtTime() for absStep+nudge, so it places notes correctly on every armed track regardless of which is selected. (Keyboard.js keeps its own inline record path.)
  machines/
    Machine.js          — Abstract base class all machines extend. Optional declarative
                          param layer: a machine defines `static SPEC` (path → descriptor +
                          execution fields) and calls `this._initSpec()` in its constructor;
                          the base then derives setParam/getParam/getParamList (cached on the
                          class)/resolveAudioParam/toJSON/fromJSON. Opt-in & incremental —
                          un-converted machines keep hand-rolled methods. See design/machines.md.
    SynthMachine.js     — Main oscillator + sub-oscillator, waveform select
    KickMachine.js      — Backward-compat alias → KickSilkMachine (type: 'kick')
    KickSilkMachine.js  — Clean kick: sine + pitch sweep + noise punch (type: 'kick.silk')
    KickHardMachine.js  — Fat kick: sub osc + body + waveshaper saturation + noise punch (type: 'kick.hard')
    AnalogueKickMachine.js — Analogue kick: KickHard structure with imperfect-sine body/sub + per-instance tolerance + thermal drift + pink-noise punch (type: 'kick.analogue'); built on AnalogueParts.js
    AnalogueParts.js    — Shared analogue building blocks extracted from MoogishMachine/PATINA: makeImperfectWave, makePinkBuffer, DriftClock (thermal pitch drift), rand/clamp. Imported by MoogishMachine + AnalogueKickMachine
    SnareMachine.js     — Synthesis snare: triangle tone + filtered noise
    AnalogueSnareMachine.js — Analogue snare: Snare structure with imperfect-triangle body + per-instance tolerance + thermal drift + pink-noise snares (type: 'snare.analogue'); built on AnalogueParts.js
    HiHatMachine.js     — Synthesis hi-hat: 6 inharmonic square oscs + HP filter
    AnalogueHiHatMachine.js — Analogue hi-hat: 6 imperfect-square oscs with per-instance ratio tolerance + thermal drift + HP filter (type: 'hihat.analogue'); built on AnalogueParts.js
    AnalogueTomMachine.js — Analogue tuned tom: imperfect-sine body + pitch sweep + thermal drift + pink-noise attack + soft-clip (type: 'tom.analogue'); built on AnalogueParts.js
    TomMachine.js       — Digital tuned tom: clean sine+triangle body + fast pitch drop + white-noise click (type: 'tom'); SPEC-driven
    TomFMMachine.js     — FM tuned tom: metallic modulator→carrier FM pair + FM-depth env + pitch sweep (type: 'tom.fm'); SPEC-driven
    AnalogueClappMachine.js — Analogue clap: Clapp's 3 staggered bursts but pink noise + per-instance spread tolerance (type: 'clapp.analogue'); built on AnalogueParts.js
    AnalogueCymbalMachine.js — Analogue cymbal: 6 imperfect-square oscs with per-instance ratio tolerance + thermal drift + HPF/BP, closed/mid/open tiers (type: 'cymbal.analogue'); built on AnalogueParts.js
    FMMachine.js        — 4-operator FM synth; per-op ADSR envelopes
    DrumMachine.js      — Generic drum stub (future)
    SamplerMachine.js   — Sample playback: load file or record mic, trim/reverse/loop
    CymbalMachine.js    — Crash/ride cymbal: inharmonic oscs + HPF + resonant BP
    WoodMachine.js      — Clave/wood block/cowbell: dual resonant bandpass + click
    ClappMachine.js     — 808-style clap: 3 staggered noise bursts through bandpass
    WavetableMachine.js — Wavetable oscillator with morphing (8-entry bank via PeriodicWave)
    WavetableSamplerMachine.js — Two-sample wavetable: morph between sample A and B via AudioWorklet
    SampleSwarmMachine.js — 7-voice sample swarm: one sample played through 7 detuned BufferSourceNodes with spread + drift (type: 'sample-swarm')
    GranularMachine.js  — Granular grain cloud: AudioWorklet sprays windowed grains; scan position (AudioParam) decoupled from pitch (type: 'granular')
    SlicerMachine.js    — Slice-and-trigger: chop buffer into N slices, pick by note or per-step p-lock (type: 'slicer')
    TimeStretchMachine.js — Tempo-locked loop player: OLA AudioWorklet stretches loop to project BPM, pitch independent; auto-detect orig BPM (type: 'stretch')
    BeatRepeatMachine.js — Stutter/retrig roll: captures a slice, fires N tempo-synced repeats with gate + pitch ramp + decay (type: 'beat-repeat')
    MultiSamplerMachine.js — Multi-zone sampler: up to 4 buffers mapped to velocity ranges (layer) or round-robin; multi-buffer (loadZoneBuffers) (type: 'multi-sampler')
    MidiMachine.js      — MIDI out machine: routes noteOn/noteOff to a selected MIDI output port/channel; params: channel (1–16), noteOffset (±24 semitones); no audio output (type: 'midi')
    KarplusMachine.js   — Karplus-Strong plucked string (noise burst + comb filter)
    MarimbaMachine.js   — Marimba bar: 3 tuned inharmonic sine partials (ratios ~1×/3.9×/9.9×) + mallet noise burst, each partial with independent decay
    BassMachine.js      — Bassline voice: saw/sq + sub + drive + portamento + accent
    CombMachine.js      — Pitched resonator: two decaying sinusoidal partials (bell/marimba/gamelan)
    ChordMachine.js     — 4-voice chord synth: 11 chord types, inversions, p-lockable per step
    StringsMachine.js   — Bowed string section: detuned saw unison + body/tone filters + bow noise + vibrato; violin/viola/cello/ensemble modes
    MoogishMachine.js   — Analogue (PATINA-derived) oscillator voice: 3 imperfect-spectrum oscs + sub + pink hiss + thermal drift + component tolerance + mains hum (hum/humFreq) + osc tricks: PWM (2-saw delay), ring/cross-mod, wavefolder, hard sync (sync-osc worklet); feeds existing Filter/Envelope/LFO (type: 'moogish'). Analogue helpers (imperfect wave, pink noise, drift) now live in AnalogueParts.js
    JunoMachine.js      — Analogue PWM string/pad voice: 1 PWM osc (saw−delayed-saw) + square sub + pink hiss + drift; analogue-family (auto ladder+chorus) (type: 'juno')
    OberishMachine.js   — Analogue SEM/Oberheim brass/pad voice: 2 detuned oscs (saw+pulse) + wide drift spread, leans on ladder drive/self-osc; analogue-family (type: 'oberish')
    FoldMachine.js      — West-coast wavefolder voice: sine/tri core → WaveShaper sine-fold (+symmetry) + timbre FM (mod→carrier); harmonics generated not filtered; analogue-family (type: 'fold')
  signal/
    Filter.js           — Filter wrapper, two engines (filter.engine): digital biquad cascade (type/cutoff/res/gain/slope) + analogue PATINA Moog ladder worklet (drive/drift/keytrack); base LPF/HPF; cutoffParam()/scheduleFrequency engine-aware (RC curves in analogue mode)
    Envelope.js         — Dual ADSR (amp + filter env), scheduleNote for sequencer, noteOn/noteOff for live; per-stage MS/BPM tempo-sync on A/D/R; analogue flow (filter.engine='analogue') switches to RC (exponential) curves + applies keytrack + velocity sensitivity (env.velSens)
    ChorusFX.js         — BBD-style stereo ensemble chorus (PATINA-derived): two delay lines + two unrelated LFOs (R=1.27×L); part of the analogue flow, bypassed unless the track is analogue
    LFO.js              — LFO: waveform, speed, depth, destination routing (supports multiple AudioParam destinations)
    VoicePool.js        — 8-slot voice pool per track: each slot owns machine + envelope + filter; slot-0 filter is canonical and mirrors params to siblings; all slots share outputGain
    DelayFX.js          — Stereo feedback delay
    BitcrushFX.js       — Bit-depth reduction + rate smear
    ReverbFX.js         — Convolution reverb with synthesised IR
    DistortionFX.js     — tanh waveshaper drive + tone LP (addable FX instance)
    CompressorFX.js     — DynamicsCompressorNode + makeup gain, dry/wet (addable FX instance)
    PhaserFX.js         — STEREO phaser: 6 LFO-swept allpass stages per channel, L/R counter-sweep (right depth tap negated) + wider range + feedback (addable FX instance). Rate is a Hz/BPM sync knob (same model as AutoPanFX). Un-parked: the old mono version was too subtle
    FXFilter.js         — Standalone post-sum biquad filter block (paraphonic; addable FX instance) — distinct from per-voice Filter.js
    NormalizerFX.js     — Live auto-gain leveller (addable FX instance): AnalyserNode taps the signal, rAF loop scales a GainNode toward a target level; auto-tracks upstream changes. A fast audio-thread brickwall DynamicsCompressor (threshold = Target dB) sits after the auto-gain to catch the transient that slips past the slow UI-thread loop
    EQ3FX.js            — 3-band EQ: low shelf / mid bell (tunable freq+Q) / high shelf, in-line (addable FX instance)
    AutoPanFX.js        — LFO auto-pan + tremolo in one (shape knob blends pan↔amp), Hz/BPM sync knob (addable FX instance)
    GateFX.js           — BPM-synced 16-slot trance-gate: lookahead-scheduled gain pattern, depth + edge smoothing (addable FX instance)
    WidthFX.js          — Stereo width via mid/side gain (0=mono, 1=unity, 2=wide), native M/S matrix (addable FX instance)
    LimiterFX.js        — Brickwall limiter: fast high-ratio DynamicsCompressorNode + output ceiling (addable FX instance)
    RingModFX.js        — Ring modulator: carrier osc × signal via gain-mult, Hz/BPM sync, dry/wet (addable FX instance)
    TapeFX.js           — Tape echo: ping-pong cross-feedback + filtered (HF-loss) feedback + wow/flutter + saturation; MS/BPM sync (addable FX instance). Absorbs the delay upgrades without touching the back-compat base DelayFX
    CombFX.js           — Tuned comb resonator (Karplus-style): short feedback delay = 1/freq pitch, damped feedback; p-lock the pitch per step (addable FX instance)
    DuckFX.js           — Trigger-driven sidechain ducker (Syntakt kick-pump): trigger(time) dips output gain to 1−depth over attack/hold/release. Pulsed by the follow loop (Track.triggerDuck) on the global FX track (addable FX instance, type 'duck')
    ShimmerFX.js        — Shimmer reverb: convolver + octave-up (native dual-delay granular shifter) FEEDFORWARD layer + bounded FREEZE hold (≤0.85, killed on disable) + pre-HP/damp (addable FX instance). No recursive loop — earlier feedback version ran away
    Crush2FX.js         — REAL bitcrusher (worklet-backed): true sample-and-hold downsample + bit quantize. JS dry/wet (parallel dry path), worklet runs fully wet → transparent if worklet missing/bypassed (addable FX instance)
    StutterFX.js        — Beat-repeat / glitch roll (worklet-backed): rolling capture, latched tempo-synced slice loop, auto-chance + manual latch. JS dry/wet parallel path (addable FX instance)
    FXInstance.js       — Namespacing proxy wrapping an FX so N instances coexist; rewrites paths to fxN.* (see design/audio-signal-chain.md → Multiple FX instances)
  ui/
    TrackRow.js         — 8 track selector buttons, mute state, machine type indicator
    StepGrid.js         — 16-step grid (current page), click to select, dblclick to add lowest note
    SynthPanel.js       — Shell + tab router only (~600 lines): builds header (tab bar,
                          oscilloscope, FX button + chain mini-outline, copy/paste), routes each tab to a panel
                          in panels/, owns shared p-lock helpers (_writeValue, _renderParamList,
                          _step) and the per-render context built by _makeTabContext(). Each tab's
                          DOM lives in its own panel file (see panels/ below).
    FilterViz.js        — Canvas widget: frequency response curve + base filter + env ghost
    Oscilloscope.js     — Canvas waveform strip: time-domain display of master output with zero-crossing trigger
    ModWheel.js         — 2 assignable mod wheels: drag or scroll (left/right screen halves → MW1/MW2). Scroll travel scaled by Settings.modWheelSensitivity.
    SettingsPanel.js    — Global-settings hover pane (⚙ cog right of WEBTAKT title) + 📖 manual placeholder button. Edits Settings (BPM grid resolution, mod-wheel sensitivity, transport keybinds, computer-keyboard layout incl. a per-key Custom editor) with continuous save + reset-to-defaults. The grid row shows a live "(X ms)" readout (one grid step at the current BPM) left of the dropdown via refreshGridMs() — fed clock.bpm by boot.js and refreshed on BPM change (transport + project load) and on grid change.
    Keyboard.js         — Piano keyboard (2 octaves), octave shift, live note trigger. Play-glow: registers a noteLightHook on the SELECTED track (null on others); Sequencer._fireStep + LiveArp._fireEvent call it per fired note so keys light red ('seq', .play-seq) for sequencer notes AND the arp's lead/input note (event.root), green ('arp', .play-arp) for the arp's generated/rolled notes, scheduled on/off by note start/offTime so the glow follows the gate. Red (.play-seq) wins even over .held so the held lead key flashes red as it fires; green (.play-arp) yields to .held (:not(.held)) so other held keys keep their amber press highlight.
    KnobWidget.js       — Rotary knob widget, supports bipolar, p-lock highlight, drag interaction. Optional `quantize` hook (a value→value fn) snaps EVERY produced value (free drag, wheel, shift-snap) to a grid via the single `_q()` choke point; BPM-sync knobs pass BpmSync.quantizeCount so the live readout can't show off-grid noise like "1/8 + 31/64" — it always lands on the user's Settings grid (1/32 / 1/64 / 1/128). setValue() is exempt (loads a stored value verbatim). `snapPoints` (shift) and `quantize` (free) are independent; both passed by every sync-knob site (FX/LFO/Arp/FM/WT-sampler/DefaultMachine). ADSRWidget is a custom canvas drag that already rounds to integer 1/32 counts.
    ADSRWidget.js       — Visual ADSR canvas widget used in AMP and FILTER tabs
    panels/             — One file per tab/machine panel. Tab panels expose render(ctx); the ctx
                          is built by SynthPanel._makeTabContext (track, step, container,
                          activeWidgets, knobByPath, state, writeValue, renderContent, fmtParam,
                          service refs). Machine panels (Default/FM/Sampler/…) use the same ctx.
      formatParam.js          — Shared param value formatter (path → display string). Used by SynthPanel + all panels.
      DefaultMachinePanel.js  — Generic SYNTH tab layout: flat knob/select/checkbox grid from getParamList()
      FMPanel.js              — Custom SYNTH tab layout for FMMachine: schematic + 2×2 operator grid
      SamplerPanel.js         — Custom SYNTH tab for SamplerMachine: file picker, mic record, waveform + trim handles
      WavetableSamplerPanel.js — Custom SYNTH tab for WavetableSamplerMachine: dual file pickers + morph/speed/level controls
      SampleSwarmPanel.js     — Custom SYNTH tab for SampleSwarmMachine: SamplerPanel + swarm knob row
      GranularPanel.js        — Custom SYNTH tab for GranularMachine: waveform with draggable position marker + cloud/grain/pitch knobs
      SlicerPanel.js          — Custom SYNTH tab for SlicerMachine: waveform with slice grid (click to select) + slices/gate knobs
      TimeStretchPanel.js     — Custom SYNTH tab for TimeStretchMachine: waveform trim + DETECT + tempo/pitch knobs + ratio readout
      BeatRepeatPanel.js      — Custom SYNTH tab for BeatRepeatMachine: waveform capture region + roll/slice knobs + rate select
      MultiSamplerPanel.js    — Custom SYNTH tab for MultiSamplerMachine: global controls + per-zone strips (load/wave/velocity-map)
      SampleBrowser.js        — 🔍 BROWSE overlay (all samplers): CURATED list + live archive.org search, LOAD into the sampler. See design/sample-browser.md
      sampleBrowserButton.js  — addBrowseButton(panel): inserts BROWSE next to LOAD FILE, fetches chosen URL → File → panel._loadFile()
      MidiPanel.js            — Custom SYNTH tab for MidiMachine (MIDI out): port/channel/note-offset
      TrigPanel.js            — TRIG tab: length/chance/detune/tone/nudge/condition knobs, voice cards, shift, note follow
      ScalesPanel.js          — SCALES tab: searchable scale dropdown, root strip, degree preview, keyboard fold
      FilterPanel.js          — FILTER tab: ANALOGUE switch (digital/analogue, drives Track.setAnalogue) + type/cutoff/res/gain/env/slope + base LPF/HPF + analogue-only drive/drift/keytrack + FilterViz + filter-env ADSR
      AmpPanel.js             — AMP tab: pan + velocity-sens + master LEVEL knob (the machine's overall out level) + → FX-track send + amp ADSR. The LEVEL knob hosts each machine's master output level — the param flagged `ampMaster: true` in its SPEC/getParamList (conventionally 'output.level'), found via Machine.ampLevelPath(). Per-osc / per-operator / sub levels stay in the SYNTH tab; the machine's own panel skips the ampMaster param.
      LFOPanel.js             — LFO tab: sub-tabs, destination dropdown, simple/advanced layouts
      FXPanel.js              — Generic FX knob-row renderer: render(ctx, fxObj, fmtOverrides). Used by FXPipelinePanel for ALL blocks' inline editor (base four + added instances); the dedicated DELAY/CRUSH/CHORUS/REVERB tabs were removed.
      FXPipelinePanel.js      — FX tab: snaking reorderable signal path + per-block ON/OFF + inline param editor for every block + ADD FX menu + SAVE (name/tags) + LOAD (opens FXPresetModal)
      FXPresetModal.js        — SOUNDS-style overlay for FX presets (FXLibrary): tag chips + cards (audition ▶ / APPLY / edit / delete) + pinned ▶ PLAY DRY audition bar. Self-contained (own DOM, Esc/click-out), one instance on state._fxPresetModal.
      MidiInPanel.js          — MIDI tab: per-track MIDI In source/channel/CC→param mappings (distinct from MidiPanel)
      MixerPanel.js           — MIXER tab: per-track strip (LEVEL fader + DJ filter + a wet/mix knob & ON/OFF for each KEY-BOUND FX block, FX 1–4, laid 2-per-row). Reflects the current FX-bind model (not the old fixed DLY/CRUSH/REV). Two layouts: DESKTOP (>1024px) full strips in a wrapping row; LIGHT mode (≤1024px — tablet/iPad AND phone) = track pick-list chips (curate which tracks show, default first 6, persisted in localStorage `webtakt_mixer_phone_tracks`) + LEVEL/DJ-only strips in a grid (4-col tablet, 3-col phone). Primary-param picker: wet/mix/amount/depth else first numeric param. Reuses KnobWidget + Track FX-bind API (getFXBindBlock/getFXBlock/getFXType).
      DeckPanel.js            — DECK tab: DJ crossfade between two decks (A/B columns + constant-power crossfader); per-deck LOAD/CONTROL/SILENCE/UNLOAD. Reads ctx.state.decks (DeckManager).
      MachinePickerPanel.js   — MACHINE tab: searchable grouped machine card grid. Owns canonical MACHINE_GROUPS / MACHINE_DEFS (re-exported by SynthPanel for back-compat).
      SoundsPanel.js          — SOUNDS tab: wraps SoundLibraryPanel + preview/restore logic
      SoundLibraryPanel.js    — SOUNDS tab content: tag filter chips + scrollable sound card list; per-card preview/load/load-special(✦)/edit/export(⤓)/delete. Load-special (✦) opens an inline "keep on track" popout (Amp/Filter/FX checkboxes) → SoundLibrary.load(id, track, keep): voice always loads, ticked sections stay as the track has them. Export downloads the sound JSON + referenced sample .wav(s) for committing to sounds/+samples/.
      ArpPanel.js             — ARP tab: arpeggiator mode/rate/variance controls. Modes on two rows: Chord/Manual/Random (step-triggered) and Input/Input-Manual (live keyboard-driven)
  signal/
    Arpeggiator.js      — Per-track arpeggiator: Chord / Manual / Random / Input / Input-Manual / Input-Random modes; BPM-sync; variance. Chord/Manual/Random are step-triggered (Sequencer._fireStep). Input modes are keyboard-driven (see LiveArp.js): the held keys drive the arp at absolute pitch; steps do not trigger them — isLiveInputMode() gates all call sites. 'input' fans the held key set as a chord (reuses chord controls); 'input-manual' leads each cycle with the held key itself (the input note, flagged event.root) then runs the MANUAL step list (semitone offset + per-step rate/gate) as the figure after it, relative to each held key — the first note is always the pressed key, not an authored step; 'input-random' leads with the held note(s) (event.root) then rolls noteCount−1 random notes (range/rate/gate/variance) around the held key(s), re-rolled each cycle. Both RANDOM modes snap each rolled note into the track's selected scale (Track mirrors scaleIndex/leadNote into the arp via setScale; chromatic = no snap; chord/manual offsets and the root note are never snapped) and share a BIAS param (-1..+1, _biasedInterval) that skews the rolled interval window: 0 = symmetric ±range, +1 = only notes above the root, -1 = only below. The lead `root:true` event lights the keyboard red (played-note), the rest green — see Keyboard.js. RATE/GATE/VARIANCE are p-lockable + LFO-able via virtual params arp.rate/arp.gate/arp.variance (JS-only: p-lock exact, LFO sample-and-hold per fire — arp timing isn't an AudioParam).
    LiveArp.js          — Free-running scheduler for the Arpeggiator input modes ('input' / 'input-manual' / 'input-random'). Fed key on/off by Keyboard.js AND by MIDI In (index.html note handlers route to track.liveArp when arp.isLiveInputMode()); cycles the held notes ahead-of-time on the BPM grid via arp.buildInputCycle() (own setTimeout loop so it works with transport stopped). When recording, prints each fired note into the playing step via Keyboard.captureArpNote() — no re-arping on playback. STOP (releaseAll / last key up) only halts the scheduler — already-fired notes ring out their natural gate + release (each note's full envelope is queued at fire time); it does NOT hard-silence the pool. Panic hard-kills via Track.silence() instead. Owned by Track.
  util/
    BpmSync.js          — Shared BPM-sync utility. Unified sync-knob model: 1/32-note counts (count32ToSeconds, MUSICAL_SNAP_32, formatCount32, divToCount32). `setSnapResolution(gridBase)` sets BOTH the free-drag quantizeCount step AND the shift-snap set: `_buildSnap` fills the fine region (≤1/4 = 8 units) at the user's resolution (1/32 → counts 1..8; 1/64 → every 0.5; 1/128 → every 0.25 — so a finer grid actually fills in the steps BETWEEN 1/32 and 1/16, not just one point below 1/32), then appends the coarse musical divisions (>1/4) unchanged. Used by DelayFX, ReverbFX, LFO, Arpeggiator. Legacy DIV_QN/SYNC_DIVISIONS/divToSeconds kept for load back-compat.
  state/
    Track.js            — Owns VoicePool + sequencer + filter + FX chain + LFOs + pannerNode + Arpeggiator. FX chain order is REORDERABLE (`_fxOrder` / `setFXOrder` / `_rewireFXChain`; default delay→crush→chorus→reverb) — see design/audio-signal-chain.md → Reorderable FX pipeline. `analogue` flag (setAnalogue) drives the whole analogue flow as a unit: filter engine, RC envelopes, keytrack, velocity, chorus. `setMachine` applies it as a DEFAULT from the machine's nature (ANALOGUE_MACHINES set: moogish + every `*.analogue` drum → analogue ladder, all else → digital); fromJSON re-asserts a saved project's engine afterward, and the user can override via the FILTER ANALOGUE switch
    Project.js          — 8–12 tracks (dynamic), BPM, export/import JSON file, save()/load() to localStorage `webtakt_project` (the **auto-cache** boot.js wires: debounced save on any AppState event + flush on pagehide/hidden, restored on boot unless a `#p=` share link overrides it — see design/state.md → Auto-cache). Owns a per-deck busGain (tracks route here → master fxBus). loadDeckJSON/reset for the deck layer. Also owns the **global FX track** (`fxTrack`, a Track held outside `tracks[]` at FX_TRACK_INDEX=−1, silent 'midi' machine, isFXTrack): other tracks SEND into it (insert), it can follow the kick to duck. `_followerTracks()` = [...tracks, fxTrack]; `applyFXSends()` re-wires sends after load; serialised under a `fxTrack` key. See design/audio-signal-chain.md → Global FX Track. **Share-via-link:** toShareString()/fromShareString() gzip (native CompressionStream, raw-base64 fallback) + base64url the whole project into a URL `#p=` fragment — no hosting, works on static GitHub Pages; boot.js reads the hash on load and wires the SHARE button (+ optional "Shorten…" via TinyURL's api-create.php — chosen over v.gd/is.gd, which send no CORS header and reject localhost URLs). unshareableSamples() flags local/recorded samples that won't travel (only remote `sampleUrl`/`sampleUrlA/B`/`zoneSampleUrls` re-fetch on the recipient).
    DeckManager.js      — Two-deck DJ layer: owns Project A + B (shared Clock/AudioEngine, beatmatched), constant-power crossfader on the two busGains, per-deck silence, "control" (which deck the UI edits), load/unload. See design/ui.md → Deck Tab.
    AppState.js         — Selected track/step, active tab/LFO, event bus. `.project` is a getter following the controlled deck (DeckManager).
    Settings.js         — App-wide user prefs (NOT part of a project): BPM-sync finest grid (bpmGrid 1/32–1/128), modWheelSensitivity, keybinds (play/record/stopAll/manual/hold + selected-track toggles arp + fx1/fx2/fx3/fx4, each an event.code), keyboardLayout preset (or 'custom' + editable customLayout {lower,chromatic}). All binds handled in index.html keydown; arp toggles the arp, fx1..fx4 are four generic FX binds each toggling whatever FX block the selected track maps it to (Track._fxBinds) via SynthPanel.toggleArp()/toggleFxBind(). Single shared `settings` instance, continuous localStorage save, on(fn) subscribers, reset() (legacy fxCrush/fxReverb/fxDelay/fxChorus binds migrated to fx1..fx4 on load). See design/ui.md → Settings Pane.
    SoundLibrary.js     — Sound library, two sources one list: USER sounds in localStorage (save/load/delete) + FACTORY sounds shipped as files in sounds/ (async init() fetches sounds/index.json manifest → each sound JSON). Factory merged by id only if not already present (user copy wins); flagged `factory:true`, never written to localStorage (re-fetched each load so preset fixes ship). Old persisted `seed_*` entries are migrated out on load. Regenerate factory files via tools/bake_sounds.py.
    FXLibrary.js        — Global FX-pipeline preset store (localStorage `webtakt_fx_presets`, no factory presets). Preset = `{ name, tags, createdAt, fx:{ delayFX,bitcrushFX,chorusFX,reverbFX,fxOrder,fxInstances } }` via Track.exportFXPreset()/applyFXPreset(). save(name,tags,track)/load/delete/rename/setTags/allTags. Track-agnostic. SAVE inline in FX pane; LOAD opens FXPresetModal (audition dry vs pipeline, apply, edit, delete).
    SampleStore.js      — Sample store. load(id) resolves: in-memory cache → localStorage (WAV-base64, user imports) → shipped samples/<id>.wav (factory samples a sound references). Exports bufferToWav() for sound export.
    ArchiveSearch.js    — Pure archive.org access for the sample browser: search(query)→items, listFiles(id)→load-ready audio-file URLs. CORS-open, no auth. See design/sample-browser.md.
    CuratedSamples.js   — Loads samples/curated.json (curated CC0 one-shots); in curator mode add()/remove() POST to tools/curate_server.py (writes the file). Detects curator via GET /curate/status.
    Scales.js           — Scale definitions (20 scales) + noteInScale() / snapToScale() helpers (snapToScale snaps a note to the nearest in-scale pitch; used by the random arp modes via Track.scaleIndex/leadNote → arp.setScale)
  worklets/
    wavetable-sampler-processor.js — AudioWorkletProcessor for WavetableSamplerMachine
    granular-processor.js          — AudioWorkletProcessor for GranularMachine (grain-cloud scheduler)
    time-stretch-processor.js      — AudioWorkletProcessor for TimeStretchMachine (overlap-add stretch)
    patina-ladder-processor.js     — AudioWorkletProcessor: PATINA Moog transistor-ladder filter (Filter.js engine='analogue'); preloaded at boot by AudioEngine
    bitcrush-processor.js          — AudioWorkletProcessor for Crush2FX: true sample-and-hold downsample + bit quantize; preloaded at boot by AudioEngine
    stutter-processor.js           — AudioWorkletProcessor for StutterFX: rolling capture + latched tempo-synced slice loop (beat-repeat); preloaded at boot by AudioEngine
    sync-osc-processor.js          — AudioWorkletProcessor: hard-sync oscillator (PolyBLEP saw, master/slave phase) for MoogishMachine osc2.sync; preloaded at boot by AudioEngine
sounds/                 — Factory sound files (one JSON per sound, shape = Sound object). index.json is the manifest the loader fetches (the browser can't list a dir). Regenerated by tools/bake_sounds.py.
samples/                — Factory sample audio as real .wav, named <sampleId>.wav; referenced by a sound's machine sampleId(s). Loaded on demand by SampleStore.
tools/
    bake_sounds.py      — One-shot/regeneratable baker: emits sounds/*.json + index.json (Python port of the old in-app seed builders; output is field-for-field identical).
```

**Adding / sharing a sound.** A user clicks Export (⤓) on a sound card → downloads `<slug>.json` plus a `<sampleId>.wav` for each sample it uses. To ship it as a factory preset: drop the `.json` into `sounds/`, add its filename to `sounds/index.json`, drop any `.wav` into `samples/`, and commit. It then loads for everyone, with samples. Factory sounds are read-only from disk (edits/deletes are session-only; reload restores from the file). Opened via `file://` (no server) the factory fetch fails gracefully and only user sounds show.

---

## Ownership & Dependency Graph

```
AppState  (.project getter → DeckManager.activeProject)
  └── DeckManager
        └── Project (×2 — deck A + deck B; share Clock + AudioEngine, beatmatched)
              │  (each Project owns a busGain → AudioEngine.fxBus; crossfader rides the two)
              └── Track (×8–12, dynamic)
                    ├── Sequencer
                    │     └── Step (×64)
                    │           └── Condition
                    ├── VoicePool (8 slots)
                    │     └── VoiceSlot (×8)
                    │           ├── Machine (SynthMachine | BassMachine | ChordMachine | … one per slot)
                    │           ├── Envelope (one per slot — prevents amplitude stacking on overlap)
                    │           └── Filter (one per slot — amp gate sits AFTER filter so idle voices
                    │                       are fully silent, incl. filter ring; slot-0 filter is
                    │                       canonical & mirrors params to siblings)
                    ├── Filter (Track.filter === pool slot-0 filter; canonical for UI/sequencer)
                    ├── StereoPannerNode (pannerNode — owned directly by Track)
                    ├── Arpeggiator (intercepts Sequencer triggers when enabled; Input mode is keyboard-driven instead)
                    ├── LiveArp (drives Arpeggiator input modes from held keyboard keys; free-running)
                    └── LFO (×N, at least 1; machine-param LFOs connect to all 4 slot machines)

AudioEngine
  └── Clock
        └── Sequencer (×8–12, registered as tick callbacks)

UI (reads AppState, calls Track/Sequencer/Machine methods)
  ├── TrackRow     → AppState.selectedTrack
  ├── StepGrid     → AppState.selectedTrack.sequencer
  ├── SynthPanel   → AppState.selectedTrack.machine / filter / envelope / lfo
  ├── FilterViz    → Track.filter + Track.envelope (read-only, canvas refresh)
  ├── ModWheel     → AppState.selectedTrack (parameter assignment + direct AudioParam control)
  └── Keyboard     → AppState.selectedTrack.machine (live trigger)
```

---

## Design Principles

- **Modular machines**: all machines extend `Machine.js`. Adding a new machine type means
  adding one file and registering it in Track.js — nothing else changes.
- **Machine panel companions**: custom SYNTH tab UIs live in `js/ui/panels/<MachineName>Panel.js`,
  not inside SynthPanel.js. SynthPanel passes a `context` object and each panel is responsible
  only for DOM construction. Machines with no custom layout use `DefaultMachinePanel`.
- **Modular conditions**: all conditions are objects with a single `evaluate(context)` method.
- **No framework dependency**: loadable as flat files without a build step.
  ES modules (`type="module"`) used for imports.
- **Audio-first scheduling**: all note timing goes through `AudioContext.currentTime`.
- **P-lock restore timing**: the method of restore depends on whether the target param
  schedules Web Audio automation. See [`design/sequencer.md`](design/sequencer.md) → P-Lock Architecture.
- **Hidden params**: params with `hidden: true` in `getParamList()` are skipped by
  `_renderParamList` but remain available for p-locking, LFO assignment, and sequencer dispatch.
- **Capability warnings**: if a feature request requires behaviour not natively supported by
  the Web Audio API, flag this to the user before implementing any workaround. Do not silently
  build hacks around fundamental limitations.
- **Feature completeness**: any new parameter added to a machine, filter, or envelope should be
  p-lockable and LFO-assignable where technically possible.

---

## Current Status

| Feature | Status |
|---|---|
| Tracks | 8–12 (configurable via TRACKS +/− in transport) |
| Steps total | 64 per track |
| Steps visible | 16 (one page) |
| Step pages | Per-track page nav UI built |
| Machines | SynthMachine, KickSilkMachine, KickHardMachine, AnalogueKickMachine, SnareMachine, AnalogueSnareMachine, HiHatMachine, AnalogueHiHatMachine, AnalogueTomMachine, TomMachine, TomFMMachine, FMMachine, SwarmMachine, NoiseMachine, TransientMachine, SamplerMachine, WavetableSamplerMachine, SampleSwarmMachine, GranularMachine, SlicerMachine, TimeStretchMachine, BeatRepeatMachine, MultiSamplerMachine, CymbalMachine, AnalogueCymbalMachine, WoodMachine, ClappMachine, AnalogueClappMachine, WavetableMachine, KarplusMachine, MarimbaMachine, BassMachine, CombMachine, ChordMachine, MoogishMachine, JunoMachine, OberishMachine, FoldMachine active; DrumMachine stubbed |
| Filter | Two engines (`filter.engine`): **digital** biquad (LP/HP/BP/Notch/Peaking/Allpass + slope) and **analogue** PATINA Moog ladder worklet (24 dB/oct, self-oscillation, drive, drift, **keytrack**) + base filter (HPF+LPF), FilterViz with env ghost (approx curve in analogue mode). Analogue mode also sweeps the cutoff with RC (exponential) curves. |
| Pan | Per-track stereo pan, p-lockable + LFO-assignable |
| Delay | Per-track feedback delay, p-lockable + LFO-assignable |
| Bitcrush | Per-track bit-depth + rate reduction, p-lockable + LFO-assignable |
| Reverb | Per-track convolution reverb (synth IR), p-lockable + LFO-assignable |
| FX pipeline | Per-track REORDERABLE, MULTI-INSTANCE FX chain and the **single home for all effects** (no dedicated DELAY/CRUSH/CHORUS/REVERB tabs, no per-FX header toggles). Drag blocks along a snaking INPUT→OUTPUT path to reorder; per-block ON/OFF bypass; per-block **FX-bind dropdown** (None / FX 1–4 → the four global FX keybinds, per track); click any block to edit its params inline; drag a block to the **BIN** (or ✕) to remove it. "+ Add FX" adds N instances of any type — extra delay/crush/chorus/reverb + a post-sum **FX filter** + **distortion / compressor / normalizer** + the full second-wave catalog: **EQ (3-band) / AutoPan+Tremolo / Gate (trance-gate) / Width (M/S) / Limiter / RingMod / Tape (ping-pong+wow/flutter) / Comb (tuned resonator) / Shimmer (octave reverb+freeze) / Crush+ (real worklet S&H crush) / Stutter (beat-repeat) / Phaser (now stereo, un-parked)** — and re-adds any detached base block. Base blocks are removable (detached from the chain but kept registered for back-compat + re-add); added instances use `FXInstance` proxies with `fxN.`-namespaced param paths (p-lock/LFO/CC-safe) and are fully torn down on remove. FX button in header opens the pane; a **chain mini-outline** of glyph icons beside it mirrors the chain (click → open pane + select). **SAVE** (name+tags) + **LOAD** (FXPresetModal popup: tag filters, audition dry vs pipeline, apply/edit/delete) — global FX presets (FXLibrary). Order + instances + binds persisted (Track/SoundLibrary/copy-paste). See design/fx.md + design/audio-signal-chain.md → Multiple FX instances. |
| Global FX track | A dedicated Syntakt-style FX track (`Project.fxTrack`, pinned first in the track row as `§`/FX, silent 'midi' machine). Held outside `tracks[]` so normal indices/saves are untouched, but fully bindable: own sequencer (p-lockable FX), own FX chain, own follow source. Normal tracks **SEND** into it (insert, after their own FX) via the MIXER strip `→ FX` toggle. **Ducking** via a `DuckFX` block on the FX track triggered by following the kick (follow loop → `triggerDuck`). See design/audio-signal-chain.md → Global FX Track. |
| Deck / DJ crossfade | Two decks (Project A+B) on a shared beatmatched clock; constant-power crossfader, per-deck control/silence/load/unload. DECK tab. Not persisted (live performance layer). |
| MIDI | MIDI out (MidiMachine per track), MIDI In CC routing, 24-PPQN clock sync out. Timing via setTimeout (Web MIDI has no sample-accurate send) — see MidiEngine.js header. |
| Loudness | Per-machine fixed trim (`js/machines/LoudnessTrim.js`) normalises every machine to a common loudness. Measured/re-tuned via the loudness bench at `tests/loudness.html`. See `design/machines.md` → Loudness Normalisation. |
| Analogue emulation | Phase 1: MoogishMachine (`type: 'moogish'`) — PATINA-derived analogue oscillators (imperfect spectra + thermal drift + tolerance + hiss + mains hum). Phase 2 (done): analogue Moog ladder-filter engine (`filter.engine: analogue`) in the FILTER pane, app-wide — PATINA worklet ladder with drive + drift. Phase 3 (done): unified **analogue flow** — one `track.analogue` switch (the ANALOGUE dropdown in FILTER) drives the ladder engine **plus** RC (exponential) envelope curves, filter keytrack, velocity sensitivity (`env.velSens`), and a BBD stereo chorus (`ChorusFX`, CHORUS tab) as a single coherent path. `digital` is the clean default; every non-analogue track/machine is unchanged. The flag is persisted (Track/SoundLibrary/copy-paste) and back-fills from `filter.engine` for projects saved before it existed. Analogue *synth* family expanded beyond Moogish: Moogish gained osc tricks (PWM, ring/cross-mod, wavefolder, hard-sync worklet), plus three new analogue synths — JunoMachine (`juno`, PWM string/pad), OberishMachine (`oberish`, 2-osc brass/pad), FoldMachine (`fold`, West-coast wavefolder). All are in `ANALOGUE_MACHINES` so they auto-engage the analogue flow on load. See `design/machines.md` → Analogue Machines and `design/audio-signal-chain.md` → Filter Engine. |

---

## Known Issues / Pending Work

| Fixed | What |
|---|---|
| WavetableMachine `pos` | `modulatable` flag removed — `pos` is JS-only (PeriodicWave swap) and cannot be driven by a Web Audio LFO AudioParam. |
| Trig multi-voice `×` button | `×` hidden on last remaining voice so clicking it doesn't confuse (removing last voice deactivates the step internally). |
| Filter env amount | Changed from `baseCut * envAmt` (% of current cutoff) to `19980 * envAmt` (% of full 20–20000 Hz range) so depth is consistent at any cutoff position. |
| WavetableSamplerMachine reliability | VoicePool polyphony introduced 8 slots; non-canonical slots (1–7) never received buffer data since `fromJSON` is JSON-only. Fixed via `syncFrom(slot0)` called in `nextVoice()` — copies `_bufferA/B` references to any slot before it fires. Trigger timing race also fixed: `startTime` embedded in trigger message; worklet holds `_pendingTrigger` and arms in `process()` when `currentTime >= startTime`. |
| Trig RESET TRIG | Now sets `step.active = false` in addition to resetting voices to one, so the step is fully deactivated. Individual `×` buttons remain on all voices when multiple exist; only the last voice has no `×` (deactivating is done via RESET TRIG). |
| Arp rate/gate LFO | Arp timing is plain JS read once per build, not a Web Audio `AudioParam`, so it cannot be continuously LFO-modulated. LFO on `arp.rate`/`arp.gate`/`arp.variance` is **sample-and-hold** (per step-fire / per arp cycle, like `trig.tone`). P-locks on these apply exactly. Documented as a Web Audio limitation rather than worked around. |
| Chrome "pre-note" / soft pre-onset | `Envelope._scheduleADS`, `Envelope.noteOff`, `Filter.scheduleFrequency`, and `FMMachine._scheduleADS` called `cancelAndHoldAtTime(time)` then `linearRampToValueAtTime(…, time+a)` with **no explicit anchor event at `time`**. Chrome ramps from the *previous* automation event (the prior note's release, in the past) instead of from `time`, so the attack/sweep began ~one scheduler-lookahead early — an audible soft "pre-note" before the real onset. Firefox inserts an implicit hold and was unaffected (Chrome-only). Fixed by always re-asserting `setValueAtTime(value, time)` after the cancel so both engines ramp from `time`. |
| Input-arp octave bleed (first ~8 notes) | Persistent oscillators are only retuned via `frequency.setValueAtTime` per note and never cleared. LiveArp schedules a whole cycle ahead in one burst, so reusing a pool slot for a new held chord left **stale future** frequency events from the previous chord queued on the slot's oscillator — the osc hopped back to the old pitch when they fired, so the previous octave bled into the first ~8 notes (one per pool slot) of the new arp. Fixed by `frequency.cancelScheduledValues(time)` before the retune in every persistent-osc machine (Synth, FM, Moogish, Bass, Wavetable, Strings, Chord). |
| Input-arp release: hard cut → natural tail | `LiveArp._stop()` called `pool.silence()` (the panic 5 ms slam) to cancel the ~100 ms lookahead overhang on release — but that nuked the **release tails of notes already sounding**, so letting go / switching tracks chopped the arp dead, ignoring gate + release. Fixed by removing the silence: each note's full gate + release is queued at fire time, so just stopping the scheduler lets sounding notes ring out naturally. Cost: notes already scheduled into the lookahead window still fire (a note or two of overhang) — reads as natural release. Panic still hard-kills via the independent `Track.silence()` path. |
| Hold "released" on track switch with arp on | The `trackSelected` handler cleared a held arp track's `_held` set + stopped its scheduler, so switching away dropped the latched arp loop (hold appeared to release — only happened with arp on; non-arp held chords stash into `_latchedVoices` and keep ringing). Fixed: a held arp track keeps looping after switch-away (LiveArp is per-track, drives its own pool, unaffected by selection). `holdModeChanged`(off) now also `releaseAll()`s a background looping arp so turning hold off still stops it. |

---

## Extending

- **New machine**: extend `Machine.js`, add to `MACHINES` map in `Track.js`, add to `SynthPanel.MACHINE_DEFS`.
- **New condition**: add condition type to `Condition.js`.
- **New p-lock mode**: add a `case` to `_fireStep()` switch, document in `design/sequencer.md`.
- **More LFO destinations**: add cases to `Track._resolveAudioParam`.
- **New hidden param**: add `hidden: true` to `getParamList()`, render manually in the desired tab.
- **More tracks**: click TRACKS + in the transport bar (max 12). `Project.setTrackCount(n)` handles it at runtime.
