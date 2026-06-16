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
- **Left tray.** **+ ADD FX** dropdown (adds an instance of any type — Filter / EQ / Delay / Tape / Chorus / Phaser / AutoPan / RingMod / Reverb / Shimmer / Comb / Crush / Crush+ / Distortion / Gate / Stutter / Width / Compressor / Limiter / Normalizer — and offers any detached base block as "(re-add)"); **SAVE** (names + tags the current chain) and **LOAD** (opens the FX-preset manager popup) wired to `FXLibrary`; and a **BIN** drop target (`.fxpipe-bin`, pinned at the bottom) — drag a tile onto it to remove that block.

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
| Phaser | `PhaserFX.js` | `phaser.rate` / `depth` / `feedback` / `wet`. **STEREO** now: 6 resonant allpass stages **per channel**, the right cascade's depth tap negated so L/R notches counter-sweep, plus a wider sweep (±1500 Hz vs the old ±650) and hard-panned cascades. Un-parked — the original mono version was too subtle. Old saves with a `phaser` instance now load it instead of skipping. **A short (3 ms) `DelayNode` sits in each feedback path** — without a DelayNode in the cycle Web Audio MUTES the whole loop (the allpass cascade is part of it), so the wet branch produced *exact* silence (wet==dry, "does nothing"). Do not remove it. |
| Filter (FX) | `FXFilter.js` | `fxfilt.type` (LP/HP/BP/notch), `fxfilt.cutoff`, `fxfilt.resonance`. Single in-line biquad, **post-sum / paraphonic** — distinct from the per-voice poly `Filter`. `setEnabled(false)` routes dry-through (transparent). |
| Normalizer | `NormalizerFX.js` | `norm.target` / `norm.range` / `norm.speed`. **Live auto-gain leveller:** an `AnalyserNode` taps the signal; an rAF loop drives a **decaying peak follower** (instant attack, slow release — so silence between hits doesn't drag the measurement to zero, the trap that made a plain windowed RMS always demand full boost) and smooths an output `GainNode` toward `target / followedPeak`. **`target` is a single bidirectional knob** — below the signal's level it attenuates, above it boosts. `range` scales how far from unity it goes (0 = transparent); `speed` sets the smoothing. A module-level `MAX_GAIN` hard-clamps boost, and the follower is seeded to `target` on enable + uses a 0.02 noise floor so the first transient doesn't spike to the clamp (which distorted the attack). No modulatable AudioParam (the gain is loop-driven); `setEnabled(false)` freezes at unity and stops the loop. |
| EQ (3-band) | `EQ3FX.js` | `eq3.lowGain` / `midGain` / `midFreq` / `midQ` / `highGain`. Low-shelf (250 Hz) → peaking bell (tunable freq+Q) → high-shelf (4 kHz) biquads in series, in-line. Bypass flattens all gains to 0 dB. |
| AutoPan | `AutoPanFX.js` | `pan.depth` / `pan.shape` (0=pan↔1=tremolo) / `pan.sync` (Hz↔BPM rate). One sine LFO → a `StereoPanner.pan` (weighted 1−shape) and a tremolo `GainNode` (weighted shape); tremolo rests below unity so the LFO lifts up, not clips. `shape` is js-driven (composite). |
| Gate | `GateFX.js` | `gate.depth` / `gate.smooth` / `gate.sync` (BPM slot size) / `gate.pattern` (16-slot mask). BPM-synced trance-gate: a **lookahead loop** (rAF, timer fallback) schedules `setTargetAtTime` ramps on a gain node at each slot boundary — sample-accurate, tempo-locked. `pattern` renders as a 16-cell toggle grid (new `type:'pattern'` in FXPanel). |
| Width | `WidthFX.js` | `width.amount` (0=mono, 1=unity, 2=wide). Native **mid/side** matrix: M=½(L+R), S=½(L−R)·w, re-encoded L'=M+S, R'=M−S via splitter/merger + summing gains. Bypass snaps width to 1. |
| Limiter | `LimiterFX.js` | `lim.threshold` / `lim.release` / `lim.ceiling`. Brickwall: a `DynamicsCompressorNode` at ratio 20, ~0 attack, hard knee + an output ceiling gain. Distinct from Compressor (this is a safety/loudness tool, always 100% wet). |
| RingMod | `RingModFX.js` | `ring.sync` (Hz↔BPM carrier) / `ring.wet`. Multiplies the signal by a carrier osc — carrier → a `GainNode.gain` resting at 0 that the through-signal passes; low carrier = tremolo, audio-rate = metallic sidebands. |
| Tape | `TapeFX.js` | `tape.sync` (MS↔BPM) / `feedback` / `tone` / `wow` / `drive` / `spread` / `wet`. Dub tape echo: two delay lines with **cross-feedback** (ping-pong) through a shared lowpass (HF-loss on each repeat), wow+flutter LFOs on delayTime, tanh tape saturation in, stereo spread via panners. A new add-only block so the back-compat base `DelayFX` is left untouched. |
| Comb | `CombFX.js` | `comb.freq` (pitch, js-driven 1/freq→delayTime) / `feedback` (sustain, **capped 0.85**) / `damp` / `wet`. Tuned feedback comb / Karplus resonator — delay length = 1/freq makes it ring at that pitch; p-lock `comb.freq` per step for a melodic comb voice. Sustain caps at **0.85** (was 0.9): above ~0.84 the loop ran away into a piercing self-oscillating tone "from nowhere". `resolveAudioParam('comb.freq')` returns **null** (the value is a frequency but the node param is a delay TIME = 1/freq, mapped in `setParam`) so it's a mod/CC target but **not** an LFO target. |
| Shimmer | `ShimmerFX.js` | `shim.decay` / `shimmer` (octave-up layer) / `damp` / `preHP` / `freeze` (off/on) / `wet`. **Feedforward** (NOT recursive through the convolver): the input is pitched up an octave by a **native dual-delay granular shifter** and that copy + the dry copy are sent into the convolver ONCE, so the wash always decays. `shimmer` is the octave-layer send amount. **ROOT-CAUSE FIX (was totally silent live):** the `freeze` path forms a cycle `revIn → convolver → damp → freezeGain → revIn`; Web Audio **mutes any feedback cycle with no `DelayNode`** (a convolver does not count), and the mute is *topological* (the edge exists even at freeze gain 0), so it silenced the convolver and the entire wet tap. Chrome's OFFLINE renderer tolerated it → the test passed while the live app made no sound. A **`_freezeDelay` (20 ms `DelayNode`)** in the freeze path makes the cycle legal everywhere. A **`_wetMakeup` gain (×8)** after the convolver compensates for the normalised noise IR spreading energy thin (raw convolved output was tens of dB down). `freeze` is a SEPARATE bounded hold — gain capped at `FREEZE_MAX=0.85` (never ≥ unity), tapped PRE-makeup, forced to 0 whenever the block is disabled. Do not reintroduce a delay-less loop through the convolver. |
| Crush+ | `Crush2FX.js` | `crush2.bits` / `crush2.downsamp` (sample-and-hold factor) / `crush2.wet`. **Worklet-backed REAL bitcrusher** (`bitcrush-processor.js`): genuine per-sample S&H downsample + bit quantize. Dry/wet is JS gain nodes (parallel dry path); the worklet runs fully wet. This matters: if the worklet node can't construct, the dry path still carries audio — the earlier in-worklet mix meant a dead/missing node silenced the track even when bypassed. **Self-heals load races:** if the module isn't registered yet at construction (`_buildNode()` fails), the block calls `addModule` itself and rebuilds the node on resolve, re-applying enabled state — otherwise a block added before boot's fire-and-forget load finished was stuck dry forever ("only slightly quieter, no crush"). |
| Stutter | `StutterFX.js` | `stut.wet` / `chance` (auto-stutter probability) / `repeats` / `latch` (off/on) / `stut.sync` (BPM slice size). **Worklet-backed beat-repeat** (`stutter-processor.js`): a rolling capture buffer; when latched it loops the most recent tempo-synced slice. Slice length pushed to the worklet as a config message on tempo/division change. Same JS-gain dry/wet as Crush+ (worklet runs fully wet, parallel dry path is the fallback), and the **same `_buildNode()` self-heal** for the load race. Audible only with `chance` > 0 or `latch` p-locked on — at rest the wet path is a transparent passthrough. |

These (and extra copies of the base four) are added as **`FXInstance`-wrapped** blocks with `fxN.`-namespaced paths — see `design/audio-signal-chain.md` → *Multiple FX instances*.

**LFO targeting & js-driven params.** The LFO connects to **AudioParams directly**, so a `modulatable` FX param that has no `resolveAudioParam` (a *composite* / js-driven one such as `pan.shape`, `tape.wow`/`spread`, `gate.depth`/`smooth`, `comb.freq`) is **p-lockable but not an LFO destination**. `Track.getAssignableParams()` therefore filters the LFO dropdown to FX params that actually resolve to an AudioParam, so those never appear as dead targets.

**Worklet FX fallback.** `Crush2FX` / `StutterFX` connect a parallel **dry gain path first**, then try to build their `AudioWorkletNode` (via `_buildNode()`); the worklet (always 100 % wet) feeds a JS `wetGain`. So the dry/wet blend is JS, and if the node can't construct the dry path alone carries full audio. (Do NOT do the dry/wet inside the worklet — a dead node then silences the track even when bypassed.) The modules are registered at boot by `AudioEngine` (`fxWorkletsReady`, alongside the analogue ladder, fire-and-forget). **Load-race self-heal:** if `_buildNode()` fails at construction (a block added before that boot load resolved), the block calls `addModule` itself and rebuilds + re-applies enabled state on resolve. The offline **test** context registers no modules and the self-heal `addModule` rejects there, so both blocks pass audio through their dry path in tests. **Node config:** both use the PROVEN pattern `{ numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2] }` — the same shape as the working `patina-ladder` / `wavetable-sampler` nodes (input/output channel counts are independent; a mono input feeding a stereo output is fine). **ROOT CAUSE of the long-running "Crush+/Stutter do nothing" bug: `disconnect()` must NOT kill the processor.** `Track._rewireFXChain()` calls `block.disconnect()` on EVERY block whenever the chain changes — including immediately after `addFX`. The old `disconnect()` did `port.postMessage('kill')`, which set the processor's `alive=false` so `process()` returned `false` **permanently** → the worklet was dead before it ever ran (no `processorerror`, no diag, just the ducked dry). Split into two methods: **`disconnect()` = audio detach only** (used by rewire), **`destroy()` = kill processor + detach** (called only on real teardown — `removeFX`, `_restoreFXInstances`, `dispose`). `FXInstance.destroy()` forwards to the wrapped block (falls back to `disconnect` for base blocks). **`processorerror` watch:** per spec a processor that throws then outputs silence for life — both blocks keep a `node.onprocessorerror` logger so that failure mode is never invisible again.

**Self-oscillation caps.** Feedback blocks clamp below divergence: `CombFX` caps `comb.feedback` at **0.85** (was 0.9; above ~0.84 it ran away into a piercing tone — the resonant peak gain is ~1/(1−fb)) and trims the wet tap by 0.25 + input by 0.5 to level-match the resonance; `PhaserFX` caps feedback at 0.85; `ShimmerFX` caps freeze feedback at 0.85. `PhaserFX` also keeps its allpass sweep in a positive audible window (centre 1000 ± 850 Hz) with low Q (0.7) so the notches actually move — the old high-Q / through-zero sweep was inaudible — and needs a `DelayNode` in each feedback cycle (a delay-less cycle is muted by Web Audio, which silenced the whole wet path).

---

## P-Lock Notes

- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay`, `delay.syncMode`, `reverb.syncMode`, `reverb.bpmCount32` are `modulatable: false` — always track-level. (`delay.bpmCount32` is `modulatable: true` / `plockMode: 'js'` — p-lockable; reverb's count is not, because it rebuilds the IR.)
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.
