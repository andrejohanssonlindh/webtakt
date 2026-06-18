# Creating a New Machine — Authoring Guide

The one doc to read before adding a machine. It lists **every file you must touch**,
the **contract** a machine must satisfy, copy-paste **skeletons** for the three common
machine shapes, the **panel** + **test** conventions, and the **doc-update** checklist.
If you follow this, you do not need to re-read the rest of the codebase.

Related: `design/machines.md` (catalogue of every existing machine — read the closest
sibling before writing a new one), `tests/TEST_DESIGN.md` (test harness rules).

---

## 0. TL;DR registration checklist

A machine is "wired in" only when **all** of these are done. Search each file for an
existing machine of the same family and copy its line.

| # | File | What to add |
|---|------|-------------|
| 1 | `js/machines/<Name>Machine.js` | The machine class (extends `Machine`). |
| 2 | `js/state/Track.js` | `import` it; add `'<type>': <Name>Machine` to the `MACHINES` map. |
| 3 | `js/ui/panels/MachinePickerPanel.js` | Add a card `{ type, label, desc }` to the right `MACHINE_GROUPS` family; if it has **no default sound** (samplers, I/O), add its `type` to the preview-exclusion `if` so no ▶ preview button is drawn. |
| 4 | `js/ui/SynthPanel.js` | If it has a **custom panel**: `import` the panel and add a `if (track.machine.type === '<type>') { … new <Name>Panel(…); return; }` branch in `_renderSynth`. Machines with a plain knob grid need **nothing here** (DefaultMachinePanel is the fallback). |
| 5 | `js/ui/panels/<Name>Panel.js` | The custom panel (only if not using DefaultMachinePanel). |
| 6 | `js/machines/LoudnessTrim.js` | Synthesis machines: add a `LOUDNESS_TRIM` entry (start `1.0`, then measure — see §6). **Sample players are intentionally omitted** (they carry their own level). |
| 7 | `tests/tests/machines/<name>.js` + `tests/index.html` | The test suite + its `import` line. |
| 8 | Sample reload hooks (samplers only) | See §4. Single-buffer machines are auto-covered; multi-buffer needs a hook. |
| 9 | Docs | `design/machines.md` (a section), `DESIGN.md` (3 listings), `js/ui/manual.js` (a per-knob entry). See §7. |

Worklet machines also add `js/worklets/<name>-processor.js` (self-loaded by the machine —
no AudioEngine change needed).

---

## 1. The Machine contract

Every machine extends `js/machines/Machine.js` and provides:

```
.type            string id, e.g. 'granular'    (matches the MACHINES map key everywhere)
.label           human name, e.g. 'Granular'
noteOn(midiNote, velocity, time)               trigger at AudioContext `time`
noteOff(time)                                  release (drum/sampler machines: no-op)
setParam(path, value, time?)                   store + apply a param
getParam(path)                                 read a param
getParamList()                                 descriptor array (see §2)
resolveAudioParam(path) → AudioParam | null    for LFO / mod-wheel binding
connect(destinationNode)                       wire machine output → next node
disconnect()                                   disconnect outputs AND release timers/worklets
toJSON() / fromJSON(obj)                        serialize / restore
```

Two ways to implement the param-related members:

- **Declarative `static SPEC`** (preferred for synthesis machines): define `static SPEC`
  and call `this._initSpec()` at the **end** of the constructor. The base derives
  `setParam`/`getParam`/`getParamList`/`resolveAudioParam`/`toJSON`/`fromJSON`. See
  `SynthMachine`, `CymbalMachine`. Details in `design/machines.md` → Declarative Param Spec.
- **Hand-written** (used by all samplers, FM, Bass, Wavetable): write the six members
  yourself. Use this when `toJSON`/`fromJSON` must carry non-param state (e.g. `sampleId`),
  or a param's behaviour doesn't fit the SPEC fields.

> Don't mix: either call `_initSpec()` (and delete the six members) or hand-write them.

