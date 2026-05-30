# Per-Track FX Chain

Three effects sit in series after the stereo panner, before the global fxBus.
Order: **Delay → Bitcrush → Reverb**.

Each effect has a **wet** knob (0–1) that blends parallel dry+wet. At wet=0 the effect is fully bypassed perceptually (dryGain=1, wetGain=0).

---

## DelayFX (`js/signal/DelayFX.js`)
Stereo feedback delay.
- **Unified sync knob** (`delay.sync`, `type: 'sync'`): a single mode-aware knob. `delay.syncMode` (`ms` | `bpm`) selects whether delay time is set manually or locked to tempo — **toggle by clicking the knob center** (the body shows the current mode, `MS`/`BPM`; no separate buttons). See `design/sync-knob-rollout.md` for the cross-FX rollout and the KnobWidget `setRange`/`snapPoints`/`onCenterClick` mechanism.
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
  - `bpm` mode: `reverb.bpmDiv` division selector (1/32–1/1). Pre-delay recalculates automatically when BPM changes.
- `reverb.damp` (200–20kHz LP on wet) and `reverb.wet` (0–1) are LFO-assignable and p-lockable.

---

## UI

Three stacked toggle units — DLY / CRUSH / REV — sit in `.fx-bar` on the right of the SynthPanel header, separated by a left border. Each unit has:
- A **name button** (top): clicking it opens that FX's param tab in the main content area
- An **ON/OFF toggle** (bottom, large): enables/disables the FX without navigating away

The on/off state is reflected in the header at all times regardless of which voice tab is active.

| FX | Content when name clicked |
|---|---|
| DLY | Unified Time knob; click center to toggle MS/BPM (mode shown in body). MS: ms time. BPM: sweeps 1/32 grid, shift-snaps to divisions. Both p-lockable. Feedback + Wet knobs always visible. |
| CRUSH | Bits, Rate, Wet knobs. Rate + Wet p-lockable + LFO-assignable. Bits track-level only. |
| REV | Decay knob. Sync toggle (ms/bpm). In ms mode: Pre-dly knob. In bpm mode: Pre-div picker (1/32–1/1). Damp + Wet always visible. |

FX tabs use a teal accent (`#7ec8c8`) to distinguish from voice tabs (amber).

---

## P-Lock Notes

- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay`, `delay.syncMode`, `reverb.syncMode`, `reverb.bpmDiv` are `modulatable: false` — always track-level. (`delay.bpmCount32` is now `modulatable: true` / `plockMode: 'js'` — p-lockable.)
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.
