# Webtakt — Architecture & Design Document

> **Maintenance rule:** Any feature addition, rename, or architectural change that affects files, signal chain, UI layout, or public APIs **must be documented here** before the PR/session is considered done. Keep tables, diagrams, and section text current — stale docs are treated as bugs.

---

## Known Issues / Pending Work

---

## Overview

A browser-based modular step sequencer / synthesizer inspired by Elektron Syntakt and Moog Mother-32.
Built in vanilla HTML5 + JavaScript. No build step, no framework, no package manager.
Served via `python3 -m http.server 8000` and opened in Chrome.

**Current scope:** 8–12 tracks (configurable at runtime via TRACKS +/− in the transport bar, default 8), unlimited steps per track (configurable per track, 16 visible per page), SynthMachine as
primary voice, KickSilkMachine / KickHardMachine / SnareMachine / HiHatMachine as synthesis drum voices,
FMMachine active (4-op FM with per-op ADSR), DrumMachine stubbed. No MIDI, no FX internals.

---

## File Structure

```
index.html
css/
  style.css
js/
  core/
    AudioEngine.js      — AudioContext, master gain, FX bus placeholder
    Clock.js            — BPM clock, tick scheduling via AudioContext.currentTime
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
    WavetableMachine.js — Wavetable oscillator with morphing (8-entry bank via PeriodicWave)
    WavetableSamplerMachine.js — Two-sample wavetable: morph between sample A and B via AudioWorklet
    KarplusMachine.js   — Karplus-Strong plucked string (noise burst + comb filter)
    BassMachine.js      — Bassline voice: saw/sq + sub + drive + portamento + accent
    CombMachine.js      — Resonator/comb filter: noise/impulse exciter + tuned delay loop
    ChordMachine.js     — 4-voice chord synth: 11 chord types, inversions, p-lockable per step
  signal/
    Filter.js           — BiquadFilterNode wrapper: type, cutoff, resonance, envAmount + base LPF/HPF
    Envelope.js         — Dual ADSR (amp + filter env), scheduleNote for sequencer, noteOn/noteOff for live
    LFO.js              — LFO: waveform, speed, depth, destination routing (supports multiple AudioParam destinations)
    VoicePool.js        — 4-slot voice pool per track: each slot owns machine + envelope; all slots share filter + outputGain
  ui/
    TrackRow.js         — 8 track selector buttons, mute state, machine type indicator
    StepGrid.js         — 16-step grid (current page), click to select, dblclick to add lowest note
    SynthPanel.js       — Tabbed panel: MACHINE / TRIG / SYNTH / FILTER / AMP / LFO
    FilterViz.js        — Canvas widget: frequency response curve + base filter + env ghost
    ModWheel.js         — 2 assignable mod wheels: drag or scroll (left/right screen halves → MW1/MW2); param selector on each wheel; direct AudioParam control
    Keyboard.js         — Piano keyboard (2 octaves), octave shift, live note trigger
    KnobWidget.js       — Rotary knob widget, supports bipolar, p-lock highlight, drag interaction
    ADSRWidget.js       — Visual ADSR canvas widget used in AMP and FILTER tabs
    panels/
      DefaultMachinePanel.js  — Generic SYNTH tab layout: flat knob/select/checkbox grid from getParamList()
      FMPanel.js              — Custom SYNTH tab layout for FMMachine: schematic + 2×2 operator grid
      SoundLibraryPanel.js    — SOUNDS tab content: tag filter chips + scrollable sound card list
      SamplerPanel.js         — Custom SYNTH tab for SamplerMachine: file picker, mic record, waveform + trim handles
      WavetableSamplerPanel.js — Custom SYNTH tab for WavetableSamplerMachine: dual file pickers + morph/speed/level controls
  state/
    Track.js            — Owns VoicePool + sequencer + filter + FX chain + LFOs + pannerNode; .machine/.envelope are getters into pool slot 0
    Project.js          — 8–12 tracks (dynamic), BPM, export/import JSON file
    AppState.js         — Selected track/step, active tab/LFO, event bus
    SoundLibrary.js     — Persistent sound library (localStorage): save/load/delete named voice snapshots
    SampleStore.js      — Persistent sample store (localStorage): WAV-base64 per sample, referenced by sampleId
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
              ├── VoicePool (4 slots)
              │     └── VoiceSlot (×4)
              │           ├── Machine (SynthMachine | BassMachine | ChordMachine | … one per slot)
              │           └── Envelope (one per slot — prevents amplitude stacking on overlap)
              ├── Filter (shared across all slots)
              ├── StereoPannerNode (pannerNode — owned directly by Track)
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

## Audio Signal Chain (per track)

Each track runs 4 voice slots in parallel. Slots share the filter and output; each has its own machine and envelope to prevent amplitude stacking when notes overlap.

```
VoiceSlot ×4 (each slot is fully isolated before the shared filter):
  Machine (oscillator nodes) → Envelope.ampGain (GainNode, per-slot ADSR gate) ─┐
                                                                                  ↓
  Filter._baseHPF (BiquadFilterNode, highpass, shared) ────────────────────────── ← all 4 slots sum here
    → Filter._baseLPF (BiquadFilterNode, lowpass, shared)
      → Filter.node (BiquadFilterNode, shared — type/cutoff/resonance)
        → Track.outputGain (GainNode, shared — mute implemented here)
            → Track.pannerNode (StereoPannerNode, shared — pan)
              → DelayFX.inputNode
                → BitcrushFX.inputNode
                  → ReverbFX.inputNode
                    → AudioEngine.fxBus (GainNode)
                      → AudioEngine.masterGain
                        → AudioContext.destination

Each Envelope also drives Filter.node.frequency directly (filter envelope modulation).
All 4 envelopes modulate the same shared filter frequency param — they race-cancel correctly
via cancelAndHoldAtTime, so whichever slot fires latest wins the filter sweep.

The ampGain gate sits BEFORE the filter (machine → ampGain → baseHPF), not after.
This ensures each slot is isolated: a silent slot contributes zero audio to the filter
even though all slots sum into the same filter input. The previous post-filter fan-out
topology (filter.node → all 4 ampGains) caused all slots to bleed through all envelopes.

LFOs connect to AudioParams:
  - Filter.node.frequency / Q  (single shared param)
  - Filter._baseLPF.frequency / Filter._baseHPF.frequency  (single shared)
  - Machine AudioParams (osc.detune, sub.level, output.level, etc.) — connected to ALL 4 slot machines
  - Track.pannerNode.pan (amp.pan — single shared)
  - DelayFX / BitcrushFX / ReverbFX params — single shared

