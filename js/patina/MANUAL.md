# PATINA

**An analog-modelling synthesizer engine for the Web Audio API.**
Single file. Zero dependencies. ES module. v1.0.0, MIT license.

Patina is not a wrapper around `OscillatorNode` with reverb on top. It is a small synthesis engine built around the specific imperfections that make analog hardware sound the way it does: thermal drift, component tolerance, transistor-ladder filtering with real saturation, RC-curve envelopes, and a circuit that is never entirely quiet. Turn all of that off and it sounds like any clean digital synth. Turn it up and it sounds like a forty-year-old voice card.

---

## 1. Installation

Copy `patina.js` into your project. That's it. It must be loaded as an ES module:

```html
<script type="module">
  import { PatinaSynth, PRESETS } from './patina.js';
</script>
```

If you prefer not to use import syntax elsewhere in your code, the module also attaches itself to `window.Patina`, so after importing it once you can use `window.Patina.PatinaSynth` anywhere.

There is no build step, no npm install, and no separate worklet file — the filter DSP is embedded in the module and loaded through a Blob URL.

**Serving note:** like all ES modules, the file must be served over http(s). Opening an HTML file directly from disk (`file://`) will fail with a CORS error. Any dev server works (`npx serve`, `python -m http.server`, your existing app's server).

---

## 2. Quick start

```js
import { PatinaSynth } from './patina.js';

const synth = new PatinaSynth();   // creates its own AudioContext
await synth.ready;                  // wait for the filter DSP to load

synth.loadPreset('warm-pad');

// Browsers require a user gesture before audio can start:
button.addEventListener('click', () => {
  synth.noteOn('C4', 0.8);
  setTimeout(() => synth.noteOff('C4'), 1500);
});
```

To integrate with an existing Web Audio project, hand Patina your context and route its output yourself:

```js
const synth = new PatinaSynth(myAudioContext, { master: 0.7 });
await synth.ready;
synth.connect(myMixerBus);          // instead of ctx.destination
```

Notes are accepted as MIDI numbers (`60`) or names (`'C4'`, `'F#2'`, `'Bb3'`). Velocity is 0–1.

---

## 3. Why it sounds analog

Each of these is individually subtle. Together they are the difference between "softsynth" and "instrument".

**Always-running VCOs.** Each voice's oscillators start when the synth is created and never stop; notes open and close a VCA around them, exactly like an analog voice card. Consecutive notes therefore catch the oscillators at arbitrary phase, so no two attacks are sample-identical.

**Component tolerance.** When each voice is built it draws fixed random offsets for tuning (a few cents), filter cutoff (a few percent), envelope times (up to ~12%), output level and stereo position. Play a chord and every voice is a slightly different instrument — this is the single biggest contributor to vintage-polysynth "width", and it is why the same patch never sounds quite the same twice on real hardware either.

**Thermal drift.** A bounded random walk nudges every oscillator's tuning continuously (up to about ±3.5 cents at `drift: 1`), and a separate, independent random walk inside the filter wobbles the cutoff. Long sustained notes breathe instead of freezing.

**The ladder filter.** The heart of the engine is a 4-pole transistor-ladder lowpass (the Moog topology) implemented per-sample in an AudioWorklet: `tanh` saturation in the input and feedback path, resonance compensation, and self-oscillation above `resonance: 1.0`. Pushing `filter.drive` up makes it growl and compress the way a real ladder does — something a clean `BiquadFilterNode` cannot do at any setting. A whisper of noise inside the loop seeds self-oscillation and keeps the math healthy.

**RC envelopes.** All envelope segments use exponential `setTargetAtTime` curves — the shape of a capacitor charging through a resistor — never linear ramps. This is what makes percussive decays sound "round" rather than "computed".

**Imperfect waveforms.** Oscillator spectra are generated per-oscillator with random harmonic-amplitude tolerance, slight phase smear, even-harmonic leakage into squares and triangles (comparator asymmetry), and a gentle rounding of the extreme highs (op-amp slew limiting). Every saw in the instrument is a slightly different saw.

**The dirty signal path.** A soft-clipping drive stage with slight asymmetry (even harmonics, like a single-ended transistor stage), a BBD-style stereo chorus with two off-rate LFOs, an optional dark-tailed reverb, plus a dialable pink-noise floor and 50/60 Hz mains hum with its second harmonic. The hiss and hum are injected *before* the drive stage so they get saturated along with the signal, which is where real circuits put them.

---

## 4. API reference

### `new PatinaSynth([context], [options])`

Both arguments are optional. `context` is an existing `AudioContext`; if omitted, one is created. `options` is a partial patch (any subset of the parameter tree in section 5).

```js
const a = new PatinaSynth();
const b = new PatinaSynth({ filter: { cutoff: 600 } });
const c = new PatinaSynth(ctx, { mode: 'mono', glide: 0.08 });
```

### `synth.ready` → `Promise<PatinaSynth>`

Resolves once the filter worklet is compiled and the voice pool exists. Always `await` it (or `.then()`) before playing. If `AudioWorklet` is unavailable, the promise still resolves and the engine silently falls back to a cascaded-biquad + soft-clip filter (see section 8).

### Playing

| Method | Description |
|---|---|
| `noteOn(note, velocity = 0.8)` | Start a note. `note` is a MIDI number or name; velocity 0–1. Auto-resumes a suspended context. |
| `noteOff(note)` | Release a note (release envelopes apply). |
| `allNotesOff()` | Release every voice musically. |
| `panic()` | Instant silence, no release tails. |
| `pitchBend(semitones)` | Smooth bend, e.g. `pitchBend(2)` / `pitchBend(0)` to return. |
| `modWheel(value)` | 0–1; adds up to +25 cents of vibrato depth on top of `lfo.pitch`. |

In `mode: 'poly'`, voice allocation prefers a free voice, then steals the oldest. In `mode: 'mono'`, held notes form a stack with last-note priority and true legato: overlapping notes glide (`glide` seconds) without retriggering the envelopes.

All playing methods return the synth, so calls chain: `synth.loadPreset('fat-bass').noteOn('A1')`.

### Patch management

| Method | Description |
|---|---|
| `set(partial)` | Deep-merge any subset of parameters live: `synth.set({ filter: { cutoff: 800 } })`. Seamless except when `polyphony`, `mode`, or the *number* of oscillators changes — those rebuild the voice pool (brief gap). |
| `loadPreset(name, overrides?)` | Replace the entire patch with a preset; `overrides` is merged on top. Throws on unknown names. |
| `getParams()` | Returns a plain-object deep copy of the current patch. `JSON.stringify` it to save; restore with `new PatinaSynth(saved)` or `set(saved)`. |

### Routing & lifecycle

| Method | Description |
|---|---|
| `connect(node)` | Route output into your own graph instead of `ctx.destination`. |
| `disconnect()` | Detach the output. |
| `resume()` | Resume a suspended context (call from a user gesture). `noteOn` does this automatically. |
| `destroy()` | Stop all sources and timers, disconnect everything. The instance is dead afterwards. |
| `synth.output` | The final `GainNode`, if you want to tap it directly. |
| `synth.ctx` | The `AudioContext` in use. |

### Helpers and exports

```js
import { PatinaSynth, PRESETS, toMidi, midiToFreq } from './patina.js';
toMidi('F#2')      // → 42
midiToFreq(69)     // → 440
Object.keys(PRESETS)
```

---

## 5. Parameter reference

Everything below can be passed to the constructor, to `set()`, or appear in a preset. Shown with defaults.

### Top level

| Parameter | Default | Range | Notes |
|---|---|---|---|
| `polyphony` | `8` | 1–16 | Number of voice cards. Each carries a ladder-filter worklet; 8 is comfortable, 16 works on most machines. |
| `mode` | `'poly'` | `'poly'` \| `'mono'` | Mono is single-voice with note stacking and legato. |
| `glide` | `0` | seconds | Portamento slew. Used in mono mode and on legato/retriggered notes. |
| `masterTune` | `440` | Hz | Reference pitch for A4. |
| `velocitySensitivity` | `0.6` | 0–1 | 0 = velocity ignored; 1 = full range on amp and filter envelope. |
| `master` | `0.8` | 0–1.5 | Output level before the glue compressor. |

### `oscillators` — array of 1 or more

| Field | Default | Notes |
|---|---|---|
| `type` | `'saw'` | `'saw'`, `'square'`, `'triangle'`, `'sine'`, `'pulse'` |
| `octave` | `0` | Integer octave shift. |
| `detune` | `0` | Cents. Spread two saws by ±5–10 ¢ for the classic two-VCO thickness. |
| `level` | `0.5` | 0–1 mixer level. |
| `pulseWidth` | `0.25` | Pulse type only, 0–0.5. Static (set at wave creation), not LFO-modulatable. |

Changing `type`, `detune`, `level`, `pulseWidth` via `set()` is seamless; changing the *number* of entries rebuilds voices.

### `sub` and `noise`

`sub: { type: 'sine', level: 0 }` — one octave below oscillator 1; `'sine'` or `'square'` work best. `noise: { level: 0 }` — per-voice pink noise into the filter, lovely for breathy pads and snappy attacks.

### `filter`

| Field | Default | Range | Notes |
|---|---|---|---|
| `cutoff` | `1400` | 20–18000 Hz | Base cutoff before keytrack and envelope. |
| `resonance` | `0.25` | 0–1.15 | The ladder self-oscillates above ~1.0 and becomes a playable sine source. |
| `drive` | `1.6` | 0.1–12 | Input gain into the ladder's `tanh` stage. 1 = clean; 3–5 = growl; 8+ = fuzz. Output is loudness-compensated. |
| `keytrack` | `0.4` | 0–1 | 1.0 = cutoff follows pitch exactly (needed to "play" a self-oscillating filter in tune). |

### `envelope` and `filterEnvelope` (ADSR, seconds / 0–1)

Both: `attack`, `decay`, `sustain`, `release`. The filter envelope adds `amount` (in Hz, may be negative) on top of cutoff: peak = `cutoff + amount`, sustain plateau = `cutoff + amount × sustain`. All segments are exponential RC curves, and every voice's envelope times differ slightly (tolerance).

### `lfo`

| Field | Default | Notes |
|---|---|---|
| `rate` | `5.2` | Hz, triangle wave, shared by all voices (like a panel LFO). |
| `pitch` | `0` | Vibrato depth in cents. `modWheel()` adds up to +25 ¢ on top. |
| `filter` | `0` | Cutoff modulation depth in Hz. |
| `delay` | `0.4` | Seconds of fade-in for the pitch LFO (delayed vibrato). |

### `character` — the analog dial

| Field | Default | What it does |
|---|---|---|
| `drift` | `0.5` | 0–1. Slow random tuning wander (≈ ±3.5 ¢ at 1.0) plus filter thermal drift. 0 = digitally stable. |
| `tolerance` | `0.6` | 0–1. Voice-to-voice spread in tuning, cutoff, envelope times, level, pan, and waveform imperfection. Applied when voices are built, so change it *before* heavy playing or follow with a rebuild (e.g. toggling `polyphony`). |
| `noiseFloor` | `0.35` | 0–1. Pink hiss into the drive stage. Quiet but load-bearing. |
| `hum` | `0.15` | 0–1. Mains hum (fundamental + 2nd harmonic). |
| `humFreq` | `50` | 50 (Europe) or 60 (Americas). A question few libraries let you answer. |

For a quick A/B of the whole concept: `synth.set({ character: { drift: 0, tolerance: 0, noiseFloor: 0, hum: 0 } })` and play a chord — then load the preset again.

### `fx`

| Field | Default | Notes |
|---|---|---|
| `drive` | `0.25` | 0–1. Output-stage soft clip with slight asymmetry; gain-compensated. |
| `chorus.mix` | `0` | 0–1 wet level. The chorus is stereo with two LFOs at deliberately unrelated rates. |
| `chorus.rate` | `0.55` | Hz. Right channel runs at 1.27 × this. |
| `chorus.depth` | `0.5` | 0–1 modulation depth. |
| `reverb.mix` | `0` | 0–1. Convolution with a procedurally generated dark-tailed impulse. |
| `reverb.size` | `2.2` | Seconds of tail. Changing size/tone regenerates the impulse (cheap, but not per-frame). |
| `reverb.tone` | `0.4` | 0–1; lower = darker tail. |

---

## 6. Presets

Load with `synth.loadPreset(name)`; inspect any of them via `PRESETS[name]`.

| Name | Character |
|---|---|
| `init` | The defaults: two detuned saws, moderate everything. A sane starting point. |
| `warm-pad` | Slow three-oscillator pad, heavy chorus, high drift/tolerance. The flagship demo of the character section. |
| `fat-bass` | Mono, glide, sub-oscillator, driven low ladder. Plays like an SH-style monosynth. |
| `screaming-lead` | Mono lead with hot filter drive and delayed vibrato. |
| `string-machine` | Three saws, fast-ish attack, drenched in ensemble chorus, maximum tolerance — the Solina recipe. |
| `ep-keys` | Sine/triangle electric-piano-ish keys, high velocity sensitivity, long decay. |
| `acid-303` | Mono square, near-self-oscillating filter, zero sustain, glide. Sequence it. |
| `poly-brass` | Detuned saws with a slow filter swell — the classic analog brass move. |
| `haunted-organ` | Two static pulses plus sine, lots of hum and drift, big dark reverb. |
| `self-oscillating-whistle` | Oscillators muted; the filter itself is the sound source (`resonance: 1.08`, `keytrack: 1.0`). Whistles in tune across the keyboard. |

---

## 7. Recipes

**MIDI keyboard in ~10 lines:**

```js
const midi = await navigator.requestMIDIAccess();
for (const input of midi.inputs.values()) {
  input.onmidimessage = ({ data: [st, note, vel] }) => {
    const cmd = st & 0xf0;
    if (cmd === 0x90 && vel > 0) synth.noteOn(note, vel / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) synth.noteOff(note);
    else if (cmd === 0xe0) synth.pitchBend((((vel << 7) | note) - 8192) / 8192 * 2);
    else if (cmd === 0xb0 && note === 1) synth.modWheel(vel / 127);
  };
}
```

**Filter sweep on a held chord:**

```js
synth.loadPreset('warm-pad');
['C3','Eb3','G3','Bb3'].forEach(n => synth.noteOn(n, 0.7));
let c = 300;
const sweep = setInterval(() => {
  synth.set({ filter: { cutoff: (c *= 1.04) } });
  if (c > 6000) clearInterval(sweep);
}, 50);
```

**Saving and restoring patches:**

```js
localStorage.setItem('mypatch', JSON.stringify(synth.getParams()));
// later:
synth.set(JSON.parse(localStorage.getItem('mypatch')));
```

**A simple step sequencer for the acid preset:**

```js
synth.loadPreset('acid-303');
const seq = ['A1','A1','C2','A1','E2','A1','G2','A2'];
let i = 0;
setInterval(() => {
  const n = seq[i++ % seq.length];
  synth.noteOn(n, 0.6 + Math.random() * 0.4);
  setTimeout(() => synth.noteOff(n), 110);
}, 140);
```

(For anything timing-critical, schedule against `synth.ctx.currentTime` with a look-ahead loop rather than `setInterval` — the standard Web Audio clock pattern.)

**Playing the filter itself:** load `self-oscillating-whistle` and play melodies; the "oscillator" is the ladder ringing. Lower `character.drift` if you want it steadier, raise it for theremin energy.

---

## 8. Performance, compatibility, troubleshooting

**CPU.** Each voice runs one ladder worklet doing four `tanh`-saturated poles per sample. Eight voices are negligible on a modern laptop; sixteen are fine. The reverb convolver is the next-largest cost; set `reverb.mix: 0` and it still convolves, so if you need every cycle, also keep `reverb.size` small or route Patina into your own send-effect instead.

**Browsers.** Chrome, Edge, Firefox and Safari ≥ 14.1 all support AudioWorklet. On anything that doesn't, Patina logs a warning and falls back to a 24 dB cascaded-biquad filter with a soft clipper — same API, same parameters, noticeably politer resonance, and no self-oscillation. `StereoPanner` is also feature-detected.

**No sound?** In order of likelihood: you didn't `await synth.ready`; the context is suspended because no user gesture has occurred yet (call `noteOn` or `resume()` from a click/keydown handler); you're loading from `file://` (serve over http); or `master`/oscillator `level`s are 0 (the `self-oscillating-whistle` preset *intends* silent oscillators).

**Clicks when editing?** Changing `polyphony`, `mode`, or the number of oscillator entries rebuilds the voice pool and will cut sound briefly — do those edits between phrases. Everything else (`cutoff`, levels, fx, character, even waveform `type`) is slewed and click-free.

**It sounds too dirty / not dirty enough.** That's the `character` block and `filter.drive`. The defaults are "well-maintained vintage". For "found in a barn", try `character: { drift: 1, tolerance: 1, noiseFloor: 0.8, hum: 0.6 }`. For mastering-grade cleanliness, zero the block and set `filter.drive: 1`.

---

## 9. File map

```
patina.js    the entire engine (this is the only required file)
MANUAL.md    this document
demo.html    a playable keyboard demo — serve the folder and open it
```
