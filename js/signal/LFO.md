# LFO Implementation Reference

## Overview

Each track owns an array of `LFO` instances (`track.lfos`). LFOs run continuously once started. Each LFO can be assigned to one destination parameter path at a time. The connection is additive: the LFO output is added on top of the destination AudioParam's base value.

---

## Audio graph

```
OscillatorNode (_lfoOsc) ──→ GainNode (_depthGain, gain = depthScale × depth/100) ─┐
ConstantSourceNode (=1) ──→ GainNode (_biasGain,  gain = bias × depthGain.gain)  ─┴→ destination AudioParam
```

In Hz mode the LFO oscillator runs at `lfo.speed` Hz. In BPM mode the rate comes
from `lfo.bpmCount32` — an integer count of 1/32 notes treated as the LFO
*period* — so `Hz = 1 / count32ToSeconds(lfo.bpmCount32, bpm)` (see
`js/util/BpmSync.js`). The depth gain scales the ±1 oscillator output into the
destination's unit space before it reaches the AudioParam.

**Bias (`lfo.bias`, −100…+100):** a DC offset added to the destination in
parallel with the oscillator, equal to `bias × (current depth amplitude)`. A
unit `ConstantSourceNode` feeds `_biasGain`, whose gain mirrors **every**
`_depthGain` schedule (steady depth, simple-mode fade, and advanced-mode ADSR
ramps) multiplied by `bias/100` — so the offset tracks the depth envelope
exactly. The effect is to slide the modulation window without changing its
width: at `+100` the window's bottom peak sits at the base value (LFO only
modulates **up**); at `−100` the top peak sits at the base value (only **down**);
at `0` it is symmetric (legacy behaviour). Works in both simple and advanced
mode, and is mirrored in `getCurrentValue()` for the JS-only `trig.tone`
destination. The bias source is started once per `start()` and recreated on
`stop()` (a source node cannot be restarted).

> The legacy Hz **Mult** knob (`lfo.speedMult`, and per-section `.mult`) was
> dropped when the unified sync knob landed; the keys remain in `_params` for
> project-load back-compat but are no longer surfaced or used by BPM mode.

---

## Parameters

| Path | Type | Range | Default | Notes |
|---|---|---|---|---|
| `lfo.waveform` | enum | `sine` `square` `sawtooth` `triangle` | `sine` | Native `OscillatorNode` types only — no random/S&H |
| `lfo.speed` | number | 0.001–20 Hz | 0.1 | Hz-mode rate (`lfo.syncMode === 'hz'`) |
| `lfo.bpmCount32` | number | 1–128 | 8 | BPM-mode rate: 1/32 count = LFO period (`lfo.syncMode === 'bpm'`); 8 = 1/4 |
| `lfo.depth` | number | 0–100 % | 30 | Percentage of half the destination range |
| `lfo.bias` | number | −100…+100 % | 0 | DC offset of the modulation window in units of the depth amplitude; `+` = only-up, `−` = only-down, `0` = symmetric |

Effective frequency: Hz mode → `lfo.speed`; BPM mode → `1 / count32ToSeconds(lfo.bpmCount32, bpm)`.

---

## depthScale — how depth maps to destination units

`depthScale` is computed by `lfoDepthScale(descriptor)` in `Track.js`. There are two cases:

- **Linear (default):** `depthScale = (lfoMax − lfoMin) / 2`. At 100% depth the LFO swings ±`depthScale` around the base value = ±half the destination's full range.
- **Octave-based (`lfoUnit: 'cents'`):** `depthScale = 1200·log2(lfoMax / lfoMin) / 2`, a cents value = half the param's *log* range, independent of the base. Used for exponential AudioParams where linear modulation would feel one-sided. At 100% depth the LFO swings ± half the full octave range — enough to reach either rail from any base.

This is set once at assignment time in `Track.setLFODestination()`.

**Why filter frequencies are octave-based:** `filter.cutoff`, `base.lpf` and `base.hpf` are declared `lfoUnit: 'cents'`. Hearing (and filter cutoff) is logarithmic, but `BiquadFilterNode.frequency` is linear in Hz — adding ±N Hz darkens far more than it brightens and can pin a lowpass at 0 Hz (silence). So these LFOs target `.detune` (cents) instead of `.frequency`: `computedFreq = frequency·2^(detune/1200)`, which is exponential, so a constant cents swing = a constant octave swing regardless of base. The intrinsic value (knob + envelope) keeps living on `.frequency`; the LFO rides on `.detune` and the two compose. See `Filter.resolveLFOTargets()`.