Mod wheels use `Track.resolveModWheelParam(path)` → `{ audioParam, min, max }` and
set the AudioParam directly (absolute value in lfoMin–lfoMax range), not additively like LFOs.
Wheel position 0–1 maps linearly to [min, max].
```

### Voice selection (VoicePool.nextVoice)

Round-robin through 4 slots; picks the first idle one (past its release tail). If all 4 are busy, steals the one whose release ends soonest. Before returning the chosen slot, syncs its machine and envelope params from slot 0 (canonical) so UI knob changes always take effect on the next note.

---

## Filter Architecture

`Filter` wraps three BiquadFilterNodes in series:

1. **Base HPF** (`_baseHPF`) — highpass, fixed Q=0.7071 (Butterworth), no resonance.
   Param: `base.hpf` (20–8000 Hz, default 20). Attenuates low end.

2. **Base LPF** (`_baseLPF`) — lowpass, fixed Q=0.7071 (Butterworth), no resonance.
   Param: `base.lpf` (200–20000 Hz, default 20000). Attenuates high end.

3. **Main filter** (`node`) — type/cutoff/resonance/gain.
   Params: `filter.type` (`lowpass` | `highpass` | `bandpass` | `notch` | `peaking` | `allpass`),
   `filter.cutoff`, `filter.resonance`, `filter.gain` (dB, active only for `peaking`), `filter.envAmount`.
   The GAIN knob is hidden in the UI unless type is `peaking`.

Signal chain: Machine → `_baseHPF` → `_baseLPF` → `node` → Envelope.

Base filter params are LFO-assignable and p-lockable. They appear under **BASE FILTER**
in the FILTER tab alongside the main filter knobs. No separate visualisation — the base
filter curves are drawn as a dim overlay in the main FilterViz.

**Machine connection**: `machine.connect(this.filter._baseHPF)` — machines feed the base HPF,
not `filter.node` directly.

---

## FilterViz

`FilterViz.js` (in `ui/`) draws a frequency response canvas updated in real time as knobs are dragged.

**Draws:**
- Base filter response (dim white line) — combined `_baseHPF` + `_baseLPF` magnitude
- Main filter fill + line (amber) — `filter.node` type/cutoff/resonance
- Dashed vertical cutoff marker
- Resonance peak dot at cutoff frequency
- Faint **filter envelope ghost** in the right ~28% of the canvas: shows the `fenv.*`
  ADSR shape as a translucent amber overlay, scaled vertically to canvas height.
  Purely illustrative (time axis is relative, not absolute seconds).

**Pure math**: uses biquad transfer function evaluation (`_evalBiquad`) — no AnalyserNode.
dB range: -42 to +30 dB (accommodates Q=20 resonance peaks of ~26 dB).

**API:**
```js
new FilterViz({
  getFilter:   () => track.filter,     // required
  getEnvelope: () => track.envelope,   // optional — enables env ghost
  getParam:    path => value,          // optional — p-lock-aware filter param reader
  getEnvParam: path => value,          // optional — p-lock-aware envelope param reader
  showBase:    true,                   // draw base filter curve
  height:      118,                    // canvas CSS height in px
})
viz.refresh()   // call after any param change
viz.destroy()   // clean up ResizeObserver
```

`getParam` / `getEnvParam` should check `step.plocks` first, then fall back to track defaults.
This makes the viz reflect p-locked values in real time while dragging.

The env ghost reads `fenv.*` params (filter envelope), NOT `env.*` (amp envelope).

---

## Per-Track FX Chain

Three effects sit in series after the stereo panner, before the global fxBus.
Order: **Delay → Bitcrush → Reverb**.

Each effect has a **wet** knob (0–1) that blends parallel dry+wet. At wet=0 the effect is fully bypassed perceptually (dryGain=1, wetGain=0).

### DelayFX (`js/signal/DelayFX.js`)
Stereo feedback delay. `delay.time` (10ms–1s), `delay.feedback` (0–95%), `delay.wet` (0–1).
All three params are LFO-assignable and p-lockable.
Internal: `DelayNode` + feedback `GainNode` loop. Max delay 2s.

### BitcrushFX (`js/signal/BitcrushFX.js`)
Bit-depth reduction + rate smear. `crush.bits` (1–16), `crush.rate` (1%–100% of nyquist), `crush.wet` (0–1).
`crush.bits` is not modulatable (rebuilds WaveShaperNode curve — JS-only).
`crush.rate` and `crush.wet` are LFO-assignable and p-lockable.
True sample-and-hold requires AudioWorklet; `crush.rate` approximates downsampling via a pre-filter cutoff.

### ReverbFX (`js/signal/ReverbFX.js`)
Convolution reverb with a synthesised exponential-decay noise IR.
`reverb.decay` (0.1–8s) and `reverb.predelay` (0–100ms) rebuild the IR on change — track-level only, not p-lockable.
`reverb.damp` (200–20kHz LP on wet) and `reverb.wet` (0–1) are LFO-assignable and p-lockable.

**UI:** Three tabs on the right side of the tab bar (DLY / CRUSH / REV), visually separated from the voice tabs by a vertical bar. FX tabs use a teal accent (`#7ec8c8`) to distinguish from voice tabs (amber).

