# UI

## SynthPanel Tab Overview

The panel header has two zones in a single row:

### Voice Tab Bar (left, amber)

| Tab | Content |
|---|---|
| MACHINE | Search input + grouped grid (Drums / Melodic / Sampler) of all machine types; click to swap machine on the selected track |
| SOUNDS | Sound library: save/load named snapshots (machine + signal chain). Tag filter chips + scrollable list. |
| SCALES | Scale dropdown + root note picker (12 buttons) + chromatic preview strip |
| TRIG | Note display, REMOVE NOTE, RESET TRIG, condition/chance/length/nudge/detune/tone knobs. NUDGE is only shown when a step is selected. QUANTIZE knob (0–100%), **NOTE FOLLOW** dropdown, and **FLW DLY** knob (0–500ms) are shown when no step is selected. |
| SYNTH | Machine params — varies by machine type. Detune is hidden here (moved to TRIG). Rendered by a machine-specific panel from `js/ui/panels/`. |
| ARP | Per-track arpeggiator. ON/OFF toggle + mode selector (Chord / Manual / Random / Input). Input mode is keyboard-driven + recordable. See Arpeggiator section below. |
| FILTER | Single row: type dropdown + cutoff/res/gain/env knobs (left) + FilterViz (centre) + right column with compact filter ADSR above base HPF/LPF knobs. All p-lockable. |
| AMP | Single row: PAN knob (left, p-lockable + LFO-assignable) + compact amp ADSR (right, canvasH=80, 44px knobs). Each A/D/R knob has a small MS/BPM tag for per-stage tempo-sync (BPM stage shows e.g. "1/8"; canvas plots resolved seconds). |
| LFO | LFO sub-selector (LFO 1, LFO 2, …, +) capped at 220px wide, destination dropdown (grouped), waveform/trig, unified RATE knob (click center HZ↔BPM), depth/phase/fade knobs |
| MIDI | Per-track MIDI In: input port dropdown, channel filter (All / Ch 1–16), CC→param mapping table (CC# + target param dropdown, + Add CC / × remove). |
| MIXER | All-tracks mixer island: one strip per track showing Level, DLY wet, CRUSH wet, REV wet, and DJ Filter knobs. Clicking a strip selects that track. |
| DECK | DJ crossfade between two decks (Project instances). Two symmetric deck columns (A/B) with a constant-power crossfader between them. Per deck: LOAD song, CONTROL (point editing UI at this deck), SILENCE (mute deck bus), UNLOAD (free CPU). See Deck Tab section below. |

### Oscilloscope Strip (centre of header, always visible)

A `<canvas class="oscilloscope">` sits between the tab bar and the FX block, filling all remaining horizontal space via `flex: 1`.

- Taps `AudioEngine.analyser` — an `AnalyserNode` connected in parallel from `masterGain` (does not alter the audio path).
- Rendered by `js/ui/Oscilloscope.js`: `requestAnimationFrame` loop, reads `fftSize=2048` float time-domain buffer.
- Zero-crossing trigger: scans for the first upward zero crossing before plotting, so the waveform stays locked and stable.
- Canvas pixel width tracks its CSS layout width via `ResizeObserver` so drawing is never stretched.
- Amber (`#e8a020`) waveform on near-black background to match the app palette.

### FX Block (right side of header, always visible, teal)

Three stacked toggle units — DLY / CRUSH / REV — sit in `.fx-bar` on the right, separated by a left border. See [`fx.md`](fx.md) for full detail.

### Clipboard Block (rightmost in header)

A `.clip-bar` with two buttons — **COPY** and **PASTE** — sits to the right of the FX block.

Behaviour is context-sensitive based on whether a step is selected:

| Context | COPY | PASTE |
|---|---|---|
| Step selected | Copies step data: voices, chance, condition, retrigger, plocks | Pastes copied step data into the currently selected step |
| No step selected | Copies machine + filter + envelope + FX + LFOs of the selected track | Pastes machine config onto the current track (swaps machine type, restores all params) |

The PASTE button shows an amber highlight when the clipboard contains data. The clipboard persists across tab and track switches within the session.

### P-Lock Knob Pattern

When a step is selected, knobs in SYNTH/FILTER/AMP write to `step.plocks` instead of track params.
Knobs show a p-lock indicator (blue label) when a step override is active.

`onChange` writes value silently (no emit) — prevents panel rebuild mid-drag killing the interaction.
`onRelease` emits `stepChanged` — updates the step grid dot after drag ends.

**Tab p-lock indicators**: when the selected step has any p-lock, the tabs that own those
params light up with a blue dot (`.tab-btn.has-plock` / `.fx-toggle-wrap.has-plock`), so you can
see at a glance which tabs hold per-step overrides. `SynthPanel._tabForPLockPath(path)` maps a
p-lock path → tab key (`filter.*`/`fenv.*`/base → FILTER; `env.*`/`amp.pan` → AMP; `arp.*` → ARP;
`lfo.*` → LFO; `delay.`/`crush.`/`reverb.` → the FX toggles; `trig.tone`/`osc.detune` → TRIG;
everything else → SYNTH). `_renderPLockTabIndicators()` refreshes on render + `stepSelected` +
`stepChanged`.

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

## Deck Tab (DJ crossfade)

A two-deck DJ layer. The app runs **two independent `Project` instances** ("deck A"
and "deck B") that share the one `AudioEngine` and the one `Clock` — both decks play
at the same BPM (**beatmatch**; a loaded song's saved BPM is discarded). Owned by
`js/state/DeckManager.js`; the `DeckPanel` (`js/ui/panels/DeckPanel.js`) is its UI.

**Audio routing** — each deck's tracks funnel into that deck's `Project.busGain`,
which feeds the shared master FX bus. The crossfader rides the two bus gains. See
`audio-signal-chain.md` → Deck Buses & Crossfader.

**Layout** — deck A column (left) · crossfader (centre) · deck B column (right).
Per-deck buttons:

| Button | Action |
|---|---|
| LOAD | File picker → `DeckManager.loadFile(id, file)`. Loads a project JSON into that deck, beatmatched. Plays silently in the background until faded toward. Confirms first only if replacing an audible deck. |
| CONTROL | `DeckManager.setControl(id)` — points the **entire editing UI** (track row, panels, step grid, keyboard) at that deck. `AppState.project` is a getter that returns the controlled deck's project, so on control switch index.html re-renders everything. Independent of the fader. **Disabled / no-op for an unloaded deck** (`setControl` returns early if `!_loaded[id]`) so control never lands on a 0-track deck. |
| SILENCE | `DeckManager.setSilenced(id, on)` — multiplies that deck's bus gain by 0, independent of the fader. |
| UNLOAD | `DeckManager.unload(id)` — disposes every track (frees CPU) and resets the deck to **empty (0 tracks)**. Disabled for the last loaded deck (nothing would be left to control). If the controlled deck is unloaded, control switches to the surviving deck first. |

**Crossfader** — horizontal slider, 0 = full deck A (left), 1 = full deck B (right).
Constant-power law: `gainA = cos(x·π/2)`, `gainB = sin(x·π/2)` — perceived loudness
stays roughly constant, no centre dip. Readout shows the A/B percentage split.

**Deck states** (shown as a chip in each column header): EMPTY (unloaded, 0 tracks),
CUED (loaded but inaudible — fader away / silenced), PLAYING (loaded + audible),
SILENCED.

**Filename** — each column shows the loaded file's name (`DeckManager.name(id)`,
captured from `File.name` on LOAD and from the IMPORT button for the controlled
deck). Deck A boots with none → "(unnamed)"; an empty deck shows "—".

**Workflow** — fade A→B, UNLOAD A to free resources, LOAD the next song into the
now-free deck A, fade back. Endless mixing into new songs. Deck B boots empty.

**Not persisted** — the deck split is a live performance layer; only the controlled
deck's own project is what EXPORT/IMPORT and localStorage save touch.

---

## Transport Controls

### PLAY / STOP ALL / REC

**PLAY** toggles the transport (`Project.start()` / `stop()`).

**STOP ALL** (panic, sits between PLAY and REC) is a hard reset of the *audible* state:
`Project.silence()` stops the transport and then hard-kills every voice on every track —
`Track.silence()` → `VoicePool.silence()` → each `VoiceSlot.silence()` calls the machine's
`noteOff` (stops oscillators / sample sources where supported) and `Envelope.silence()`
(cancels all scheduled gain automation and slams the amp gate to 0 over a 5 ms anti-click
ramp). It also releases any live-input arp and exits record mode, and emits a `panic` event so
the Keyboard drops held-key state + highlights. Use it when a sound rings out, loops, or sticks.
Silencing is non-destructive to future notes — the next `noteOn`/`scheduleNote` reopens the gate.

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
| Amp | `amp.level` (tremolo VCA), `amp.pan` |

`Track._resolveAudioParam(path)` handles `amp.level` (returns `tremGain.gain`) and `amp.pan`
(returns `pannerNode.pan`) directly, then delegates to `machine.resolveAudioParam` then
`filter.resolveAudioParam`. `amp.level` is the dedicated post-envelope tremolo VCA — the
per-note ADSR owns `ampGain` with absolute automation, so the LFO rides `tremGain` (base 1.0)
instead; pair with the LFO Bias knob for one-sided/classic tremolo.

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
| `panic` | `{}` | Keyboard (drop held-key state). Emitted by the STOP ALL button. |

---

## Arpeggiator Tab (ARP)

Per-track arpeggiator UI. Lives at `js/ui/panels/ArpPanel.js`.

**Header row** — always visible:
- **ARP ON / ARP OFF** toggle button (amber when on)
- **Mode selector** — CHORD / MANUAL / RANDOM / INPUT buttons

**Chord mode controls:**
| Control | Description |
|---|---|
| Chord selector | Drop-down of 11 chord types (same set as ChordMachine) |
| Pattern | Up / Down / UpDown / Rand buttons |
| RATE knob (unified) | Note gap. **Click knob center toggles MS↔BPM** (mode shown in body). MS: ms gap (1–2000ms). BPM: sweeps 1/32 grid (`bpmCount32`), shift-drag/scroll snaps to musical divisions. P-lockable + LFO-able (see below). |
| GATE knob (unified) | Note-on length. **Click knob center toggles MS↔BPM** (`gateSyncMode`, independent of RATE's sync). MS: ms (0 = LEGATO, 90% of gap). BPM: 1/32 count (`gateBpmCount32`), always an explicit length — no LEGATO. P-lockable + LFO-able. |
| VARIANCE knob | 0–100%: widens gaps on middle notes by ±50% × variance. P-lockable + LFO-able. |

**P-lock + LFO on arp RATE / GATE / VARIANCE:**
The RATE, GATE and VARIANCE knobs are p-lockable per step and assignable as LFO destinations, via three virtual params: `arp.rate`, `arp.gate`, `arp.variance` (see `Arpeggiator.modParamDescriptors()`). `arp.rate` modulates **in the current sync mode** — the count32 in BPM mode, the ms gap in MS mode (toggling MS↔BPM clears a rate p-lock on the selected step, since the unit changes). `arp.gate` works the same way against its **own** sync (`gateSyncMode`): it maps to `gate` (ms) or `gateBpmCount32` (BPM count), and toggling MS↔BPM clears any gate p-lock on the selected step. These are **JS-only** params (arp timing is read once at build time, not a Web Audio `AudioParam`): p-locks apply exactly (set before `buildEvents`, restored after, via the Sequencer's `js`-mode dispatch on `track.arp`); LFOs are **sample-and-hold** — sampled once per step-fire in `Sequencer._fireStep` (step modes) or once per cycle in `LiveArp` (input mode), like `trig.tone`. A fast LFO therefore steps the value per trigger rather than sweeping it continuously. The `Arp` group only appears in the LFO destination dropdown while the arp is enabled. GATE p-lock applies to chord/input modes (random mode's separate `rGate` stays live-only; in BPM gate mode it shares `gateBpmCount32`).

**Manual mode controls:**
A scrollable list of steps. Each step has:
| Control | Description |
|---|---|
| NOTE / +/− knob | Semitone offset from root (−24 to +24) |
| RATE knob (unified) | Time before the next note. **Click knob center toggles MS↔BPM** for this step. BPM: 1/32-count, shift-snaps. |
| GATE knob | Note-on length in ms; 0 = "STEP" (inherit base step length) |
| × button | Remove this step (hidden if only one remains) |

`+ ADD STEP` button appends a new step at the bottom.

**Random mode controls:**
| Control | Description |
|---|---|
| NOTES knob | Number of notes per arp cycle (2–8) |
| RANGE ± knob | Semitone spread ±N around root (1–24) |
| RATE knob (unified) | Same unified MS/BPM rate knob as Chord mode |
| GATE knob (unified) | Note-on length via the separate `rGate` field (live-only, not p-lockable). MS 0 = LEGATO; BPM mode shares `gateBpmCount32`. |
| VARIANCE knob | Timing jitter applied to all gaps |

**Input mode controls (live keyboard-driven):**
| Control | Description |
|---|---|
| Hint text | Explains the live model: hold keys to arp them; RECORD captures the output |
| Pattern | Up / Down / UpDown / Rand buttons (same as Chord) |
| RATE knob (unified) | Same unified MS/BPM rate knob as Chord mode |
| GATE knob (unified) | Same unified MS/BPM gate knob as Chord mode; MS 0 = LEGATO (90% of gap) |
| VARIANCE knob | Timing jitter on middle notes |

There is **no chord selector** — the keys you hold on the keyboard *are* the chord, played at their absolute pitches. The arp does **not** fan steps in input mode: `buildEvents()` returns `[]`, and `Sequencer._fireStep()` detects input mode (`arpFiresSteps = arp.enabled && mode !== 'input'`) and fires each step's voices through the **normal** (non-arp) path. Instead `Keyboard._noteOn/_noteOff` route held keys to `track.liveArp` (`js/signal/LiveArp.js`), a free-running scheduler that cycles the held set on the BPM grid (works with the transport stopped). When **RECORD** is on and the transport is playing, each fired arp note is printed into the step it lands on via `Keyboard.captureArpNote()`. The whole cycle is scheduled in one synchronous burst, so capture maps each note by its **scheduled time** (`Sequencer.stepIndexAtTime()`) — projecting forward from the last scheduled tick to the absolute step + sub-step nudge — rather than by "now" (which would pile the whole chord onto a single step). Because input mode fires steps normally, those recorded notes play back as plain notes on the next pass (no re-arping — `random`/`variance` are baked in, not re-rolled). Track switching releases all held live arps.

**Timing implementation:**
The arpeggiator intercepts `_fireStep()` in `Sequencer.js`. When `arp.enabled` is true (and mode ≠ input), `arp.buildEvents()` is called with the root note and step timing. It returns a flat array of `{ note, velocity, time, offTime }` events, each scheduled independently using `AudioContext.currentTime` — no `setInterval` or `setTimeout`. Notes can naturally overlap when gate > gap, producing polyphony via the voice pool. Input mode uses the same `_spaceNotes`/`_applyPattern` logic via `arp.buildInputCycle()`, scheduled by `LiveArp` instead of the sequencer.

**BPM sync utility:**
`js/util/BpmSync.js` — shared by `DelayFX`, `ReverbFX`, `LFO`, and `Arpeggiator`. Unified model: integer 1/32-note counts (`count32ToSeconds`, `MUSICAL_SNAP_32`, `formatCount32`, `divToCount32`). Legacy `DIV_QN`/`SYNC_DIVISIONS`/`divToSeconds` kept for project-load back-compat only.
