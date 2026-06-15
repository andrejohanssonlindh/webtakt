# Handover: FX Pipeline Customizer

**For:** an implementing agent continuing this feature, or a reviewer.
**Status:** All four steps are **built** (parse-checked). Steps 1+2 are
**user-verified**; Steps 3 (multi-instance) and 4 (presets) are built but should
be browser-verified by the user. A later pass also **unified the editor**: the
dedicated DELAY/CRUSH/CHORUS/REVERB tabs and per-FX header on/off toggles were
removed — every block (base + added) is now edited inline in the FX pane, and the
header shows a clickable **chain mini-outline** instead. See "Editor unification"
below.

This doc is the single source of truth for what exists, how it's wired, what's
left, and the traps. Read it before touching FX code.

### Later pass — removal, FX binds, normalizer (built, browser-verify)

Three follow-ups landed after the unification above:

1. **Normalizer FX** — `js/signal/NormalizerFX.js`, an addable instance. Live
   auto-gain: an `AnalyserNode` taps the signal reaching it; an rAF loop reads
   RMS and smooths a `GainNode` toward `target/RMS` (clamped by `maxGain`, blended
   by `amount`, smoothed by `speed`). Auto-levels whatever reaches it, so a loud
   upstream effect doesn't blow up the level — and it re-adjusts on its own when
   the upstream chain changes. Registered in `FX_TYPES` / `FX_TYPE_LABELS` /
   `TYPE_GLYPH`. No modulatable AudioParam (the gain is loop-driven).
2. **All cards removable + BIN** — base blocks can now leave the chain too.
   `removeFX` detaches a base block from `_fxOrder` but **keeps it registered**
   (bare paths intact for back-compat) and re-addable via `reattachBaseFX`
   (shown in the Add menu as "(re-add)"). Added instances are still fully torn
   down. `setFXOrder` no longer auto-appends omitted base blocks (it still does
   for added instances, so none orphan). `isFXRemovable(id)` now = "in the chain";
   new `isFXBase(id)` distinguishes the permanent four — **audit every old
   `isFXRemovable` call**: places that meant "is an added instance" now need
   `isFXRemovable(id) && !isFXBase(id)` (toJSON/exportFXPreset/copy-paste do).
   The FX pane gained a `.fxpipe-bin` drop target (under SAVE) and the old
   manual-text tray note was removed. The ✕ shows on every tile now.
3. **FX binds (4 generic)** — replaced the four hard-coded per-effect keybinds
   (`fxCrush/fxReverb/fxDelay/fxChorus`) with `fx1..fx4` (same default keys
   C/V/B/N). Each track maps each bind to a block via a per-tile dropdown
   (`Track._fxBinds`, persisted in `toJSON().fxBinds`). The key toggles the
   assigned block on the **selected track only** (`SynthPanel.toggleFxBind` →
   `Track.toggleFXBind`). `Settings._load` migrates old rebinds. See design/fx.md
   → *FX binds*.

---

## The idea (user's words, paraphrased)

A per-track **FX pipeline customizer**: a pane (FX button in the header, left of
CRUSH) showing the per-track effect chain as a snaking `INPUT → … → OUTPUT` path.
The user reorders effects by dragging, toggles each on/off, **adds N instances of
any effect** (incl. brand-new types and a post-sum filter), removes added ones,
and (future) saves/loads pipeline presets. Per track.

The reordering genuinely changes the sound (crush-at-end vs crush-early is a big
difference) — that's the whole point.

---

## Why it was feasible (the key facts)

1. **All FX already share one block interface**: `.inputNode` / `.outputNode` /
   `connect(dest)` / `connectInput(src)` / `disconnect()` / `setEnabled()` /
   `setParam` / `getParam` / `getParamList()` / `resolveAudioParam()` / `toJSON` /
   `fromJSON`. Reordering is pure rewiring.
2. **`disconnect()` on every FX only disconnects its `outputNode`** (verified) —
   internal routing survives a rewire.
3. **The filter is per-voice-slot** (inside VoicePool, before the amp gate) — the
   ghost-note fix. We did NOT move it. The addable "FX filter" is a SEPARATE,
   simpler, post-sum block (`FXFilter`, paraphonic). The poly filter is untouched.
4. **P-lock / LFO / mod-wheel / MIDI-CC route by param PATH**, all funnelling
   through resolvers — so namespacing paths per instance is enough to support
   duplicates without touching the dispatch logic.

---

## What's built — Step 1: data-driven chain (Track.js)

The historical hardwired chain (`panner → delay → crush → chorus → reverb → bus`)
is now data-driven:

- `Track._fxBlocks` — `{ id → FX block }`. Base four ids: `delay`, `crush`,
  `chorus`, `reverb` (bare param paths, permanent). Added instances: ids `fxN`
  (FXInstance-wrapped, namespaced paths).
- `Track._fxOrder` — array of ids; the chain order.
- `Track._fxBaseIds` = `['delay','crush','chorus','reverb']` (never removable).
- `Track._fxNextId` — monotonic counter for `fxN` ids.
- `setFXOrder(order)` / `getFXOrder()` — rebuild via `_rewireFXChain()`. Repairs
  partial/unknown/duplicate orders; never drops a registered block.
- `_rewireFXChain()` — `pannerNode → block[0] → … → busGain`. Upstream
  (`outputGain → tremGain → pannerNode`) and the bus are FIXED.

Persisted in `toJSON().fxOrder`; legacy projects without it keep the default.

**UI:** `js/ui/panels/FXPipelinePanel.js`, opened by the **FX** button in the
header FX bar (`SynthPanel._buildShell`, leftmost in `.fx-bar`), `activeTab ===
'fx'`. The oscilloscope shrinks via flexbox to make room.

---

## What's built — Step 3: multiple FX instances

### The proxy (the linchpin) — `js/signal/FXInstance.js`

Wraps a bare FX so multiple instances coexist. Public surface speaks **prefixed**
paths (`fx5.reverb.wet`); it strips the prefix before delegating to the wrapped
FX (which only knows `reverb.wet`). Rewrites `path` AND nested descriptor refs
(`modePath` / `msPath` / `bpmPath` on `type:'sync'` params). Forwards the audio
graph interface. To everything else, a proxied instance is indistinguishable
from a base block — it just owns a unique path namespace.

`stripFXPrefix(path)` / `fxTokenOf(path)` helpers are exported too.

### New FX types (all addable instances)

| Type | File | Notes |
|---|---|---|
| Distortion | `js/signal/DistortionFX.js` | tanh waveshaper + tone LP, 2× oversample, makeup. `dist.drive/tone/wet`. |
| Compressor | `js/signal/CompressorFX.js` | DynamicsCompressorNode + makeup gain. `comp.threshold/ratio/attack/release/makeup/wet`. wet=1 fully replaces dry. |
| Phaser | `js/signal/PhaserFX.js` | 4 LFO-swept allpass stages + feedback. `phaser.rate/depth/feedback/wet`. Has a running OscillatorNode (like ChorusFX). |
| Filter (FX) | `js/signal/FXFilter.js` | Single post-sum biquad, paraphonic. `fxfilt.type/cutoff/resonance`. `setEnabled(false)` = dry-through (transparent). Distinct from per-voice `Filter.js`. |

All follow the standard block interface. Extra copies of the base four are also
addable (`addFX('reverb')` etc.).

### Track.js instance API

- `addFX(type)` → builds FX, wraps in FXInstance, appends, rewires, returns `fxN`.
- `removeFX(id)` → base blocks refused. Detaches, strips the instance's p-locks
  from every step, drops LFOs pointed at it, deletes, rewires.
- `isFXRemovable(id)` / `getFXType(id)` / `getFXBlock(id)` / `getFXBlockIds()`.
- `fxObjForPath(path)` → **the central resolver.** `fxN.` prefix → that instance;
  base type prefix → base block. Everything path→owner goes through this.
- `_allFXParams()` → all FX descriptors (base + instances), namespaced.
- `_restoreFXInstances(list)` → rebuild added instances from JSON, **preserving
  saved ids** (so namespaced paths still resolve), bump `_fxNextId` past the max.
  Call this BEFORE `setFXOrder` on load.

`FX_TYPES` (type → class) and `FX_TYPE_LABELS` (exported, drives the Add menu).

### Wiring the namespace through the app (all done)

- **Sequencer** (`_resolveParamOwner`, `_buildPlockModeMap`) → via
  `track.fxObjForPath` / `getFXBlockIds`. **`_fireStep` needed NO change** — its
  p-lock dispatch uses `_resolveParamOwner` + `getParam`/`setParam`, which work on
  proxied namespaced paths transparently. (This is the payoff of the proxy.)
- **Track** `_resolveAudioParam` (LFO), `resolveModWheelParam`,
  `getAssignableParams` (one LFO-dest group per block, labelled "Reverb 2" etc.).
- **index.html** MIDI-CC mapper → `track.fxObjForPath`.
- **SynthPanel** `_tabForPLockPath` → `fxN.*` lights the FX tab.

### Persistence (all done)

- `Track.toJSON().fxInstances` = `[{id,type,params,enabled}]`; `fromJSON` calls
  `_restoreFXInstances` then `setFXOrder`.