**P-lock notes:**
- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay` are `modulatable: false` — they appear in the UI but are always track-level.
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.

---

## Mixer Tab

A global overview tab showing all tracks simultaneously (8–12). Each strip contains:

| Control | What it drives |
|---|---|
| LEVEL | `track.machine.getParam('output.level')` — same AudioParam as the Level knob in the SYNTH tab. Changes are immediately reflected when switching to SYNTH. |
| DLY / CRUSH / REV | Each FX's `*.wet` param (0–1). Same AudioParam as the knobs in the FX tabs. |
| DJ FILT | `track.djFilter` (−1 to +1). See **DJ Filter** section below. |

Clicking a strip (not a knob) selects that track. Selected strip is amber-highlighted.

The LEVEL, DLY, CRUSH, and REV knobs write directly to the live AudioParam — no p-locking (this is a performance mixer, not a step sequencer view).

---

## DJ Filter

Each track has a single **DJ filter** control (`track.djFilter`, −1 to +1, default 0) that sweeps the existing base filter nodes in the signal chain:

- **Center (0)**: flat — LPF at 20 kHz, HPF at 20 Hz (neutral)
- **Left (−1)**: full LPF — sweeps `_baseLPF.frequency` exponentially from 20 kHz → 80 Hz; HPF stays neutral
- **Right (+1)**: full HPF — sweeps `_baseHPF.frequency` exponentially from 20 Hz → 8 kHz; LPF stays neutral

**Implementation:** `Track.applyDJFilter(value)` sets `filter._baseLPF.frequency` and `filter._baseHPF.frequency` directly via `setTargetAtTime`. This shares the same BiquadFilterNodes as `base.lpf` / `base.hpf` in the FILTER tab — they are the same nodes but driven by a single unified knob in the mixer context.

**Serialised** as `djFilter` in `track.toJSON()`. Reset to 0 by `resetTrack()`.

---

## Pan (Stereo Panner)

Each track has a `StereoPannerNode` (`track.pannerNode`) inserted between `outputGain` and `fxBus`.
- Default: `pan = 0` (centre)
- Range: -1 (full left) to +1 (full right)
- Serialised in `track.toJSON()` as `pan`
- Exposed in the **AMP tab** as a bipolar PAN knob (displays C / L50 / R100 etc.)
- P-lockable: `amp.pan` plock key. Sequencer handles it via scheduled `setValueAtTime` /
  restore on `pannerNode.pan` AudioParam.
- LFO-assignable: appears as "Pan" under the "Amp" group in the LFO destination dropdown.
  `Track._resolveAudioParam('amp.pan')` returns `{ audioParam: pannerNode.pan, depthScale: 1.0 }`.
- `Track.resetTrack()` resets pan to 0.

---

## Scale Quantisation

Each track has two scale fields serialised in `Track.toJSON()`:

| Field | Type | Default | Description |
|---|---|---|---|
| `scaleIndex` | number | 0 | Index into `SCALE_DEFS` in `js/state/Scales.js`. 0 = Chromatic (no filtering). |
| `leadNote` | number 0–11 | 0 | Root pitch class (C=0). Used as the reference for interval arithmetic. |

**`js/state/Scales.js`** — single source of truth for all scale definitions (20 scales: Chromatic through Japanese) and the `noteInScale(midi, scaleIndex, leadNote)` helper.

**Scale enforcement:**
- `Keyboard._isInScale(midiNote)` calls `noteInScale` against the selected track's fields.
- Mouse clicks and computer keyboard presses that resolve to a blocked note are silently dropped in `_noteOn`.
- `_applyScale()` adds/removes `.scale-blocked` CSS class on every key element, visually graying them out. Called on `scaleChanged` and `trackSelected` events.
- The sequencer does **not** filter notes — steps already programmed with out-of-scale notes still play. Scale only affects live input.

**UI (SCALES tab):** Scale dropdown (160 px wide, searchable) + 12-button root picker displayed side by side. A chromatic strip below shows which pitch classes are active in the current scale/root combination, updating live.

---

## Detune (Universal / TRIG Tab)

`osc.detune` has been moved out of the SYNTH tab UI. It is:
- **Hidden** in `SynthMachine.getParamList()` via `hidden: true` flag
- `_renderParamList` skips params with `hidden: true`
- Rendered as a **DETUNE knob in the TRIG tab** (visible only when the machine supports
  `osc.detune`, i.e. SynthMachine — not drum machines)
- P-lockable from the TRIG tab: writes `osc.detune` to `step.plocks`
- **LFO-assignable**: appears under "Trig" group in LFO destination dropdown
  (pulled out of the machine group by `Track.getAssignableParams()`)
- `Track._resolveAudioParam` still resolves it via `machine.resolveAudioParam('osc.detune')`

The `hidden` flag pattern can be reused for any param that should be modulatable/p-lockable
but not rendered in its machine's default knob grid.

---

## AMP Tab (formerly ENV)

The ENV tab has been renamed to **AMP**. It contains:
1. **PAN knob** (bipolar, -1 to +1) — p-lockable, LFO-assignable
2. **Amp ADSR widget** (ADSRWidget, `env.*` prefix) — same as before

---

## Track Count Control

A **TRACKS −** / **+** control sits in the transport bar between the clear buttons and BPM.
- Default: 8 tracks. Range: 1–12 (min/max enforced by `Project.setTrackCount()`).
- Adding a track appends a fresh default `Track` instance.
- Removing a track pops the last track (stops its sequencer). If the selected track is removed, selection clamps to the new last track.
- Saved to JSON as `trackCount`; restored on import.

## Clear / Reset Buttons

Four buttons replace the old two:

| Button | Scope | What it clears |
|---|---|---|
| CLR NOTES | Selected track | Steps only (active, note, vel, length, plocks, condition) |
| CLR TRACK | Selected track | Full reset: notes + machine to synth defaults + filter + envelope + pan + LFOs reset to 1 |
| CLR NOTES ALL | All tracks | Steps only on all tracks |
| CLR ALL | All tracks | Full reset on all tracks |

`Track.clearNotes()` and `Track.resetTrack()` are the underlying methods.
`resetTrack()` tears down all LFOs (stop + clearDestination) and re-adds one clean LFO.

---

## Global Tape Recorder

A **TAPE** button sits next to REC in the transport bar. It captures the full master audio output to a file.

**Behaviour:**
- Clicking **⏺ TAPE** while stopped starts recording. The button turns green and pulses (`#btn-tape.taping`).
- Clicking **⏹ STOP TAPE** while recording stops capture, then immediately opens the filename prompt modal (same `promptFilename` used by EXPORT).
- After confirming the filename, a `.webm` (or `.ogg`) audio file is downloaded.

**Implementation:**
- `js/core/GlobalRecorder.js` — owns a `MediaStreamDestinationNode` tapped from `masterGain` in parallel (does not interrupt audio). Uses `MediaRecorder` with `audio/webm;codecs=opus` (falls back to `/webm`, `/ogg`).
- `recorder.start()` — begins capture, collects 100 ms chunks.
- `recorder.stop()` — returns `Promise<Blob>`.
- `recorder.save(filename)` — triggers browser download with the correct extension.
- Instantiated as `const recorder = new GlobalRecorder(audio)` immediately after `AudioEngine`.

**File:**
```
js/core/GlobalRecorder.js   — MediaRecorder wrapper tapping masterGain
```

**Signal tap:** `masterGain → MediaStreamDestinationNode` (parallel, does not modify the main chain).

---

## Record Mode

A **REC** button sits next to PLAY in the transport bar. Clicking it toggles `AppState.recording`.

**Behaviour when recording is ON and sequencer is playing:**
- The clock tick callback in `index.html` tracks which step just fired (`justFired`).
- On each new step, `state.selectedStepIndex` is silently updated to match the currently playing step on the visible page. A `stepSelected` event is emitted so `StepGrid` and `SynthPanel` (TRIG tab) update.
- Playing a note on the Keyboard (or computer keys) writes the note into the currently selected step as normal — the record-step tracking means the step advances automatically each beat, so no manual step selection is needed.
- If the playing step is outside the visible page (polyrhythm / page offset), no forced selection occurs (the user can scroll pages manually).

**When recording is OFF:** no step-advance side effect — step selection behaves as normal.

