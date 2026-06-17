# Audio Signal Chain

## Per-Track Signal Chain

Each track runs 8 voice slots in parallel. Each slot owns its own machine, envelope, AND filter — only `Track.outputGain` (and everything downstream) is shared. Per-slot machines/envelopes prevent amplitude stacking when notes overlap; per-slot filters keep the amp gate AFTER the filter so an idle slot is fully silent including its filter's resonant ring.

```
VoiceSlot ×8 (each slot is fully self-contained up to the shared outputGain):
  Machine (oscillator nodes → machine.outputGain → machine._trimGain)
    → Filter._baseHPF (BiquadFilterNode, highpass, per-slot)
      → Filter._baseLPF (BiquadFilterNode, lowpass, per-slot)
        → Filter.node (+ slope stages) (BiquadFilterNode, per-slot — type/cutoff/resonance)
          → Envelope.ampGain (GainNode, per-slot ADSR gate)  ← gate AFTER filter
            → Track.outputGain (GainNode, shared) ← all 8 slots sum here
              → Track.tremGain (GainNode, shared — tremolo VCA, LFO target amp.level)
              → Track.pannerNode (StereoPannerNode, shared — pan)
                → [FX pipeline — REORDERABLE, default delay → crush → chorus → reverb]
                    DelayFX.inputNode / BitcrushFX.inputNode /
                    ChorusFX.inputNode / ReverbFX.inputNode
                      → Project.busGain (GainNode, per-deck — crossfader/silence)
                        → AudioEngine.fxBus (GainNode)
                          → AudioEngine.masterGain
                            → AudioContext.destination
                            → AudioEngine.analyser (AnalyserNode — parallel tap, no audio output)

A track's FX-chain tail connects to its Project's `busGain` (passed to `Track` as
the optional 4th constructor arg, defaulting to `AudioEngine.fxBus` for back-compat).
This per-deck sub-bus is what the DECK tab's crossfader rides — see Deck Buses below.

### Reorderable FX pipeline

The per-track FX chain order is **data-driven and user-customisable** (FX pipeline
pane — see `design/fx.md`). `Track._fxOrder` is an array of block ids
(`['delay','crush','chorus','reverb']` by default); `Track._fxBlocks` maps id →
FX instance. `Track.setFXOrder(order)` rebuilds the graph via `_rewireFXChain()`,
which disconnects `pannerNode` + every block output and reconnects them in order:
`pannerNode → block[0] → … → block[n] → busGain`. Every FX implements the same
block interface (`inputNode` / `outputNode` / `connect()` / `disconnect()`), so
reordering is pure rewiring. Upstream (`outputGain → tremGain → pannerNode`) and
the output bus are fixed; only the FX blocks reorder.

`setFXOrder` cleans the order: unknown ids are dropped and duplicates removed.
**Added instances** missing from the list are appended (never orphan an `fxN`
node), but **base blocks** missing from the list stay out — the user can remove a
base block from the chain (it leaves the signal path). Order persists in
`Track.toJSON().fxOrder`; legacy projects without it keep the default chain. P-lock
/ LFO / mod-wheel routing target AudioParams by path and are unaffected by order.

#### Multiple FX instances

Beyond the base four, the user can **add N instances of any effect**
(`Track.addFX(type)`), including new types — distortion, compressor, phaser, a
post-sum **FX filter** (`FXFilter`, paraphonic; the per-voice poly filter is
untouched), and a live auto-gain **normalizer** (`NormalizerFX` — an `AnalyserNode`
taps the signal and an rAF loop scales a `GainNode` toward a target RMS, so it
auto-levels whatever reaches it as the upstream chain changes). Added instances
get ids `fxN` and are wrapped in an **`FXInstance`
proxy** (`js/signal/FXInstance.js`) that namespaces their param paths
(`fx5.reverb.wet`) so duplicates never collide. The proxy forwards the audio
graph interface (inputNode/outputNode/connect/disconnect) and rewrites paths in
getParamList/setParam/getParam/resolveAudioParam (incl. nested `sync` descriptor
refs). The base four keep **bare** paths (`reverb.wet`) for back-compat.

Path → owner resolution funnels through `Track.fxObjForPath(path)`: a `fxN.`
prefix → that instance; a base type prefix → the base block. The Sequencer's
p-lock dispatch (`_resolveParamOwner`, `_buildPlockModeMap`), `getAssignableParams`,
`_resolveAudioParam`, `resolveModWheelParam`, and the MIDI-CC mapper all go
through it, so namespaced FX params p-lock / LFO-assign / CC-map like any other.

`removeFX(id)` removes a block from the chain. An **added instance** is fully torn
down: detached from the graph, its p-locks cleared from every step, any LFO and
any FX bind pointed at it dropped, then deleted from the registry. A **base block**
is only detached from `_fxOrder` — it stays registered (bare paths intact for
back-compat) and can be re-added with its original id via `reattachBaseFX(id)`
(surfaced in the "+ ADD FX" menu as "(re-add)"). Added instances serialise to
`Track.toJSON().fxInstances` (`[{id,type,params,enabled}]`) and are rebuilt by
`_restoreFXInstances` (preserving ids so namespaced paths still resolve) before
`setFXOrder` is applied. Carried through SoundLibrary and machine copy/paste too.

**FX binds.** `Track._fxBinds` maps each of the four global FX keybinds (1–4) to a
block id (or null), persisted in `toJSON().fxBinds`. `setFXBind(n,id)` /
`getFXBindFor(id)` / `toggleFXBind(n)` enforce a 1:1 block↔bind mapping; binds
pointing at a vanished block are dropped on load. `toggleFXBind(n)` flips the
assigned block's `enabled` — the per-track wiring behind the `fx1..fx4` keys (see
design/fx.md → FX binds).

Each slot's Envelope drives ITS OWN Filter.node.frequency (per-voice filter envelope) —
no cross-slot races on a shared frequency param.

`machine._trimGain` is a fixed per-machine loudness-normalisation gain sitting between the
machine's own `outputGain` and the filter chain — it equalises perceived loudness across
machine types and is never modulated. See `design/machines.md` → Loudness Normalisation.

The amp gate sits AFTER the filter (machine → filter → ampGain → outputGain). This is the
pre-polyphony topology, restored per voice: the gate silences the filter's own resonant ring
between notes, so idle voices contribute zero audio. The intermediate "gate before a single
SHARED filter" topology let the shared filter ring bleed across steps — heard as a "pre-sound /
ghost note" before every sequenced trigger (cleared only as slots warmed up). Per-voice filters
fix it: see dual_note.md.

Slot 0's filter is canonical — UI and sequencer read & write `Track.filter` (=== slot-0 filter).
Every `setParam` on it fans out to the sibling slot filters via `Filter.mirrorTo()`, so all
voices stay identical. DJ-filter base-cutoff writes iterate `VoicePool.filters` directly.

#### Continuous Input machine — held-open amp gate (departure)

The Input machine (`InputMachine`, machine family I/O — live audio capture, see
`design/input-machine.md`) is the one source that is continuous and note-less. In its default
**continuous** mode the per-voice amp gate must be held OPEN, since there are no notes to open
it. `Track._applyInputGate()` pins every slot's `Envelope.ampGain.gain` to 1 (called from
`setMachine` and the InputPanel gate toggle), and `Sequencer._fireStep` early-returns for a
continuous-input track — skipping the voice/envelope firing so steps don't re-gate the signal,
while still letting shared filter/pan/FX p-locks sweep the live audio. In **gated** mode
(`input.gate` on) the machine falls back to the normal VoiceSlot path: steps/keys chop the
input through the envelope like any other voice. Leaving the Input machine restores the gate
to closed (0). The Input source itself is a single ref-counted `MediaStreamAudioSourceNode`
shared across slots (one stream, fanned out), not 8 independent sources.

LFOs connect to AudioParams:
  - Filter.node.frequency / Q, _baseLPF/_baseHPF.frequency — connected to ALL 8 slot filters
  - Machine AudioParams (osc.detune, sub.level, output.level, etc.) — connected to ALL 8 slot machines
  - Track.tremGain.gain (amp.level — single shared tremolo VCA, post-envelope so the
    per-note ADSR automation on ampGain can't stomp it; base gain 1.0, LFO rides ± around
    unity. Pair with LFO Bias for one-sided/classic tremolo)
  - Track.pannerNode.pan (amp.pan — single shared)
  - DelayFX / BitcrushFX / ReverbFX params — single shared

Mod wheels use `Track.resolveModWheelParam(path)` → `{ audioParam, min, max }` and
set the AudioParam directly (absolute value in lfoMin–lfoMax range), not additively like LFOs.
Wheel position 0–1 maps linearly to [min, max].
```

