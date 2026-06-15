# Per-Track FX Chain

Four effects sit in series after the stereo panner, before the global fxBus. The
chain **order is user-reorderable** per track via the FX pipeline pane (default
**Delay → Crush → Chorus → Reverb**). The order is owned by `Track._fxOrder` and
applied by `Track.setFXOrder()` / `_rewireFXChain()` — see
`design/audio-signal-chain.md` → *Reorderable FX pipeline* for the graph
mechanics, persistence, and back-compat.

Each effect has a **wet** knob (0–1) that blends parallel dry+wet. At wet=0 the effect is fully bypassed perceptually (dryGain=1, wetGain=0).

---

## DelayFX (`js/signal/DelayFX.js`)
Stereo feedback delay.
- **Unified sync knob** (`delay.sync`, `type: 'sync'`): a single mode-aware knob. `delay.syncMode` (`ms` | `bpm`) selects whether delay time is set manually or locked to tempo — **toggle by clicking the knob center** (the body shows the current mode, `MS`/`BPM`; no separate buttons). See `design/audio-signal-chain.md` → *Unified Sync-Knob Model* for the app-wide model and the KnobWidget `setRange`/`snapPoints`/`onCenterClick` mechanism.
  - `ms` mode: knob drives `delay.time` (1ms–2s), LFO-assignable and p-lockable.
  - `bpm` mode: knob sweeps `delay.bpmCount32` — an integer count of 1/32 notes (1–64). Display shows the nearest division + 1/32 remainder (e.g. `1/8 + 1/32`). **Shift snaps to musical divisions** (1/16, 1/8, dotted-1/8, 1/4 …). **P-lockable** (`plockMode: 'js'` — Sequencer setParam/restore). Time recalculates automatically when BPM changes.
  - LFO on `delay.time` is **always continuous/native** (modulates the seconds AudioParam) regardless of mode — no per-tick JS quantisation. `lfoMin/lfoMax` deliberately narrowed to 0.02–0.6s (not the full 0.001–2.0 knob range): a full-range sweep flanges/self-oscillates the delay line. The knob still reaches the full range; only LFO depth is windowed.
- `delay.feedback` (0–95%) and `delay.wet` (0–1) are LFO-assignable and p-lockable in both modes.
- Internal: `DelayNode` + feedback `GainNode` loop. Max delay 2s.
- `Track.onBpmChanged(bpm)` propagates BPM changes from `Project.setBPM` → all track FX.

## BitcrushFX (`js/signal/BitcrushFX.js`)
Bit-depth reduction + rate smear.
- `crush.bits` (1–16), `crush.rate` (1%–100% of nyquist), `crush.wet` (0–1).
- `crush.bits` is not modulatable (rebuilds WaveShaperNode curve — JS-only).
- `crush.rate` and `crush.wet` are LFO-assignable and p-lockable.
- True sample-and-hold requires AudioWorklet; `crush.rate` approximates downsampling via a pre-filter cutoff.

## ReverbFX (`js/signal/ReverbFX.js`)
Convolution reverb with a synthesised exponential-decay noise IR.
- `reverb.decay` (0.1–8s) rebuilds the IR on change — track-level only, not p-lockable.
- `reverb.syncMode` (`ms` | `bpm`): selects whether pre-delay is set manually or locked to tempo.
  - `ms` mode: `reverb.predelay` knob (0–500ms), rebuilds IR on change — track-level only.
  - `bpm` mode: knob sweeps `reverb.bpmCount32` — an integer count of 1/32 notes (1–32). Same unified click-center sync knob as Delay (`type: 'sync'` via `FXPanel._renderSync`); display shows the nearest division + 1/32 remainder, shift snaps to musical divisions. Track-level in both modes (IR rebuild ⇒ not modulatable). Pre-delay recalculates automatically when BPM changes. Legacy `reverb.bpmDiv` strings auto-convert on load.
- `reverb.damp` (200–20kHz LP on wet) and `reverb.wet` (0–1) are LFO-assignable and p-lockable.

---

## UI

**The FX pipeline pane is the single home for every effect** — there are no
longer dedicated DELAY/CRUSH/CHORUS/REVERB tabs, and the per-FX header on/off
toggles are gone. Their old job (open + bypass + edit a specific effect) now all
lives inside the pane.

### Header FX bar (`SynthPanel._buildShell`)