### Output chain + loudness trim

Synthesis machines route `outputGain → _trimGain → [Filter]` and connect `_trimGain`:

```js
import { makeTrimGain } from './LoudnessTrim.js';
this.outputGain = context.createGain();
this._trimGain  = makeTrimGain(context, this.type);   // fixed normalisation node
this.outputGain.connect(this._trimGain);
// connect(dest) { this._trimGain.connect(dest); }
```

**Sample players skip the trim** (Sampler/Granular/Slicer/etc. connect `outputGain`
directly) — recorded audio carries its own level, so there is no trim node and no
`LOUDNESS_TRIM` entry.

---

## 2. `getParamList()` descriptors — the contract fields

Each entry is read by the sequencer (p-locks), LFO/mod-wheel routing, the panels, and
serialization. Fields:

```js
{ path: 'grain.size',          // unique key, also the _params key and p-lock key
  label: 'Size',               // UI label
  type: 'number'|'enum'|'boolean',
  min, max, default,           // number
  options: ['a','b'],          // enum (string values — stored value is the string)
  default: true,               // boolean
  modulatable: true,           // LFO/mod-wheel assignable → also give lfoMin/lfoMax
  lfoMin: 0, lfoMax: 1,
  plockMode: 'audioParam'|'js',// see below
  hidden: true,                // omit from the default grid (still p-lockable) — e.g. osc.detune
  group: 'TONE' }              // optional: DefaultMachinePanel clusters by group
```

**`plockMode` is the most important field** — it tells the sequencer how to apply &
restore a p-lock at note time:

- `'audioParam'` — the param is backed by a real `AudioParam`; `resolveAudioParam(path)`
  must return it. The sequencer schedules at sample time. Use for anything an LFO should
  drive (level, cutoff, the granular `position`).
- `'js'` — plain JS value read inside `noteOn` (or applied via a side-effect). The
  sequencer calls `setParam(path, value)` before `noteOn` and restores after. Use for
  enums, booleans, and anything read per-trigger (most sampler params).

> A param can be `modulatable` only if it is genuinely an `AudioParam`
> (`plockMode: 'audioParam'`). For worklet machines, expose worklet `AudioParam`s via
> `resolveAudioParam`.

---

## 3. Three skeletons

### 3a. Synthesis machine (SPEC-driven, with loudness trim)

```js
import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

export class FooMachine extends Machine {
  static SPEC = {
    'tone':         { label: 'Tone', type: 'number', min: 0, max: 1, default: 0.5,
                      target: m => m._toneNode.frequency, modulatable: true, lfoMin: 0, lfoMax: 1 },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.5,
                      target: m => m.outputGain.gain, modulatable: true, lfoMin: 0, lfoMax: 1 },
  };
  constructor(context) {
    super(context);
    this.type = 'foo'; this.label = 'Foo';
    this.outputGain = context.createGain();
    this._trimGain  = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);
    // …build persistent nodes…
    this._initSpec();                  // LAST — after nodes exist
  }
  noteOn(note, vel, time) { /* … */ }
  noteOff(time) { /* … */ }
  connect(dest) { this._trimGain.connect(dest); }
  disconnect()  { this._trimGain.disconnect(); /* + .stop() any timers/oscs */ }
  // setParam/getParam/getParamList/resolveAudioParam/toJSON/fromJSON derived from SPEC
}
```

### 3b. Single-buffer sampler (hand-written + the shared protocol)

Implement the **single-buffer protocol** and you get VoicePool carry-over (same-type and
cross-type swaps) and SampleStore reload **for free** — they are detected by
`typeof machine.setBuffer === 'function'`, no per-type branches.