### Voice Selection (VoicePool.nextVoice)

Round-robin through 8 slots; picks the first idle one (past its release tail). If all 8 are busy, steals the one whose release ends soonest. Before returning the chosen slot, syncs its machine and envelope params from slot 0 (canonical) so UI knob changes always take effect on the next note. (Filter params stay synced continuously via `Filter.mirrorTo`.)

**Bulk param writes must fan out to the slots.** `machine.fromJSON` / `envelope.fromJSON` write ONLY the canonical slot-0; any path that calls them (project load, paste, **sound-library load**) must follow with `VoicePool.syncParams()` to copy slot 0 into slots 1–7. The machine does *not* auto-mirror (unlike `Filter`, which fans every `setParam` to its mirrors). A missing `syncParams()` left slots 1–7 on the previous machine's stale levels/waveforms — audible as "every 8th note (the canonical slot, hit once per round-robin cycle) sounds different from the other 7" after loading a sound. Fixed in `SoundLibrary.load()` (2026-06-17).

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

### Filter Engine: digital biquad ↔ analogue ladder (`filter.engine`)

`filter.engine` (enum `digital` | `analogue`, default `digital`, p-lockable) selects which DSP
runs after the base filters. Available on **every** track, switchable live in the FILTER tab.

- **digital** — the biquad cascade above (`node` + slope stages). Unchanged default behaviour.
- **analogue** — the **PATINA Moog transistor-ladder** running in an AudioWorklet
  (`js/worklets/patina-ladder-processor.js`): Huovilainen 4-pole filter with tanh saturation,
  self-oscillation (resonance > ~1.0), input drive, and thermal cutoff drift. Fixed 24 dB/oct
  (4-pole) — `filter.slope` does not apply (greyed out). **`filter.type` DOES apply**: a
  `shape` AudioParam selects the response via Oberheim-Xpander-style pole-mixing of the four
  ladder states (LP=s4, HP=x−4s1+6s2−4s3+s4, BP=4s2−8s3+4s4, notch=HP+LP, allpass-ish). The
  ladder has no peaking response, so `peaking` maps to LP. `Filter._LADDER_SHAPE` maps the
  shared `filter.type` enum → shape index; pushed on `filter.type` change and on engine switch.
  The **TYPE dropdown hides `peaking` when engine=analogue** (FilterPanel `buildTypeOptions`);
  switching to analogue while peaking is selected falls the type back to lowpass.

