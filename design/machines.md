# Machines

All machines extend `Machine.js`. To add a new machine type: create one file, register it in `Track.js`'s MACHINES map and in `SynthPanel.MACHINE_DEFS` — nothing else changes.

Custom SYNTH tab UIs live in `js/ui/panels/<MachineName>Panel.js`. Machines with no custom layout use `DefaultMachinePanel`.

---

## Loudness Normalisation (per-machine trim)

Machines were built with mismatched internal amp scaling, so at equal `output.level` they
came out up to ~30× apart in perceived loudness. Each machine carries a **fixed trim gain**
that normalises it to a common reference.

- Factors live in `js/machines/LoudnessTrim.js` (`LOUDNESS_TRIM` map keyed by machine type,
  `1.0` = no change). `makeTrimGain(context, type)` builds the node.
- Each machine creates `this._trimGain = makeTrimGain(...)` right after `outputGain`, wires
  `outputGain → _trimGain`, and connects `_trimGain` (not `outputGain`) in `connect()`.
- The trim is a **dedicated node downstream of `outputGain`** so it is never touched by
  `output.level`, p-locks, or LFOs (all of which target `outputGain.gain`).
- **Derivation:** measured by `tests/loudness.html` (the loudness bench). Target = median RMS
  of the set (≈0.068). Factor = target / machine RMS, except spiky percussion (clapp, snare,
  cymbal, hihat, noise, wood) whose factor is capped so the projected peak stays ≤ 0.90 —
  they sit slightly below median RMS by design. **Re-run the bench after changing any
  machine's synthesis and update the factor.** See `design/tests.md`.
- **New machine:** add an entry to `LOUDNESS_TRIM` (start at 1.0), run the bench, set the value.

---

## Drum Machine Architecture

KickMachine, SnareMachine, and HiHatMachine are **self-enveloping**: they manage their own
amp envelope internally and do not rely on the track's `Envelope` for amplitude shaping.
The track `Envelope` and `Filter` nodes are still in the signal chain and can be used for
additional tonal shaping, but drum voices sound correct with the track envelope at default settings.

All drum machines follow the same `noteOff` convention: it is a no-op. The sequencer still
calls it; the machines simply ignore it. Decay is controlled entirely by internal gain ramps
scheduled in `noteOn`.

**Shared noise buffer pattern:** KickMachine and SnareMachine each cache one `AudioBuffer`
of white noise at module scope (not per-instance). The buffer is generated once on first use
and reused across all `noteOn` calls via `AudioBufferSourceNode` (which is one-shot by spec,
so a new source node is created each hit pointing at the shared buffer).

---

## Drum Machines

### KickSilkMachine (`type: 'kick.silk'`)
Clean, round kick. No saturation.
```
OscillatorNode (sine) → bodyGain (exp decay) ─┐
AudioBufferSourceNode → punchGain (exp decay) ─┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `punch`, `punch.decay`, `output.level` (LFO+plock)

### KickHardMachine (`type: 'kick.hard'`)
Fat, saturated kick with sub oscillator and waveshaper drive.
```
_tuneOsc (sine, persistent) → bodyGain (2× vel, exp decay) ─┐
_subOsc  (sine, tune/2)     → subGain  (sub.level×2×vel)   ─┼→ WaveShaperNode (tanh, 4× oversample) → outputGain → [Filter]
AudioBufferSourceNode       → punchGain (bypasses shaper)   ─┘
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `sub.level` (plock), `drive` (1–6, plock — rebuilds curve, not LFO-able), `punch`, `punch.decay`, `output.level` (LFO+plock)

Note: `sub.level` and `drive` are p-lockable (`plockMode: 'js'`) but not LFO-assignable — they are read per-hit, not as live AudioParams.