- `SoundLibrary` save/load carries `fxOrder` + `fxInstances`.
- `SynthPanel` machine copy/paste carries both.
- Legacy/older saves without these fields → base-four default. Verified by test.

### UI (FXPipelinePanel.js)

- Path shows ALL blocks always, in order; bypassed (`!enabled`) tiles dimmed.
- Each tile: ON/OFF toggle (= `enabled`, emits `fxEnabledChanged` to sync header
  toggles), drag to reorder (onto a tile = insert-before; onto empty path = move
  last), and (added only) an ✕ to remove.
- Click a **base** tile → opens its dedicated tab. Click an **added/new** tile →
  selects it; its params render **inline** below the path via the generic
  `FXPanel` (works because the proxy's getParamList/setParam speak namespaced
  paths, and p-locks key off the same paths).
- Selected id is on `state.fxSelectedBlockId` (the panel is recreated on every
  `_renderContent`, so instance fields wouldn't survive).
- Left tray: **+ ADD FX** dropdown, LOAD/SAVE (disabled — presets step), help note.

---

## Step 4: presets (BUILT)

**BOTH** halves done:
- **Standalone store** — `js/state/FXLibrary.js` (localStorage `webtakt_fx_presets`,
  no factory presets). Preset shape: `{ id, name, tags, createdAt, fx: { delayFX,
  bitcrushFX, chorusFX, reverbFX, fxOrder, fxInstances } }`. `Track.exportFXPreset()`
  builds the `fx` subset; `Track.applyFXPreset()` restores base-four params →
  `_restoreFXInstances` → `setFXOrder` (that order — instance ids must resolve
  before the order references them). Instantiated in `SynthPanel` (no constructor
  arg threaded; it has no init dependency) and passed to panels as `ctx.fxLibrary`.
  API mirrors `SoundLibrary`: `save(name, tags, track)` / `load` / `delete` /
  `rename` / `setTags` / `allTags`.
- **FX-preset manager popup** — `js/ui/panels/FXPresetModal.js` (replaced the old
  cramped inline tray picker, which broke past ~8 presets). SOUNDS-style overlay,
  self-contained like `ManualOverlay`; the single instance lives on
  `state._fxPresetModal` (the panel is rebuilt each `_renderContent`, so it can't
  hold it). Tag-filter chips + cards (▶ audition / APPLY / ✎ edit / ✕ delete) +
  a **non-scrollable** ▶ PLAY DRY bar at top. **SAVE** stays inline in the pane
  (prompts name → tags). **Audition** routes through `Track.auditionFXPreset(fx,
  {dry})`: snapshot FX → apply preset (or bypass all blocks for dry) → one-shot
  C4 on the current machine → restore on `_auditionRestoreTimer`. A/B dry ↔
  pipeline without committing; APPLY commits via `FXLibrary.load`.
- **Folded into saved sounds** — `SoundLibrary` already carries `fxOrder` +
  `fxInstances`; loading a sound restores its FX chain. Verify it round-trips
  through the SOUNDS tab.

### Glyph-refresh fix
The header chain mini-outline now refreshes inside `SynthPanel._renderContent`
(not only on `render`/`toggleFx`/`fxEnabledChanged`) — so add/remove/reorder in
the FX pane (which all call `_renderContent`) update the header icons immediately,
not just when a block is toggled. `MixerPanel` FX toggles now emit
`fxEnabledChanged` (instead of poking the removed header DOM) to drive the same
refresh.

---

## Editor unification (dedicated tabs removed)

The old per-FX header bar had four units (DLY/CRUSH/REV/CHORUS), each a name
button (→ a dedicated tab) + an on/off toggle. Those tabs were trivial wrappers:
`SynthPanel._renderDelay/_renderCrush/_renderChorus/_renderReverb` each just did
`new FXPanel().render(ctx, track.<fx>FX)` — the SAME thing the FX pane's inline
editor does for added blocks. So they were removed and folded into the pane:

- **`FXPipelinePanel`** — clicking *any* tile (base or added) now selects it for
  the inline `FXPanel` editor below the path. The `BASE_TAB` jump is gone. Base
  blocks render identically to before (same `FXPanel`, bare paths) — just inline.
- **`SynthPanel._buildShell`** — the four `fxDefs` toggle-wraps were replaced by a
  **chain mini-outline** (`_renderFXChainOutline`): glyph icons (`TYPE_GLYPH`,
  exported from `FXPipelinePanel`) in chain order, bypassed ones dimmed, each
  click → `state.fxSelectedBlockId = id` + `setTab('fx')`. Rebuilt on `render()`,
  `toggleFx()`, and `fxEnabledChanged`. The FX-pipe button (`.fx-pipe-wrap`) is
  the only remaining `.fx-toggle-wrap`.
- **Dispatch/router** — `case 'delay'/'crush'/'chorus'/'reverb'` and the four
  `_render*` methods deleted from `SynthPanel`; `FXPanel` import dropped there
  (still imported by `FXPipelinePanel`).
- **`_tabForPLockPath`** — base FX paths (`delay.`/`crush.`/`chorus.`/`reverb.`)
  now map to `'fx'` (like `fxN.`), so any FX p-lock lights the FX button.
- **Keybinds C/V/B/N** still call `SynthPanel.toggleFx(...)`, which toggles the
  block's `enabled` flag directly (unchanged) and refreshes the outline.
- **CSS** — `.fx-toggle-name`/`.fx-toggle-onoff` rules replaced by
  `.fx-chain-outline`/`.fx-chain-icon`(`.off`); preset-picker styles added.

The base-FX manual entries (`delay`/`crush`/`chorus`/`reverb` in `manual.js`)
are kept as effect reference but are no longer reachable by tab (the overlay is
keyed by `activeTab`); the `fx` entry documents the unified flow.

## Traps & gotchas

- **No Node on this Mac.** Tests run **in the browser** (`tests/index.html`,
  user-run). Parse-check JS with `jsc`:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`
  after sed-stripping import/export lines (jsc doesn't resolve ES modules). This
  only catches SYNTAX errors, not logic.
- **Never move the poly filter.** The ghost-note fix depends on the per-voice amp
  gate + per-voice filters. The FX filter is a separate post-sum block on purpose.
- **`_restoreFXInstances` MUST run before `setFXOrder`** on every load path, else
  the order's `fxN` ids don't resolve. (Track.fromJSON, SoundLibrary.load,
  SynthPanel paste all do this — keep it that way.)
- **Base blocks keep bare paths.** Do not namespace `reverb.wet` etc. — it would
  break every existing project, p-lock, and preset.
- **Chorus is auto-toggled by the analogue flow** (`Track.setAnalogue`). The base
  chorus block participates in that; don't let pipeline on/off fight it.
- **Order-independence of p-lock/LFO/CC** is a property to preserve: they key off
  paths via `fxObjForPath`, never off chain position.
- **The "snake"** is CSS `flex-wrap` (each row left-to-right, wraps down) — NOT a
  true boustrophedon (right→down→left→down). User accepted this; a true serpentine
  needs JS row-reversal. Open if they want the exact visual.

---

## Files touched (this feature)

**New:** `js/signal/FXInstance.js`, `DistortionFX.js`, `CompressorFX.js`,
`PhaserFX.js`, `FXFilter.js`; `js/ui/panels/FXPipelinePanel.js`;
`js/state/FXLibrary.js` (presets); `tests/tests/fx_chain.js`.

**Modified:** `js/state/Track.js` (the bulk; + `exportFXPreset`/`applyFXPreset`),
`js/sequencer/Sequencer.js`, `js/ui/SynthPanel.js` (chain outline, tab removal,
FXLibrary wiring), `js/state/AppState.js` (`fxSelectedBlockId`),
`js/state/SoundLibrary.js`, `index.html` (MIDI-CC), `css/style.css`,
`js/ui/manual.js`, `tests/index.html` (register), and the docs
(`DESIGN.md`, `design/fx.md`, `design/audio-signal-chain.md`).

---

## Project rules to honour (from CLAUDE.md / memory)

- Update `DESIGN.md` + the relevant `design/*.md` on any architectural/UI change.
- Update `js/ui/manual.js` whenever a panel/control changes.
- str_replace-style edits; commit directly to `main` unless told otherwise.
- Defer to the recommended option on judgment calls; don't over-ask.
- Don't launch a browser to debug — the user verifies the app.

---

## First actions for the next session

Everything is built; the remaining work is **browser verification by the user**.
Load `tests/index.html` (FX chain + multi-instance suites) and the app, and try:
1. Click each base block in the FX pane → its knobs edit inline (matches the old
   tabs); ON/OFF dims the tile AND the header chain icon.
2. The header **chain mini-outline** shows the icons in order; click one → opens
   the FX pane with that block selected.
3. Add a filter after crush, drop a 2nd reverb, p-lock an added + a base FX param
   (FX button should light), reorder, remove an added one.
4. **SAVE** a pipeline → **LOAD** it onto another track; delete a preset.
5. Save+reload a sound, copy/paste a machine — FX chain round-trips.