Routing (both subgraphs stay alive; only two cut points move — see `Filter._setEngine`, idempotent
via `_wiredEngine`):
```
digital:  _baseLPF → node → stages… → _outputGain
analogue: _baseLPF →        ladder   → _outputGain
```

The ladder worklet **module is preloaded once at boot** by `AudioEngine` (`ladderReady`/`ladderLoaded`),
so the node is created **synchronously** on first switch to analogue. If the worklet is unavailable
(load failed / OfflineAudioContext without worklet support), the filter stays digital.

Analogue-only params (shown as DRIVE + DRIFT knobs in analogue mode): `filter.drive` (0.1–12,
default 2.0 — input gain into the tanh stage) and `filter.drift` (0–0.08, default 0.01 — thermal
cutoff wander). Both p-lockable + LFO-assignable.

**Resonance mapping**: the UI RES knob is biquad Q (0.1–20). For the ladder it maps linearly to the
worklet's resonance 0–1.15 (`_resToLadder`), so the top of the knob reaches self-oscillation.

**Engine seams** (how the rest of the chain stays engine-agnostic):
- **Cutoff param**: `Filter.cutoffParam()` returns the ladder `cutoff` param in analogue mode, else
  `node.frequency`. The Envelope live-keyboard path and `resolveAudioParam('filter.cutoff')` use it.
- **Envelope sweep**: `Filter.scheduleFrequency` / `anchorFrequency` fan to `_cutoffParams()` — the
  biquad node + slope stages (digital) or the single ladder cutoff (analogue). Envelope code unchanged.
- **LFO → cutoff**: digital rides `.detune` (cents, exponential); the ladder has no `.detune`, so
  `resolveLFOTargets('filter.cutoff')` returns the ladder `cutoff` param (Hz, linear). Depth is then
  interpreted in Hz rather than cents — a known nuance, acceptable.
