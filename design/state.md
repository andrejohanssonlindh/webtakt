# State, Persistence & Libraries

## Save / Load

`Project.toJSON()` serializes full state to a plain object:
- BPM
- Per track: machine type + params, filter params (including base.lpf/base.hpf), envelope params,
  LFO params + destinations, pan value, sequencer (stepCount, pageOffset, all 64 steps), mod wheel targets

`Project.fromJSON(obj)` restores full state.

**Auto-cache (work-in-progress persistence).** The boot project (deck A — the song
the user works on) is auto-saved to localStorage under `webtakt_project` and
restored on the next load, so a reload or a close-and-reopen brings the whole song
back (pattern, params, FX, sample IDs — and the sample audio itself via SampleStore).
Wiring lives in `boot.js`:
- **Save:** `AppState.onAny()` (a wildcard event subscriber) schedules a debounced
  `project.save()` (~800 ms) after any mutation — knob drags, step edits, machine
  swaps, sample loads, clears. A synchronous flush runs on `pagehide` and on
  `visibilitychange → hidden` so closing/backgrounding the tab persists immediately.
- **Load:** `_loadFromHash()` restores the cache when no `#p=` share link is present;
  a share link still overrides the cache on boot.
- **Clear:** `CLR ALL` resets every track to its **starter-kit** machine + default
  params (kick/snare/hihat/bass/moogish/synth/sampler/granular — the same layout a
  fresh project boots with, via `Project.defaultMachineFor(i)`), which auto-saves
  that clean project — the "start over" path. `CLR TRACK` does the same for the
  selected track (FX track falls back to plain synth). `Track.resetTrack(type)`
  takes the target machine type (default `'synth'`).

EXPORT/IMPORT remains the explicit file save path (downloads / reads a `.json` File).
The DECK performance layer (deck B) is intentionally NOT cached.

---

## Sound Library

A persistent library of named sounds (voice snapshots) stored in `localStorage` under `webtakt_sounds`.

**What a sound captures:** machine type + params, filter, envelope, FX chain (delay/bitcrush/reverb), LFOs + destinations, pan, trigTone.
**What it does NOT capture:** sequencer steps, step count, page offset, mute state.

**Files:**
- `js/state/SoundLibrary.js` — CRUD: `save(name, tags, track)`, `load(id, track, keep)`, `delete(id)`, `rename()`, `setTags()`, `allTags()`
- `js/ui/panels/SoundLibraryPanel.js` — panel content: tag filter chips + scrollable card list

**UI:** SOUNDS tab in the SynthPanel tab bar. Clicking the tab opens the panel with:
- `+ SAVE SOUND` button → two-step modal (name, then comma-separated tags)
- Tag filter chips (ALL + one per tag + `+ TAG` to define a new category)
- Scrollable list of sound cards (name, tags, machine badge), each with LOAD / ✦ load-special / ✎ edit / ⤓ export / ✕ delete

Loading a sound swaps the current track's machine and all signal chain params, leaving sequencer data intact.

**Load Special (`✦`):** `load(id, track, keep)` takes an optional `keep = { amp?, filter?, fx? }` flag set. The voice/machine section **always** loads; each true flag *skips* that section's restore so the track keeps its current setting: `amp` = amp envelope + pan; `filter` = the filter; `fx` = delay/crush/chorus/reverb + FX pipeline order/instances. The analogue-flow flag (spans filter + FX + env curves) is only re-applied when neither filter nor fx is kept. The ✦ button on each card opens an inline popout of "keep" checkboxes + CONFIRM LOAD (`SoundLibraryPanel._toggleLoadSpecial`); the plain LOAD button passes no flags (loads everything).

---

## SampleStore

`js/state/SampleStore.js` encodes `AudioBuffer` as PCM16 WAV → base64 and stores in localStorage under `webtakt_samples`.

Each entry: `{ id, name, mimeType, data, createdAt }`.
- `save(name, buffer)` → `{ id, persisted }`. `persisted: false` if localStorage quota exceeded (stays in memory cache).
- `load(id, context)` → `Promise<AudioBuffer|null>`. Decodes on first call, caches decoded buffer in memory.

**Sample persistence in saved projects:** `SamplerMachine.toJSON()` includes `sampleId` and `sampleName`. On `fromJSON()`, `Track` asynchronously loads the buffer from `SampleStore` via the track's `sampleStore` reference (set by `Project` at construction). The same async restore happens in `SoundLibrary.load()`.

**Sample persistence across machine swap:** `fromJSON()` restores `sampleId`/`sampleName` but NOT the live `AudioBuffer`. On a **same-type** rebuild (`VoicePool.setMachine`), the new machine's `syncFrom(oldCanonical)` carries the in-memory buffer over. On a **cross-type** swap between SINGLE-buffer samplers (`sampler` ↔ `sample-swarm`), `VoicePool.setMachine` carries both the buffer (shared `getBuffer()`/`setBuffer()` protocol) **and every param the two machines have in common** (`sample.start`/`end`/`loopStart`, speed, reverse, loop, level …) — so a sample + its trim/loop settings survive the switch. Params unique to either side stay at the new machine's defaults. The A/B `wt-sampler` lacks the buffer protocol (only `setBufferA`/`setBufferB`) and is correctly excluded.

**RESET (SamplerPanel):** a `↺ RESET` button next to LOAD FILE drops the sample on every voice slot (`VoicePool.clearSampleBuffers()` → `Machine.clearBuffer()`) and resets all params to their SPEC defaults — the explicit "start anew" path now that swaps preserve state.

**WAV download:** `SampleStore.bufferToWav(buffer)` (PCM16) is reused by the SamplerPanel `⤓ WAV` button (`_downloadSample`) to export the loaded/recorded buffer as a file. Button is disabled when no buffer is loaded.