### AnalogueKickMachine (`type: 'kick.analogue'`)
Analogue-modelled counterpart to KickHard — the same three-layer structure, but
every layer is given PATINA "analogue" character via the shared `AnalogueParts.js`
helpers (see Analogue Machines below). The body/sub use imperfect-sine
`PeriodicWave`s (not textbook sines), a fixed per-instance tuning tolerance is
baked in at construction, a `DriftClock` wanders the body/sub `detune` ~12×/s
(scaled by `drift`), and the punch transient is **pink** noise instead of white.
```
_tuneOsc (imperfect-sine, persistent, +tol/drift on detune) → bodyGain (2× vel, exp decay) ─┐
_subOsc  (imperfect-sine, tune/2)                            → subGain  (sub.level×2×vel)   ─┼→ WaveShaperNode (tanh, 4× oversample) → outputGain → [Filter]
AudioBufferSourceNode (pink)                                 → punchGain (bypasses shaper)   ─┘
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `sub.level` (plock), `drive` (1–6, plock — rebuilds curve, not LFO-able), `drift` (0–1, plock — read by DriftClock), `punch`, `punch.decay`, `output.level` (LFO+plock). The per-note pitch sweep writes `.frequency` while drift writes `.detune`, so the two stack without fighting. `drive` defaults lower (2.5) and `tune` lower (55 Hz) than KickHard for a rounder analogue character.

### KickMachine (`type: 'kick'`) — backward compat alias
Re-exports `KickSilkMachine`. Existing saved projects with `type:'kick'` load as Kick Silk.

### SnareMachine (`type: 'snare'`)
```
OscillatorNode (triangle) → bodyGain ─┐
AudioBufferSourceNode → HP filter     │
                      → noiseGain ───┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz), `decay`, `tone` (body level), `snap` (noise level), `noise.cutoff` (Hz), `output.level`