**Visual:** the REC button gains a pulsing red style (`#btn-rec.recording`) to make the armed state obvious.

---

## Double-Click Step to Add Note

In `StepGrid`, double-clicking a step cell:
1. Activates the step
2. Sets its note to the **lowest note** among all currently active steps on that track
3. Falls back to MIDI 36 (C2) if no active steps exist
4. Selects the step so the TRIG tab updates

Useful for drum tracks where you want to quickly add hits at the track's established pitch.

---

## Clock & Sequencer Architecture

The master `Clock` uses `AudioContext.currentTime` for scheduling — not `setInterval`.
This gives sample-accurate timing regardless of JS event loop jitter.

```
Clock.start()
  → schedules ticks ahead in time using a lookahead window (~100ms)
  → each registered Sequencer._onTick(tickIndex, scheduledTime) is called
  → Sequencer resolves which step fires, evaluates Condition then Chance
  → _fireStep() dispatches p-locks and calls:
      machine.noteOn(note, velocity, time)
      machine.noteOff(oscOffTime)          ← kept alive through release tail
      envelope.scheduleNote(time, offTime, envOverrides)
```

**P-lock dispatch** in `_fireStep`: driven by the `plockMode` field on each param descriptor
(see **P-Lock Architecture** section). `_buildPlockModeMap()` collects all modes from the
track's param lists once per fired step, then a single `switch(mode)` loop handles all cases.
Adding a new param only requires `plockMode` in its `getParamList()` — no sequencer changes.

Polyrhythm: each Sequencer has its own `stepCount` (1–64). The Clock fires a global tick at
the smallest subdivision; each Sequencer increments its own counter independently.

Step pages: Sequencer holds 64 steps total. `pageOffset` selects which 16 are visible.
Page nav UI is not yet built but the data layer is complete.

---

## P-Lock Architecture

P-locks are per-step parameter overrides stored in `step.plocks` (a `Map<string, value>`).
They are applied at fire time by `Sequencer._fireStep()` using a data-driven dispatch
framework: **each param descriptor in `getParamList()` carries a `plockMode` field**
that tells the sequencer exactly how to apply and restore it.

### plockMode values

| Mode | Who uses it | Behaviour |
|---|---|---|
| `'envelope'` | `env.*`, `fenv.*`, `filter.envAmount`, `filter.cutoff` | Collected into `envOverrides`, passed to `scheduleNote()`. Never touches `_params` directly. `filter.cutoff` must go here (not `'filter'`) because `scheduleNote` calls `cancelAndHoldAtTime` on the filter frequency AudioParam — any `setTargetAtTime` scheduled before it would be cancelled. `scheduleNote` reads `overrides['filter.cutoff']` as the sweep base and ramps back to the true (non-locked) cutoff at release. |
| `'filter'` | `filter.resonance`, `filter.gain`, `base.lpf`, `base.hpf` | `filter.setParam(path, value, time)` + restore at `offTime`. Web Audio automation handles timing. Only valid for filter AudioParams that `scheduleNote` does NOT touch. |
| `'audioParam'` | Any param backed by a live `AudioParam` (detune, gains, FX params) | `obj.setParam(path, value, time)` schedules the lock; restore is pushed as `() => obj.setParam(path, old, offTime)`. |
| `'js'` | Waveform strings, envelope timing values, curve/IR rebuilds, JS-only timing | `obj.setParam(path, value)` immediately before `noteOn`; `() => obj.setParam(path, old)` added to restore queue (no time arg — runs synchronously). |
| `'pan'` | `amp.pan` | `pannerNode.pan.setValueAtTime(value, time)` + restore at `offTime` via the restore queue. |
| `'trig'` | `trig.tone` | Handled separately below the loop (semitone transpose). No restore needed. |

### Extending the framework

To add a new param to p-lock support: add `plockMode: '<mode>'` to its descriptor in
`getParamList()` in the owning class. No changes to `Sequencer._fireStep()` are needed.

To add an entirely new plockMode: add a `case` to the `switch(mode)` block in
`_fireStep()` and document it here.

`env.*` / `fenv.*` paths are not in any `getParamList()` — `_fireStep` treats unmapped
paths matching those prefixes as `'envelope'` automatically.

---

## LFO Destination Groups

> Full LFO implementation detail — depthScale math, FM split-gain topology, JS-only destinations, lifecycle, and extension guide — is in [`js/signal/LFO.md`](js/signal/LFO.md).

`Track.getAssignableParams()` returns grouped destinations for the LFO dropdown:

| Group | Params |
|---|---|
| Trig | Detune (`osc.detune`) — only if machine supports it |
| Synth / Machine | Machine params marked `modulatable: true` (excluding detune) |
| Filter | `filter.cutoff`, `filter.resonance`, `base.lpf`, `base.hpf` |
| Amp | `amp.pan` |

`Track._resolveAudioParam(path)` handles `amp.pan` directly (returns `pannerNode.pan`),
then delegates to `machine.resolveAudioParam` then `filter.resolveAudioParam`.

---

## Envelope Architecture

`Envelope` owns two independent ADSR envelopes:
- **Amp envelope** (`env.*`) — controls `ampGain.gain`
- **Filter envelope** (`fenv.*`) — modulates `filter.node.frequency` directly

Two scheduling paths:

**Sequencer path — `scheduleNote(time, offTime, overrides)`:**
  Queues A→D→S starting at `time`, then R starting at `offTime`. Does NOT cancel prior
  scheduled events before `time` — the previous note's release tail runs until the new
  attack overwrites it. Accepts an `overrides` dict for p-locked ADSR values.
  The oscillator is kept alive until `offTime + release` (so the release tail has audio to shape).

**Live keyboard path — `noteOn(time)` / `noteOff(time)`:**
  Cancels prior events and restarts from zero. Used only for keyboard playing.
  These two paths must stay separate — using noteOn from the sequencer caused release bugs.

---

## Step Data Model

```
Step {
  index      — position in steps array (0–63)
  active     — fires a note?
  note       — MIDI note number (0–127), default 60
  velocity   — 0–127, default 100
  length     — gate duration in ticks (fractional ok), default 1
  nudge      — signed tick offset in ticks, default 0
               UI exposes as -99%..+99% of one step interval.
               -99% = nudge ≈ one step back (plays just after the previous step).
               +99% = nudge ≈ one step forward (plays just before the next step).
               Stored as ticks: nudge = percent / 100.
               Original nudge is never modified by quantize — quantize is non-destructive.
  nudgeQuantize — 0.0–1.0, track-level. Applied at fire time: effectiveNudge = step.nudge × (1 − nudgeQuantize).
               0% = use recorded nudge as-is. 100% = ignore nudge (all steps play on the grid).
               Serialised in Track.toJSON(). Reset to 0 by resetTrack().
  retrigger  — { count, rate } or null
  condition  — Condition instance (type: 'always' | 'ratio')
  chance     — 0–100 percent, evaluated after condition, default 100
  plocks     — Map<string, number|string>  (parameter locks)
}
```

