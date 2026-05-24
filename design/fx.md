# Per-Track FX Chain

Three effects sit in series after the stereo panner, before the global fxBus.
Order: **Delay → Bitcrush → Reverb**.

Each effect has a **wet** knob (0–1) that blends parallel dry+wet. At wet=0 the effect is fully bypassed perceptually (dryGain=1, wetGain=0).

---

## DelayFX (`js/signal/DelayFX.js`)
Stereo feedback delay.
- `delay.time` (10ms–1s), `delay.feedback` (0–95%), `delay.wet` (0–1).
- All three params are LFO-assignable and p-lockable.
- Internal: `DelayNode` + feedback `GainNode` loop. Max delay 2s.

## BitcrushFX (`js/signal/BitcrushFX.js`)
Bit-depth reduction + rate smear.
- `crush.bits` (1–16), `crush.rate` (1%–100% of nyquist), `crush.wet` (0–1).
- `crush.bits` is not modulatable (rebuilds WaveShaperNode curve — JS-only).
- `crush.rate` and `crush.wet` are LFO-assignable and p-lockable.
- True sample-and-hold requires AudioWorklet; `crush.rate` approximates downsampling via a pre-filter cutoff.

## ReverbFX (`js/signal/ReverbFX.js`)
Convolution reverb with a synthesised exponential-decay noise IR.
- `reverb.decay` (0.1–8s) and `reverb.predelay` (0–100ms) rebuild the IR on change — track-level only, not p-lockable.
- `reverb.damp` (200–20kHz LP on wet) and `reverb.wet` (0–1) are LFO-assignable and p-lockable.

---

## UI

Three stacked toggle units — DLY / CRUSH / REV — sit in `.fx-bar` on the right of the SynthPanel header, separated by a left border. Each unit has:
- A **name button** (top): clicking it opens that FX's param tab in the main content area
- An **ON/OFF toggle** (bottom, large): enables/disables the FX without navigating away

The on/off state is reflected in the header at all times regardless of which voice tab is active.

| FX | Content when name clicked |
|---|---|
| DLY | Delay Time, Feedback, Wet knobs. All p-lockable + LFO-assignable. |
| CRUSH | Bits, Rate, Wet knobs. Rate + Wet p-lockable + LFO-assignable. Bits track-level only. |
| REV | Decay, Pre-dly, Damp, Wet knobs. Damp + Wet p-lockable + LFO-assignable. Decay + Pre-dly track-level only. |

FX tabs use a teal accent (`#7ec8c8`) to distinguish from voice tabs (amber).

---

## P-Lock Notes

- All `modulatable: true` FX params are p-lockable and LFO-assignable.
- `crush.bits`, `reverb.decay`, `reverb.predelay` are `modulatable: false` — they appear in the UI but are always track-level.
- The sequencer dispatches FX p-locks the same way as filter p-locks: scheduled `setParam(path, value, time)` + restore at `offTime`.