```js
export class FooSamplerMachine extends Machine {
  constructor(context) {
    super(context);
    this.type = 'foo-sampler'; this.label = 'Foo Sampler';
    this._params = { 'sample.start': 0, 'sample.end': 1, /* … */ 'output.level': 0.85 };
    this._buffer = null; this.sampleId = null; this.sampleName = ''; this._duration = 0;
    this.outputGain = context.createGain();             // NO trim node for sample players
    this.outputGain.gain.value = this._params['output.level'];
  }
  // ── single-buffer protocol ──
  setBuffer(buffer, id, name) { this._buffer = buffer; this.sampleId = id; this.sampleName = name; this._duration = buffer.duration; }
  get hasBuffer() { return this._buffer !== null; }
  getBuffer() { return this._buffer; }
  clearBuffer() { /* stop sources */ this._buffer = null; this.sampleId = null; this.sampleName = ''; this._duration = 0; }
  syncFrom(other) { if (other instanceof FooSamplerMachine && other._buffer && other._buffer !== this._buffer)
                      this.setBuffer(other._buffer, other.sampleId, other.sampleName); }
  // ── protocol ──
  noteOn(note, vel, time) { if (!this._buffer) return; /* createBufferSource per note */ }
  noteOff(time) {}                                     // self-enveloping
  connect(dest) { this.outputGain.connect(dest); }
  disconnect()  { /* stop sources */ this.outputGain.disconnect(); }
  setParam(p, v, t) { this._params[p] = v; if (p === 'output.level') this.outputGain.gain.setTargetAtTime(v, t ?? this.context.currentTime, 0.01); }
  getParam(p) { return this._params[p]; }
  resolveAudioParam(p) { return p === 'output.level' ? this.outputGain.gain : null; }
  getParamList() { return [ /* …; output.level → plockMode:'audioParam', modulatable:true */ ]; }
  toJSON()   { return { type: this.type, sampleId: this.sampleId, sampleName: this.sampleName, params: { ...this._params } }; }
  fromJSON(o){ this.sampleId = o.sampleId ?? null; this.sampleName = o.sampleName ?? ''; Object.entries(o.params ?? {}).forEach(([k,v]) => this.setParam(k,v)); }
}
```

**Always give sample machines `sample.start` / `sample.end` trim** (project rule). Confine
playback / slices / grains to `[start, end]`.

### 3c. AudioWorklet machine

For DSP that can't be expressed with native nodes (granular clouds, time-stretch). The
machine self-loads its processor module and forwards params via `port.postMessage` and/or
worklet `AudioParam`s.

```js
const WORKLET_PATH = 'js/worklets/foo-processor.js';   // relative to the PAGE, not this file
export class FooWorkletMachine extends Machine {
  constructor(context) {
    super(context);
    this.type = 'foo'; this.label = 'Foo';
    this._workletNode = null; this._workletReady = false;
    this.outputGain = context.createGain();
    this._loadWorklet();
  }
  async _loadWorklet() {
    try {
      await this.context.audioWorklet.addModule(WORKLET_PATH);
      this._workletNode = new AudioWorkletNode(this.context, 'foo-processor',
        { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this._workletNode.connect(this.outputGain);
      this._workletReady = true;
      /* push any pending buffer/config */
    } catch (err) { console.error('FooWorkletMachine: worklet load failed', err); }
  }
  resolveAudioParam(p) {                                // expose worklet AudioParams to LFO
    if (p === 'position' && this._workletReady) return this._workletNode.parameters.get('position');
    return p === 'output.level' ? this.outputGain.gain : null;
  }
  disconnect() { if (this._workletNode) { try { this._workletNode.disconnect(); } catch (_) {} } this.outputGain.disconnect(); }
  // …guard every worklet access with this._workletReady…
}
```

Worklet rules (also see `reference_audioworklet_rules` in memory):
- The processor `registerProcessor('foo-processor', …)` name MUST match the
  `new AudioWorkletNode(ctx, 'foo-processor', …)` name.
- `addModule` may reject in the **OfflineAudioContext** used by tests — always wrap in
  try/catch and guard every access with `this._workletReady`. This is why worklet machines
  are **excluded from audio rendering tests** (see §5).
