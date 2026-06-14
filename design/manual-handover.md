# Handover: Fill in the in-app manual (Tier 1)

**For:** an implementing agent (Sonnet is fine — this is content work against a
finished framework, not architecture).
**Goal:** Write the manual content for every remaining tab in the synth panel.
The framework is already built and shipped; the FILTER tab is fully seeded as
the worked example. Your job is to replicate that for the other tabs.

---

## What already exists (do not rebuild)

The Tier-1 manual system is complete:

- **`js/ui/manual.js`** — holds two registries and the `ManualOverlay` class
  (the modal). **You only edit the two registries.** Do not touch
  `ManualOverlay`, the CSS, `SynthPanel`, or `index.html` unless you find an
  actual bug.
  - **`MANUAL_CONTENT`** — keyed by tab name (`filter`, `synth`, …). One entry
    per tab.
  - **`MACHINE_MANUAL`** — keyed by machine type (`moogish`, `fm`,
    `kick.analogue`, …). Per-machine SYNTH-tab sections. See the SYNTH note
    below — this is how per-machine help works.
- The **📖 transport button** toggles "manual mode"; a **?** button then appears
  in the tab bar and opens the overlay for the active tab.
- Tabs with no `MANUAL_CONTENT` entry already render a graceful "not documented
  yet" placeholder — so partial progress is always shippable.

See `design/ui.md` → "In-App Manual (Tier 1, per-tab help)" for the design note.

## The authoring format (copy this exactly)

Each tab is one entry in the `MANUAL_CONTENT` object, keyed by the tab's
internal name (the `data-tab` / switch key, lowercase):

```js
tabkey: {
  title: 'TITLE IN CAPS',
  blurb: 'One or two sentences: what this tab is for, the big picture.',
  items: [
    ['CONTROL NAME', 'Plain-language description of what this control does ' +
                     'and when you would reach for it.'],
    // ...one row per control
  ],
},
```

Study the existing **`filter`** entry in `js/ui/manual.js` before writing — it
is the style target. Note specifically how it:
- keeps the blurb conceptual (what/why), not a control list;
- gives each control a *functional* description (what it does to the sound),
  not a restatement of its label;
