# Machines

All machines extend `Machine.js`. To add a new machine type: create one file, register it in `Track.js`'s MACHINES map and in `SynthPanel.MACHINE_DEFS` — nothing else changes.

Custom SYNTH tab UIs live in `js/ui/panels/<MachineName>Panel.js`. Machines with no custom layout use `DefaultMachinePanel`.

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

### KickMachine (`type: 'kick'`) — backward compat alias
Re-exports `KickSilkMachine`. Existing saved projects with `type:'kick'` load as Kick Silk.

### SnareMachine (`type: 'snare'`)
```
OscillatorNode (triangle) → bodyGain ─┐
AudioBufferSourceNode → HP filter     │
                      → noiseGain ───┴→ outputGain → [Filter]
```
Parameters: `tune` (Hz), `decay`, `tone` (body level), `snap` (noise level), `noise.cutoff` (Hz), `output.level`

### HiHatMachine (`type: 'hihat'`)
```
Osc×6 (square, inharmonic ratios) → mixGain → HP filter → ampGain (exp decay) → outputGain → [Filter]
```
Parameters: `decay`, `open.decay`, `open` (boolean), `cutoff` (HP Hz), `tone` (HP Q), `output.level`

### CymbalMachine (`type: 'cymbal'`)
Crash / ride cymbal. 6 inharmonic square oscillators at metallic ratios → HPF (tone) → resonant bandpass (body) → per-note exponential decay.
Three decay tiers: `closed`, `mid`, `open` — selected by `mode` enum p-lockable per step.
Parameters: `tune` (base Hz, LFO+plock), `tone` (HP cutoff, LFO+plock), `body` (BP center, LFO+plock), `resonance` (BP Q, LFO+plock), `decay`, `mid.decay`, `open.decay`, `mode`, `output.level`.

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