- **FilterViz**: in analogue mode draws an **approximate** 4-pole (24 dB/oct) curve matching the
  selected `filter.type` (LP/HP/BP/notch/allpass via the matching biquad cascaded ×2, peaking→LP)
  with a resonance bump (can't read the worklet's true response), labelled `≈ LADDER <SHAPE>`.
  For **allpass** (either engine) the magnitude curve is intentionally flat (an allpass only
  shifts phase, so Res/Q don't move the magnitude) — FilterViz labels it `ALLPASS · phase only`.

**Known limitation**: an LFO already assigned to `filter.cutoff` resolves its target at assignment
time, so switching the engine afterwards won't re-point an existing cutoff LFO. Re-assign the cutoff
LFO after choosing the engine.

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

  **Release must cancel-and-hold at `offTime` first (`_scheduleR`).** Because A→D→S and R
  are queued in one shot, when the decay is long enough that its endpoint (`time+attack+decay`)
  falls AFTER the release end (`offTime+release`) — i.e. `attack+decay > gateLen+release` — the
  decay stage's trailing pin/ramp to SUSTAIN is *later in the timeline* than the release, so it
  fires after the release has driven the gate to 0 and slams it back to sustain, holding it there.
  On a persistent-oscillator machine (Moogish/synth/bass/strings/chord, oscillators never stop) a
  frozen-at-sustain amp gate is an **endless drone** — only STOP/panic clears it; the "~2 s of
  silence then it starts" is the gap between the release pin and the late decay pin. Fix:
  `_scheduleR` (amp gate) and `Filter.scheduleFrequency` (filter cutoff) `cancelAndHoldAtTime(offTime)`
  before scheduling the release, dropping any late A/D/S events and ramping from the held value.
  Sequencer/arp-only because the keyboard's `noteOff` already cancels before its release.

**Live keyboard path — `noteOn(time)` / `noteOff(time)`:**
  Cancels prior events and restarts from zero. Used only for keyboard playing.
  These two paths must stay separate — using noteOn from the sequencer caused release bugs.

---

## Unified Sync-Knob Model

Every time/rate param that can lock to tempo uses **one mode-aware knob** (MS↔BPM,
or HZ↔BPM for rate-domain params) instead of a separate ms knob + division
dropdown. The knob's range + formatter swap with the mode; **clicking the knob
center** toggles the mode (the body shows `MS`/`HZ`/`BPM`). Core helpers live in
`js/util/BpmSync.js`; the KnobWidget primitives are `setRange` / `snapPoints` /
`centerLabel` / `onCenterClick`.

- **BPM granularity is a 1/32 count.** A synced param stores `*.bpmCount32` — an
  integer count of 1/32 notes — plus a `*.syncMode` (`ms`/`bpm`, or `hz`/`bpm`).
  `GRID_BASE` (=32, grid units per whole note) is the single resolution constant;
  `GRID_UNIT_QN`, the snap points, and the division names all derive from it, so
  one edit rescales the grid. Seconds = `count32ToSeconds(count, bpm)`; rate-domain
  params (LFO/chorus/vibrato/sweep) treat the count as an oscillator **period** via
  `count32ToHz(count, bpm)`.
- **Display** shows the nearest division + 1/32 remainder (`5` → `1/8 + 1/32`);
  clean divisions render clean (`8` → `1/4`). `formatCount32` handles this.
- **Shift snaps to the next musical division** (`MUSICAL_SNAP_32`).
- **FX/LFO knobs are continuous** (fractional counts via a `FINE_STEP` sub-grid);
  envelopes/arp use integer counts.
- **LFO in BPM mode is always continuous/native** — the LFO modulates the
  underlying *seconds* AudioParam, never a JS-stepped value.
- **Both modes are p-lockable**: ms-seconds via `audioParam`, the 1/32 count via
  `plockMode: 'js'`; `syncMode` is p-lockable too. The two underlying params are
  kept split per param so dispatch/serialisation layers stay untouched.

**Where it's applied** (all migrated): DelayFX time, ReverbFX pre-delay, Arp rate
(chord/random + per manual step), LFO rate (global + per-section), amp/filter
envelope A/D/R (`env.*`/`fenv.*`, sustain excluded), Chorus rate, Strings vibrato
rate, WT-sampler sweep rate, and **FM per-operator ADSR** (FM carries its own
ADSR, parallel to `Envelope.js` — any machine with its own internal envelope needs
the same per-stage treatment). BPM reaches machines via
`Track.onBpmChanged → VoicePool.setBpm → machine.setBpm?.()`.

**Rendering.** The generic `FXPanel._renderSync` (FX) and
`DefaultMachinePanel._renderSyncKnob` (machines) auto-render any number param that
has sibling `<base>.syncMode` + `<base>.bpmCount32` (BPM params marked `hidden`).
Custom panels (Arp, LFO, ADSRWidget, FMPanel, WavetableSamplerPanel) carry their
own `_makeSyncKnob` helper for the same model.

**User-settable finest grid.** The Settings pane exposes a finest division
(1/32 / 1/64 / 1/128). It does **not** change `GRID_BASE` (that would reinterpret
every stored count). Instead `BpmSync.setSnapResolution(gridBase)` reassigns the
live `MUSICAL_SNAP_32` array (prepending sub-1/32 targets) and lowers the FX
knobs' `bpmMin` to reach them; stored counts stay in 1/32 units. `MUSICAL_SNAP_32`
is an exported live `let` binding so panels read it fresh.

**Back-compat.** Every migrated class maps legacy `*.bpmDiv` enum strings → 1/32
count in `fromJSON` (via `divToCount32`) and deletes the legacy key. Covered by
`tests/tests/sync_knob.js`.

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

## Deck Buses & Crossfader

The app runs two `Project` instances ("decks") sharing one `AudioEngine` + one
`Clock` (beatmatch — same BPM). Each deck owns a `Project.busGain` GainNode; every
track in that deck routes its FX-chain tail to that bus instead of the master bus:

```
deck A tracks → projectA.busGain ┐
                                 ├→ AudioEngine.fxBus → masterGain → destination
deck B tracks → projectB.busGain ┘
```

`DeckManager` (`js/state/DeckManager.js`) rides the two bus gains:

- **Crossfader** `x ∈ [0,1]` (0 = full A, 1 = full B), **constant-power**:
  `gainA = cos(x·π/2)`, `gainB = sin(x·π/2)` — applied via `setTargetAtTime`
  (≈12 ms smoothing) so fader drags don't zipper.
- **Per-deck silence** multiplies that deck's bus by 0, independent of the fader.
- Both are folded into one `_applyGains()` pass: `gain = silenced ? 0 : faderGain`.

A single master `AnalyserNode` taps `masterGain`, so the oscilloscope shows the
**blended** mix of both decks.

**Empty decks cost nothing:** an unloaded deck is reset to 0 tracks (no voices,
no sequencers); only its `busGain` node remains (cheap, still connected) so the
deck is instantly reusable. Deck B boots empty. See `ui.md` → Deck Tab.

---

## Known Audio Constraints

- **Shared ampGain node:** All oscillators on a track share one `ampGain` GainNode. A new
  note's attack overwrites the previous note's release — standard monophonic behaviour.
- **linearRampToValueAtTime requires an *explicit* anchor at the start time.** Always precede it
  with `setValueAtTime(value, time)`. **`cancelAndHoldAtTime(time)` alone is NOT a reliable anchor
  in Chrome:** when the only prior events are already in the past, Chrome ramps from the previous
  event's time instead of from `time`, so the ramp starts a scheduler-lookahead early — heard as a
  soft "pre-note" before the onset (Firefox inserts an implicit hold and was unaffected). Every
  cancel-then-ramp site (`Envelope._scheduleADS`, `Envelope.noteOff`, `Filter.scheduleFrequency`)
  therefore re-issues `setValueAtTime` at `time` after the cancel.
- **`cancelAndHoldAtTime` preferred over `cancelScheduledValues`.** The former holds the
  param at its current scheduled value; the latter snaps to the JS-thread value. Still anchor
  explicitly afterwards (see above).
- **Persistent oscillators must `cancelScheduledValues(time)` before retuning on `noteOn`.**
  Melodic machines (SynthMachine, FMMachine, MoogishMachine, BassMachine, WavetableMachine,
  StringsMachine, ChordMachine) keep their oscillators running forever and only retune via
  `frequency.setValueAtTime` per note. LiveArp (input-mode arp) schedules a whole cycle ahead in
  one burst, so a slot reused for the next held chord can still carry **stale future** frequency
  events from the *previous* chord. Without cancelling, the osc hops back to the old pitch when a
  stale event fires — heard as the previous octave bleeding into the first ~8 notes (one per pool
  slot) of the new arp. Each `noteOn`/`_retune`/`_applyChord`/`_applyTuning` therefore calls
  `frequency.cancelScheduledValues(time)` (drops only events ≥ `time`, leaving valid earlier notes
  intact) before the `setValueAtTime`.
- **Never read `gainNode.gain.value` for future state.** Returns the current JS-thread value.
- **Env p-locks must bypass `setParam`.** `Envelope.setParam` only writes `_params`.
  Passing overrides directly to `scheduleNote` is the correct path.