- Send the buffer once (`port.postMessage({type:'buffer', pcm, …}, [transferables])`), send
  trigger/config per note. Hold a `_pendingTrigger` and arm it in `process()` when
  `currentTime >= startTime` if you need sample-accurate start.
- `disconnect()` must `disconnect()` the node; `setBpm(bpm)` if tempo-synced.

---

## 4. Sample reload + carry-over hooks

These keep a loaded sample alive across project save/load, sound load, and machine swaps.

- **Single-buffer machines** (`setBuffer`/`sampleId`): **nothing to add.** The reload hooks
  in `Track.fromJSON` and `SoundLibrary.applySound` detect them by
  `typeof machine.setBuffer === 'function'`, and `VoicePool.setMachine` carries the buffer
  across swaps. Just implement `syncFrom` (for sibling voice slots) and carry `sampleId` in
  `toJSON`.
- **Multi-buffer machines** (MultiSampler): implement `loadZoneBuffers(store, ctx)` and
  carry an id array in `toJSON`. The reload hooks call it via
  `typeof machine.loadZoneBuffers === 'function'`. Implement `syncFrom` to copy all buffers.
  (See `MultiSamplerMachine`.)
- **A/B machines** (WT-Sampler): has its own dedicated `type === 'wt-sampler'` reload branch
  in both files — copy that pattern only if you genuinely need two independent buffers with
  morph.

---

## 5. Tests (`tests/tests/machines/<name>.js`)

The harness is **browser-only** (OfflineAudioContext via `tests/index.html`) — there is no
Node runner on this machine. Add the suite's `import` to `tests/index.html` near the other
`machines/*` imports.

Helpers from `../../runner.js`: `suite`, `test`, `assert` (`.gt/.lt/.near/.ok`),
`makeOfflineTrack(type, durationSec, {bpm})`, `renderSteps(track, ctx, sr, n, stepSec, builder)`,
`rms`, `bandpassRms(buf, sr, centerHz, bwOctaves)`, `spectralCentroid`, `bandEnergy`.

Patterns:
- **Native-node machines** (synthesis, plain BufferSource samplers — Slicer, BeatRepeat,
  MultiSampler): render audio. Inject a synthetic buffer with `track.machine.setBuffer(...)`
  / `setBufferAt(...)`; build buffers whose regions have **distinct frequencies** and assert
  with `bandpassRms` which region/zone/slice sounded. Set `track.filter.setParam('filter.cutoff', 20000)`
  to open the filter. Always test: makes sound with a buffer, silent without, the headline
  behaviour, and `toJSON`/`fromJSON` round-trip.
- **Worklet machines** (Granular, TimeStretch): do **NOT** render audio (AudioWorklet is
  unreliable in OfflineAudioContext — see `tests/TEST_DESIGN.md`). Test the **contract
  only**: `getParamList()` shape (which params are `audioParam`/`modulatable`), defaults,
  `setParam`/`getParam`, `toJSON`/`fromJSON`, `setBuffer`/`hasBuffer`/`syncFrom`, and any
  pure-JS math (e.g. TimeStretch `computeRatio`/`detectBpm`). These run fine because they
  never touch the worklet.

Determinism: if you generate noise in a test buffer, seed your PRNG (peak/RMS assertions
flake on `Math.random`). See `makeNoiseBuffer` in `beat_repeat.js`.

Don't add SPEC-driven machines to `tests/tests/machines/param_spec.js` unless they use
`static SPEC`; hand-written samplers are excluded there by design.

---

## 6. Loudness trim (synthesis machines only)

1. Add `'<type>': 1.0` to `LOUDNESS_TRIM` in `js/machines/LoudnessTrim.js`.
2. Open `tests/loudness.html` (the bench), find your machine's suggested factor, set it.
3. Re-run after any synthesis change. Spiky percussion is capped so peak ≤ ~0.90.

**Skip entirely for sample players** — they are intentionally absent from the map.