Condition is evaluated first (ratio logic), then chance (random). Both must pass for the step to fire.

---

## State Flow

```
User interaction (click/key)
  → UI component handler
    → mutates AppState / Track / Sequencer directly
      → AppState.emit(event) notifies other components
        → UI re-renders affected component only (no framework, manual DOM updates)
```

No virtual DOM, no reactive framework. Each UI component owns its DOM elements and
exposes a `render()` method called explicitly when its data changes.

**Key events emitted by AppState:**

| Event | Payload | Listeners |
|---|---|---|
| `trackSelected` | `{ index, track }` | TrackRow, StepGrid, SynthPanel |
| `tabChanged` | `{ tab }` | SynthPanel |
| `lfoChanged` | `{ index }` | SynthPanel |
| `stepSelected` | `{ index, step }` | StepGrid, SynthPanel |
| `stepChanged` | `{ trackIndex, stepIndex, step }` | StepGrid, SynthPanel (trig tab only) |
| `recordingChanged` | `{ recording }` | index.html transport (REC button) |

**P-lock knob pattern:**
`onChange` writes value silently (no emit) — prevents panel rebuild mid-drag killing the interaction.
`onRelease` emits `stepChanged` — updates the step grid dot after drag ends.

---

## SynthPanel Tab Overview

The panel header has two zones in a single row:

**Voice tab bar (left, amber) — navigates main content area:**

| Tab | Content |
|---|---|
| MACHINE | Grid of all machine types; click to swap machine on the selected track |
| SOUNDS | Sound library: save/load named snapshots (machine + signal chain). Tag filter chips + scrollable list. |
| SCALES | Scale dropdown + root note picker (12 buttons) + chromatic preview strip |
| TRIG | Note display, REMOVE NOTE, RESET TRIG, condition/chance/length/nudge/detune/tone knobs. NUDGE is only shown when a step is selected. QUANTIZE knob (0–100%) is shown when no step is selected. |
| SYNTH | Machine params — varies by machine type. Detune is hidden here (moved to TRIG). Rendered by a machine-specific panel from `js/ui/panels/`. |
| FILTER | Single row: type dropdown + cutoff/res/gain/env knobs (left) + FilterViz (centre) + right column with compact filter ADSR above base HPF/LPF knobs. All p-lockable. |
| AMP | Single row: PAN knob (left, p-lockable + LFO-assignable) + compact amp ADSR (right, canvasH=80, 44px knobs). |
| LFO | LFO sub-selector (LFO 1, LFO 2, …, +) capped at 220px wide, destination dropdown (grouped), speed/depth/waveform knobs |
| MIXER | All-tracks mixer island: positioned between LFO and the FX block, with a left border separator. One strip per track (T1–TN) showing Level, DLY wet, CRUSH wet, REV wet, and DJ Filter knobs. Clicking a strip selects that track. |

**FX block (right side of header, always visible, teal):**

Three stacked toggle units — DLY / CRUSH / REV — sit in `.fx-bar` on the right of the header, separated by a left border. Each unit has:
- A **name button** (top): clicking it opens that FX's param tab in the main content area
- An **ON/OFF toggle** (bottom, large): enables/disables the FX without navigating away

The on/off state is reflected in the header at all times regardless of which voice tab is active. The FX content tabs (`delay` / `crush` / `reverb`) in `_renderContent` are still reached by clicking the name button; they no longer have their own on/off button inside the content area.

| FX | Content when name clicked |
|---|---|
| DLY | Delay Time, Feedback, Wet knobs. All p-lockable + LFO-assignable. |
| CRUSH | Bits, Rate, Wet knobs. Rate + Wet p-lockable + LFO-assignable. Bits track-level only. |
| REV | Decay, Pre-dly, Damp, Wet knobs. Damp + Wet p-lockable + LFO-assignable. Decay + Pre-dly track-level only. |

When a step is selected, knobs in SYNTH/FILTER/AMP write to `step.plocks` instead of track params.
Knobs show a p-lock indicator (blue label) when a step override is active.

**FilterViz refresh pattern**: all knobs in the FILTER tab call `mainViz.refresh()` in both
`onChange` (live animation while dragging) and `onRelease`. The viz uses plock-aware
`getParam`/`getEnvParam` closures so p-locked values are reflected correctly.

---

## Drum Machine Architecture

KickMachine, SnareMachine, and HiHatMachine are **self-enveloping**: they manage their own
amp envelope internally and do not rely on the track's `Envelope` for amplitude shaping.
The track `Envelope` and `Filter` nodes are still in the signal chain and can be used for
additional tonal shaping, but drum voices sound correct with the track envelope at default settings.

All drum machines follow the same `noteOff` convention: it is a no-op. The sequencer still
calls it; the machines simply ignore it. Decay is controlled entirely by internal gain ramps
scheduled in `noteOn`.

**Shared noise buffer pattern:** KickMachine and SnareMachine each cache one `AudioBuffer`
of white noise at module scope (not per-instance). The buffer is generated once on first use
and reused across all `noteOn` calls via `AudioBufferSourceNode` (which is one-shot by spec,
so a new source node is created each hit pointing at the shared buffer).

### KickSilkMachine (`type: 'kick.silk'`)
Clean, round kick. No saturation.
```
OscillatorNode (sine) → bodyGain (exp decay) ─┐
AudioBufferSourceNode → punchGain (exp decay) ─┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `punch`, `punch.decay`, `output.level` (LFO+plock)

### KickHardMachine (`type: 'kick.hard'`)
Fat, saturated kick with sub oscillator and waveshaper drive.
```
_tuneOsc (sine, persistent) → bodyGain (2× vel, exp decay) ─┐
_subOsc  (sine, tune/2)     → subGain  (sub.level×2×vel)   ─┼→ WaveShaperNode (tanh, 4× oversample) → outputGain → [Filter]
AudioBufferSourceNode       → punchGain (bypasses shaper)   ─┘
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `sub.level` (plock), `drive` (1–6, plock — rebuilds curve, not LFO-able), `punch`, `punch.decay`, `output.level` (LFO+plock)

Note: `sub.level` and `drive` are p-lockable (`plockMode: 'js'`) but not LFO-assignable — they are read per-hit, not as live AudioParams.

### KickMachine (`type: 'kick'`) — backward compat alias
Re-exports `KickSilkMachine`. Existing saved projects with `type:'kick'` load as Kick Silk.

