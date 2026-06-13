# Sync-Knob Redesign — Rollout Tracking

> Tracks the migration of synced/time params from the **dropdown-of-divisions**
> pattern to a single **mode-aware knob** (MS ↔ BPM). One knob whose range +
> formatter swap with the sync mode; in BPM mode it sweeps a continuous
> **32nd-note grid**, and **shift snaps to musical divisions**. See
> `DESIGN.md` and the original discussion for rationale.

## Design summary (decided)

| Aspect | Decision |
|---|---|
| BPM granularity | Count of **grid units**, `GRID_BASE` units per whole note (=32 ⇒ a 1/32 note). Seconds = `count * GRID_UNIT_QN * 60/bpm`. `GRID_BASE` is the single resolution knob — everything derives from it. **FX sync knobs** sweep a `FINE_STEP` sub-grid (fractional counts) so they reach values *between* divisions; envelopes/LFO/arp stay on integer counts. |
| Display in BPM mode | **Nearest division + 1/32 remainder**, e.g. `5` → `1/8 + 1/32`, `7` → `3/16 + 1/32`. Pure divisions show clean (`8` → `1/4`). |
| Shift on a sync knob | **Snaps to the next musical division** (1/16, 1/8, dotted-1/8, 1/4, …) instead of fine mode. |
| Mode toggle | **Click the knob center** (no drag) flips MS↔BPM; body shows current mode (`MS`/`BPM`). No separate buttons — saves space in cramped UIs. KnobWidget: `centerLabel`/`onCenterClick`/`setCenterLabel`; click-vs-drag threshold 4px, hotspot = body radius (size*0.35). |
| LFO in BPM mode | **Continuous, un-quantised** — LFO always modulates the underlying *seconds* AudioParam (native Web Audio). No JS-driven stepping. |
| P-lock | Keep **two underlying params** (ms-seconds + 32nd-count) per the existing DelayFX split; lock whichever the active mode targets. **Both modes p-lockable**: ms → `audioParam`, 32nd-count → `js`. sync-mode enum stays p-lockable. |
| Data model change | `*.bpmDiv` (enum string) → `*.bpmCount32` (number, integer 32nd count). |

## Generic pieces (shared, build once)

| File | Change | Status |
|---|---|---|
| `js/util/BpmSync.js` | `count32ToSeconds(count,bpm)`, `MUSICAL_SNAP_32`, `formatCount32(count)` (→ "1/8 + 1/32"), `divToCount32(div)` for load back-compat. Kept `DIV_QN`/`SYNC_DIVISIONS`. **All derived from `GRID_BASE`** (grid units per whole note, =32; one edit rescales the grid: `GRID_UNIT_QN`, snap points, division names, `divToCount32` all flow from it). `FINE_STEP`/`FINE_INCREMENT` define a sub-grid the **FX sync knobs** sweep so they land between divisions (15 sub-steps between 1/32↔1/16); `count32ToSeconds`/`formatCount32` accept fractional counts (`formatCount32` appends a `·N` fine suffix). Envelopes/LFO/arp keep integer counts. | ✅ done |
| `js/ui/KnobWidget.js` | Added `setRange(...)`; `snapPoints` (shift snap); `centerLabel`/`onCenterClick`/`setCenterLabel` (click-center mode toggle, drawn in body). | ✅ done |
| `js/ui/panels/FXPanel.js` | Recognises `type: 'sync'` via `_renderSync()`: one knob whose center click toggles MS/BPM (rebuilds via `renderContent()`); binds knob to ms-seconds or 32nd-count param per mode. | ✅ done |
| `css/style.css` | Added `.fx-sync-cell` (toggle buttons removed — replaced by click-center). | ✅ done |

## Per-param rollout

