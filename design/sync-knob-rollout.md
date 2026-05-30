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
| Reverb pre-delay | `js/signal/ReverbFX.js`, `FXPanel.js`, `formatParam.js` | after pilot | ☐ |
| Arp rate | `js/signal/Arpeggiator.js`, `js/ui/panels/ArpPanel.js` | after pilot (custom panel — needs own knob wiring) | ☐ |
| LFO rate | `js/signal/LFO.js`, `js/ui/panels/LFOPanel.js` | after pilot (custom panel) | ☐ — already has dropdown BPM sync (`lfo.syncMode` hz/bpm + `lfo.bpmDiv` + `divToHz`); migrate the dropdown → unified click-center sync knob. |
| Amp/filter envelope times | `js/signal/Envelope.js`, `js/ui/panels/AmpPanel.js`, `FilterPanel.js`, `TrigPanel.js` | candidate (user-flagged) | ☐ — `env.attack/decay/release` + `fenv.*` are plain seconds, no BPM sync today. Adding sync = a new feature (envelope-time-to-tempo), not just a UI swap. Decide whether attack/decay/release should be tempo-syncable at all before building. |

## Notes / gotchas

- **No p-lock/LFO plumbing changes needed**: `Sequencer` dispatch keys off
  `plockMode` per path, and `Track._resolveAudioParam` already routes
  `delay.*`/`reverb.*` to the FX object's AudioParam. Keeping the two-param
  split means those layers are untouched.
- **Arp & LFO use custom panels**, not the generic FXPanel — they need their own
  sync-knob wiring (or a shared helper extracted from FXPanel). Arp also has
  *per-step* manual-mode sync values (`steps[].bpmDiv`), a bigger surface.
- **Serialization / back-compat**: old projects store `*.bpmDiv` strings. On
  load, map the string → 32nd count (via `DIV_QN[div]*8`) so existing patterns
  survive. Decide whether to keep reading the old key indefinitely.