### SnareMachine (`type: 'snare'`)
```
OscillatorNode (triangle) → bodyGain ─┐
AudioBufferSourceNode → HP filter     │
                      → noiseGain ───┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz), `decay`, `tone` (body level), `snap` (noise level), `noise.cutoff` (Hz), `output.level`

### HiHatMachine (`type: 'hihat'`)
```
Osc×6 (square, inharmonic ratios) → mixGain → HP filter → ampGain (exp decay) → outputGain → [Filter]
```
Parameters: `decay`, `open.decay`, `open` (boolean), `cutoff` (HP Hz), `tone` (HP Q), `output.level`

---

## Sound Library

A persistent library of named sounds (voice snapshots) stored in `localStorage` under `webtakt_sounds`.

**What a sound captures:** machine type + params, filter, envelope, FX chain (delay/bitcrush/reverb), LFOs + destinations, pan, trigTone.
**What it does NOT capture:** sequencer steps, step count, page offset, mute state.

**Files:**
- `js/state/SoundLibrary.js` — CRUD: `save(name, tags, track)`, `load(id, track)`, `delete(id)`, `rename()`, `setTags()`, `allTags()`
- `js/ui/panels/SoundLibraryPanel.js` — panel content: tag filter chips + scrollable card list

**UI:** SOUNDS tab in the SynthPanel tab bar (between MACHINE and SCALES). Clicking the tab opens the panel with:
- `+ SAVE SOUND` button → two-step modal (name, then comma-separated tags)
- Tag filter chips (ALL + one per tag + `+ TAG` to define a new category)
- Scrollable list of sound cards (name, tags, machine badge), each with LOAD / ✎ edit / ✕ delete

Loading a sound swaps the current track's machine and all signal chain params, leaving sequencer data intact.

---

## Save / Load

`Project.toJSON()` serializes full state to a plain object:
- BPM
- Per track: machine type + params, filter params (including base.lpf/base.hpf), envelope params,
  LFO params + destinations, pan value, sequencer (stepCount, pageOffset, all 64 steps), mod wheel targets

`Project.fromJSON(obj)` restores full state.

**No auto-load on boot** — always starts fresh. EXPORT/IMPORT is the explicit save path.
Export downloads a `.json` file; Import reads a `.json` File object.

---

## Design Principles

- **Modular machines**: all machines extend `Machine.js`. Adding a new machine type means
  adding one file and registering it in Track.js — nothing else changes.
- **Machine panel companions**: custom SYNTH tab UIs live in `js/ui/panels/<MachineName>Panel.js`,
  not inside SynthPanel.js. SynthPanel passes a `context` object (machine, step, hasStep,
  container, activeWidgets, writeValue, emitStep, fmtParam) and each panel is responsible
  only for DOM construction. Machines with no custom layout use `DefaultMachinePanel`.
  To add a custom layout for a new machine: create `js/ui/panels/NewMachinePanel.js`,
  add a `case` in `SynthPanel._renderSynth()`.
- **Modular conditions**: all conditions are objects with a single `evaluate(context)` method.
- **No framework dependency**: loadable as flat files without a build step.
  ES modules (`type="module"`) used for imports.
- **Audio-first scheduling**: all note timing goes through `AudioContext.currentTime`.
- **P-lock restore timing**: the method of restore depends on whether the target param
  schedules Web Audio automation. See P-Lock Architecture above.
- **Hidden params**: params with `hidden: true` in `getParamList()` are skipped by
  `_renderParamList` but remain available for p-locking, LFO assignment, and sequencer dispatch.
- **Capability warnings**: if a feature request requires behaviour not natively supported by
  the Web Audio API (e.g. a random/S&H LFO waveform, which `OscillatorNode` does not provide),
  flag this to the user before implementing any workaround. Do not silently build hacks around
  fundamental limitations — the user will likely prefer to skip the feature.
- **Feature completeness**: any new parameter added to a machine, filter, or envelope should be
  p-lockable and LFO-assignable where technically possible. Follow the `hidden: true` param
  pattern when the param belongs in a different tab from its machine's default grid.

---

## Known Architecture Constraints

- **Shared ampGain node:** All oscillators on a track share one `ampGain` GainNode. A new
  note's attack overwrites the previous note's release — standard monophonic behaviour.
- **linearRampToValueAtTime requires an anchor.** Always preceded by `setValueAtTime` or
  `cancelAndHoldAtTime`.
- **`cancelAndHoldAtTime` preferred over `cancelScheduledValues`.** The former holds the
  param at its current scheduled value; the latter snaps to the JS-thread value.
- **Never read `gainNode.gain.value` for future state.** Returns the current JS-thread value.
- **Env p-locks must bypass `setParam`.** `Envelope.setParam` only writes `_params`.
  Passing overrides directly to `scheduleNote` is the correct path.
- **Storage key still references old name.** `Project.js` uses `'pysynth_project'` as the
  localStorage key. Low priority since auto-load is disabled.

---

## Current Status & Extending

| Feature | Status |
|---|---|
| Tracks | 8–12 (configurable via TRACKS +/− in transport) |
| Steps total | 64 per track |
| Steps visible | 16 (one page) |
| Step pages | Per-track page nav UI built (see Track Nav section) |
| Machines | SynthMachine, KickSilkMachine, KickHardMachine, SnareMachine, HiHatMachine, FMMachine, SwarmMachine, NoiseMachine, TransientMachine, SamplerMachine, WavetableSamplerMachine, CymbalMachine, WoodMachine, WavetableMachine, KarplusMachine, BassMachine, CombMachine, ChordMachine active; DrumMachine stubbed |
| Machine selector | MACHINE tab in SynthPanel; scrollable card grid, click to swap |
| Filter | Main filter (LP/HP/BP/Notch/Peaking/Allpass) + base filter (HPF+LPF), FilterViz with env ghost |
| Pan | Per-track stereo pan, p-lockable + LFO-assignable |
| Delay | Per-track feedback delay, p-lockable + LFO-assignable |
| Bitcrush | Per-track bit-depth + rate reduction, p-lockable + LFO-assignable |
| Reverb | Per-track convolution reverb (synth IR), p-lockable + LFO-assignable |
| Detune | Moved to TRIG tab, p-lockable + LFO-assignable |
| FX block | Placeholder passthrough only |
| MIDI | Out of scope |
| Analogue emulation | Out of scope |
| Sample playback | SamplerMachine active (see Sampler section below) |

## Sampler Machine

`type: 'sampler'` — audio sample playback triggered per step.

### Files
- `js/machines/SamplerMachine.js` — machine logic
- `js/state/SampleStore.js` — localStorage-backed WAV storage (base64)
- `js/ui/panels/SamplerPanel.js` — custom SYNTH tab UI

### Architecture
SamplerMachine is **self-enveloping** (like drum machines): amplitude is set via `outputGain.gain.setValueAtTime` at each noteOn; `noteOff` is a no-op. The track Envelope and Filter still sit in-chain for optional tonal shaping.

One `AudioBufferSourceNode` is created per noteOn (Web Audio spec: source nodes are single-use). The previous source is stopped before the new one starts.

```
AudioBufferSourceNode (per-note) → outputGain → [Filter]
```

### Parameters
| Path | Range | Default | Description |
|---|---|---|---|
| `sample.start` | 0–1 | 0 | Normalized start trim point (auto-set on load/record) |
| `sample.end` | 0–1 | 1 | Normalized end trim point (auto-set on load/record) |
| `sample.speed` | 0.125–4 | 1 | Playback rate multiplier |
| `sample.pitch` | boolean | true | When true: transpose pitch from `sample.root` per MIDI note |
| `sample.root` | 0–127 | 60 | Root note the sample is tuned to (C4 = 60) |
| `sample.reverse` | boolean | false | Play region backwards |
| `sample.loop` | boolean | false | Loop between start/end |
| `output.level` | 0–1 | 0.85 | Output gain (LFO-assignable) |

### SampleStore
`js/state/SampleStore.js` encodes `AudioBuffer` as PCM16 WAV → base64 and stores in localStorage under `webtakt_samples`. Each entry: `{ id, name, mimeType, data, createdAt }`.
- `save(name, buffer)` → `{ id, persisted }`. `persisted: false` if localStorage quota exceeded (stays in memory cache).
- `load(id, context)` → `Promise<AudioBuffer|null>`. Decodes on first call, caches decoded buffer in memory.

### SamplerPanel UI (SYNTH tab)
- **LOAD FILE** button: opens file picker, decodes audio, saves to SampleStore, sets buffer on machine.
- **⏺ REC** button: toggles microphone recording via `MediaRecorder`. Stop saves and loads automatically.
- **Waveform canvas**: renders channel 0 waveform. Green `S` handle and amber `E` handle draggable to set trim region. Active region highlighted.
- **Params row**: START, END, SPEED, LEVEL knobs + REV and LOOP toggle buttons.

### Sample persistence in saved projects
`SamplerMachine.toJSON()` includes `sampleId` and `sampleName`. On `fromJSON()`, `Track` asynchronously loads the buffer from `SampleStore` via the track's `sampleStore` reference (set by `Project` at construction). The same async restore happens in `SoundLibrary.load()`.

### Machine note behaviour
`noteOn(midiNote, velocity, time)`:
- When `sample.pitch = true`: `playbackRate = sample.speed × 2^((midiNote − sample.root) / 12)`. Playing C4 on a sample rooted at C4 plays at original pitch; C5 plays an octave up, etc.
- When `sample.pitch = false`: drum mode — MIDI note is ignored, `playbackRate = sample.speed`.
- Velocity scales `output.level`.
- Reverse: rebuilds a reversed `AudioBuffer` slice per noteOn (cheap for trimmed regions).
- Loop: `src.loopStart/loopEnd` set to the trimmed region.

---

## WavetableSampler Machine

`type: 'wt-sampler'` — two-sample wavetable machine. Loads sample A and sample B, then morphs between them per-sample using an `AudioWorkletNode`.

### Files
- `js/machines/WavetableSamplerMachine.js` — machine logic
- `js/worklets/wavetable-sampler-processor.js` — AudioWorkletProcessor
- `js/ui/panels/WavetableSamplerPanel.js` — custom SYNTH tab UI

### Architecture
Self-enveloping (like SamplerMachine). Uses a persistent `AudioWorkletNode` running `wavetable-sampler-processor.js`.

```
AudioWorkletNode (persistent) → outputGain → [Filter]
```

The worklet receives two `Float32Array[]` channel arrays (one per sample) via its `port`. On each `process()` call it linearly interpolates between the two buffers sample-by-sample, driven by the `morph` AudioParam. A single playhead advances through a shared reference length scaled to each buffer's actual length, so both samples stay time-aligned regardless of differing durations.

Reverse playback is implemented by inverting the playback rate in the trigger message (negative rate → processor reads backwards). Loop wraps the playhead back to `startFrac`.

### Parameters
| Path | Range | Default | Description |
|---|---|---|---|
| `morph` | 0–1 | 0.5 | Crossfade centre: 0 = full A, 1 = full B. LFO-assignable + p-lockable. |
| `sweep.depth` | 0–1 | 0 | SampleSweep depth: sine LFO amplitude around morph centre (0 = off). |
| `sweep.speed` | 0.05–20 Hz | 0.5 | SampleSweep rate. |
| `sample.start` | 0–1 | 0 | Normalized start of playback region |
| `sample.end` | 0–1 | 1 | Normalized end of playback region |
| `sample.speed` | 0.125–4 | 1 | Playback rate multiplier |
| `sample.pitch` | boolean | true | Track MIDI note (true) or fixed pitch (false) |
| `sample.rootA` | 0–127 | 60 | MIDI root of sample A |
| `sample.rootB` | 0–127 | 60 | MIDI root of sample B |
| `sample.loop` | boolean | false | Loop region |
| `sample.reverse` | boolean | false | Reverse playback |
| `output.level` | 0–1 | 0.85 | Output gain. LFO-assignable + p-lockable. |

Pitch interpolation: the effective root is `rootA × (1 − morph) + rootB × morph`, so detuning tracks the morph position when the two samples are at different pitches.

### WavetableSamplerPanel UI (SYNTH tab)
Two side-by-side sample slots (A = green, B = amber), each with:
- **LOAD** button: opens file picker, decodes audio, saves to SampleStore
- **Root A/B knob**: MIDI root note for that sample
- **Waveform canvas**: renders sample channel 0

Below the slots:
- **MORPH** knob (large), **START**, **END**, **SPEED**, **LEVEL** knobs
- **PITCH**, **LOOP**, **REV** toggle buttons

### Sample persistence in saved projects
`WavetableSamplerMachine.toJSON()` includes `sampleIdA/B` and `sampleNameA/B`. On `fromJSON()`, `Track` asynchronously loads both buffers from `SampleStore`.

---

## New Machines (batch addition)

Seven machines were added. All follow the standard Machine contract: `getParamList()` with `plockMode`, `modulatable`/`lfoMin`/`lfoMax` where applicable, and `resolveAudioParam()`. All are registered in `Track.js` MACHINES map and listed in `SynthPanel.MACHINE_DEFS`.

### CymbalMachine (`type: 'cymbal'`)
Crash / ride cymbal. 6 inharmonic square oscillators at metallic ratios → HPF (tone) → resonant bandpass (body) → per-note exponential decay.
Three decay tiers: `closed`, `mid`, `open` — selected by `mode` enum p-lockable per step.
Parameters: `tune` (base Hz, LFO+plock), `tone` (HP cutoff, LFO+plock), `body` (BP center, LFO+plock), `resonance` (BP Q, LFO+plock), `decay`, `mid.decay`, `open.decay`, `mode`, `output.level`.

### WoodMachine (`type: 'wood'`)
Clave / wood block / rimshot / cowbell. Two resonant bandpass filters (ring1, ring2) driven by a looping noise source through per-note decay gains, plus a sine click burst. `mix` knob blends between the two resonator bands.
Parameters: `freq1`, `freq2`, `ring` (Q), `mix`, `decay`, `click`, `click.freq`, `output.level`. Frequencies and ring Q are LFO+plock targets.

### WavetableMachine (`type: 'wavetable'`)
Wavetable oscillator with continuous morphing. 8-entry wavetable bank built from `PeriodicWave` (Sine, Triangle, Sawtooth, Square, Pulse25, Bright Saw, Hollow, Vocal/Formant). Two persistent oscillators (_oscA, _oscB) hold adjacent table entries; crossfade GainNodes blend between them. `pos` param (0–7 float) drives the morph — ideal LFO target for wavetable sweeps.
Sub oscillator (sine, one octave below) mixed independently.
Parameters: `osc.detune` (hidden, trig tab), `pos` (JS-only plock, LFO-assignable), `sub.level`, `output.level`.

### KarplusMachine (`type: 'karplus'`)
Karplus-Strong plucked string synthesis. Per-note: short noise burst (exciter) feeds a tuned comb filter (DelayNode + LP feedback loop). Delay time is computed from MIDI note at noteOn for accurate pitch. Self-decaying — track Envelope is optional.
Parameters: `damping` (LP cutoff in feedback), `feedback` (ring length), `excite` (burst length ms), `excite.tone` (LP on burst), `stretch` (feedback detune for chorus), `output.level`. All JS-only except `output.level`.

### BassMachine (`type: 'bass'`)
Dedicated bassline voice. Persistent sawtooth/square main oscillator + sine sub (2 octaves below) through a hard-clip tanh WaveShaperNode. Built-in portamento: `glide` (ms) causes `exponentialRampToValueAtTime` between consecutive notes. `accent` threshold: velocity ≥ threshold boosts output +50% for that step, then restores.
Parameters: `osc.detune` (hidden, trig tab), `waveform`, `sub.level`, `drive` (rebuilds curve, JS), `glide` (JS), `accent` (JS), `output.level`.

### CombMachine (`type: 'comb'`)
Resonator / comb filter synthesizer. Comb filter (DelayNode + LP feedback) pitched to MIDI note at noteOn. Two exciter modes: `noise` (continuous white noise, sustained tone) and `impulse` (short noise burst, bell/metallic ring). noteOff fades the noise exciter; resonator decays naturally from `feedback`.
Parameters: `feedback` (LFO+plock), `damping` (LFO+plock), `exciter` (enum), `excite.level` (LFO+plock), `excite.tone` (LFO+plock), `output.level`.

### ChordMachine (`type: 'chord'`)
Four-voice chord synthesizer. Four persistent oscillators tuned to chord intervals above the played root. 11 chord types: major, minor, dom7, maj7, min7, sus2, sus4, dim, aug, power, octave. `inversion` (0–3) rotates the lowest voice up one octave per step. `spread` adds symmetric per-voice detune for stereo width. Both `chord` and `inversion` are p-lockable per step — enables chord progressions from a single track.
Parameters: `osc.detune` (hidden, trig tab), `chord` (enum), `inversion` (JS), `spread` (JS, LFO-assignable), `waveform`, `output.level`.

---

## Track Nav (Page Counter + Length Control)

The right side of the middle row holds a `#track-nav` panel (replaces the old VIEW button):

