# Webtakt — Audio Test Suite Design

> Reference: see DESIGN.md § "Audio Test Suite" for the one-paragraph architectural summary.
> This document is the full design spec: rationale, harness internals, per-suite strategy, known limitations, and lessons learned during calibration.

---

## Goals

Catch regressions in p-locks and LFO routing without requiring a human to listen.
These two systems fail silently — the sequencer keeps running, the UI looks fine, but the wrong sound comes out.
The tests run entirely in-browser against `OfflineAudioContext` (no speakers, no server changes needed) and produce a pass/fail report.

---

## Non-goals

- Testing the UI or interaction layer (knob drag, click handlers, panel rendering).
- Testing `wt-sampler` or `sampler` machines (AudioWorklet / file-load dependencies not supported in OfflineAudioContext).
- Exact waveform comparison or snapshot regression — audio output is non-deterministic enough (envelope ramps, BPM timing) that absolute comparison would be brittle.

---

## How to run

1. Serve the project: `python3 -m http.server 8000`
2. Open `http://localhost:8000/tests/index.html` in Firefox
3. Click **Run All** (the full suite is 2+ min — see *Running a subset* below to go faster)
4. Results appear in-page with green/red per line
5. Click **Copy Results** or **Save to File** to share the report

### Running a subset

The full suite takes 2+ minutes, so the runner can scope what it executes.
Filtering happens in `runAll(filter)` (runner.js); the UI in `index.html` drives it
three ways:

- **Suite picker** — click **Suites ▾** to reveal a checklist of every registered
  suite (with test counts). Tick the ones you want and press **Run Selected**.
  Each row also has a **run** link to run that one suite immediately.
- **Filter box** — type a substring; **Run Selected** then runs only tests whose
  *name* contains it (e.g. `reverb`). Combine with checked suites to narrow further.
  Press Enter in the box to run.
- **URL params** — deep-link a scoped run:
  - `?suite=fx` — only suites whose name contains "fx"
  - `?test=reverb` — only tests whose name contains "reverb"
  - add `&run` to auto-run on load, e.g. `tests/index.html?suite=fx&run`

  (`suite=`/`test=` here are case-insensitive substring matches, not exact names.)

`runAll(filter)` accepts `{ suite, test, suites }`:
`suite`/`test` are case-insensitive substring filters; `suites` is a `Set` of exact
suite names (used by the picker). A filtered report is tagged `(filtered)` in its
summary line so a partial run is never mistaken for a clean full pass.
`listSuites()` returns `[{ name, tests:[…] }]` and is what builds the picker.

---

## File structure

```
tests/
  index.html              — test runner page (Run button, Copy/Save)
  results.html            — legacy stub (results now rendered in index.html)
  runner.js               — harness: OfflineAudioContext factory, measurement helpers, runner loop
  TEST_DESIGN.md          — this file
  tests/
    lfo.js                — LFO core behaviour: depth=0 baseline, depth=100 variation, TRG determinism
    lfo_machine_params.js — LFO wiring tests for every modulatable param on every machine + signal chain
    plocks.js             — p-lock apply and restore tests
    fx_chain.js           — per-track reorderable FX pipeline order + panic/silence (flush) behaviour
    fx_blocks.js          — second-wave add-only FX blocks: addable, in-chain, audio passes, params round-trip
    fx_bypass_gain.js     — INVARIANT: adding a DISABLED FX of any type must not change the track level
                            (a bypassed block must pass dry at unity). Caught Tape's always-on saturation
                            in the dry path. Sweeps every addable type, one test each, full-buffer RMS vs bare.
    fx_worklets.js        — worklet-backed FX (crush2/stutter): chain survives them (degrade to dry offline)
    filter_engine.js      — digital/analogue filter engine switch (analogue = PATINA ladder worklet; pass-with-note if worklet unavailable offline)
    machines/
      synth.js
      kick_silk.js
      kick_hard.js
      snare.js
      hihat.js
      fm.js
      bass.js
      karplus.js
      noise.js
      transient.js
      cymbal.js
      wood.js
      wavetable.js
      comb.js
      chord.js
      strings.js
      swarm.js
      sample_swarm.js
      marimba.js
      param_spec.js         — declarative `static SPEC` regression: getParamList/resolveAudioParam/toJSON round-trip per machine
      loudness.js           — pass/fail loudness-normalisation guard (median-band for tonal machines, peak ceiling for percussion)
  loudness.js               — MANUAL loudness BENCH (no pass/fail) — see loudness.html
  loudness.html             — bench page: renders the table + suggested per-machine trim
```

