# Input Machine — Live audio capture as a track source

## Goal
A "machine" that captures live incoming audio (3.5 mm line-in, USB interface, any
device the browser exposes via `getUserMedia`) and feeds it into the normal
per-track signal chain, so it can be filtered, p-locked, LFO-modulated, and run
through the reorderable FX pipeline like any other voice — but without being
"programmed" with notes.

This is the input mirror of `MidiMachine`: that machine produces no audio and
routes notes outward; this one produces continuous *real* audio and ignores
pitch.

## Decisions (settled with the user)
- **Continuous, gate optional.** Input passes through continuously by default
  (like a mixer channel) — the per-voice amp gate is held open. A `gate` toggle
  lets the sequencer/keyboard chop it (trance-gate / gated-reverb).
- **Full feature in one pass**: machine + device/channel picker UI + permission
  handling + gate toggle + latency constraints + save/load + manual.js + this
  design doc.
- Some input→output latency is expected and accepted; minimise where the
  platform allows (constraints + latencyHint), don't pretend it's zero.

## Why it fits the architecture
A `MediaStreamAudioSourceNode` (`ctx.createMediaStreamSource(stream)`) is a
persistent continuous source — structurally identical to `NoiseMachine`'s
looping `_noiseSrc`. Every machine's only structural obligation is
`machine.connect(filter._baseHPF)` (VoicePool `VoiceSlot` ctor). Once the input
node reaches the per-slot filter, **filter, DJ filter, FX pipeline, LFOs,
mod-wheel and p-locks all come for free** — they target AudioParams by path and
are source-agnostic.

## The one real wrinkle: the amp gate
`Envelope.ampGain` starts at `gain.value = 0` and only opens on a note
(`scheduleNote`/`noteOn`). Continuous input has no notes, so the InputMachine
must keep its slot audible without a note:

- **Continuous (default)**: on activation, pin slot-0's `envelope.ampGain.gain`
  to 1 and keep it there; `noteOn(note,…)` ignores pitch and does NOT drive the
  amp. The machine's own `outputGain` is the level control.
- **Gate on**: revert to normal — `noteOn`/`noteOff` drive the envelope so steps
  and keys chop the live input. Reuses the existing VoiceSlot path unchanged.

The toggle flips between these by re-pinning or releasing `ampGain`.

## Singleton source in a voice pool
`VoicePool` builds 8 slots, each with its own machine — but there is only one
input stream. Resolution:
- One **shared** `MediaStreamAudioSourceNode` (module-level, ref-counted) fanned
  out to whichever slot is audible. Web Audio allows one node → many
  destinations.
- For continuous mode only slot 0 is audible (others stay gated/silent); gate
  mode can use the pool normally (all slots tap the same shared source node).
- Ref-count getUserMedia so swapping machine type / disposing one slot does not
  kill the stream for others, and the stream + tracks are stopped when the last
  InputMachine goes away.

## Latency levers (do what the platform allows)
- `new AudioContext({ latencyHint: 'interactive' })` in AudioEngine (currently
  bare `new AudioContext()`).
- getUserMedia constraints tuned for music, NOT voice:
  `echoCancellation:false, autoGainControl:false, noiseSuppression:false`,
  `latency: 0` (hint), and a channelCount matching the device.
- Surface the context's `baseLatency`/`outputLatency` read-only in the panel so
  the user sees the real round-trip number instead of guessing.
- Expectation set in the manual: browser round-trip is typically ~20–60 ms+;
  great for processing/looping, noticeable for live monitoring. Cannot be fully
  eliminated in-browser.

## Files

### New
- `js/machines/InputMachine.js` — the machine. `static SPEC` with
  `input.level`, `input.gate` (bool), `input.monitor`? (maybe). Holds the shared
  source (via a small module-level manager), implements `connect`/`disconnect`,
  `noteOn`/`noteOff` (no-op amp in continuous mode), device selection
  (`setDevice(deviceId)`), and async `enableInput()` (getUserMedia). Singleton
  guard + ref-count for the stream.
- `js/ui/panels/InputPanel.js` — device picker (enumerateDevices), channel
  select, permission prompt button + denied/no-device/unplugged states, gate
  toggle, level, and a read-only latency readout. Modeled on MidiPanel +
  MidiInPanel.

