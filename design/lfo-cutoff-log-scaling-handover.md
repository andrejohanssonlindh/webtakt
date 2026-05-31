# Handover: LFO modulation of `filter.cutoff` feels one-sided (linear vs log Hz)

**Status:** FIXED (Option 1, `detune`, log-range depth). The cutoff LFO now rides
on `.detune` (cents → octave-based) instead of `.frequency`, so up/down swings are
musically symmetric and Bias is symmetric for free. `base.lpf`/`base.hpf` got the
same treatment. The mechanism is generic: descriptors flag `lfoUnit: 'cents'`,
`Track.lfoDepthScale()` returns `1200·log2(lfoMax/lfoMin)/2` cents (half the full
log range), and `Filter.resolveLFOTargets()` returns the `.detune` AudioParam(s) —
fanning to every slope stage for cutoff.

**Why log-range and not a fixed ±N octaves:** a fixed octave count is anchored to
the base (`base·2^N`), so from a low cutoff full depth still can't reach 20 kHz —
the user reported exactly this ("darker at the bottom, never caps to the roof").
Scaling depth to the full log range means 100% depth reaches `lfoMax` from any
base (the large detune drives the computed freq past Nyquist; the node clamps) and
reaches `lfoMin` from a high base. See the "Implementation notes" at the bottom.
Separate from the LFO **Bias** feature (shipped, verified on `output.level`).

## Symptom

Assign an LFO to **filter cutoff** (depth 100%, bias 0%). Audibly the filter
*only ever darkens* — the downswing slams the filter shut (sound cuts out), and
the upswing is barely perceptible. Setting **Bias** doesn't fix it because Bias
inherits the same scaling: `+bias` "only up" is nearly inaudible, `-bias` "only
down" is dramatic. On a plain gain param (`output.level`) bias works perfectly,
which is how we isolated this to cutoff specifically.

## Root cause — it is NOT a bug in the LFO or Bias code

The modulation is **linear in Hz** but hearing (and filter cutoff) is
**logarithmic / octave-based**.

- `depthScale` for cutoff = `(lfoMax - lfoMin) / 2 = (20000 - 20) / 2 ≈ 9990`
  (Hz). See `Track._resolveAudioParam()` (`js/state/Track.js`) and the descriptor
  `filter.cutoff` in `js/signal/Filter.js` (`lfoMin: 20, lfoMax: 20000`).
- The LFO sums a **linear** ±9990 Hz onto `node.frequency` via the Web Audio
  graph (`_depthGain`/`_biasGain` → `BiquadFilterNode.frequency`).
- From a base of e.g. 2000 Hz: `+9990` → ~12 kHz (≈ 2.6 octaves up, small
  perceptual move), `−9990` → clamped to ~0 Hz (a lowpass at 0 Hz passes nothing
  → total silence). Symmetric in Hz, wildly asymmetric to the ear.
- From the cutoff floor (20 Hz) the entire negative half is pinned at 0, and the
  positive half opens only ~2 octaves — so it reads as "only goes down / cuts
  out," exactly as reported.

`BiquadFilterNode.frequency` is also hard-clamped to `[0, Nyquist]`, compounding
the floor/ceiling asymmetry.

## Why the rest of the chain is a red herring (already checked)

- Bias wiring is correct: console logs showed `biasGain: +9990` (and `-9990`),
  `biasStarted: true`, `dests: 8` (one per voice slot). Not the problem.
- The filter **envelope** (`js/signal/Envelope.js` → `Filter.scheduleFrequency`)
  uses `cancelAndHoldAtTime` + ramps on `node.frequency`, but that sets the
  *intrinsic* value; the LFO is an *additive node input* and is summed on top
  regardless. With `filter.envAmount = 0` the envelope holds the intrinsic value
  flat, so it is not the cause. (Confirmed: the issue reproduces at fenv 0%.)
- Slope stages (`_stages[].biquad`) are NOT LFO-modulated, but at `filter.slope = 0`
  they are fully dry (`wetGain = 0`) and pass through, so they don't shape this.

## The fix (proposal — pick one)

The goal: LFO (and therefore Bias) should move cutoff by a **constant number of
octaves**, so `+` audibly brightens and `−` darkens by the same musical amount,
and neither half collapses to silence.

Web Audio has no log-domain AudioParam, so a plain additive connection to
`frequency` can't be log. Options:

1. **`detune` instead of `frequency` (recommended).** `BiquadFilterNode.detune`
   is in **cents** and combines with `frequency` as
   `computedFreq = frequency * 2^(detune/1200)` — i.e. it IS exponential. Route
   the cutoff LFO to `node.detune` (and each slope stage's `.detune`) instead of
   `.frequency`, with `depthScale` expressed in cents (e.g. ±`N` octaves →
   `±N*1200` cents). The knob/base value stays on `.frequency`; the envelope
   keeps using `.frequency`. Bias then offsets in cents → symmetric octaves.
   - Touch points: `Filter.resolveAudioParam('filter.cutoff')` would need to
     return `node.detune` for LFO purposes (but the envelope + UI still write
     `node.frequency`). Note `resolveAudioParam` is currently shared by envelope
     and LFO — may need to split "LFO target" from "envelope target," or add a
     dedicated path. Also must connect to **every slope stage's** `.detune`, not
     just `node` (see `VoicePool.connectLFOToAllFilters` — it currently resolves
     one param per slot filter; detune routing must fan to all stages the same
     way `scheduleFrequency` does).
   - `depthScale` for the cutoff-detune target becomes a cents value
     (`Track._resolveAudioParam`), independent of base Hz → pitch/again-stable.

2. **JS-driven log modulation.** Make `filter.cutoff` a JS-only LFO destination
   (like `trig.tone`): sample `lfo.getCurrentValue()` and write
   `frequency = baseCut * 2^(value)` per step/Frame. Loses sample-accurate audio
   modulation and adds CPU; not recommended vs option 1.

3. **Accept linear, just rescale.** Keep linear Hz but shrink `depthScale` and
   document the asymmetry. Doesn't actually fix the musical lopsidedness — not
   recommended.

## Suggested approach

Option 1 (`detune`). It keeps modulation on the audio thread, is naturally
exponential, makes Bias symmetric for free, and is pitch-independent. Main work
is plumbing a *separate LFO target* (`node.detune` + all `_stages[].biquad.detune`)
distinct from the envelope/UI target (`node.frequency`), and changing
`depthScale` for cutoff to a cents value.

## Verify after fixing

- LFO depth 100%, bias 0% on cutoff from a mid base → audibly opens AND closes by
  equal musical amounts; downswing no longer fully cuts out.
- Bias +100% → only brightens (audible), −100% → only darkens, symmetric.
- `base.lpf` / `base.hpf` LFO targets: decide whether they get the same treatment
  (they have the same linear-Hz issue).
- Existing `tests/tests/lfo.js` still passes; consider adding a cutoff-symmetry
  test (e.g. band-energy up-swing vs down-swing should be comparable in octaves).

## Key files

- `js/signal/LFO.js` — `_depthGain`/`_biasGain`, `addDestination`. (unchanged)
- `js/signal/Filter.js` — added `resolveLFOTargets()`; `filter.cutoff`/`base.lpf`/
  `base.hpf` descriptors flagged `lfoUnit: 'cents'`.
- `js/signal/Envelope.js` — `scheduleFrequency` caller; still writes `.frequency`
  (intrinsic), composes with the LFO's `.detune`. (unchanged)
- `js/state/Track.js` — new `lfoDepthScale()` helper (cents-aware); `_resolveAudioParam`
  uses it.
- `js/signal/VoicePool.js` — `connectLFOToAllFilters`/`disconnectLFOFromAllFilters`
  now iterate `resolveLFOTargets()` (multi-param fan-out).
- `js/signal/LFO.md` — depthScale + destination docs updated.
- `tests/tests/lfo.js` — added octave-symmetry / no-silence regression test.

## Implementation notes (the actual fix)

- **Two resolution paths, deliberately separate.** `Filter.resolveAudioParam()`
  (single `.frequency`/`.Q`) still serves the envelope + UI, which write the
  *intrinsic* value. `Filter.resolveLFOTargets()` (new) serves the LFO and returns
  an *array* of `.detune` params for frequency-type targets. The two never alias.
- **Why `detune`:** `computedFreq = frequency·2^(detune/1200)`, so it's exponential
  on the audio thread — a constant cents swing = a constant octave swing regardless
  of base, and the downswing can never reach 0 Hz. No JS per-frame work, no pitch
  dependence.
- **Why full log-range depth (not fixed octaves):** see the status note above —
  fixed octaves can't reach the rail from a far base. `lfoDepthScale()` returns
  `1200·log2(lfoMax/lfoMin)/2` cents for `lfoUnit:'cents'` params, mirroring the
  linear default's `(max−min)/2` half-range semantic in log space. Base-independent,
  set once at assignment — no live recompute needed (clamping handles the rails).
- **Generic, not a cutoff special-case:** the cents/octave behaviour is driven by
  descriptor metadata (`lfoUnit`) consumed by `lfoDepthScale()`, and
  `resolveLFOTargets()` keys off the path. Adding another octave-based filter
  param later is a one-line descriptor flag.
- **Q/gain stay linear** (not octave quantities). **Mod wheel unchanged** — it
  reads only `lfoMin`/`lfoMax` and writes absolute Hz via `setParam`, ignoring
  `lfoUnit`.
