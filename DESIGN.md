# Webtakt — Design Overview

> **Maintenance rule:** Any feature addition, rename, or architectural change **must be documented** in the relevant sub-document before the session is considered done. Keep tables, diagrams, and section text current — stale docs are treated as bugs. This rule applies to sub-documents too.

---

## Sub-Documents

| Document | What it covers |
|---|---|
| [`design/audio-signal-chain.md`](design/audio-signal-chain.md) | Per-track signal chain, filter architecture, FilterViz, envelope architecture, voice pool/selection, pan, DJ filter, audio constraints |
| [`design/sequencer.md`](design/sequencer.md) | Clock/sequencer architecture, step data model, p-lock architecture, track nav/page control, record mode, drum mode, double-click step |
| [`design/machines.md`](design/machines.md) | All machine types: drum machines, melodic synths, sampler, wavetable sampler; drum architecture; hidden param pattern |
| [`design/fx.md`](design/fx.md) | DelayFX, BitcrushFX, ReverbFX — parameters, signal routing, UI, p-lock behaviour |
| [`design/ui.md`](design/ui.md) | SynthPanel tabs, mixer tab, transport controls, scale quantisation, LFO destination groups, state/event flow |
| [`design/state.md`](design/state.md) | Save/load (Project JSON), sound library, sample store |
| [`design/tests.md`](design/tests.md) | Audio test suite architecture, coverage, how the Clock shim works |

---

## Overview

A browser-based modular step sequencer / synthesizer inspired by Elektron Syntakt and Moog Mother-32.
Built in vanilla HTML5 + JavaScript. No build step, no framework, no package manager.
Served via `python3 -m http.server 8000` and opened in Chrome.

**Current scope:** 8–12 tracks (configurable at runtime via TRACKS +/− in the transport bar, default 8), unlimited steps per track (configurable per track, 16 visible per page), SynthMachine as primary voice, full suite of synthesis drum voices and melodic machines. MIDI out (MidiMachine per track), MIDI In CC routing per track, MIDI clock sync out (24 PPQN).

---

## File Structure

```
index.html
css/
  style.css
js/
  core/
    AudioEngine.js      — AudioContext, master gain, FX bus, AnalyserNode (master output tap)
    Clock.js            — BPM clock, tick scheduling via AudioContext.currentTime
    GlobalRecorder.js   — MediaRecorder wrapper tapping masterGain
    MidiEngine.js       — Web MIDI singleton: port enumeration, note/CC out, CC in routing, 24-PPQN clock sync out
  sequencer/
    Sequencer.js        — Per-track step runner, polyrhythm, page logic, p-lock dispatch
    Step.js             — Single step: note, vel, length, nudge, retrigger, chance, condition, plocks
    Condition.js        — Condition objects: ratio-based (hits:of) and always
  machines/
    Machine.js          — Abstract base class all machines extend
    SynthMachine.js     — Main oscillator + sub-oscillator, waveform select
    KickMachine.js      — Backward-compat alias → KickSilkMachine (type: 'kick')
    KickSilkMachine.js  — Clean kick: sine + pitch sweep + noise punch (type: 'kick.silk')
    KickHardMachine.js  — Fat kick: sub osc + body + waveshaper saturation + noise punch (type: 'kick.hard')
    SnareMachine.js     — Synthesis snare: triangle tone + filtered noise
    HiHatMachine.js     — Synthesis hi-hat: 6 inharmonic square oscs + HP filter
    FMMachine.js        — 4-operator FM synth; per-op ADSR envelopes
    DrumMachine.js      — Generic drum stub (future)
    SamplerMachine.js   — Sample playback: load file or record mic, trim/reverse/loop
    CymbalMachine.js    — Crash/ride cymbal: inharmonic oscs + HPF + resonant BP
    WoodMachine.js      — Clave/wood block/cowbell: dual resonant bandpass + click
    ClappMachine.js     — 808-style clap: 3 staggered noise bursts through bandpass
    WavetableMachine.js — Wavetable oscillator with morphing (8-entry bank via PeriodicWave)
    WavetableSamplerMachine.js — Two-sample wavetable: morph between sample A and B via AudioWorklet
    SampleSwarmMachine.js — 7-voice sample swarm: one sample played through 7 detuned BufferSourceNodes with spread + drift (type: 'sample-swarm')
    MidiMachine.js      — MIDI out machine: routes noteOn/noteOff to a selected MIDI output port/channel; params: channel (1–16), noteOffset (±24 semitones); no audio output (type: 'midi')
    KarplusMachine.js   — Karplus-Strong plucked string (noise burst + comb filter)
    MarimbaMachine.js   — Marimba bar: 3 tuned inharmonic sine partials (ratios ~1×/3.9×/9.9×) + mallet noise burst, each partial with independent decay
    BassMachine.js      — Bassline voice: saw/sq + sub + drive + portamento + accent
    CombMachine.js      — Pitched resonator: two decaying sinusoidal partials (bell/marimba/gamelan)
    ChordMachine.js     — 4-voice chord synth: 11 chord types, inversions, p-lockable per step
  signal/
    Filter.js           — BiquadFilterNode wrapper: type, cutoff, resonance, envAmount + base LPF/HPF
    Envelope.js         — Dual ADSR (amp + filter env), scheduleNote for sequencer, noteOn/noteOff for live
    LFO.js              — LFO: waveform, speed, depth, destination routing (supports multiple AudioParam destinations)
    VoicePool.js        — 8-slot voice pool per track: each slot owns machine + envelope + filter; slot-0 filter is canonical and mirrors params to siblings; all slots share outputGain
    DelayFX.js          — Stereo feedback delay
    BitcrushFX.js       — Bit-depth reduction + rate smear
    ReverbFX.js         — Convolution reverb with synthesised IR
  ui/
    TrackRow.js         — 8 track selector buttons, mute state, machine type indicator
    StepGrid.js         — 16-step grid (current page), click to select, dblclick to add lowest note
    SynthPanel.js       — Tabbed panel: MACHINE / TRIG / SYNTH / FILTER / AMP / LFO
    FilterViz.js        — Canvas widget: frequency response curve + base filter + env ghost
    Oscilloscope.js     — Canvas waveform strip: time-domain display of master output with zero-crossing trigger
    ModWheel.js         — 2 assignable mod wheels: drag or scroll (left/right screen halves → MW1/MW2)
    Keyboard.js         — Piano keyboard (2 octaves), octave shift, live note trigger
    KnobWidget.js       — Rotary knob widget, supports bipolar, p-lock highlight, drag interaction
    ADSRWidget.js       — Visual ADSR canvas widget used in AMP and FILTER tabs
    panels/
      DefaultMachinePanel.js  — Generic SYNTH tab layout: flat knob/select/checkbox grid from getParamList()
      FMPanel.js              — Custom SYNTH tab layout for FMMachine: schematic + 2×2 operator grid
      SoundLibraryPanel.js    — SOUNDS tab content: tag filter chips + scrollable sound card list
      SamplerPanel.js         — Custom SYNTH tab for SamplerMachine: file picker, mic record, waveform + trim handles
      WavetableSamplerPanel.js — Custom SYNTH tab for WavetableSamplerMachine: dual file pickers + morph/speed/level controls
      SampleSwarmPanel.js     — Custom SYNTH tab for SampleSwarmMachine: SamplerPanel + swarm knob row
  signal/
    Arpeggiator.js      — Per-track arpeggiator: Chord / Manual / Random modes; BPM-sync; variance. Owned by Track, called from Sequencer._fireStep()
  util/
    BpmSync.js          — Shared BPM-sync utility: DIV_QN map, SYNC_DIVISIONS list, divToSeconds(div, bpm). Used by DelayFX, ReverbFX, Arpeggiator.
  state/
    Track.js            — Owns VoicePool + sequencer + filter + FX chain + LFOs + pannerNode + Arpeggiator
    Project.js          — 8–12 tracks (dynamic), BPM, export/import JSON file
    AppState.js         — Selected track/step, active tab/LFO, event bus
    SoundLibrary.js     — Persistent sound library (localStorage): save/load/delete named voice snapshots
    SampleStore.js      — Persistent sample store (localStorage): WAV-base64 per sample, referenced by sampleId
    Scales.js           — Scale definitions (20 scales) + noteInScale() helper
  worklets/
    wavetable-sampler-processor.js — AudioWorkletProcessor for WavetableSamplerMachine
```