The depthScale spans the **full log range** (e.g. cutoff: `1200·log2(20000/20)/2 ≈ 5977` cents ≈ 5 octaves each way), not a fixed octave count. That is deliberate: at 100% depth the sweep reaches `lfoMax` from a low base (the big detune pushes the computed frequency past Nyquist, which the node clamps) and reaches `lfoMin` from a high base. A fixed ±N octaves could *not* reach the ceiling from a low cutoff (`base·2^N` stays low) — that was the "darker at the bottom, can't cap to the roof" bug. Bias inherits this for free — `+100` = only-up toward `lfoMax`, `−100` = only-down toward `lfoMin`, symmetric in octaves. Filter `resonance`/`gain` (Q, dB) are *not* octave quantities and stay linear.

**Critical constraint for FM modulators**: FM operator level/feedback AudioParams are in frequency-scaled space (`level × freq × MAX_MOD_RATIO`), which changes pitch-to-pitch. To keep `depthScale` pitch-independent, FMMachine uses a split-gain topology for OP2/3/4:

```
opNEnvGain → opNLevelGain (0–1, LFO target) → opNScaleGain (freq×MAX_MOD_RATIO, updated on noteOn) → target.frequency
```

The LFO connects to `opNLevelGain.gain` — a 0–1 AudioParam — so `depthScale = 0.5` is stable across all pitches. `opNScaleGain` is updated to the current `freq × MAX_MOD_RATIO` on each `noteOn`. This same pattern applies to `op2.feedback`.

---

## Destination types

### AudioParam destinations (normal case)

`Track._resolveAudioParam(path)` returns `{ audioParam, depthScale }`. The LFO's `_depthGain` is connected directly to the AudioParam. The connection is permanent until `clearDestination()` is called (e.g. on track reset or destination change).

All params with `modulatable: true` and a non-null `resolveAudioParam` result fall here.

**Multi-target filter params:** filter params route per voice slot via `VoicePool.connectLFOToAllFilters`, which calls `Filter.resolveLFOTargets(path)` — this returns an *array* of AudioParams, so one path can drive several nodes. `filter.cutoff` returns the primary node's `.detune` plus every slope stage's `.detune` (all poles track the same modulation). Other filter params return a single param. The same `depthScale` applies to all targets of one LFO.

### JS-only destinations

`trig.tone` has no AudioParam — it is a semitone offset read at step-fire time by the sequencer. `_resolveAudioParam` returns `{ audioParam: null, depthScale: 24, jsOnly: true }`. The LFO is not connected to any AudioParam; instead `lfo.getCurrentValue()` is called in `Sequencer._fireStep()` and summed into the note's semitone offset.

`getCurrentValue()` re-implements the waveform math in JS (sine/square/sawtooth/triangle) using `AudioContext.currentTime` to approximate the oscillator's phase. It matches the oscillator output closely but is not sample-accurate.

No other JS-only destinations exist. `osc.detune` routes to a real AudioParam.

---

## Destination groups (LFO tab dropdown)

`Track.getAssignableParams()` builds the dropdown in this order:

| Group | Contents |
|---|---|
| Trig | `trig.tone` always; `osc.detune` only if machine has it |
| Machine label (e.g. FM) | All machine params where `modulatable: true`, excluding `osc.detune` |
| Filter | `filter.cutoff`, `filter.resonance`, `base.lpf`, `base.hpf` |
| Amp | `amp.pan` |
| Delay | `delay.time`, `delay.feedback`, `delay.wet` |
| Crush | `crush.rate`, `crush.wet` |
| Reverb | `reverb.damp`, `reverb.wet` |

`amp.pan` is resolved directly in `_resolveAudioParam` (not via machine). All other paths delegate to `machine.resolveAudioParam` → `filter.resolveAudioParam` → FX chain in order.