| Element | Function |
|---|---|
| Page counter (`1/N`) | Shows current page / total pages. Pages = `ceil(stepCount / 16)`. |
| `▶` (next) button | Advances to the next page, wrapping from last page back to page 1. |
| `LEN` button | Toggles the length popup. |

**Length popup** (`#length-popup`): floating panel anchored above the LEN button.
- Shows current step count as a large number.
- Four buttons: `-16`, `-1`, `+1`, `+16` (clamped to 1–64).
- Closing: click LEN again, or click outside the popup.

**Step count rules:**
- Stored in `Sequencer.stepCount` (1–64, default 16). Serialised in `toJSON()`.
- `pageOffset` is **never** clamped when stepCount changes — all 4 pages remain navigable at all times.
- The sequencer's `_onTick` loop (`_stepIndex >= stepCount`) is the only place that wraps — no other changes needed.

**Active vs inactive pages:**
- "Active pages" = `ceil(stepCount / 16)`. Steps at index ≥ stepCount are inactive.
- All 4 pages are always navigable and editable. Inactive steps are dimly styled but otherwise normal.
- Intended use: pre-author steps on inactive pages, then increase stepCount to unlock them live.

**Page counter format:**
- `1/2(4)` — current / active pages (total slots). `(4)` shows inactive pages exist.
- `1/4` — shown when all pages are active (no parens needed).

