# Per-Track FX Chain

Three effects sit in series after the stereo panner, before the global fxBus.
Order: **Delay → Bitcrush → Reverb**.

Each effect has a **wet** knob (0–1) that blends parallel dry+wet. At wet=0 the effect is fully bypassed perceptually (dryGain=1, wetGain=0).

---

## DelayFX (`js/signal/DelayFX.js`)
Stereo feedback delay.
- `delay.syncMode` (`ms` | `bpm`): selects whether delay time is set manually or locked to tempo.
  - `ms` mode: `delay.time` knob (1ms–2s), LFO-assignable and p-lockable.
  - `bpm` mode: `delay.bpmDiv` division selector (1/32–4/1 quarter-note multiples). Time recalculates automatically when BPM changes.
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
| DLY | Sync toggle (ms/bpm). In ms mode: Time knob (p-lockable). In bpm mode: Division picker (1/32–4/1). Feedback + Wet knobs always visible. |
| CRUSH | Bits, Rate, Wet knobs. Rate + Wet p-lockable + LFO-assignable. Bits track-level only. |
| REV | Decay knob. Sync toggle (ms/bpm). In ms mode: Pre-dly knob. In bpm mode: Pre-div picker (1/32–1/1). Damp + Wet always visible. |

FX tabs use a teal accent (`#7ec8c8`) to distinguish from voice tabs (amber).

---

## P-Lock Notes

- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay`, `delay.syncMode`, `delay.bpmDiv`, `reverb.syncMode`, `reverb.bpmDiv` are `modulatable: false` — always track-level.
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.
