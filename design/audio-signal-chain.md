# Audio Signal Chain

## Per-Track Signal Chain

Each track runs 8 voice slots in parallel. Each slot owns its own machine, envelope, AND filter — only `Track.outputGain` (and everything downstream) is shared. Per-slot machines/envelopes prevent amplitude stacking when notes overlap; per-slot filters keep the amp gate AFTER the filter so an idle slot is fully silent including its filter's resonant ring.

```
VoiceSlot ×8 (each slot is fully self-contained up to the shared outputGain):
  Machine (oscillator nodes)
    → Filter._baseHPF (BiquadFilterNode, highpass, per-slot)
      → Filter._baseLPF (BiquadFilterNode, lowpass, per-slot)
        → Filter.node (+ slope stages) (BiquadFilterNode, per-slot — type/cutoff/resonance)
          → Envelope.ampGain (GainNode, per-slot ADSR gate)  ← gate AFTER filter
            → Track.outputGain (GainNode, shared — mute implemented here) ← all 8 slots sum here
              → Track.pannerNode (StereoPannerNode, shared — pan)
                → DelayFX.inputNode
                  → BitcrushFX.inputNode
                    → ReverbFX.inputNode
                      → AudioEngine.fxBus (GainNode)
                        → AudioEngine.masterGain
                          → AudioContext.destination
                          → AudioEngine.analyser (AnalyserNode — parallel tap, no audio output)

Each slot's Envelope drives ITS OWN Filter.node.frequency (per-voice filter envelope) —
no cross-slot races on a shared frequency param.

The amp gate sits AFTER the filter (machine → filter → ampGain → outputGain). This is the
pre-polyphony topology, restored per voice: the gate silences the filter's own resonant ring
between notes, so idle voices contribute zero audio. The intermediate "gate before a single
SHARED filter" topology let the shared filter ring bleed across steps — heard as a "pre-sound /
ghost note" before every sequenced trigger (cleared only as slots warmed up). Per-voice filters
fix it: see dual_note.md.

Slot 0's filter is canonical — UI and sequencer read & write `Track.filter` (=== slot-0 filter).
Every `setParam` on it fans out to the sibling slot filters via `Filter.mirrorTo()`, so all
voices stay identical. DJ-filter base-cutoff writes iterate `VoicePool.filters` directly.

LFOs connect to AudioParams:
  - Filter.node.frequency / Q, _baseLPF/_baseHPF.frequency — connected to ALL 8 slot filters
  - Machine AudioParams (osc.detune, sub.level, output.level, etc.) — connected to ALL 8 slot machines
  - Track.pannerNode.pan (amp.pan — single shared)
  - DelayFX / BitcrushFX / ReverbFX params — single shared

Mod wheels use `Track.resolveModWheelParam(path)` → `{ audioParam, min, max }` and
set the AudioParam directly (absolute value in lfoMin–lfoMax range), not additively like LFOs.
Wheel position 0–1 maps linearly to [min, max].
```

### Voice Selection (VoicePool.nextVoice)

Round-robin through 8 slots; picks the first idle one (past its release tail). If all 8 are busy, steals the one whose release ends soonest. Before returning the chosen slot, syncs its machine and envelope params from slot 0 (canonical) so UI knob changes always take effect on the next note. (Filter params stay synced continuously via `Filter.mirrorTo`.)

---

## Filter Architecture

`Filter` wraps three BiquadFilterNodes in series:

1. **Base HPF** (`_baseHPF`) — highpass, fixed Q=0.7071 (Butterworth), no resonance.
   Param: `base.hpf` (20–8000 Hz, default 20). Attenuates low end.

2. **Base LPF** (`_baseLPF`) — lowpass, fixed Q=0.7071 (Butterworth), no resonance.
   Param: `base.lpf` (200–20000 Hz, default 20000). Attenuates high end.

3. **Main filter** (`node`) — type/cutoff/resonance/gain, plus 3 additional cascaded biquad stages.
   Params: `filter.type` (`lowpass` | `highpass` | `bandpass` | `notch` | `peaking` | `allpass`),
   `filter.cutoff`, `filter.resonance`, `filter.gain` (dB, active only for `peaking`), `filter.envAmount`.
   The GAIN knob is hidden in the UI unless type is `peaking`.

4. **Slope** (`filter.slope`, 0–1) — continuously blends in up to 7 extra cascaded biquad stages
   (all tracking the same type/cutoff/Q as `node`), giving 12–96 dB/oct. At 0 only the primary
   node is active. Each extra stage fades in across one seventh of the 0–1 range via dry/wet GainNodes.
   Applies to all filter types. P-lockable and LFO-assignable.
   UI shows `1P/12dB` → `8P/96dB` as a display hint.

Signal chain: Machine → `_baseHPF` → `_baseLPF` → `node` → `_stages[0..2]` (wet-blended) → output.

Base filter params are LFO-assignable and p-lockable. They appear under **BASE FILTER**
in the FILTER tab alongside the main filter knobs. No separate visualisation — the base
filter curves are drawn as a dim overlay in the main FilterViz.

