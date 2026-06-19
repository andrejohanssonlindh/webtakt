# Sample Browser (curated + archive.org)

A "🔍 BROWSE" affordance on every sampler machine for loading samples without a
local file pick. Two sources, no login required:

- **CURATED** — a shipped, hand-picked list of free / public-domain one-shots
  (`samples/curated.json`), filterable by category. Always reliable.
- **ARCHIVE.ORG** — a live search of the Internet Archive's public audio.

## Why archive.org

It is the only large audio host that is **CORS-open AND auth-free**: its
`advancedsearch.php`, `metadata/<id>`, and `download/<id>/<file>` endpoints all
return `Access-Control-Allow-Origin: *`, so the browser can `fetch()` the raw
bytes and `decodeAudioData()` them directly — no API key, no OAuth (which is why
Freesound was rejected). The `/download/` URL 302-redirects to a per-node host;
the redirect target is also CORS-open, so a plain `fetch(url)` works end to end.

Trade-off: archive.org is general archives, not a clean sample bank. The
CURATED list is the antidote — a clean, finite set. Two filters keep the
ARCHIVE tab usable:

**Search relevance.** The `audio` mediatype is dominated by spoken-word
collections (LibriVox audiobooks, old-time radio, podcasts), so a bare keyword
like "bird" used to return Lord of the Rings and Julius Caesar. `search()` now
matches the keyword against the item **title** (not full text) and excludes
those collections/subjects (`EXCLUDE_COLLECTIONS` / `EXCLUDE_SUBJECTS`), sorted
by downloads. If a title search returns nothing it retries once `broad` (full
text) so unusual terms still get results.

**One-shot vs. full track.** `listFiles()` hides files over 6 MB AND over
`MAX_ONESHOT_SECONDS` (30 s), then de-dupes wav/mp3 copies of the same clip.
Duration is the key filter: a 10-minute track encoded as Ogg Vorbis comes in
*under* the 6 MB byte cap, so it used to load, draw a waveform, then play ten
silent minutes on a single key-press — the classic "it loaded but won't play".
archive.org reports `length` (seconds) per file, so we filter on real duration.
When every file is hidden, the file list shows a **"+ show full-length files"**
button that re-requests with `includeLarge` (for users who want to chop a full
track themselves).

## Files

| File | Role |
|---|---|
| `js/state/ArchiveSearch.js` | Pure data access — `search(query)` → items, `listFiles(id)` → load-ready audio-file URLs. No DOM. |
| `js/state/CuratedSamples.js` | Loads `samples/curated.json`; in curator mode `add()`/`remove()` POST to the curate server (which writes the file). Detects curator via `GET /curate/status`. |
| `js/ui/panels/SampleBrowser.js` | The overlay UI (CURATED + ARCHIVE tabs). Calls a host `onLoad(url, name)` callback — never touches the audio graph itself. |
| `js/ui/panels/sampleBrowserButton.js` | `addBrowseButton(panel)` — inserts BROWSE next to a panel's `.sampler-load-btn`, fetches the chosen URL into a `File`, runs it through the panel's own `_loadFile(file)`, then records `panel.machine.sampleUrl` so saving the track persists the link. Shares one `CuratedSamples` instance across panels. |
| `tools/curate_server.py` | Local dev server: serves the site AND writes `samples/curated.json` on `POST /curate/add` / `/curate/remove`. `GET /curate/status` lets the app detect it. 127.0.0.1 only. |
| `samples/curated.json` | `{ version, items: [{name, category, url, source, license}] }`. Seeded from the public-domain `mailboxbadgerdrumsamplesvolume2` pack. |

## Wiring a sampler panel

Single-buffer panels (`SamplerPanel`, `WavetableSamplerPanel`, `GranularPanel`,
`SlicerPanel`, `TimeStretchPanel`, `BeatRepeatPanel`) call `addBrowseButton(this)`
at the end of `_render()` (after `this.container.appendChild(wrap)`). The helper
requires a `.sampler-load-btn` element and an `async _loadFile(file)` method — it
fails silently if the button is absent, so BROWSE is purely additive.

`MultiSamplerPanel` is the **multi-buffer exception**: its `_loadFile(i, file)`
is per-zone, so it wires a dedicated per-zone 🔍 button inline (same fetch →
`File` → `_loadFile(zone, file)` path) rather than using the shared helper.

## Curator mode (local curate server)

The curated list works online for everyone — it's just a static
`samples/curated.json`. EDITING it is the privileged part. A browser can't write
to disk, so the curate server does it:

```
python3 tools/curate_server.py        # serves the app on :8000 AND writes curated.json
```

When the app loads, `CuratedSamples` pings `GET /curate/status`. If the curate
server answers (`{curator:true}`), the browser shows a green **● CURATOR** badge,
each ARCHIVE file row gets a **★ ADD** button, and each CURATED row gets a **✕**
remove button. ADD/REMOVE `POST` to the server, which appends/drops the entry in
`samples/curated.json` immediately. Workflow: find on archive → ★ ADD (file
written) → `git commit` → live for everyone.

This is the safety mechanic: with a plain static server (`python3 -m
http.server`) or on GitHub Pages, `/curate/status` 404s, `isCurator` is false,
and the ADD/REMOVE affordances never appear — visitors can only browse + load.
The server binds 127.0.0.1 only, so it's not reachable from other machines.

## Saving a track that uses a remote sample

Local samples are stored in `SampleStore` (localStorage, base64 WAV) keyed by
`sampleId`, and a track's `toJSON` persists just that id. But large samples
silently overflow localStorage (`save()` returns `persisted:false`, which the
panels ignore), so on reload the id resolves to nothing and the sample is lost.

Single-buffer sampler machines (`SamplerMachine`, `BeatRepeatMachine`,
`GranularMachine`, `SlicerMachine`, `TimeStretchMachine`, `SampleSwarmMachine`)
therefore also carry a **`sampleUrl`** — set by the BROWSE load path, persisted
in `toJSON`, restored in `fromJSON`, and cleared on `clearBuffer`. On project
load `Track.fromJSON` tries `SampleStore.load(sampleId)` first; if that misses
**and** a `sampleUrl` is present, it re-fetches + decodes from the URL
(`Track._fetchUrlBuffer`, no localStorage write). So big archive.org / curated
samples survive a reload as long as the source is still reachable. Failure
(offline, item removed, CORS) degrades quietly — the track loads without audio.

`MultiSamplerPanel` (per-zone buffers) does **not** yet persist zone URLs — a
follow-up if remote multi-zone kits become common.

## Limitations / future

- Loading streams from the host, so it needs a connection (local files don't).
- archive.org node hosts occasionally return 503 under load; the loader surfaces
  the error in the status line and leaves the panel usable.
- Possible later: an archive.org "loose-files only" search filter, or a Freesound
  tab behind an opt-in API key for users who want the bigger filtered library.