| Param | File(s) | Pilot? | Status |
|---|---|---|---|
| Delay time | `js/signal/DelayFX.js`, `FXPanel.js` | **PILOT** — build + bugcheck first | ✅ done + bugchecked. Both modes p-lockable; LFO range narrowed to 0.02–0.6s. |
| Reverb pre-delay | `js/signal/ReverbFX.js`, `FXPanel.js` | after pilot | ✅ done. `reverb.bpmDiv`→`reverb.bpmCount32`; uses generic `FXPanel._renderSync` (no panel change). Track-level both modes (IR rebuild ⇒ not modulatable). `formatParam` already handled `reverb.predelay`. |
| Arp rate | `js/signal/Arpeggiator.js`, `js/ui/panels/ArpPanel.js` | after pilot (custom panel — needs own knob wiring) | ✅ done. `bpmDiv`→`bpmCount32` for chord/random **and** per-step manual. Shared `ArpPanel._makeSyncKnob` (accessor-bundle, works for params + step objects). FX-style: integer count, shift-snaps. |
| LFO rate | `js/signal/LFO.js`, `js/ui/panels/LFOPanel.js` | after pilot (custom panel) | ✅ done. `lfo.bpmDiv`→`lfo.bpmCount32` (count = LFO *period*, `Hz = 1/count32ToSeconds`); Advanced per-section too (`lfo.adsr.<sec>.bpmCount32`). Shared `LFOPanel._makeSyncKnob`. **Continuous in BPM mode, shift-drag/scroll snaps.** Hz-mode **Mult knob dropped** (`lfo.speedMult`/`.mult` kept in `_params` for load back-compat only). |
| Amp/filter envelope times | `js/signal/Envelope.js`, `ADSRWidget.js`, `AmpPanel.js`, `FilterPanel.js`, `VoicePool.js`, `Track.js` | new feature (user-approved) | ✅ done. Per-stage MS↔BPM on A/D/R of `env.*` **and** `fenv.*` (sustain excluded). New params `<prefix>.<stage>.syncMode` + `.bpmCount32`. Resolved at note-fire (`Envelope._stageSeconds`, `count32ToSeconds`) — no write-back. BPM via `Track.onBpmChanged → VoicePool.setBpm → Envelope.setBpm`. ADSRWidget: per-stage MS/BPM tag under each timed knob; canvas plots resolved seconds; BPM-stage knob drives the 1/32 count, drag snaps it (shift → musical division). Both modes p-lockable (active param), syncMode p-lockable too. |
| FM per-operator ADSR times | `js/machines/FMMachine.js`, `FMPanel.js`, `VoicePool.js` | follow-up — FM carries its OWN ADSR (4 ops × A/D/S/R), separate from `Envelope.js`, and was missed in the row above | ✅ done. Per-stage MS↔BPM on A/D/R of all four operators (`opN.env.{a,d,r}`; sustain excluded — it's a level, not a time). New params `opN.env.<stage>.syncMode` + `.bpmCount32`, JS-only + hidden (`plockMode:'js'`) like the existing FM env params. Resolved at note-fire (`FMMachine._stageSeconds` in `_scheduleOpADS/_scheduleOpR`, `count32ToSeconds`) — no write-back. BPM reaches the machine via the **already-existing** `Track.onBpmChanged → VoicePool.setBpm` path, extended to also call `machine.setBpm?.(bpm)` (and seed BPM in `_makeSlot` + `setMachine`). FMPanel: each op's A/D/R knob gets the click-center MS↔BPM toggle (KnobWidget `centerLabel`/`onCenterClick`/`setRange`); BPM knob drives the integer 1/32 count (shown "1/8", shift-snaps via `MUSICAL_SNAP_32`), the per-op canvas plots resolved seconds. Both modes p-lockable, syncMode too. Back-compat: legacy FM projects lack the keys → constructor defaults (`'ms'`/count 4); no `bpmDiv` migration needed (FM never had sync). Covered by `tests/tests/sync_knob.js`. |

## User-settable finest grid (Settings pane)

The Settings pane (`SettingsPanel`) exposes a **finest synced-knob division**
(1/32 / 1/64 / 1/128). It deliberately does **NOT** raise `GRID_BASE` (which
would reinterpret every stored `bpmCount32` and rescale saved projects).
Instead `BpmSync.setSnapResolution(gridBase)` reassigns the live
`MUSICAL_SNAP_32` array, *prepending* finer snap targets (1/64 → count 0.5,
1/128 → 0.25) below the historical 1/32. Stored counts stay in 1/32 units. The
FX sync knobs' `bpmMin` was lowered from 1 to 0.25 so those sub-1/32 snaps are
reachable; integer-count knobs (LFO/arp/env) round, so the finer grid mainly
benefits the continuous FX/LFO knobs. `MUSICAL_SNAP_32` is now an exported
`let` (live binding) — panels read it fresh at render, so the change propagates
without re-import.

## Notes / gotchas

- **No p-lock/LFO plumbing changes needed**: `Sequencer` dispatch keys off
  `plockMode` per path, and `Track._resolveAudioParam` already routes
  `delay.*`/`reverb.*` to the FX object's AudioParam. Keeping the two-param
  split means those layers are untouched.
- **Arp & LFO use custom panels**, not the generic FXPanel — each now has its own
  `_makeSyncKnob` helper. `ArpPanel._makeSyncKnob` takes an accessor bundle so it
  serves both arp-level params and per-step objects (`steps[].bpmCount32`).
  `LFOPanel._makeSyncKnob` toggles the whole LFO's `lfo.syncMode` and serves the
  Simple-mode rate + all four Advanced per-section rates.
- **LFO BPM rate is continuous** (not integer-rounded like the FX knobs): the knob
  sweeps fractional 1/32 counts and **shift-drag/scroll snaps** to musical
  divisions. The Hz-mode **Mult knob was dropped** (count model makes it
  redundant); `lfo.speedMult`/`lfo.adsr.*.mult` stay in `_params` for load
  back-compat but are no longer surfaced.
- **FM has its own ADSR** (a parallel copy of `Envelope.js`'s scheduling, per
  operator) — it is NOT routed through `Envelope`, which is why the amp/filter
  envelope migration didn't cover it. The follow-up row added the same per-stage
  MS↔BPM model directly on `FMMachine`. The BPM plumbing already reached
  `VoicePool` (for the track envelopes); FM only needed the final hop
  (`machine.setBpm?.()`). If another machine grows its own internal envelope,
  it needs the same treatment.
- **Serialization / back-compat**: every migrated class maps legacy `*.bpmDiv`
  strings → 32nd count in `fromJSON` (via `divToCount32`) and deletes the legacy
  key: DelayFX, ReverbFX, LFO (global + per-section), Arpeggiator (chord/random +
  per manual step). Covered by `tests/tests/sync_knob.js`.