### AnalogueSnareMachine (`type: 'snare.analogue'`)
Analogue counterpart to Snare via the shared `AnalogueParts.js` helpers (see Analogue Machines below): the body oscillator is an imperfect-triangle `PeriodicWave` with a per-instance tuning tolerance and a `DriftClock` wandering its `detune` (scaled by `drift`), and the "snares" use **pink** noise (`makePinkBuffer`) instead of white. Same two-layer structure and per-note decay amps as Snare.
```
_tuneOsc (imperfect tri, +tol/drift) → _toneGain → _bodyAmp ─┐
_noiseSrc (pink, loop) → _noiseHP → _snapGain → _noiseAmp ───┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `tone` (LFO+plock), `snap` (LFO+plock), `noise.cutoff` (LFO+plock), `drift` (0–1, plock — read by DriftClock), `output.level` (LFO+plock).

### HiHatMachine (`type: 'hihat'`)
```
Osc×6 (square, inharmonic ratios) → mixGain → HP filter → ampGain (exp decay) → outputGain → [Filter]
```
Parameters: `decay`, `open.decay`, `open` (boolean), `cutoff` (HP Hz), `tone` (HP Q), `output.level`

### AnalogueHiHatMachine (`type: 'hihat.analogue'`)
Analogue counterpart to HiHat via the shared `AnalogueParts.js` helpers. The six oscillators are imperfect **squares**; each oscillator's inharmonic ratio gets a fixed per-instance tolerance nudge (±0.6%) so the metallic cluster differs per instance, and a `DriftClock` wanders all six detunes (scaled by `drift`). Same HP-filtered cluster + per-note amp as HiHat.
```
Osc×6 (imperfect square, +ratio-tol, +drift) → mixGain → HP filter → ampGain (exp decay) → outputGain → [Filter]
```
Parameters: `decay`, `open.decay`, `open` (boolean), `cutoff` (HP Hz, LFO+plock), `tone` (HP Q, LFO+plock), `drift` (0–1, plock — read by DriftClock), `output.level` (LFO+plock).

### CymbalMachine (`type: 'cymbal'`)
Crash / ride cymbal. 6 inharmonic square oscillators at metallic ratios → HPF (tone) → resonant bandpass (body) → per-note exponential decay.
Three decay tiers: `closed`, `mid`, `open` — selected by `mode` enum p-lockable per step.
Parameters: `tune` (base Hz, LFO+plock), `tone` (HP cutoff, LFO+plock), `body` (BP center, LFO+plock), `resonance` (BP Q, LFO+plock), `decay`, `mid.decay`, `open.decay`, `mode`, `output.level`.

### AnalogueCymbalMachine (`type: 'cymbal.analogue'`)
Analogue counterpart to Cymbal via the shared `AnalogueParts.js` helpers (see Analogue Machines below). The six oscillators are imperfect **squares**; each gets a fixed per-instance ratio-tolerance nudge (±0.5%) and a `DriftClock` wanders all six detunes (scaled by `drift`). Same HPF → BP topology and closed/mid/open tiers as Cymbal. `tune` (manualTarget) writes each osc's `.frequency` by its tolerance-skewed ratio; drift writes `.detune`, so the two coexist.
Parameters: as Cymbal, plus `drift` (0–1, plock — read by DriftClock).

### AnalogueTomMachine (`type: 'tom.analogue'`)
Tuned analogue drum — there is **no digital "Tom" machine**; this is a focused single-body pitched drum, closest in structure to the analogue kick but tuned higher, with no sub and a soft pink-noise attack rather than a hard punch. The body is an imperfect-sine `PeriodicWave` with a per-instance tuning tolerance and a `DriftClock` on its `detune` (scaled by `drift`); a per-note pitch sweep writes `.frequency` (drift writes `.detune` — no conflict). The body passes through a soft-clip waveshaper.
```
_tuneOsc (imperfect sine, +tol/drift) → _bodyGain (per-note) → _shaper → outputGain → [Filter]
PinkNoiseSource (per-note) → _attackGain (bypasses shaper) ───────────────────────────┘
```
Parameters: `tune` (Hz, LFO+plock), `decay`, `sweep`, `drive` (1–4, plock — rebuilds curve), `drift` (0–1, plock), `attack` (pink-noise attack level), `attack.decay`, `output.level` (LFO+plock).
**Loudness:** brand-new voice with no digital sibling — its `LOUDNESS_TRIM` is a placeholder (1.0) and **must** be measured on `tests/loudness.html`.

### WoodMachine (`type: 'wood'`)
Clave / wood block / rimshot / cowbell. Two resonant bandpass filters (ring1, ring2) driven by a looping noise source through per-note decay gains, plus a sine click burst. `mix` knob blends between the two resonator bands.
Internal amplitude is scaled ×2 vs velocity (hardcoded in `noteOn`) so the machine sits at a comparable level to other drums without requiring the `output.level` knob to be cranked.
Parameters: `freq1`, `freq2`, `ring` (Q), `mix`, `decay`, `click`, `click.freq`, `output.level`. Frequencies and ring Q are LFO+plock targets.

### ClappMachine (`type: 'clapp'`)
808-style synthesized clap. Three short noise bursts staggered by `spread` ms simulate the layered hand-clap character of a TR-808. All bursts pass through a shared persistent bandpass filter.
```
AudioBufferSourceNode × 3 (one-shot) → BandpassFilter (persistent) → ampGain (per-burst exp decay) → outputGain → [Filter]
```
First two bursts are short transients (~12 ms); the third carries the decay tail. `spread` controls the inter-burst gap (0–30 ms).
Parameters: `tone` (BP center Hz, LFO+plock), `snap` (BP Q, LFO+plock), `decay`, `spread`, `output.level`.

### AnalogueClappMachine (`type: 'clapp.analogue'`)
Analogue counterpart to Clapp via the shared `AnalogueParts.js` helpers. Same three-burst 808 structure, but the noise is **pink** (`makePinkBuffer`) instead of white — rounding off the harsh top of a white-noise clap — and a fixed per-instance jitter (±8%) on the inter-burst gap keeps the layered claps from sounding mechanically even. No persistent oscillators, so no DriftClock (there is no pitched layer to wander).
Parameters: as Clapp (`tone`, `snap`, `decay`, `spread`, `output.level`).

### TransientMachine
Transient-focused drum machine (details TBD).

### NoiseMachine
Noise-based machine (details TBD).

---

## Melodic / Synth Machines

### SynthMachine (`type: 'synth'`)
Main oscillator + sub-oscillator, waveform select.

`osc.detune` is hidden from the SYNTH tab UI (via `hidden: true`) and rendered instead in the **TRIG tab**. P-lockable, LFO-assignable.

### FMMachine (`type: 'fm'`)
4-operator FM synth; per-op ADSR envelopes.
Custom panel: `FMPanel.js` — schematic + 2×2 operator grid.

### BassMachine (`type: 'bass'`)
Dedicated bassline voice. Persistent sawtooth/square main oscillator + sine sub (2 octaves below) through a hard-clip tanh WaveShaperNode. Built-in portamento: `glide` (ms) causes `exponentialRampToValueAtTime` between consecutive notes. `accent` threshold: velocity ≥ threshold boosts output +50% for that step, then restores.
Parameters: `osc.detune` (hidden, trig tab), `waveform`, `sub.level`, `drive` (rebuilds curve, JS), `glide` (JS), `accent` (JS), `output.level`.

### KarplusMachine (`type: 'karplus'`)
Karplus-Strong plucked string synthesis. Per-note: short noise burst (exciter) feeds a tuned comb filter (DelayNode + LP feedback loop). Delay time is computed from MIDI note at noteOn for accurate pitch. Self-decaying — track Envelope is optional.
Parameters: `damping` (LP cutoff in feedback), `feedback` (ring length), `excite` (burst length ms), `excite.tone` (LP on burst), `stretch` (feedback detune for chorus), `output.level`. All JS-only except `output.level`.

### CombMachine (`type: 'comb'`)
Pitched resonator — bell, marimba, gamelan, music box. Two decaying sinusoidal partials are pre-synthesised into an AudioBuffer on each noteOn (same stable approach as KarplusMachine — no DelayNode feedback loop). Partial 1 is the MIDI note fundamental; partial 2 is `fundamental × ratio`. Inharmonic ratios produce bell tones; harmonic ratios (2.0, 4.0) produce vibraphone or marimba. A short bandpass noise burst provides the strike transient. Self-decaying — track Envelope is optional.
Parameters: `ratio` (partial 2 frequency multiplier, 0.5–8), `decay` (partial 1 decay seconds), `decay2` (partial 2 decay relative to decay, 0.1–2×), `mix` (0=p1 only, 1=p2 only), `strike` (noise burst level), `output.level`.

### ChordMachine (`type: 'chord'`)
Four-voice chord synthesizer. Four persistent oscillators tuned to chord intervals above the played root. 11 chord types: major, minor, dom7, maj7, min7, sus2, sus4, dim, aug, power, octave. `inversion` (0–3) rotates the lowest voice up one octave per step. `spread` adds symmetric per-voice detune for stereo width. Both `chord` and `inversion` are p-lockable per step — enables chord progressions from a single track.
Parameters: `osc.detune` (hidden, trig tab), `chord` (enum), `inversion` (JS), `spread` (JS, LFO-assignable), `waveform`, `output.level`.

### WavetableMachine (`type: 'wavetable'`)
Wavetable oscillator with continuous morphing. 8-entry wavetable bank built from `PeriodicWave` (Sine, Triangle, Sawtooth, Square, Pulse25, Bright Saw, Hollow, Vocal/Formant). Two persistent oscillators (_oscA, _oscB) hold adjacent table entries; crossfade GainNodes blend between them. `pos` param (0–7 float) drives the morph — ideal LFO target for wavetable sweeps.
Sub oscillator (sine, one octave below) mixed independently.
Parameters: `osc.detune` (hidden, trig tab), `pos` (JS-only plock, not LFO-assignable — PeriodicWave swap has no AudioParam), `sub.level`, `output.level`.

### StringsMachine (`type: 'strings'`)
Bowed / plucked string-section synthesizer. A persistent unison stack of detuned sawtooth oscillators (the "section") is summed → body bandpass (wooden resonance) → tone lowpass (brightness), with looped band-limited bow noise mixed in and a shared internal vibrato LFO modulating every osc's `detune`. Sustained/pad-style — amplitude is gated by the track Envelope (like Synth/Chord); `noteOn` retunes the section, `noteOff` is a no-op.
`mode` (enum) selects instrument character — `violin` (+12 st, tight), `viola` (mid), `cello` (−12 st, with an added octave-down voice), `ensemble` (wide, extra octave-up + octave-down voices). Each mode sets an octave shift, its unison voice offsets, and a relative ensemble-spread scaler. `MAX_VOICES` oscillators are allocated up front; voices unused by the active mode are silenced via per-voice gains (persistent-oscillator architecture).
Parameters: `mode` (enum, JS), `osc.detune` (hidden, trig tab — manualTarget, applied via `_applyTuning` to preserve per-voice spread), `ensemble` (JS, LFO-assignable — recomputes section detune), `tone`, `body`, `resonance`, `bow`, `vibrato` (depth ¢, drives `_vibratoGain.gain`), `vibrato.rate` (drives `_vibratoOsc.frequency`), `output.level`. Everything except `mode` is LFO/p-lock assignable.

---

## Analogue Machines

Machines adapted from the PATINA analog-modelling engine (`js/patina/`). They reproduce
PATINA's *oscillator* character (imperfect spectra, thermal drift, component tolerance,
circuit hiss) but deliberately rely on Webtakt's own Filter / Envelope / LFO / FX rather
than PATINA's built-in versions — so every existing GUI tab, p-lock and LFO destination
drives them with no machine-specific UI. Shown under the **Analogue** group in the MACHINE tab
(the analogue **drums** — kick, snare, hi-hat, tom, clap, cymbal — live in the Drums group, since they are percussion voices, not osc voices; only Moogish sits in the Analogue group).

**Shared toolkit — `AnalogueParts.js`.** The reusable analogue building blocks were extracted
out of MoogishMachine into `js/machines/AnalogueParts.js` so every analogue machine imports them
rather than carrying private copies:
- `makeImperfectWave(ctx, type, {tolerance, pulseWidth})` — the imperfect-spectrum `PeriodicWave`.
- `makePinkBuffer(ctx, seconds)` — Paul-Kellet pink noise (circuit hiss / drum noise colour).
- `DriftClock(ctx, detuneParams, {baseFor, amountFor, …})` — graph-agnostic thermal-drift clock:
  bounded random walk on a set of oscillator `detune` params; the caller supplies the per-osc
  *base* detune via `baseFor(i)` and the max wander via `amountFor()`. Owns its own `setInterval`
  (call `.stop()` in the machine's `disconnect()`).
- `rand` / `clamp` helpers.

The full analogue family — MoogishMachine plus the analogue drums (Kick, Snare, HiHat, Tom, Clapp,
Cymbal) — all build on these helpers: imperfect spectra + drift on every pitched/metallic voice,
plus pink noise wherever a noise layer exists (kick punch, snare snares, tom attack, clap bursts),
rather than re-porting from PATINA. Any further analogue voices should follow the same pattern.

The analogue *ladder* filter (PATINA's self-oscillating transistor ladder) is now available as
the `filter.engine: analogue` option in the FILTER pane, app-wide (any track, not just Moogish) —
see `design/audio-signal-chain.md` → Filter Engine. Pairing Moogish with the analogue ladder gives
the most complete PATINA emulation (imperfect oscillators + Moog ladder); Moogish also works fine
through the default digital biquad filter.

### MoogishMachine (`type: 'moogish'`)
Analogue-modelling oscillator voice — the tone-generator section of PATINA. Three persistent
main oscillators (each with its own *imperfect* `PeriodicWave`: harmonic-amplitude tolerance,
even-harmonic leakage on squares, phase smear, gentle HF slew-limiting — ported from PATINA's
`makeImperfectWave`) + a sine sub one octave below osc1 + a looped pink-noise hiss layer, summed
into a mix bus → `outputGain` → `_trimGain` → [Filter]. A `DriftClock` (from `AnalogueParts.js`,
≈12×/s, like SwarmMachine) applies a bounded random-walk to every oscillator's `detune`, scaled by
`drift`; the per-osc *base* detune it wanders around is supplied by `_driftBase(i)`. Fixed
per-instance "component tolerance" tuning offsets are baked in at construction so two instances
differ subtly. Persistent-oscillator architecture (like Synth/Strings/Chord): amplitude is gated by
the track Envelope; `noteOn` retunes via `_retune`, `noteOff` is a no-op. The drift clock is
released via `this._drift.stop()` in `disconnect()` (un-released timers leak — see Machine base note).
Parameters: per-osc `oscN.waveform` (enum: saw/square/triangle/pulse/sine, JS), `oscN.octave`
(−2..+2, JS — retunes), `oscN.detune` (±50 ¢, manualTarget — retunes, preserves master detune),
`oscN.level` (drives that osc's gain); `sub.level`, `noise.level`, `drift` (0–1, JS), `osc.detune`
(hidden, trig tab — manualTarget master detune), `output.level`. All level/detune params are
LFO/p-lock assignable; waveforms, octaves and drift are JS-only. Presets are recreated as saved
SoundLibrary snapshots (machine + Filter + Envelope together), not a machine-level dropdown.

---

## Sampler Machines

### SamplerMachine (`type: 'sampler'`)

Audio sample playback triggered per step. Self-enveloping (like drum machines): amplitude is set via `outputGain.gain.setValueAtTime` at each noteOn; `noteOff` is a no-op.

One `AudioBufferSourceNode` is created per noteOn (Web Audio spec: source nodes are single-use). The previous source is stopped before the new one starts.

```
AudioBufferSourceNode (per-note) → outputGain → [Filter]
```

**Parameters:**
| Path | Range | Default | Description |
|---|---|---|---|
| `sample.start` | 0–1 | 0 | Normalized start trim point |
| `sample.end` | 0–1 | 1 | Normalized end trim point |
| `sample.loopStart` | 0–1 | 0 | Normalized loop-resume point: first pass plays from `start`, subsequent loops restart here. Allows an intro region that only plays once (e.g. "doooo" → loops "oooo"). Clamped to `[start, end]` at playback time. |
| `sample.speed` | 0.125–4 | 1 | Playback rate multiplier |
| `sample.pitch` | boolean | true | When true: transpose pitch from `sample.root` per MIDI note |
| `sample.root` | 0–127 | 60 | Root note the sample is tuned to (C4 = 60) |
| `sample.reverse` | boolean | false | Play region backwards |
| `sample.loop` | boolean | false | Loop between loopStart/end |
| `output.level` | 0–1 | 0.85 | Output gain (LFO-assignable) |

**Note behaviour:**
- When `sample.pitch = true`: `playbackRate = sample.speed × 2^((midiNote − sample.root) / 12)`.
- When `sample.pitch = false`: drum mode — MIDI note is ignored, `playbackRate = sample.speed`.
- Velocity scales `output.level`.
- Reverse: rebuilds a reversed `AudioBuffer` slice per noteOn (cheap for trimmed regions).
- Loop: `src.loopStart` = `sample.loopStart × duration`, `src.loopEnd` = `sample.end × duration`. First pass starts from `sample.start`.

**Custom panel:** `SamplerPanel.js` — file picker, mic record, waveform + trim handles, params row.

**Files:** `js/machines/SamplerMachine.js`, `js/state/SampleStore.js`, `js/ui/panels/SamplerPanel.js`

---

### WavetableSamplerMachine (`type: 'wt-sampler'`)

Two-sample wavetable machine. Loads sample A and sample B, then morphs between them per-sample using an `AudioWorkletNode`. Self-enveloping.

```
AudioWorkletNode (persistent) → outputGain → [Filter]
```

The worklet receives two `Float32Array[]` channel arrays via its `port`. On each `process()` call it linearly interpolates between the two buffers sample-by-sample, driven by the `morph` AudioParam. A single playhead advances through a shared reference length scaled to each buffer's actual length, so both samples stay time-aligned regardless of differing durations.

Reverse playback is implemented by inverting the playback rate in the trigger message (negative rate → processor reads backwards). Loop wraps the playhead back to `startFrac`.

**Parameters:**
| Path | Range | Default | Description |
|---|---|---|---|
| `morph` | 0–1 | 0.5 | Crossfade centre: 0 = full A, 1 = full B. LFO-assignable + p-lockable. |
| `sweep.depth` | 0–1 | 0 | SampleSweep depth: sine LFO amplitude around morph centre (0 = off). |
| `sweep.speed` | 0.05–20 Hz | 0.5 | SampleSweep rate. |
| `sample.startA` / `sample.startB` | 0–1 | 0 | Normalized start of each buffer's playback region |
| `sample.endA` / `sample.endB` | 0–1 | 1 | Normalized end of each buffer's playback region |
| `sample.loopStartA` / `sample.loopStartB` | 0–1 | 0 | Normalized loop-resume point per buffer; first pass plays from start, loops restart here. Clamped to `[startX, endX]`. |
| `sample.speed` | 0.125–4 | 1 | Playback rate multiplier |
| `sample.pitch` | boolean | true | Track MIDI note (true) or fixed pitch (false) |
| `sample.rootA` | 0–127 | 60 | MIDI root of sample A |
| `sample.rootB` | 0–127 | 60 | MIDI root of sample B |
| `sample.loop` | boolean | false | Loop region |
| `sample.reverse` | boolean | false | Reverse playback |
| `output.level` | 0–1 | 0.85 | Output gain. LFO-assignable + p-lockable. |

Pitch interpolation: the effective root is `rootA × (1 − morph) + rootB × morph`.

**Custom panel:** `WavetableSamplerPanel.js` — dual file pickers + morph/speed/level controls.

**Files:** `js/machines/WavetableSamplerMachine.js`, `js/worklets/wavetable-sampler-processor.js`, `js/ui/panels/WavetableSamplerPanel.js`

**Not tested** by the audio test suite (uses AudioWorklet, not supported in OfflineAudioContext).

---

### SampleSwarmMachine (`type: 'sample-swarm'`)

Seven-voice sample swarm. One root voice plays the loaded buffer at nominal pitch; six swarm voices are spread symmetrically above and below it in cents (the `spread` param). All seven sources are `AudioBufferSourceNode` instances spawned fresh per `noteOn` — no persistent oscillators.

Sample controls mirror `SamplerMachine`: `sample.start/end/loopStart/speed/gain/root`, `sample.reverse`, `sample.loop`, `sample.pitch`.

Swarm controls mirror `SwarmMachine`:
- `spread` — cent gap between adjacent pairs (0–100¢)
- `swarm.detune` — random per-trigger jitter added to every voice's initial detune (0–50¢)
- `height` — level of the 6 swarm voices relative to root (0–1), AudioParam-backed
- `noise.amount` — drift depth applied by the `setInterval` drift timer (0–50¢)
- `noise.color` — drift timer rate: 0=slow (800ms), 1=fast (50ms)

Gain architecture: all 7 sources sum into `_mix` (normalised by 1/7), then `outputGain`. Velocity and `sample.gain` are applied to `outputGain` at each `noteOn`.

`syncFrom(other)` copies the `AudioBuffer` reference — used by `VoicePool.nextVoice()` so non-canonical slots stay in sync with slot 0.

**Custom panel:** `SampleSwarmPanel.js` — embeds `SamplerPanel` (waveform + sample controls) above a swarm knob row (Spread, Detune, Height, Noise Amt, Noise Rate).

**Files:** `js/machines/SampleSwarmMachine.js`, `js/ui/panels/SampleSwarmPanel.js`

---

### MidiMachine (`type: 'midi'`)

Routes sequencer note events to a MIDI output port instead of audio. No WebAudio nodes are created beyond a silent `outputGain` placeholder so the normal Track/VoicePool signal chain doesn't break.

**Parameters:**
- `midi.channel` (1–16) — MIDI channel to send on
- `midi.noteOffset` (±24) — semitone offset applied to every outgoing note

**Port selection:** `machine.setOutputPort(portId)` / `machine.getOutputPort()` — selected in MidiPanel.

**noteOn timing:** converts AudioContext-scheduled time to a `setTimeout` delay so notes fire at approximately the right moment. Typical jitter ~1–5 ms — fine for melodic/harmonic MIDI control; not sample-accurate.

**Custom panel:** `MidiPanel.js` — output port dropdown, channel knob, note offset knob, clock sync port dropdown.

**Files:** `js/machines/MidiMachine.js`, `js/ui/panels/MidiPanel.js`, `js/core/MidiEngine.js`

---

## Hidden Param Pattern

Params with `hidden: true` in `getParamList()` are skipped by `_renderParamList` but remain available for p-locking, LFO assignment, and sequencer dispatch. Used for `osc.detune` (moved to TRIG tab). Reuse this pattern for any param that belongs in a different tab from its machine's default grid.

## Declarative Param Spec (`static SPEC`)

A machine can replace its hand-written `setParam`/`getParam`/`getParamList`/`resolveAudioParam`/`toJSON`/`fromJSON` with a single declarative table. Define `static SPEC` (path → entry) and call `this._initSpec()` at the **end of the constructor** (after audio nodes exist); the `Machine` base derives all six members. This is **opt-in and incremental** — machines that don't call `_initSpec()` keep their own methods, so converted and un-converted machines coexist.

**Spec entry fields:**
- *Descriptor* (copied verbatim into `getParamList()` — these names are the contract): `label`, `type` (`'number'`/`'enum'`/`'boolean'`), `min`, `max`, `default`, `options`, `hidden`, `modulatable`, `lfoMin`, `lfoMax`, `plockMode`. `default` doubles as the `_params` init value. `plockMode` defaults to `'audioParam'` if a `target` is present, else `'js'`.
- *Execution*: `target` `(m) => AudioParam` (lazy; drives auto-schedule **and** `resolveAudioParam`); `schedule` `'setTarget'` (default) | `'setValue'`; `tc` (setTargetAtTime time-constant, default `0.005`); `apply` `(value, time, m) => void` (JS side-effect, runs after store); `manualTarget: true` (the `target` is exposed to LFO/`resolveAudioParam` only — `setParam` does **not** auto-schedule it; the `apply` hook owns the write).

**Three action kinds it expresses:** (a) store-only (`plockMode:'js'`, no target/apply); (b) store + schedule AudioParam (`target` + `schedule`); (c) store + JS side-effect (`apply`, e.g. ChordMachine's `_applyChord`). `manualTarget` covers params that are LFO-targetable yet written via a side-effect (ChordMachine `osc.detune`; samplers' `output.level`).

`getParamList()` is **cached on the class** (`constructor._paramListCache`) since the spec is static and the result is read-only — never mutate a returned descriptor array.

**Converted so far (14):** Synth, Snare, Chord, KickSilk, KickHard, HiHat, Clapp, Cymbal, Noise, Karplus, Comb, Marimba, Transient, Wood. **Not converted:** FM (28 params, op*.ratio side-effect vs _baseFreq), Bass (drive curve), Wavetable (PeriodicWave pos swap), the three Samplers (override toJSON/fromJSON with super), Swarm/SampleSwarm (drift timers), Midi (bespoke flat JSON + step/fmt descriptor fields), Drum (stub). Regression-guarded by `tests/tests/machines/param_spec.js`, which asserts each converted machine's `getParamList()`/`resolveAudioParam()`/JSON round-trip against the original hand-written descriptors.
