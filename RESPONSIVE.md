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
- [ ] **Phase 1 — Fluid sizing pass.** `rem`/`clamp` + root-scale variable.
      Reaches iPad-landscape + large screens. Reversible, testable on desktop.
- [ ] **Phase 2 — Mobile shell.** New `mobile.html` + tab-bar nav (one panel at a
      time), 4×4 step grid, live-only keyboard, tap-step → note-picker. Reuses
      engine, state, most panels.
- [ ] **Phase 3 — Per-panel compact modes.** Incremental, opt-in (same style as
      the machine SPEC refactor).

## Status log

- 2026-06-16: Doc created. Starting Phase 0 (boot extraction).
