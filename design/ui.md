# UI

## SynthPanel Tab Overview

The panel header has two zones in a single row:

### Voice Tab Bar (left, amber)

| Tab | Content |
|---|---|
| MACHINE | Search input + grouped grid (Drums / Melodic / Sampler) of all machine types; click to swap machine on the selected track |
| SOUNDS | Sound library: save/load named snapshots (machine + signal chain). Tag filter chips + scrollable list. |
| SCALES | Scale dropdown + root note picker (12 buttons) + chromatic preview strip |
| TRIG | Note display, REMOVE NOTE, RESET TRIG, condition/chance/length/nudge/detune/tone knobs. NUDGE is only shown when a step is selected. QUANTIZE knob (0–100%) is shown when no step is selected. |
| SYNTH | Machine params — varies by machine type. Detune is hidden here (moved to TRIG). Rendered by a machine-specific panel from `js/ui/panels/`. |
| FILTER | Single row: type dropdown + cutoff/res/gain/env knobs (left) + FilterViz (centre) + right column with compact filter ADSR above base HPF/LPF knobs. All p-lockable. |
| AMP | Single row: PAN knob (left, p-lockable + LFO-assignable) + compact amp ADSR (right, canvasH=80, 44px knobs). |
| LFO | LFO sub-selector (LFO 1, LFO 2, …, +) capped at 220px wide, destination dropdown (grouped), speed/depth/waveform knobs |
| MIXER | All-tracks mixer island: one strip per track showing Level, DLY wet, CRUSH wet, REV wet, and DJ Filter knobs. Clicking a strip selects that track. |

### Oscilloscope Strip (centre of header, always visible)

A `<canvas class="oscilloscope">` sits between the tab bar and the FX block, filling all remaining horizontal space via `flex: 1`.

- Taps `AudioEngine.analyser` — an `AnalyserNode` connected in parallel from `masterGain` (does not alter the audio path).
- Rendered by `js/ui/Oscilloscope.js`: `requestAnimationFrame` loop, reads `fftSize=2048` float time-domain buffer.
- Zero-crossing trigger: scans for the first upward zero crossing before plotting, so the waveform stays locked and stable.
- Canvas pixel width tracks its CSS layout width via `ResizeObserver` so drawing is never stretched.
- Amber (`#e8a020`) waveform on near-black background to match the app palette.

### FX Block (right side of header, always visible, teal)

Three stacked toggle units — DLY / CRUSH / REV — sit in `.fx-bar` on the right, separated by a left border. See [`fx.md`](fx.md) for full detail.

### P-Lock Knob Pattern

When a step is selected, knobs in SYNTH/FILTER/AMP write to `step.plocks` instead of track params.
Knobs show a p-lock indicator (blue label) when a step override is active.

`onChange` writes value silently (no emit) — prevents panel rebuild mid-drag killing the interaction.
`onRelease` emits `stepChanged` — updates the step grid dot after drag ends.

**FilterViz refresh pattern**: all knobs in the FILTER tab call `mainViz.refresh()` in both
`onChange` (live animation while dragging) and `onRelease`.

---

## Mixer Tab

A global overview tab showing all tracks simultaneously (8–12). Each strip contains:

| Control | What it drives |
|---|---|
| LEVEL | `track.machine.getParam('output.level')` — same AudioParam as the Level knob in the SYNTH tab. |
| DLY / CRUSH / REV | Each FX's `*.wet` param (0–1). Same AudioParam as the knobs in the FX tabs. |
| DJ FILT | `track.djFilter` (−1 to +1). See `audio-signal-chain.md` → DJ Filter section. |

Clicking a strip (not a knob) selects that track. Selected strip is amber-highlighted.

The LEVEL, DLY, CRUSH, and REV knobs write directly to the live AudioParam — no p-locking (this is a performance mixer, not a step sequencer view).

---

## Transport Controls

### Track Count Control

A **TRACKS −** / **+** control sits in the transport bar.
- Default: 8 tracks. Range: 1–12 (min/max enforced by `Project.setTrackCount()`).
- Adding a track appends a fresh default `Track` instance.
- Removing a track pops the last track (stops its sequencer). If the selected track is removed, selection clamps to the new last track.
- Saved to JSON as `trackCount`; restored on import.

