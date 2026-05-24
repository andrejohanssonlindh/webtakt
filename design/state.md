# State, Persistence & Libraries

## Save / Load

`Project.toJSON()` serializes full state to a plain object:
- BPM
- Per track: machine type + params, filter params (including base.lpf/base.hpf), envelope params,
  LFO params + destinations, pan value, sequencer (stepCount, pageOffset, all 64 steps), mod wheel targets

`Project.fromJSON(obj)` restores full state.

**No auto-load on boot** — always starts fresh. EXPORT/IMPORT is the explicit save path.
Export downloads a `.json` file; Import reads a `.json` File object.

> Note: `Project.js` uses `'pysynth_project'` as the localStorage key (old name). Low priority since auto-load is disabled.

---

## Sound Library

A persistent library of named sounds (voice snapshots) stored in `localStorage` under `webtakt_sounds`.

**What a sound captures:** machine type + params, filter, envelope, FX chain (delay/bitcrush/reverb), LFOs + destinations, pan, trigTone.
**What it does NOT capture:** sequencer steps, step count, page offset, mute state.

**Files:**
- `js/state/SoundLibrary.js` — CRUD: `save(name, tags, track)`, `load(id, track)`, `delete(id)`, `rename()`, `setTags()`, `allTags()`
- `js/ui/panels/SoundLibraryPanel.js` — panel content: tag filter chips + scrollable card list

**UI:** SOUNDS tab in the SynthPanel tab bar. Clicking the tab opens the panel with:
- `+ SAVE SOUND` button → two-step modal (name, then comma-separated tags)
- Tag filter chips (ALL + one per tag + `+ TAG` to define a new category)
- Scrollable list of sound cards (name, tags, machine badge), each with LOAD / ✎ edit / ✕ delete

Loading a sound swaps the current track's machine and all signal chain params, leaving sequencer data intact.

---

## SampleStore

`js/state/SampleStore.js` encodes `AudioBuffer` as PCM16 WAV → base64 and stores in localStorage under `webtakt_samples`.

Each entry: `{ id, name, mimeType, data, createdAt }`.
- `save(name, buffer)` → `{ id, persisted }`. `persisted: false` if localStorage quota exceeded (stays in memory cache).
- `load(id, context)` → `Promise<AudioBuffer|null>`. Decodes on first call, caches decoded buffer in memory.

**Sample persistence in saved projects:** `SamplerMachine.toJSON()` includes `sampleId` and `sampleName`. On `fromJSON()`, `Track` asynchronously loads the buffer from `SampleStore` via the track's `sampleStore` reference (set by `Project` at construction). The same async restore happens in `SoundLibrary.load()`.
