# Responsive / Multi-Surface Refactor

Working doc for scaling Webtakt beyond the fixed desktop layout — toward iPad
and (ambitiously) phone, with **full track-building**, not a reduced remote.

This is the scratch/plan doc for the effort. DESIGN.md is **not** updated until a
phase is fully landed and verified — keep churn out of the canonical doc.

## Goal & constraints

- Target tiers: desktop (today) → iPad landscape → iPad portrait / large phone → phone.
- Small screens must still allow **full track building**, not just live tweaking.
- The audio engine, state, and FX/sequencer logic are screen-agnostic and must be
  **reused unchanged** by any new surface. No second engine.

## Key findings (why this is feasible)

- **State/event layer is real.** `AppState` is a genuine store with an event bus
  (`on`/`off`/`emit`); panels react to events, not to each other. Engine
  (`js/core`, `js/signal`, `js/machines`) is fully DOM-decoupled. A second
  front-end can sit on the same engine + state.
- **Panels are self-contained render units** (`Panel.render(ctx)` builds its own
  DOM from a context bag). Modular, hence portable.
- **But:** panels encode *desktop layout* imperatively (fixed knob `size:`, fixed
  column structure, canvas heights) — so responsive CSS alone can't reflow them.
  Small-screen panels need compact render paths, panel by panel (Phase 3).
- **CSS was written for one viewport:** ~849 hardcoded `px`, effectively one
  media query in the whole codebase. A `:root` with custom props already exists,
  so a `rem`/`clamp` + root-scale pass lands naturally there (Phase 1).
- **Boot logic was trapped in an inline `<script>` in index.html** (~760 lines:
  UI mount + transport wiring + real logic like page-nav/step-shift/MIDI routing).
  No other entry point could reuse it. Phase 0 fixes this.

## Decisions made

- **Not** a blind `px → %` conversion. Percentages stretch elements; they don't
  solve "too many elements at once." Use `rem` + root font-size scale + `clamp()`
  for genuine proportional scaling (Phase 1). `%` reaches iPad, not phone.
- **On-screen keyboard = live-play only** on small screens. Click-step-then-click-
  note pitch entry is a desktop affordance; replace with tap-step → note-picker.
- **Step grid → 4×4** on small screens. Maps cleanly to the existing 16-step/page
  model (page N = next 4×4). `StepGrid` already builds an inner grid div from
  `getVisibleSteps()`, so this is mostly a `grid-template-columns` change.

## Phases

- [ ] **Phase 0 — Detangle boot.** Extract the inline `index.html` script into a
      module (`js/boot.js`) imported by index.html. Behavior byte-identical;
      desktop unaffected. Unlocks a reusable entry point for the mobile shell.
      *(Optional follow-up later: split boot.js into transport.js / trackNav.js.)*
- [~] **Phase 1 — Fluid sizing pass.** `rem`/`clamp` + root-scale variable.
      Reaches iPad-landscape + large screens. Reversible, testable on desktop.
      - [x] **Step 1a — root scale + font-sizes.** Added `html { font-size:
            clamp(...) * --ui-scale }` (1rem === 11px on desktop). Converted all
            184 `font-size: Npx` → `rem` (verified: 0 px font-sizes left, no other
            px property touched). Borders/radii stay px. `--ui-scale` reserved for
            a future zoom setting (no UI yet). `letter-spacing` em values scale
            correctly; no px line-heights to worry about.
      - [x] **Step 1a.1 — fix timid clamp.** First clamp stayed pinned at 11px
            until <768px, so narrowing did nothing visible. New curve
            `clamp(8px, 0.7vw + 3.6px, 11px)` eases from ~1100px down. Desktop
            still 11px.

## PIVOT (2026-06-16)

Step 1a (font-only) was nearly invisible because this layout is **box/grid-
driven, not text-driven** (keyboard keys are `%`, knobs/panes are px boxes).
Fluid scaling alone is low-value here. The real win is **reflow** — rearranging
big containers at breakpoints. So the ambition is restated plainly: an
**adaptive UI**, rolled out **one surface at a time**, each committed separately
so any step is easy to revert.

Breakpoints: tablet `<=1024px`, phone `<=640px`.

### Adaptive surfaces (in order)
- [x] **A — Step grid reflow.** 16-wide → 8-wide (tablet) → 4×4 (phone).
      Pure CSS: `.step-grid-inner` col-count override; `#middle-row` height:auto
      then column at phone. Cells are `aspect-ratio:1` so they stay square.
- [x] **B — Transport bar.** Content-driven wrap (base `flex-wrap` on
      `#transport` + `.transport-right`, `min-height:32px`) so the row breaks the
      instant buttons would overflow — at any width, no breakpoint guessing.
      Global `.btn { white-space:nowrap }` stops labels reflowing across lines.
      **Overflow menu:** rarely-used controls (4× CLR, TRACKS ±, EXPORT, IMPORT)
      wrapped in `.transport-overflow` behind a `⋯` toggle (`#btn-overflow`,
      wired in boot.js: toggles `.open`, click-outside closes). Desktop shows the
      group inline + hides the toggle (no change); only at `<=640px` does it
      collapse into a dropdown. BPM slider capped at 90px so it never claims a
      full row. Result: phone transport stays <=2 rows.
- [ ] **C — Synth panel** → one-panel-at-a-time + tab bar on narrow.
- [ ] **D — Keyboard** → live-play strip on narrow.
- [ ] **E — Knob/component sizes** (JS — `size:` passed in panel render code).
- [ ] **Phase 2 — Mobile shell.** New `mobile.html` + tab-bar nav (one panel at a
      time), 4×4 step grid, live-only keyboard, tap-step → note-picker. Reuses
      engine, state, most panels.
- [ ] **Phase 3 — Per-panel compact modes.** Incremental, opt-in (same style as
      the machine SPEC refactor).

## Status log

- 2026-06-16: Doc created. Starting Phase 0 (boot extraction).
- 2026-06-16: Phase 0 landed + pushed (commit "extract inline index.html boot").
- 2026-06-16: Pivot to adaptive/reflow (fluid-alone too invisible here).
- 2026-06-16: Surface A (step grid 16→8→4×4) + fluid type landed + pushed.
- 2026-06-16: Surface B (transport wrap + overflow menu + compact BPM) — **done,
  awaiting in-browser verify, NOT yet committed.**

## Next up

- **Surface C — Synth panel → one-panel-at-a-time + tab bar on narrow.** The hard
  one (tab nav model; some panels encode desktop layout imperatively in JS render
  code, so may need per-panel compact paths). Pause to agree the approach before
  diving in. Files: `js/ui/SynthPanel.js`, `js/ui/panels/*`, panel CSS.
- Then D — Keyboard (live-play strip), E — knob/component sizes (JS `size:`).
- Verify pattern: resize desktop browser across desktop/tablet/phone widths;
  user verifies in-browser (no headless). Hard-refresh to dodge CSS module cache.
