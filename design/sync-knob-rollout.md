# Sync-Knob Redesign — Rollout Tracking

> Tracks the migration of synced/time params from the **dropdown-of-divisions**
> pattern to a single **mode-aware knob** (MS ↔ BPM). One knob whose range +
> formatter swap with the sync mode; in BPM mode it sweeps a continuous
> **32nd-note grid**, and **shift snaps to musical divisions**. See
> `DESIGN.md` and the original discussion for rationale.

## Design summary (decided)

| Aspect | Decision |
|---|---|
| BPM granularity | Integer count of **1/32 notes**. Seconds = `count * (60/bpm)/8`. |
| Display in BPM mode | **Nearest division + 1/32 remainder**, e.g. `5` → `1/8 + 1/32`, `7` → `3/16 + 1/32`. Pure divisions show clean (`8` → `1/4`). |
| Shift on a sync knob | **Snaps to the next musical division** (1/16, 1/8, dotted-1/8, 1/4, …) instead of fine mode. |
| Mode toggle | **Click the knob center** (no drag) flips MS↔BPM; body shows current mode (`MS`/`BPM`). No separate buttons — saves space in cramped UIs. KnobWidget: `centerLabel`/`onCenterClick`/`setCenterLabel`; click-vs-drag threshold 4px, hotspot = body radius (size*0.35). |
| LFO in BPM mode | **Continuous, un-quantised** — LFO always modulates the underlying *seconds* AudioParam (native Web Audio). No JS-driven stepping. |
| P-lock | Keep **two underlying params** (ms-seconds + 32nd-count) per the existing DelayFX split; lock whichever the active mode targets. **Both modes p-lockable**: ms → `audioParam`, 32nd-count → `js`. sync-mode enum stays p-lockable. |
| Data model change | `*.bpmDiv` (enum string) → `*.bpmCount32` (number, integer 32nd count). |

## Generic pieces (shared, build once)

| File | Change | Status |
|---|---|---|
| `js/util/BpmSync.js` | Added `THIRTYSECOND_QN`, `count32ToSeconds(count,bpm)`, `MUSICAL_SNAP_32`, `formatCount32(count)` (→ "1/8 + 1/32"), `divToCount32(div)` for load back-compat. Kept `DIV_QN`/`SYNC_DIVISIONS`. | ✅ done |
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
- **Serialization / back-compat**: every migrated class maps legacy `*.bpmDiv`
  strings → 32nd count in `fromJSON` (via `divToCount32`) and deletes the legacy
  key: DelayFX, ReverbFX, LFO (global + per-section), Arpeggiator (chord/random +
  per manual step). Covered by `tests/tests/sync_knob.js`.