### Clear / Reset Buttons

| Button | Scope | What it clears |
|---|---|---|
| CLR NOTES | Selected track | Steps only (active, note, vel, length, plocks, condition) |
| CLR TRACK | Selected track | Full reset: notes + machine to synth defaults + filter + envelope + pan + LFOs reset to 1 |
| CLR NOTES ALL | All tracks | Steps only on all tracks |
| CLR ALL | All tracks | Full reset on all tracks |

`Track.clearNotes()` and `Track.resetTrack()` are the underlying methods.
`resetTrack()` tears down all LFOs (stop + clearDestination) and re-adds one clean LFO.

### Global Tape Recorder

A **TAPE** button sits next to REC in the transport bar.

**Behaviour:**
- Clicking **⏺ TAPE** while stopped starts recording. The button turns green and pulses (`#btn-tape.taping`).
- Clicking **⏹ STOP TAPE** while recording stops capture, then immediately opens the filename prompt modal.
- After confirming the filename, a `.webm` (or `.ogg`) audio file is downloaded.

**Implementation:**
- `js/core/GlobalRecorder.js` — owns a `MediaStreamDestinationNode` tapped from `masterGain` in parallel (does not interrupt audio). Uses `MediaRecorder` with `audio/webm;codecs=opus` (falls back to `/webm`, `/ogg`).
- `recorder.start()` — begins capture, collects 100 ms chunks.
- `recorder.stop()` — returns `Promise<Blob>`.
- `recorder.save(filename)` — triggers browser download with the correct extension.

**Signal tap:** `masterGain → MediaStreamDestinationNode` (parallel, does not modify the main chain).

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
- `_applyScale()` adds/removes `.scale-blocked` CSS class on every key element. Called on `scaleChanged` and `trackSelected` events.
- The sequencer does **not** filter notes — steps already programmed with out-of-scale notes still play.

**UI (SCALES tab):** Scale dropdown (160 px wide, searchable) + 12-button root picker displayed side by side. A chromatic strip below shows which pitch classes are active in the current scale/root combination. Below the preview strip, a **KEYBOARD FOLD** toggle enables folded mode.

**Keyboard layout (Swedish physical layout):**
- Bottom row: `a s d f g h j k l ö ä '` (12 keys)
- Top row:    `q w e r t y u i o p å ¨` (12 keys)
- Chromatic mode: bottom row → white keys in order; top row → black keys in order.
- Folded mode: bottom row → in-scale notes 0–11 ascending; top row → same notes +2 octaves.
- `AppState.keyFolding` (boolean) — global fold state, toggled from the SCALES tab, broadcast via `keyFoldingChanged` event.

---

## Detune (TRIG Tab)

`osc.detune` has been moved out of the SYNTH tab UI. It is:
- **Hidden** in `SynthMachine.getParamList()` via `hidden: true` flag
- Rendered as a **DETUNE knob in the TRIG tab** (visible only when the machine supports `osc.detune`)
- P-lockable from the TRIG tab: writes `osc.detune` to `step.plocks`
- **LFO-assignable**: appears under "Trig" group in LFO destination dropdown

---

## LFO Destination Groups

> Full LFO implementation detail — depthScale math, FM split-gain topology, JS-only destinations, lifecycle, and extension guide — is in [`js/signal/LFO.md`](../js/signal/LFO.md).

`Track.getAssignableParams()` returns grouped destinations for the LFO dropdown:

| Group | Params |
|---|---|
| Trig | Detune (`osc.detune`) — only if machine supports it |
| Synth / Machine | Machine params marked `modulatable: true` (excluding detune) |
| Filter | `filter.cutoff`, `filter.resonance`, `filter.slope`, `base.lpf`, `base.hpf` |
| Amp | `amp.pan` |

`Track._resolveAudioParam(path)` handles `amp.pan` directly (returns `pannerNode.pan`),
then delegates to `machine.resolveAudioParam` then `filter.resolveAudioParam`.

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