- flags engine/mode-specific controls explicitly (e.g. "Analogue only", "Digital
  engine only") when a control only appears or applies in one mode.

## Tabs to document (internal key → source file to read first)

The tab keys live in `SynthPanel._renderContent()` (`js/ui/SynthPanel.js`). For
each, **read the listed panel source to see the real controls** before writing:

| key | title | source of truth (read this) |
|---|---|---|
| `machine` | MACHINE | `js/ui/panels/MachinePickerPanel.js` |
| `sounds`  | SOUNDS  | `js/ui/panels/SoundsPanel.js`, `SoundLibraryPanel.js` |
| `scales`  | SCALES  | `js/ui/panels/ScalesPanel.js` |
| `trig`    | TRIG    | `js/ui/panels/TrigPanel.js` |
| `synth`   | SYNTH   | per-machine — uses `MACHINE_MANUAL`; see "SYNTH tab" note below. Generic `synth` fallback already seeded |
| `arp`     | ARP     | `js/ui/panels/ArpPanel.js` |
| `amp`     | AMP     | `js/ui/panels/AmpPanel.js` |
| `lfo`     | LFO     | `js/ui/panels/LFOPanel.js` (+ `js/signal/LFO.md`) |
| `midi`    | MIDI    | `js/ui/panels/MidiInPanel.js` |
| `mixer`   | MIXER   | `js/ui/panels/MixerPanel.js` |
| `deck`    | DECK    | `js/ui/panels/DeckPanel.js` (+ `design/deck.md` if present) |
| `delay`   | DELAY (FX)  | `js/ui/panels/FXPanel.js` (+ `design/fx.md`) |
| `crush`   | CRUSH (FX)  | `js/ui/panels/FXPanel.js` (+ `design/fx.md`) |
| `chorus`  | CHORUS (FX) | `js/ui/panels/FXPanel.js` (+ `design/fx.md`) |
| `reverb`  | REVERB (FX) | `js/ui/panels/FXPanel.js` (+ `design/fx.md`) |

`filter` is **already done** — use it as your reference, don't redo it.

### Suggested order
Easiest/highest-value first: `amp`, `arp`, `lfo`, the four FX tabs (`delay`,
`crush`, `chorus`, `reverb`), then `trig`, `scales`, `sounds`, `midi`, `mixer`,
`deck`. Do the SYNTH/per-machine work last (it's the largest).

### SYNTH tab — per-machine sections (the big one)
The SYNTH tab is **machine-dependent**: the controls change per machine type,
rendered by different panels. The framework now supports this via the
**`MACHINE_MANUAL`** registry (keyed by `track.machine.type`). When SYNTH help
opens, the overlay shows the loaded machine's entry if present, else the generic
`synth` entry (already seeded in `MANUAL_CONTENT`).

To document machines:
1. Find the machine type keys — they're the keys of the machine map in
   `js/state/Track.js` (search `setMachine` / the type→class map) and the
   `MACHINE_DEFS` in `js/ui/panels/MachinePickerPanel.js`.
2. For each machine, **read both** its UI panel (which renders the SYNTH-tab
   knobs — e.g. `DefaultMachinePanel.js`, `FMPanel.js`, `SamplerPanel.js`,
   `WavetableSamplerPanel.js`, `SampleSwarmPanel.js`, `MidiPanel.js`) **and** the
   machine class in `js/machines/` (its `static SPEC` lists the real params,
   ranges, defaults). Document the controls that actually render.
3. Add a `MACHINE_MANUAL['<type>'] = { title, blurb, items }` entry.

This is the largest chunk and is itself splittable per machine. It is fine to do
a subset (e.g. the most-used machines first); the rest fall back to the generic
`synth` text automatically. **Do not** invent params — `static SPEC` is the
source of truth for what exists. Leave the generic `synth` entry in place as the
fallback; don't delete it.

## Hard rules (these matter)

1. **Read the real panel source for each tab before writing its entry.** List
   the controls that actually exist — correct labels, correct behavior. Do
   **not** write descriptions from memory or from the label alone. If a knob's
   range/units clarify its meaning (e.g. a 0–500 ms delay), confirm them in
   source.
2. **Match labels to what the UI shows.** If the panel renders a knob labeled
   `KEYTRK`, the manual row name is `KEYTRK` (you may expand it in the
   description, e.g. "Key tracking — …").
3. **Mode/engine-specific controls** must say so (mirror how FILTER marks
   "Analogue only" / "Digital engine only"). Several tabs have controls that
   only show in certain states — call those out.
4. **Descriptions are functional and plain.** What does it do to the sound, and
   when would you use it. No marketing, no restating the label.
5. **One entry per tab**, keys exactly as in the table above. Don't invent tab
   keys.
6. **Update `design/ui.md`** — the "Currently seeded: FILTER" line should be
   updated to list the tabs you've documented. (Project rule: design doc tracks
   architectural/UI state.)

## Constraints of this environment

- **No Node/npm on this machine** — you cannot run a build or `node --check`.
  Verify your edits by re-reading them. Keep `manual.js` valid ES module syntax
  (it's plain object literals + string concatenation; no transpile step).
- The app is served statically (Python http.server on :8000). **The user
  verifies in the browser themselves — do not launch a browser or headless
  Chrome.**
- Edits should use surgical string replacement, not full-file rewrites of
  `manual.js`. Present changed files for the user to review.

## Definition of done

- Every tab key in the table (except `filter`, already done) has a
  `MANUAL_CONTENT` entry, OR is explicitly noted as intentionally skipped with a
  reason.
- SYNTH: the generic `synth` fallback stays in place, and `MACHINE_MANUAL` has
  per-machine entries for at least the common machines (document as many as
  practical — the rest fall back automatically). State which machines you
  covered and which still fall back.
- Each entry follows the format and the FILTER style.
- `design/ui.md` updated to reflect which tabs / machines are now documented.
- A short summary back to the user: which tabs and machines you documented, and
  any controls you were unsure about (and why).

## How to test (user-driven)

Tell the user to: serve the app, click 📖 in the transport bar, then visit each
tab and click the **?** button to read its section. For SYNTH, load different
machines (MACHINE tab) and re-open the **?** to confirm the per-machine sections
swap correctly and undocumented machines show the generic fallback. Esc / ✕ /
outside-click closes the overlay.