`.fx-bar` on the right of the SynthPanel header holds, left to right:
- The **FX** button (`.fx-pipe-btn`) — opens the FX pipeline pane (`activeTab === 'fx'`). Teal accent (`#7ec8c8`).
- A **chain mini-outline** (`.fx-chain-outline`, `SynthPanel._renderFXChainOutline`) — a read-at-a-glance row of the selected track's FX as glyph icons **in chain order**. Bypassed (`!enabled`) blocks render dimmed (`.fx-chain-icon.off`). Single-clicking an icon sets `state.fxSelectedBlockId` and opens the FX pane with that block selected; **double-clicking toggles that block's ON/OFF in place** (the single-click navigation is deferred ~220ms and cancelled when a second click lands, since navigating re-renders the header and breaks native `dblclick` pairing). Rebuilt on every `render()`, on `toggleFxBind()`, and on order/enable changes.

The header p-lock indicator lights the **FX** button (`data-fxtab='fx'`) for ANY FX param-lock — base four (`delay.`/`crush.`/`chorus.`/`reverb.`) and added instances (`fxN.`) alike (`_tabForPLockPath`).

### FX pipeline pane (`js/ui/panels/FXPipelinePanel.js`)

A pure view over `Track.getFXOrder()` / `setFXOrder()` plus the inline param editor and presets:

- **Right: snaking signal path.** `INPUT → [all blocks in chain order] → OUTPUT`, rendered as draggable block tiles separated by `→` arrows. CSS `flex-wrap` makes the row snake as tiles wrap. The path shows every block **currently in the chain** (a removed base block leaves the path). Drag a block onto another to insert it before that block; drop on empty path area to move it last. Each tile has an **ON/OFF** toggle (bypass; dims via `.fxpipe-block.off`), an **FX-bind dropdown** (None / FX 1–4 — see *FX binds* below), and an **✕** to remove. Clicking **any** tile — base or added — selects it for the **inline param editor** below the path (generic `FXPanel` over the block's params, namespaced for instances). The base four render identically to how their old dedicated tab did (same `FXPanel`, bare paths).
- **Left tray.** **+ ADD FX** dropdown (adds an instance of any type — Filter / Delay / Crush / Chorus / Reverb / Distortion / Compressor / Normalizer — and offers any detached base block as "(re-add)"); **SAVE** (names + tags the current chain) and **LOAD** (opens the FX-preset manager popup) wired to `FXLibrary`; and a **BIN** drop target (`.fxpipe-bin`, pinned at the bottom) — drag a tile onto it to remove that block.

A block's ON/OFF **is its `enabled` flag** — disabling bypasses the FX audibly without unplugging it from the graph (chain blocks stay wired; see `_rewireFXChain`). Toggling here emits `fxEnabledChanged`, which `SynthPanel` listens for to refresh the header chain mini-outline.

**Per-card manual.** Clicking a selected tile again **deselects** it (`_selectedId` toggles to `null`). The 📖 manual key (`SynthPanel.openManual`) keys off the selection on the FX tab: a selected block → that effect's own `MANUAL_CONTENT[type]` page; none selected → the `fx` pane overview. `ManualOverlay.show(tab, machineType, fxType)` resolves this; both modes show a `.manual-tip` explaining the select/deselect flow, and the empty param area shows the same hint.

**Removing a block** (✕ or BIN) → `Track.removeFX(id)`. Added instances (`fxN`) are fully torn down (detached, p-locks + LFOs + bind stripped, deleted). Base blocks (delay/crush/chorus/reverb) are only **detached from the chain order** — they stay registered with their bare paths (back-compat for existing projects / p-locks / presets) and reappear in **+ ADD FX** as "(re-add)" (`Track.reattachBaseFX`). `setFXOrder` therefore no longer auto-appends omitted base blocks (it still auto-appends omitted added instances so none is orphaned in the graph).

### FX binds (the four global FX keybinds)

Four generic FX keybinds — `Settings.keybinds.fx1..fx4` (default `KeyC` / `KeyV` / `KeyB` / `KeyN`, rebindable in the Settings pane as "FX bind 1–4"). Each **track** maps each bind to one of its FX blocks via the per-tile dropdown (`Track._fxBinds`: `{1..4 → blockId|null}`, persisted in `toJSON().fxBinds`). Pressing a bind key → `index.html` keydown → `SynthPanel.toggleFxBind(n)` → `Track.toggleFXBind(n)`, which flips the assigned block's `enabled` on the **selected track only**. So the same key drives a different effect per track. Invariant: a block holds at most one bind and a bind at most one block (`setFXBind` steals on conflict); removing a block clears its bind; stale binds (pointing at a block no longer in the chain) are dropped on load.

This replaced the old per-effect binds (`fxCrush`/`fxReverb`/`fxDelay`/`fxChorus`), which only ever toggled a single hard-coded base block. `Settings._load` migrates a user's old rebound keys to `fx1..fx4` and drops the stale keys.

### FX presets (`js/state/FXLibrary.js`)

A **global**, track-agnostic preset store (localStorage `webtakt_fx_presets`, no factory presets). A preset is `{ name, tags, createdAt, fx }` where `fx` is the FX subset of a track — `{ delayFX, bitcrushFX, chorusFX, reverbFX, fxOrder, fxInstances }` — produced by `Track.exportFXPreset()` and applied by `Track.applyFXPreset()` (restores base-four params, rebuilds instances via `_restoreFXInstances`, then `setFXOrder` — **in that order**, so `fxN` ids resolve). `FXLibrary` mirrors `SoundLibrary`: `save(name, tags, track)` / `load(id, track)` / `delete` / `rename` / `setTags` / `allTags`.

**FX-preset manager popup (`js/ui/panels/FXPresetModal.js`).** LOAD opens a SOUNDS-style overlay (self-contained, built on demand like `ManualOverlay`; one instance kept on `state._fxPresetModal`). Tag-filter chips + one card per preset (name · tags · block-count badge; ▶ audition / APPLY / ✎ edit / ✕ delete). A **non-scrollable** audition bar pins **▶ PLAY DRY** at the top. Auditioning routes through `Track.auditionFXPreset(presetFx, {dry})`: snapshot the current FX (`exportFXPreset`), apply the preset (or bypass every block for dry), fire a one-shot C4 on the current machine, then restore the snapshot on a timer (`_auditionRestoreTimer`). Lets the user A/B dry ↔ pipeline ↔ dry without committing; APPLY commits via `FXLibrary.load`.

Saved **sounds** also carry `fxOrder` + `fxInstances` (SoundLibrary), so loading a sound restores its FX chain too — the second half of "presets".

### New FX types (addable instances)

| Type | File | Params |
|---|---|---|
| Distortion | `DistortionFX.js` | `dist.drive` (1–50), `dist.tone` (Hz LP), `dist.wet`. tanh waveshaper w/ makeup, 2× oversample. |
| Compressor | `CompressorFX.js` | `comp.threshold` / `ratio` / `attack` / `release` / `makeup` / `wet`. DynamicsCompressorNode + makeup gain; wet=1 fully replaces dry (parallel comp below 1). |
| ~~Phaser~~ (PARKED) | `PhaserFX.js` | `phaser.rate` / `depth` / `feedback` / `wet`. 6 resonant allpass stages + feedback. **Removed from the Add-FX menu** — too subtle to be useful on the project's material; class kept for a future revisit (would need a stronger topology). Old saves with a `phaser` instance load fine (unknown type skipped). |
| Filter (FX) | `FXFilter.js` | `fxfilt.type` (LP/HP/BP/notch), `fxfilt.cutoff`, `fxfilt.resonance`. Single in-line biquad, **post-sum / paraphonic** — distinct from the per-voice poly `Filter`. `setEnabled(false)` routes dry-through (transparent). |
| Normalizer | `NormalizerFX.js` | `norm.target` / `norm.range` / `norm.speed`. **Live auto-gain leveller:** an `AnalyserNode` taps the signal; an rAF loop drives a **decaying peak follower** (instant attack, slow release — so silence between hits doesn't drag the measurement to zero, the trap that made a plain windowed RMS always demand full boost) and smooths an output `GainNode` toward `target / followedPeak`. **`target` is a single bidirectional knob** — below the signal's level it attenuates, above it boosts. `range` scales how far from unity it goes (0 = transparent); `speed` sets the smoothing. A module-level `MAX_GAIN` hard-clamps boost, and the follower is seeded to `target` on enable + uses a 0.02 noise floor so the first transient doesn't spike to the clamp (which distorted the attack). No modulatable AudioParam (the gain is loop-driven); `setEnabled(false)` freezes at unity and stops the loop. |

These (and extra copies of the base four) are added as **`FXInstance`-wrapped** blocks with `fxN.`-namespaced paths — see `design/audio-signal-chain.md` → *Multiple FX instances*.

---

## P-Lock Notes

- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay`, `delay.syncMode`, `reverb.syncMode`, `reverb.bpmCount32` are `modulatable: false` — always track-level. (`delay.bpmCount32` is `modulatable: true` / `plockMode: 'js'` — p-lockable; reverb's count is not, because it rebuilds the IR.)
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.