---

## Ownership & Dependency Graph

```
AppState
  └── Project
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
              ├── Arpeggiator (intercepts Sequencer triggers when enabled)
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
| Machines | SynthMachine, KickSilkMachine, KickHardMachine, SnareMachine, HiHatMachine, FMMachine, SwarmMachine, NoiseMachine, TransientMachine, SamplerMachine, WavetableSamplerMachine, SampleSwarmMachine, CymbalMachine, WoodMachine, ClappMachine, WavetableMachine, KarplusMachine, MarimbaMachine, BassMachine, CombMachine, ChordMachine active; DrumMachine stubbed |
| Filter | Main filter (LP/HP/BP/Notch/Peaking/Allpass) + base filter (HPF+LPF), FilterViz with env ghost |
| Pan | Per-track stereo pan, p-lockable + LFO-assignable |
| Delay | Per-track feedback delay, p-lockable + LFO-assignable |
| Bitcrush | Per-track bit-depth + rate reduction, p-lockable + LFO-assignable |
| Reverb | Per-track convolution reverb (synth IR), p-lockable + LFO-assignable |
| MIDI | Out of scope |
| Analogue emulation | Out of scope |

---

## Known Issues / Pending Work

| Fixed | What |
|---|---|
| WavetableMachine `pos` | `modulatable` flag removed — `pos` is JS-only (PeriodicWave swap) and cannot be driven by a Web Audio LFO AudioParam. |
| Trig multi-voice `×` button | `×` hidden on last remaining voice so clicking it doesn't confuse (removing last voice deactivates the step internally). |
| Filter env amount | Changed from `baseCut * envAmt` (% of current cutoff) to `19980 * envAmt` (% of full 20–20000 Hz range) so depth is consistent at any cutoff position. |
| WavetableSamplerMachine reliability | VoicePool polyphony introduced 8 slots; non-canonical slots (1–7) never received buffer data since `fromJSON` is JSON-only. Fixed via `syncFrom(slot0)` called in `nextVoice()` — copies `_bufferA/B` references to any slot before it fires. Trigger timing race also fixed: `startTime` embedded in trigger message; worklet holds `_pendingTrigger` and arms in `process()` when `currentTime >= startTime`. |
| Trig RESET TRIG | Now sets `step.active = false` in addition to resetting voices to one, so the step is fully deactivated. Individual `×` buttons remain on all voices when multiple exist; only the last voice has no `×` (deactivating is done via RESET TRIG). |

---

## Extending

- **New machine**: extend `Machine.js`, add to `MACHINES` map in `Track.js`, add to `SynthPanel.MACHINE_DEFS`.
- **New condition**: add condition type to `Condition.js`.
- **New p-lock mode**: add a `case` to `_fireStep()` switch, document in `design/sequencer.md`.
- **More LFO destinations**: add cases to `Track._resolveAudioParam`.
- **New hidden param**: add `hidden: true` to `getParamList()`, render manually in the desired tab.
- **More tracks**: click TRACKS + in the transport bar (max 12). `Project.setTrackCount(n)` handles it at runtime.