---

## 7. Docs to update (every machine)

1. **`design/machines.md`** — add a `### <Name>Machine (`type: '<type>'`)` section: blurb,
   ASCII audio graph, parameter list (mark which are AudioParam/LFO targets), custom panel,
   Files line, and whether it's audio-tested or worklet-excluded. Put samplers under the
   "Sampler Machines" run.
2. **`DESIGN.md`** — three listings: the `js/machines/` file line, the `js/ui/panels/` line
   (if custom panel), and the "Machines" status-table row.
3. **`js/ui/manual.js`** — a `'<type>': { title, blurb, items: [[label, help], …] }` entry
   (in-app SYNTH-tab help). One `items` row per knob/toggle.

> Project rule (memory): update `DESIGN.md` and `js/ui/manual.js` on any machine/panel
> change, not just new machines.

---

## 8. Panel conventions (custom panels)

Custom panels live in `js/ui/panels/<Name>Panel.js`, constructed as
`new <Name>Panel(container, ctx, sampleStore, audioContext)` from `SynthPanel._renderSynth`.
The `ctx` (from `SynthPanel._makeTabContext`) gives you:

- `ctx.machine` — the canonical machine.
- `ctx.writeValue(machine, path, value, emitChange)` — **the p-lock-aware write path**;
  always use this, never `machine.setParam` directly, so step p-locks work.
- `ctx.emitStep()` — call on knob release / drag end to commit a p-lock to the selected step.
- `ctx.activeWidgets` — push every `KnobWidget` and any `{ destroy() }` cleanup (ResizeObservers,
  document listeners) so the panel tears down cleanly.
- `ctx.getTrack()`, `ctx.renderContent()`, `ctx.state`.

Reuse the shared sampler CSS so the panel is responsive (desktop 3-up → iPad 2-up → phone
1-up) automatically:
- `.sampler-wrap` (column), `.sampler-topbar` (load/rec/dl row), `.sampler-canvas-wrap` +
  `.sampler-waveform` (waveform), `.sampler-groups` (reflowing row of groups),
  `.param-group` + `.param-group-label` + `.param-group-body` (one labelled knob cluster),
  `.sampler-toggle` / `.sampler-toggle-btn` / `.sampler-action-btn`, `.param-select` (enum).
- Knobs: `new KnobWidget({ label, min, max, value, size: 56, fmt, onChange, onRelease })`.
  KnobWidget values are **continuous** (no `step` option) — round in `fmt` and in `noteOn`
  for integer params.
- Make canvas drags **touch-friendly**: bind both `mousedown`+`mousemove`+`mouseup` and
  `touchstart`+`touchmove`+`touchend` (`{ passive: false }` + `preventDefault`).

Machines with a plain knob grid need **no panel** — `DefaultMachinePanel` renders
`getParamList()` automatically (and clusters by the optional `group` field).

---

## 9. Common pitfalls

- **Forgetting a registration point.** Use the §0 table; the type string must be identical
  in: `.type`, MACHINES map, picker card, panel routing, manual key, test. Grep for an
  existing type to confirm parity.
- **`modulatable: true` without a real AudioParam.** The LFO will try to bind and get
  `null`. Either back it with an AudioParam (native or worklet) and return it from
  `resolveAudioParam`, or set `modulatable: false`.
- **Writing `machine.setParam` from a panel.** Breaks p-locks — use `ctx.writeValue`.
- **Leaking timers/worklets.** `disconnect()` must `.stop()` any `setInterval`/oscillators
  and `disconnect()` the worklet node — VoicePool drops the reference right after.
- **Enum value vs index.** Enum params store the **string** option, not an index. If you
  want a numeric selector, use `type: 'number'` (p-lockable just the same).
- **Worklet path is page-relative** (`'js/worklets/…'`), not relative to the machine file.
- **Sample machine without trim.** Add `sample.start`/`sample.end` and honour them.
```