**Inactive step appearance** (`.step-cell.inactive`):
- Darker bg, dim border, 55% opacity. has-note/has-data borders preserved desaturated.
- Fully interactive — click, dblclick, p-lock all work normally.

**Keyboard shortcut**: `Shift+1` through `Shift+4` jump directly to pages 1–4, including inactive pages. (Plain `1–8` toggle mute.)

**Step highlight**: clock callback converts absolute step index to visible cell index. Off-page → `highlightStep(-1)`.

**Step numbers in grid**: cells always show absolute step number (e.g. page 2 shows 17–32).

**Extending:**
- **Step page nav**: `Sequencer.pageOffset` exists; add prev/next page buttons to StepGrid.
- **More tracks**: click TRACKS + in the transport bar (max 12). `Project.setTrackCount(n)` handles it at runtime.
- **New machine**: extend `Machine.js`, add to `MACHINES` map in `Track.js`.
- **New condition**: add condition type to `Condition.js`.
- **FX block**: replace placeholder GainNode in `AudioEngine.js` with a real FX graph.
- **MIDI**: add `MIDIMachine.js` and a `MIDIEngine.js` alongside `AudioEngine.js`.
- **More LFO destinations**: add cases to `Track._resolveAudioParam`.
- **New hidden param**: add `hidden: true` to `getParamList()`, render manually in the desired tab.