**Machine connection**: `machine.connect(this.filter._baseHPF)` — machines feed the base HPF,
not `filter.node` directly.

---

## FilterViz

`FilterViz.js` (in `ui/`) draws a frequency response canvas updated in real time as knobs are dragged.

**Draws:**
- Base filter response (dim white line) — combined `_baseHPF` + `_baseLPF` magnitude
- Main filter fill + line (amber) — `filter.node` type/cutoff/resonance
- Dashed vertical cutoff marker
- Resonance peak dot at cutoff frequency
- Faint **filter envelope ghost** in the right ~28% of the canvas: shows the `fenv.*`
  ADSR shape as a translucent amber overlay, scaled vertically to canvas height.
  Purely illustrative (time axis is relative, not absolute seconds).

**Pure math**: uses biquad transfer function evaluation (`_evalBiquad`) — no AnalyserNode.
dB range: -42 to +30 dB (accommodates Q=20 resonance peaks of ~26 dB).

**API:**
```js
new FilterViz({
  getFilter:   () => track.filter,     // required
  getEnvelope: () => track.envelope,   // optional — enables env ghost
  getParam:    path => value,          // optional — p-lock-aware filter param reader
  getEnvParam: path => value,          // optional — p-lock-aware envelope param reader
  showBase:    true,                   // draw base filter curve
  height:      118,                    // canvas CSS height in px
})
viz.refresh()   // call after any param change
viz.destroy()   // clean up ResizeObserver
```

`getParam` / `getEnvParam` should check `step.plocks` first, then fall back to track defaults.
This makes the viz reflect p-locked values in real time while dragging.

The env ghost reads `fenv.*` params (filter envelope), NOT `env.*` (amp envelope).

---

## Envelope Architecture

`Envelope` owns two independent ADSR envelopes:
- **Amp envelope** (`env.*`) — controls `ampGain.gain`
- **Filter envelope** (`fenv.*`) — modulates `filter.node.frequency` directly

Two scheduling paths:

**Sequencer path — `scheduleNote(time, offTime, overrides)`:**
  Queues A→D→S starting at `time`, then R starting at `offTime`. Does NOT cancel prior
  scheduled events before `time` — the previous note's release tail runs until the new
  attack overwrites it. Accepts an `overrides` dict for p-locked ADSR values.
  The oscillator is kept alive until `offTime + release` (so the release tail has audio to shape).

**Live keyboard path — `noteOn(time)` / `noteOff(time)`:**
  Cancels prior events and restarts from zero. Used only for keyboard playing.
  These two paths must stay separate — using noteOn from the sequencer caused release bugs.

---

## Pan (Stereo Panner)

Each track has a `StereoPannerNode` (`track.pannerNode`) inserted between `outputGain` and `fxBus`.
- Default: `pan = 0` (centre)
- Range: -1 (full left) to +1 (full right)
- Serialised in `track.toJSON()` as `pan`
- Exposed in the **AMP tab** as a bipolar PAN knob (displays C / L50 / R100 etc.)
- P-lockable: `amp.pan` plock key. Sequencer handles it via scheduled `setValueAtTime` /
  restore on `pannerNode.pan` AudioParam.
- LFO-assignable: appears as "Pan" under the "Amp" group in the LFO destination dropdown.
  `Track._resolveAudioParam('amp.pan')` returns `{ audioParam: pannerNode.pan, depthScale: 1.0 }`.
- `Track.resetTrack()` resets pan to 0.

---

## DJ Filter

Each track has a single **DJ filter** control (`track.djFilter`, −1 to +1, default 0) that sweeps the existing base filter nodes in the signal chain:

- **Center (0)**: flat — LPF at 20 kHz, HPF at 20 Hz (neutral)
- **Left (−1)**: full LPF — sweeps `_baseLPF.frequency` exponentially from 20 kHz → 80 Hz; HPF stays neutral
- **Right (+1)**: full HPF — sweeps `_baseHPF.frequency` exponentially from 20 Hz → 8 kHz; LPF stays neutral

**Implementation:** `Track.applyDJFilter(value)` sets `filter._baseLPF.frequency` and `filter._baseHPF.frequency` directly via `setTargetAtTime`. This shares the same BiquadFilterNodes as `base.lpf` / `base.hpf` in the FILTER tab — they are the same nodes but driven by a single unified knob in the mixer context.

**Serialised** as `djFilter` in `track.toJSON()`. Reset to 0 by `resetTrack()`.

---

## Known Audio Constraints

- **Shared ampGain node:** All oscillators on a track share one `ampGain` GainNode. A new
  note's attack overwrites the previous note's release — standard monophonic behaviour.
- **linearRampToValueAtTime requires an anchor.** Always preceded by `setValueAtTime` or
  `cancelAndHoldAtTime`.
- **`cancelAndHoldAtTime` preferred over `cancelScheduledValues`.** The former holds the
  param at its current scheduled value; the latter snaps to the JS-thread value.
- **Never read `gainNode.gain.value` for future state.** Returns the current JS-thread value.
- **Env p-locks must bypass `setParam`.** `Envelope.setParam` only writes `_params`.
  Passing overrides directly to `scheduleNote` is the correct path.