---

## Harness design (`runner.js`)

### `makeOfflineTrack(machineType, durationSec)`

Creates the full production stack — `Track`, `VoicePool`, `Filter`, `Envelope`, `LFO`, `Sequencer` — against an `OfflineAudioContext` using two shims:

**AudioEngine shim:**
```js
{ context: offlineCtx, fxBus: gainNode → offlineCtx.destination }
```
`Track` and `Filter`/`FX` nodes call `audio.context` and `audio.fxBus`. This satisfies both without any changes to production code.

**Clock shim:**
```js
{ bpm, ticksPerBeat: 4, _secondsPerTick (getter), register(){}, unregister(){}, audio: audioShim }
```
The shim exposes `clock.audio.context.currentTime` which `Sequencer._fireStep` reads for the trig-glow animation. Without this the shim throws on every step fire. The `register/unregister` no-ops mean the sequencer never starts its tick loop — tests drive timing manually.

### `renderSteps(track, ctx, sampleRate, n, stepSec, stepBuilder)`

Calls `track.sequencer._fireStep(step, t)` directly for `n` steps spaced `stepSec` apart, then calls `ctx.startRendering()`. Returns `n` `Float32Array` windows sliced to `[stepSec * sampleRate]` samples each. This bypasses the Clock's `setTimeout` loop entirely and gives sample-accurate control over scheduled times.

### Why `_fireStep` directly?

`_fireStep` is the real production code path for p-locks and LFO routing — it builds the `envOverrides` map, dispatches p-locks by `plockMode`, calls `lfo.noteOn/noteOff`, and fires the voice pool. Testing through it exercises the full dispatch chain without needing wall-clock scheduling.

---

## Measurement functions

### `rms(buf)`
Root mean square. Used for amplitude-level comparisons (LFO on output.level, output.level p-lock).

### `bandEnergy(buf, sampleRate, loHz, hiHz)`
FFT-based energy in a frequency band. Buffer is peak-normalised before FFT to prevent overflow in high-amplitude resonators (Karplus, Comb). Used for filter cutoff tests and drive/saturation tests where the direction of change matters more than absolute values.

### `bandpassRms(buf, sampleRate, centerHz, bwOctaves=1)`
**Primary tool for pitch-presence tests.** Time-domain two-pole Butterworth IIR bandpass. Measures RMS amplitude in a frequency band independent of window length — unlike FFT-based energy, this does not scale with the number of cycles in the window. A 261 Hz sine and a 1047 Hz sine of the same amplitude produce the same total RMS but very different `bandpassRms` at 261 Hz.