### Touched
- `js/state/Track.js` — import InputMachine, add `input: InputMachine` to
  `MACHINES`. Add the continuous-gate hook: when the machine is input + gate off,
  hold slot-0 ampGain open (a small method like `_applyInputGate()` called from
  setMachine and the panel's gate toggle).
- `js/core/AudioEngine.js` — `new AudioContext({ latencyHint: 'interactive' })`;
  expose `baseLatency`/`outputLatency` getters for the panel.
- `js/ui/panels/MachinePickerPanel.js` — rename the `MIDI` group to `I/O` and add
  `{ type:'input', label:'Input', desc:'Live audio in (line/USB)'}` alongside
  `midi`. Not previewable (like sampler/midi → exclude from preview ▶).
- `js/ui/SynthPanel.js` — `_renderSynth`: branch `machine.type === 'input'` →
  `new InputPanel(...)` with audioContext (mirrors the sampler/midi branches).
- `js/ui/manual.js` — document the Input machine, the gate toggle, device pick,
  and the latency expectation (manual-sync rule).
- `design/audio-signal-chain.md` — note the continuous-gate departure from the
  VoiceSlot topology (DESIGN-doc rule).

### Tests
- `tests/tests/machines/input.js` — construct InputMachine with a mocked
  AudioContext/getUserMedia; assert: SPEC-derived params, connect targets the
  filter input, continuous mode pins ampGain, gate mode does not, singleton
  ref-count, and graceful no-op when getUserMedia is unavailable/denied. Follow
  the existing machine test harness (e.g. midi/sampler tests for the no-audio /
  device-y patterns). Run the suite per project convention.

## Build order — STATUS (all implemented; awaiting user review)
1. ✅ AudioEngine latencyHint + `getLatencySeconds()`.
2. ✅ InputMachine.js — ref-counted `_StreamManager` singleton, SPEC
   (`output.level`, `input.gate`), `enableInput`/`setDevice`, no-op notes,
   toJSON/fromJSON (device restored, NOT auto-enabled).
3. ✅ Track.js — registered `input`; `_applyInputGate()` pins/releases slot
   ampGain, called from setMachine + fromJSON; VoicePool `envelopes` getter.
4. ✅ Sequencer `_fireStep` continuous-input guard (skips voice firing, keeps
   shared p-locks). Keyboard `_continuousInputTrack()` guard (no key gating).
5. ✅ MachinePickerPanel — MIDI group renamed `I/O`, `input` card added,
   excluded from preview. SynthPanel dispatches `input` → InputPanel.
6. ✅ InputPanel.js — enable button, device picker, level, gate toggle, latency
   readout, permission/insecure/error states. CSS `input-*` block.
7. ✅ tests/tests/machines/input.js (registered in tests/index.html).
8. ✅ manual.js `input` entry + family rename; design/audio-signal-chain.md note.

Tests run via tests/index.html in the browser (the suite uses
OfflineAudioContext — getUserMedia is exercised manually). Verified working with
a live mic; line/synth input pending hardware test.

## As-built behaviour (the bits that bit us)

### Gain staging
- Signal path inside the machine: `source → inputGain (makeup, 0–8×, default 2×)
  → outputGain (level, default 1.0) → filter`. Line-in / mic / synth often
  arrive far quieter than a normalised synth machine, so the **makeup Gain knob**
  is the lever — distortion drive does NOT add level (DistortionFX normalises its
  curve by `tanh(k)` to hold loudness constant), so a quiet input stays quiet
  through distortion. Turn Gain up first.

### Level meter
- A parallel `AnalyserNode` taps **post-makeup-gain, pre-level/gate/filter**, so
  the panel meter shows the amplified signal you'll hear regardless of gate
  state. `getInputLevel()` returns `{rms, peak}`; the panel maps them on a dBFS
  scale (−60→0 dB) with green/yellow/orange/red zones + peak hold. The meter
  moving with no sound = the problem is downstream (it was the suspended context
  + gain staging during bring-up).

### Singleton source across ALL slots
- `Track.enableInput()` / `disableInput()` fan out to **every** voice slot's
  InputMachine, not just slot 0. They all acquire the SAME shared
  `MediaStreamAudioSourceNode` (ref-counted in `_StreamManager` by device). This
  is required for note-gated mode: `nextVoice()` round-robins, so a key/step may
  land on any slot — if only slot 0 had the stream, only the first note sounded.
  The InputPanel calls the Track-level methods (not the bare machine).

### Amp-gate baseline + `reset` intent (the "stays open" bug)
- `Track._applyInputGate({ reset })` reconciles the gate with the mode:
  - **Continuous**: pin every slot's `ampGain` to a static value — open (1) while
    unmuted, closed (0) while muted. No envelope runs; the machine owns ampGain.
  - **Gated / other**: the per-note ADSR envelope owns ampGain. On INCIDENTAL
    calls (mute, re-render, fromJSON, enable/disable) we must NOT cancel/pin it —
    that would wipe a ringing note's scheduled release and freeze the gate OPEN.
    Only on an explicit **`reset: true`** (machine swap, gate-mode toggle, load)
    do we force a clean closed baseline. The continuous→gated toggle was the bug:
    continuous had pinned the gate to 1.0, and without the reset the envelope had
    no clean baseline, so it played continuously after the first note.

### Mute & STOP
- **Mute**: continuous input has no notes, so mute can't work via the Sequencer's
  `track.muted` early-return (that only stops sequenced notes). Instead
  `_applyInputGate` folds in `this.muted` — a muted continuous-input track pins
  the gate to 0. `mute()`/`unmute()` re-apply it. (Gated input mutes like any
  machine: sequenced gating stops, live keys still play.)
- **STOP / panic** (`Track.silence`): slams every gate to 0 to cut sound, then
  re-applies the gate — continuous input is a live monitor, not a ringing note,
  so it re-arms rather than staying dead. The stream itself is untouched (use the
  panel toggle to actually stop capture).

## Risks / open points
- getUserMedia needs HTTPS (GitHub Pages OK) or localhost; plain http non-local
  fails — surfaced by a clear panel message.
- Singleton-in-a-pool: in continuous mode only slot 0 is audible (7 slots idle);
  acceptable cost of the machine route (gets SPEC/panel/p-lock/save for free).
- Gate-mode polyphony: all slots tap one shared source, so overlapping gated
  notes are fine (same signal, independent envelopes).
- Latency: browser input→output round-trip ~20–60 ms+; irreducible in-browser.
  Shown read-only in the panel (`AudioEngine.getLatencySeconds()`).