**LFO dropdown uses `getLFOAssignableParams()`**, not the raw `getAssignableParams()`. It is the same list filtered to destinations the LFO can actually drive: an AudioParam-backed param, or a recognised JS-only target (`trig.tone`/`trig.velocity`/`arp.*`). Composite FX params that are `modulatable` but have no `resolveAudioParam` — e.g. `comb.freq` (value is a frequency, node param is a delay time), `pan.shape`, `tape.wow`/`spread`, `gate.depth`/`smooth` — are **dropped from the LFO dropdown** (they'd be dead targets) but **stay in the mod-wheel / MIDI-CC dropdowns** (`getAssignableParams`), which apply via `setParam` and so support them.

---

## Lifecycle

- `addLFO()` — creates a new `LFO`, calls `lfo.start()`, pushes to `track.lfos` and `track._lfoDestPaths`.
- `removeLFO(index)` — calls `lfo.stop()` then `clearDestination()` before splicing.
- `resetTrack()` — stops and clears all LFOs, then calls `addLFO()` once for a clean state.
- LFOs are serialised in `Track.toJSON()` under `lfos: [{ index, params, destPath }]`. On `fromJSON`, `setLFODestination` is called after restoring params so the AudioParam connection is re-established.

---

## Adding a new LFO destination

1. Add `modulatable: true`, `lfoMin`, `lfoMax` to the param descriptor in the owning class's `getParamList()`.
2. Make sure `resolveAudioParam(path)` in that class returns the live AudioParam.
3. If the AudioParam is in a non-obvious unit space (like FM mod depth), use the split level/scale gain pattern described above.
4. If there is no AudioParam at all, return `null` from `resolveAudioParam` and add a `jsOnly: true` case in `Track._resolveAudioParam`, then read `lfo.getCurrentValue()` at the point where the param is consumed.

---

---

## Elektron LFO Reference

This section documents how Elektron machines (Digitakt, Digitakt II, Syntakt, Digitone, Analog Four, Analog Rytm) implement their LFO, as a design reference for features we want to model.

### Waveform types

Elektron offers 7 waveforms; we currently support 4:

| Waveform | Elektron | Webtakt | Notes |
|---|---|---|---|
| Triangle | ✓ | ✓ | |
| Sine | ✓ | ✓ | |
| Square | ✓ | ✓ | |
| Sawtooth | ✓ | ✓ | Elektron has both saw and ramp (reverse saw) |
| Ramp (reverse saw) | ✓ | — | Implementable: negate sawtooth or flip phase |
| Exponential | ✓ | — | Approximable in JS; not a native OscillatorNode type |
| Random / S&H | ✓ | — | Requires a JS-driven approach; not available as OscillatorNode |

### Trig modes (LFO reset/flow behavior)

Elektron defines five modes that control how the LFO responds to a note trigger:

| Mode | Elektron label | Behavior |
|---|---|---|
| Free-running | FRE | LFO runs continuously, never resets. Phase is shared across all notes on the track. |
| Triggered | TRG | LFO phase resets to Start Phase on every note trigger. Classic retrigger. |
| Hold | HLD | LFO runs free in background; when a note is triggered, the current output value is latched and held until the next note trigger. |
| Single shot | ONE | On note trigger, LFO starts at Start Phase, runs exactly one cycle, then stops. |
| Half shot | HLF | On note trigger, LFO starts at Start Phase, runs to the midpoint of the cycle, then stops. |

**Start Phase** (0–127, where 64 = midpoint of wave) controls where in the waveform TRG/ONE/HLF modes begin. This is the equivalent of a phase offset on reset.

### BPM sync

Elektron LFO speed can be synced to the sequencer tempo. The system uses two parameters:

- **Speed (SPD)**: base rate of the LFO; specific integer values correspond to musically useful divisions.
- **Multiplier**: scales SPD relative to tempo. Can be set against the current track BPM or a fixed 120 BPM reference.

Musically relevant speed settings (at SPD × Multiplier = 1 full cycle per N beats):

| Division | Cycles per bar |
|---|---|
| 1/32 | 8 per bar |
| 1/16 | 4 per bar |
| 1/8 | 2 per bar |
| 1/4 | 1 per bar |
| 1/2 | 0.5 per bar |
| 1/1 | 0.25 per bar |

Negative SPD values reverse the LFO direction (plays the waveform backward).

**What we want to model**: The LFO speed should be expressible either as a free Hz rate (current behavior) or as a tempo-synced note division (1/32, 1/16, 1/8, 1/4, 1/2, 1/1, 2/1, 4/1, etc.), computed from the sequencer BPM via `Clock.bpm`. The division maps to Hz as: `Hz = (BPM / 60) / stepsPerCycle` where `stepsPerCycle` is the note division denominator in quarter-note units.

### Fade in / Fade out

A single Fade parameter controls an amplitude ramp applied to the LFO output after trigger:

- **Positive fade value**: LFO starts at full depth and fades out over time.
- **Negative fade value**: LFO starts at zero depth and fades in over time.
- **Zero**: No fade; LFO depth is constant.

This is implemented as a separate gain envelope on the LFO output, not a change to the oscillator itself.

---

---

## Simple vs Advanced mode

The LFO UI presents two modes selectable per LFO instance. The mode affects which parameters are exposed; the underlying audio graph is the same in both.

### Simple mode

Aligned with Elektron conventions. Parameters:

| Parameter | Description |
|---|---|
| Waveform | sine / triangle / square / sawtooth |
| Trig mode | FRE / TRG / HLD / ONE / HLF (see Elektron reference above) |
| Speed | Free Hz rate OR tempo-synced division (1/32 … 4/1) |
| Mult | Integer multiplier on speed |
| Depth | Single global depth (0–100%) |
| Start Phase | Phase offset on reset (0–127); active only in TRG / ONE / HLF modes |
| Fade | Single fade-in (negative) / fade-out (positive) value; replaces per-section depth |

This is a direct upgrade of the current implementation: adds trig modes, BPM sync, start phase, and Elektron-style fade.

### Advanced mode

Adds the LFO ADSR envelope on top of simple mode. All simple parameters remain except Fade, which is superseded by the ADSR depth envelope.

Additional parameters:

| Parameter | Description |
|---|---|
| ADSR source | `amp` — read amp A/D/S/R timings at noteOn; `own` — independent values |
| A / D / S / R time | Own-mode only: duration in ms (A, D, R) or ignored (S, which is gate-length) |
| Depth per section | Per A/D/S/R: LFO depth (0–100%) active during that phase |
| Speed per section | Per A/D/S/R: LFO oscillator rate during that phase (Hz or synced division) |
| Mult per section | Per A/D/S/R: integer multiplier on per-section speed |

---

## Proposed: LFO ADSR Envelope

This is a non-standard extension beyond what Elektron implements. The concept: rather than a single fade parameter, the LFO depth (and optionally speed) is shaped by a full ADSR envelope that can either follow the track's own amp ADSR or use an independent ADSR.

### Motivation

Amp ADSR defines how a note evolves over time — Attack builds, Decay falls to Sustain, Release fades out. Applying that same time-shape to LFO depth means the modulation intensity tracks the natural energy arc of the sound: strong during the body, quiet at the edges. An independent ADSR gives full creative control beyond that.

### Mode: Synced to Amp ADSR

In **sync mode**, the LFO ADSR mirrors the track's amp ADSR timings exactly. Each phase of the LFO depth envelope matches the corresponding amp envelope phase:

```
LFO Depth
  |
  |         A: rises over amp.attack ms
  |         D: falls over amp.decay ms
  |         S: held for the sustain portion of the note
  |         R: fades over amp.release ms
```

Amp A/D/S/R values are read at `noteOn` time (read-only snapshot). If the amp ADSR is edited mid-session, the new values are picked up on the next note. No bidirectional coupling — the amp is always the source of truth.

The sustain phase has no fixed duration — it lasts until `noteOff`, exactly as the amp sustain does. The LFO release ramp is scheduled at the same `noteOff` event. No special logic beyond matching the amp's noteOn/noteOff call sites.

### Mode: Independent ADSR

In **independent mode**, the LFO ADSR uses its own A, D, S, R values. S is still gate-length driven (noteOff triggers release). Otherwise identical mechanics to sync mode.

### Per-section parameters

Each of A, D, S, R has three sub-parameters:

| Parameter | Per-section? | Description |
|---|---|---|
| Depth | ✓ | LFO depth (0–100%) during this section. Replaces global depth — global depth is hidden in advanced mode. |
| Speed | ✓ | LFO oscillator rate during this section (Hz or synced division). |
| Mult | ✓ | Integer speed multiplier for this section. |

**Depth per section**: straightforward `AudioParam` gain scheduling at each phase boundary.

**Speed per section**: scheduled via `setValueAtTime` on `_lfoOsc.frequency` at each phase boundary. Causes a phase discontinuity (click/jump) on abrupt change. At low depth this is inaudible; on pitched destinations (`trig.tone`, `osc.detune`) it may be audible. Accepted as a known artifact — documented, not fixed. Glide and phase-accurate transitions are skipped (require JS waveform rewrite).

### Implementation feasibility summary

| Feature | Verdict |
|---|---|
| Simple mode (Elektron parity) | Easy |
| BPM-synced speed | Easy — `Hz = (BPM/60) / division` |
| Trig modes FRE / TRG | Easy — TRG resets OscillatorNode phase via stop/start at noteOn |
| Trig modes HLD / ONE / HLF | Moderate — require JS phase tracking; OscillatorNode has no mid-cycle stop |
| Start phase on reset | Easy — set `_lfoOsc` phase offset at stop/start |
| Fade in/out | Easy — scheduled gain ramp on depth node |
| Advanced mode: depth envelope (ADSR) | Easy — gain scheduling at noteOn/noteOff |
| Advanced mode: amp-sync (read-only) | Easy — snapshot amp values at noteOn |
| Advanced mode: per-section depth | Easy |
| Advanced mode: per-section speed/mult (snap) | Easy, click artifact on pitched destinations |
| Advanced mode: per-section speed (glide/phase-accurate) | Skipped — rewrite required |
| Sustain gate-length sync | Easy — already how amp ADSR works |