**Why not `bandEnergy` for pitch tests?**
`bandEnergy` squares the FFT bins, so a 1047 Hz (C6) tone in a 0.3s window produces ~16× as many cycles — and therefore ~16× the accumulated squared energy in its fundamental bin — compared to a 261 Hz (C4) tone at the same amplitude. This caused every pitch-direction test to fail (C6 appeared louder than C4 in C4's own frequency band). `bandpassRms` avoids this entirely.

---

## Per-suite test strategy

### LFO core (`tests/lfo.js`)

| Test | Method | Rationale |
|---|---|---|
| depth=0 → consistent RMS | `rms` per step, check max deviation < 10% | Baseline: no modulation should produce flat output |
| depth=100 → RMS variation | `rms` max/min ratio > 1.15 | At 3 Hz, each 0.25s step catches a different LFO phase — loudest vs quietest should differ by > 15% |
| TRG mode deterministic | Two identical renders, `rms` per step must match ±5% | Phase reset on every note means the LFO starts from the same point each hit |

**Target param:** `output.level` — chosen because it is a direct AudioParam connection (`plockMode: 'audioParam'`, `resolveAudioParam` returns `outputGain.gain`). `filter.cutoff` uses `plockMode: 'envelope'` which routes through `scheduleNote()`, creating contention with the envelope's own filter frequency scheduling.

**Removed test:** "LFO depth=100 mean differs from depth=0 mean" — a symmetric sine LFO at depth=100 averages to zero modulation over a full cycle, so the mean RMS across 4 steps is identical for both. The max/min ratio test captures the same information more robustly.

### LFO machine params (`tests/lfo_machine_params.js`)

One test file that covers every `modulatable: true` param that has an AudioParam backing (`resolveAudioParam ≠ null`) across all machines and the shared signal chain (Filter, DelayFX, BitcrushFX, ReverbFX, amp.pan).

**Exclusions (by design):**
- JS-only params (`plockMode:'js'`, `resolveAudioParam → null`): `CombMachine.decay/mix`, `NoiseMachine.color`, `SwarmMachine.spread/noise.amount/noise.color`, `SampleSwarmMachine.spread/swarm.detune/noise.amount/noise.color`, `ChordMachine.spread`, `TransientMachine.pitch`, `FMMachine.op*.ratio`. The LFO cannot write to these via WebAudio.
- `filter.cutoff`: envelope ramps overwrite it (see §"Known limitations").
- `output.level` on synth: already covered in `lfo.js`.
- `wt-sampler.morph`: AudioWorklet not available in OfflineAudioContext.

**Test approach:**
- **Level params** (output.level, sub.level, op*.level, body.level, crush.wet, delay.wet, reverb.wet, etc.): `rms` max/min ratio > 1.08–1.12 across 4 steps at 3 Hz LFO.
- **Frequency params** (tune, cutoff, tone, freq1/2, etc.): `bandEnergy` in the relevant band, max/min ratio > 1.10.
- **Detune / pitch-drift params** (osc.detune, op*.detune): `bandpassRms` at the note fundamental, or just confirms RMS > 0 (detune can't silence).
- **Structural params** (delay.time, crush.rate, reverb.damp, delay.feedback): confirms RMS > 0 (signal reaches output with LFO connected).

### P-locks (`tests/plocks.js`)

| Test | What it checks | Key setup |
|---|---|---|
| `filter.cutoff` p-lock applies | Even steps (cutoff=400) vs odd steps (cutoff=12000): odd steps have more 1–8kHz energy | `filter.envAmount=0`, `fenv.*` zeroed to prevent filter envelope from sweeping cutoff |
| `filter.cutoff` p-lock restores | Step 0 (baseline) → Step 1 (p-lock) → Step 2 (baseline): Step 2 energy < 80% of Step 1 | Same envelope suppression as above |
| `output.level` p-lock | Baseline level=0.2 vs p-locked level=1.0: p-locked steps > 1.5× louder | Straightforward `rms` comparison |
| Note p-lock (pitch) | C3 (48) vs C6 (84) alternating: `bandpassRms` at 131 Hz >> for C3 | Sine waveform, sub off, 4-octave gap, narrow band centred on C3 fundamental |

**Why filter envelope must be suppressed in cutoff tests:**
`filter.cutoff` p-locks use `plockMode: 'envelope'` — they arrive as `envOverrides['filter.cutoff']` in `scheduleNote()`. The filter envelope (`fenv.*`) also modulates `filter.node.frequency` in the same `scheduleNote` call. If the fenv decay is non-trivial, it sweeps the cutoff during the measurement window, obscuring the p-lock value. Setting `fenv.attack=0.001, fenv.decay=0.001, fenv.sustain=0` collapses the filter envelope to an inaudible blip at note-on.

### Machine tests (`tests/machines/*.js`)

Every machine has at minimum:
- **"produces audible output"** — 4 steps, assert `rms > threshold` on each window. Catches: machine not producing any sound, VoicePool not firing, envelope stuck at 0.

Machines with pitch-tracking also have:
- **"C4 has more amplitude at its fundamental than C6"** — `bandpassRms` at 261 Hz, note=60 vs note=84. The ratio threshold is 2× for resonators (Karplus, Comb — feedback can blur the fundamental) and 3× for oscillator-based machines.

Additional machine-specific tests:

| Machine | Extra test | Method |
|---|---|---|
| SynthMachine | Sawtooth has more 2nd harmonic (522 Hz) than sine | `bandpassRms` at 522 Hz |
| KickSilkMachine | Low-freq energy at attack (20ms window, punch=0) | `bandEnergy` 20–300 Hz |
| KickSilkMachine | Higher tune → more energy in 80–200 Hz band | `bandEnergy` comparison |
| BassMachine | Drive increases energy above 1kHz | `bandEnergy` 1–10kHz |
| HiHatMachine | Energy concentrated in high frequencies | `bandEnergy` hi > lo |
| CymbalMachine | Energy concentrated in high frequencies | `bandEnergy` hi > lo |
| SnareMachine | Mid-frequency energy present | `bandEnergy` 200–4kHz > 0 |
| FMMachine | op2.level=1 spreads sidebands above 1kHz | `bandEnergy` 1–10kHz wet >> dry |

### Loudness normalisation (`tests/machines/loudness.js`)

A pass/fail guard built on the same model as the manual loudness BENCH (`tests/loudness.html`),
turning its measurement into a regression test. Each machine renders through the production stack
(filter wide open, FX off, 8 hits @ note 60 / vel 100) — i.e. *after* its `LOUDNESS_TRIM` is applied.

- **Tonal/sustained machines** (synth, fm, wavetable, bass, marimba, comb, chord, strings, **moogish**,
  swarm, karplus, kick.silk) must land within **0.5×–2.2×** of the MEDIAN trimmed RMS. The band is wide
  on purpose: it catches a *gross* mistune (a missing or zero trim → ≫2×), not small drift. A failure
  means "re-run tests/loudness.html and update that machine's `LOUDNESS_TRIM`".
- **Percussion** (kick.hard, snare, hihat, cymbal, clapp, wood, noise, transient) is intentionally
  *below* median RMS — the bench caps their trim so transient peaks keep headroom — so they are held
  only to a **peak ceiling** (< 1.0 linear) + audibility, not the band.
- Catches: a new machine added without a tuned trim (defaults to 1.0 → usually fails the band), or a
  synthesis change that shifts a machine's level. Each machine is rendered once (cached) across its tests.
- **Reference velocity is 127 (full).** The bench and the guard fire at velocity 127 because the trims
  are calibrated against full-scale note output. `_fireStep` now honours per-voice velocity (the Envelope
  always scales amp by `velocity/127`), so firing at a lower velocity would scale every measurement and
  invalidate the calibration. `makeStep`'s default velocity is likewise 127.
- **Noise is deterministic IN TESTS.** The runner calls `seedNoiseRandom()` once at the top of `runAll()`,
  swapping the `Math.random` source inside `getNoiseBuffer` (white) and `makePinkBuffer` (analogue/pink) for
  a seeded mulberry32 PRNG. White/pink noise is statistically identical regardless of seed, but fixed content
  makes peak/RMS reproducible — without it the peak-ceiling and noise-variance tests flaked on an unlucky
  draw (results differed run-to-run and Chrome vs Firefox). **Production keeps `Math.random`** — analogue
  voices must vary (seeding it made the 8 moogish pool voices share one buffer → audible "every-8th-note"
  artifact). Per-voice tolerance/drift (`AnalogueParts.rand` / `DriftClock`) stays random in both.

---

## Known limitations

**`wt-sampler` not tested.** Uses an AudioWorklet processor (`wavetable-sampler-processor.js`). AudioWorklet is not available in `OfflineAudioContext` in Firefox. Machine produces silence in tests; excluded from index.html.

**`sampler` not tested.** Requires loading an audio file or mic input before it produces sound. No mechanism to inject a buffer in the test harness currently.

**`sample-swarm` tested with synthetic buffer.** Unlike `sampler`, the machine architecture allows injecting a programmatically created `AudioBuffer` via `track.machine.setBuffer()`. Tests create a 0.5s sine tone as the source buffer. LFO tests for `height` and `output.level` (both AudioParam-backed) are included in `lfo_machine_params.js`; `spread`, `swarm.detune`, `noise.amount`, and `noise.color` are JS-only and cannot carry a Web Audio LFO.

**filter.cutoff LFO not directly testable.** The `filter.cutoff` param uses `plockMode: 'envelope'` — it is modulated via scheduled `linearRampToValueAtTime` calls in `Envelope.scheduleNote`, not via a permanent LFO → AudioParam connection. The LFO does connect to `filter.node.frequency` via `resolveAudioParam`, but the envelope's ramps overwrite it. The LFO tests use `output.level` instead, which has a clean direct AudioParam connection.

**Machine p-locks target the firing voice, not slot 0.** In the 8-voice pool, each voice owns its own machine + filter and the sequencer round-robins which slot plays each step. `_fireStep` therefore collects machine-owned p-locks (`audioParam` and `js` modes) and applies them to the *actual firing voice's* machine inside the voice loop (after `syncParamsAt`), not to canonical slot 0. Filter p-locks reach every slot because the canonical filter mirrors `setParam` to its siblings (`Filter.mirrorTo`); pan/FX p-locks hit shared post-pool nodes. A reused voice carries the canonical baseline via `nextVoice()` → `fromJSONSafe` + `copyAudioParamState`, then `syncParamsAt(time)` schedules it at note start. The `output.level` / `filter.cutoff` p-lock tests fire 8 steps (spanning all slots) and rely on this behaviour — before it, p-locks landed on slot 0 while a different slot played, so they failed deterministically.

**Chance and condition steps not tested.** `Step.chance < 100` and ratio conditions are JS-only and non-deterministic. They are excluded from the current test suite.

**Retrigger not tested.** No test for `step.retrigger` behaviour.

---

## Calibration history (lessons)

- **FFT energy scales with cycle count** — the first pitch tests used `bandEnergy` and consistently showed higher notes as "louder" in low-frequency bands. Replaced with `bandpassRms`.
- **FFT overflow on resonators** — Karplus/Comb feedback loops produce large amplitude values. Fixed by peak-normalising the buffer before FFT in `bandEnergy`.
- **Filter default cutoff (8kHz) masks spectral differences** — early tests measured spectral centroid and got ~11kHz regardless of note or settings (the filter ceiling dominated). Fixed by calling `track.filter.setParam('filter.cutoff', 20000)` in every test.
- **Symmetric LFO mean is identical to baseline** — a full-cycle sine LFO averages to zero modulation. Switched from mean-difference test to max/min-ratio test.
- **Filter envelope contaminates cutoff p-lock tests** — `fenv.*` sweeps the same AudioParam that cutoff p-locks write to. Fixed by zeroing the filter envelope in cutoff tests.
- **`clock.audio` was null** — the clock shim originally set `audio: null`. `Sequencer._fireStep` reads `this.clock.audio.context.currentTime` for the trig-glow animation, throwing on every test. Fixed by assigning `clock.audio = audioShim` after both are created.
