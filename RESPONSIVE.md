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
- [~] **C — Synth panel** → narrow-screen reflow. The headline fix is
      **step-grid-as-a-tab**; three pure-CSS compactions ride along.
      0. **STEPS pseudo-tab (the real fix).** On phone the 4×4 step grid
         (`#middle-row`, `flex-shrink:0`) claimed its full natural height and
         crushed the `flex:1` `#synth-panel` to ~nothing — so the synth tabs/knobs
         were invisible (this is why fluid/knob tweaks "did nothing"). Fix: step
         grid + synth panel are **mutually-exclusive surfaces** toggled by a
         phone-only `STEPS` tab (leftmost in the strip). Driven by a body class
         `phone-show-steps` (not `state.activeTab`, so the `_renderContent` switch
         + desktop semantics are untouched). Phone default surface = STEPS (set in
         boot.js via `matchMedia`). Touches: `SynthPanel.js` (tab button +
         `_syncTabActive`), `boot.js` (default), CSS.
      1. **Header fluff:** hide oscilloscope + COPY/PASTE bar at `<=640px`.
      2. **Tab strip:** 13 tabs scroll sideways (`overflow-x:auto`,
         `flex-wrap:nowrap`, scrollbar hidden) instead of overflowing. P-lock
         highlights ride along.
      3. **3-knobs-wide:** scale `.knob-canvas` → 48px in CSS (KnobWidget bakes
         64px in JS; the 2× backing store stays crisp). Applies to every
         DefaultMachinePanel machine at once.
      4. **Param sections (responsive section grid).** Opt-in `group` field on
         SPEC → DefaultMachinePanel renders each group as a self-contained ROW
         (selector + its knobs on one line, e.g. Moogish OSC 1 =
         [Wave][Oct][Detune][Level]). Sections reflow side-by-side by viewport:
         **3-up desktop → 2-up iPad(≤1024) → 1-up phone(≤640)** via
         `.param-group` flex-basis. Same design language reused for the machine
         picker next (see below). Generic; ungrouped machines unchanged.
      5. **Vertical anchoring (phone).** `#app` → `100dvh` (was `100vh`
         overshooting under the mobile URL bar = the under-keyboard gap). Exactly
         one surface grows (synth-panel on SYNTH, middle-row on STEPS) so the
         keyboard pins to the bottom and the growing surface scrolls internally
         instead of shoving the bars above. Step grid aligns to the bottom of its
         area (`align-items:flex-end`) so it sits just above the keyboard.
      Pilot verify: MoogishMachine/analogue + a drum machine (Kick/HiHat).
      Custom panels (FM/Sampler) deferred — they pin their own canvas sizes and
      may need per-panel paths (Surface E / Phase 3).
- [x] **C.1 — Machine picker.** Couldn't select machines on narrow: the wrap was
      a fixed 3 group-cols × 3 card-cols = 9 cells wide. The DOM already groups by
      family (`.machine-group` columns), so this was pure CSS — reflow
      `.machine-grid-wrap` 3/2/1-up (same cadence as param sections) + drop cards
      to 2-up on phone. No JS.
- [x] **C.1b — MACHINE tab cohesion.** Group headings now match
      `.param-group-label` (underlined section header) so MACHINE + param tabs
      share one design language. Phone: 1 group/row, cards single-column (2-up
      cramped the desc). iPad: groups 2-up. Desktop: groups 3-up.
- [x] **C.1b-FIX — MACHINE reflow was dead (cascade order).** The machine media
      queries sat EARLIER in the file than the base `.machine-grid-wrap` rule
      (≈2390), so the base (equal specificity, later in source) always won → grid
      stayed 3-wide at every width. Moved the overrides to immediately AFTER the
      base. Lesson: responsive overrides must follow their base rule in source
      order (media queries add no specificity). Left a comment at the old site.
- [x] **C.1c — TRIG tab squish fix.** `.trig-panel` (min-width:280) +
      `.trig-side-col` (min-width:180) + un-shrunk 64px knobs forced the synth
      panel wider than a phone → squished/overflowed. On ≤640px: drop the
      min-widths to 0 + full-width basis (columns stack), and include
      `.trig-knobs-row .knob-canvas` in the 52px shrink. Pure CSS. (NB: the
      "squished synth bar" the user reported was actually the STEPS surface, not
      TRIG — see C.3 — but this TRIG hardening stands on its own.)
- [x] **C.2 — Manual overlay (phone).** `.manual-list` header column was
      `max-content` → long headers grabbed ~55%, starving the text. On ≤640px cap
      it to `minmax(0,0.4fr)` + let headers wrap. Pure CSS.
- [x] **C.3 — STEPS surface fill.** On the STEPS surface the collapsed
      `#synth-panel` header + the width-driven square 4×4 grid left ~25% empty
      space at the TOP of the grid area (the "squished synth bar" the user meant —
      it was STEPS, not TRIG). Fix (user chose "stretch to fill"): on ≤640px when
      STEPS is active, `#step-grid` align-items:stretch, `.step-grid-inner`
      height:100% + grid-auto-rows:1fr, and `.step-cell` aspect-ratio:auto — cells
      become rectangles and the grid fills the whole freed area, zero gap.
      Keyboard stays bottom-pinned. Pure CSS.
- [~] **C.4 — Roll param sections out to every machine.** Moogish proved the
      `group:` SPEC field (Surface C step 4). Now tagged ALL 22 remaining
      DefaultMachinePanel machines so the whole SYNTH tab shares one section
      language (3-up desktop → 2-up iPad → 1-up phone, same `.param-group` CSS,
      zero CSS/JS changes — pure SPEC additions). Per-machine groupings:
      - Tonal — Synth: OSC/SUB; Bass: OSC/VOICE; Chord: CHORD/OSC; Strings:
        VOICE/TONE/VIBRATO; Swarm: OSC/SWARM/NOISE; Karplus: STRING/EXCITE;
        Marimba: DECAY/PARTIALS/MALLET; Wood: RESONATOR/STRIKE; Noise:
        COLOR/BODY/SHAPE; Comb: TUBE/VOICE; Transient: BODY/CLICK.
      - Drums (synth) — KickHard/KickSilk: TONE/PUNCH; Snare: TONE/NOISE; HiHat:
        DECAY/TONE; Clapp: TONE/SHAPE; Cymbal: TONE/DECAY.
      - Drums (analogue) — Kick: TONE/PUNCH; Snare: TONE/NOISE; HiHat: DECAY/TONE;
        Clapp: TONE/SHAPE; Cymbal: TONE/DECAY; Tom: TONE/ATTACK.
      Every machine gets a dedicated **OUTPUT** section (lone Level knob), matching
      Moogish. Hidden params (osc.detune, vibrato sync-knob halves) left ungrouped
      — they don't render. FM/Sampler/WT-Sampler/SampleSwarm/MIDI/Input untouched
      (custom panels — FM is the deferred beast; fold into Surface E / Phase 3).
      manual.js intentionally NOT touched: grouping is a layout hint, not a new or
      renamed control. **Awaiting in-browser verify, NOT yet committed.**
- [~] **C.5 — Sampler-family panels.** The three sample panels lay out
      imperatively (custom panels, not DefaultMachinePanel) but were close. Pulled
      them onto the same `.param-group` section language via a new `.sampler-groups`
      flex-row (same wrap cadence as `.panel-content`, so groups inherit the
      shared 3/2/1-up `.param-group` media queries — no new breakpoints).
      - **Sampler:** waveform canvas 80→64px; params → TRIM / PLAYBACK (knobs +
        pitch/rev/loop toggles) / OUTPUT (level + SMPL LEN).
      - **SampleSwarm:** embeds SamplerPanel (inherits the above), swarm row →
        SWARM / NOISE groups.
      - **WT-Sampler:** the two sample slots now **stack vertically** (was
        side-by-side — `.wt-sampler-slots` flex-direction:column), canvas fixed
        72px; params → MORPH / SLOT A / SLOT B / SWEEP groups. Dead CSS removed
        (`.sampler-param-row`, `.wt-sampler-params`, `.wt-sampler-root-row`).
      **Awaiting in-browser verify, NOT yet committed.**
- [~] **C.6 — FM panel (the beast).** Was schematic-left + 2×2 op-grid-right
      (couldn't reflow narrow). Now:
      - Each operator → its own `.param-group` (`.fm-op-group`) in a `.fm-ops-row`
        flex-row → reflows 3/2/1-up via the shared `.param-group` queries. Body =
        2 stacked knob rows (ratio/level/detune[/fb] + A/D/S/R). Carrier (OP1)
        first so signal flow reads top-down when stacked.
      - **OUTPUT** is its own section now (was tucked under the schematic).
      - Per-op **ADSR shape canvas** → `<details>` ("shape"); **schematic** moved
        to the **bottom** in a `<details>` ("Operator routing"). Both **collapse
        on phone only** (open=true unless `matchMedia(max-width:640px)`); a
        `toggle` listener redraws the canvas on expand (it has 0 size while
        collapsed). matchMedia is read per-render so tab switches reapply.
      Dead CSS removed (`.fm-top-row`, `.fm-ops-right`, `.fm-op-cell`,
      `.fm-op-params-row`, `.fm-out-row`, `.fm-op-adsr-label`). The ADSR
      knob/sync-knob logic + schematic drawing are unchanged.
      **Awaiting in-browser verify, NOT yet committed.**
- [~] **C.7 — FX as a phone tab + tab-strip squish fix (the real cause).**
      Squish ROOT CAUSE (first pass was a band-aid): the header FX bar
      (`.fx-bar` — FX-pipe button + chain mini-outline, ~24px icons) gave
      `.panel-header` its height. On the STEPS surface the FX bar was hidden, so
      the header collapsed to the bare (short) tab-bar height → the tab buttons
      (which bleed DOWN into the content body: rounded-top only, no bottom border,
      `tab-bar` padding `4px 4px 0`) jammed against the header's bottom border and
      read as squished upward (the "STEPS / MACHINES / SOUNDS" strip). Also, hiding
      the FX bar on STEPS meant **FX was unreachable** while on the step grid.
      Fix (user chose "FX tab + hide FX bar"):
      - **FX is now a phone tab** (`.tab-fx`, mirrors the STEPS pseudo-tab; CSS-
        hidden on desktop where the header FX bar owns the entry point). FX was
        already a real tab in the `_renderContent` switch (`activeTab==='fx'`) — it
        just had no strip button. `dataset.tab='fx'` so `_syncTabActive` +
        `_renderPLockTabIndicators` highlight it via the normal activeTab path (no
        JS beyond adding the button). Handler removes `phone-show-steps` like the
        voice tabs.
      - **FX bar hidden on phone entirely** (added `.fx-bar` to the header-fluff
        hide group with oscilloscope + clip-bar). So the phone header is ALWAYS
        just the tab strip → uniform height, squish gone at its source. The
        chain mini-outline is a desktop luxury (like the scope).
      - Squish padding now applies to the whole phone header (`#synth-panel
        .panel-header` centered, `.tab-bar` 5px top/bottom) — no longer scoped to
        `phone-show-steps`, since the header is uniform on phone now.
      Desktop unchanged (FX tab + the rules are inside the ≤640 block / desktop-
      hidden). **Awaiting in-browser verify.**
- [~] **C.8 — FILTER + AMP panes → `.param-group` sections.** Both tabs laid out
      with bespoke flex rows (`.filter-top-row`/`.filter-knob-sec`/`.filter-right-col`,
      `.amp-tab-row`/`.amp-pan-sec`/`.amp-adsr-sec`) that couldn't reflow narrow.
      Refactored onto the shared `.param-group` section language (same idiom as
      DefaultMachinePanel / FMPanel — sections live directly in `.panel-content` and
      reflow 3-up desktop → 2-up iPad → 1-up phone via the existing `.param-group`
      media queries; zero new breakpoints):
      - **FILTER:** FILTER (engine/type dropdowns stacked over the main knob row via
        `.filter-controls`) · RESPONSE (FilterViz, capped 240px) · BASE (LPF/HPF) ·
        FILTER ENV (ADSR). The manual `.filter-env-label` div is gone (section uses
        `.param-group-label`).
      - **AMP:** AMP (pan + vel knobs) · ENVELOPE (amp ADSR). Compact ADSR-knob
        sizing kept (retargeted `.amp-adsr-sec`→`.amp-adsr-group`).
      Dead CSS removed (all the bespoke filter/amp layout classes +
      `.filter-env-label`). `.filter-viz-wrap` kept (FilterViz still emits it).
      Audio/p-lock/viz logic unchanged. **Awaiting in-browser verify, NOT committed.**
- [~] **C.9 — Overflow-menu IMPORT alignment.** In the phone transport overflow
      dropdown (`flex-direction:column; align-items:stretch`), IMPORT sat left-
      aligned while every other entry centered. Cause: IMPORT is a
      `<label class="btn">` (wraps a hidden file input), not a `<button>`, so it
      lacks the button UA-default `text-align:center`. Fix:
      `.transport-overflow > .btn { text-align:center }` (scoped to the dropdown).
      Pure CSS. **Awaiting in-browser verify.**
- [~] **C.10 — Oscilloscope hidden on iPad.** The header scope was only hidden at
      ≤640px; on iPad (≤1024px) it still overlapped the synth pane on the right
      where the tab bar needs the width. Added `.panel-header .oscilloscope {
      display:none }` to the existing ≤1024 block (the ≤640 block still hides it
      too, alongside more header fluff). Pure CSS.
- [~] **F — FX pane phone reflow.** Desktop = left tray + right(path-over-params),
      drag-to-reorder. That doesn't fit a phone and drag is unreliable on touch.
      On ≤640px the pane goes single-column (user's design):
      - **Function row on top:** `.fxpipe-tray` flips to a horizontal row (ADD /
        LOAD / SAVE). The **bin is hidden** (drag-only; the per-card ✕ removes).
      - **Vertical card stack:** `.fxpipe-path` flips to a column, arrows rotate to
        ↓, blocks become **full-width cards** (glyph+name left, ON/OFF + ▲/▼ +
        bind + ✕ right). Reads INPUT (top) → OUTPUT (bottom).
      - **▲/▼ reorder** (phone-only, built in JS): each card gets move buttons →
        new `_moveByOffset(id,dir)` (swaps in `getFXOrder`/`setFXOrder`), disabled
        at the ends. Replaces drag on touch; desktop keeps drag untouched.
      - **Inline params (accordion):** on phone the selected card's FXPanel knobs
        expand INLINE under it (wrapped in `.fxpipe-block-unit` → `.fxpipe-block-
        params`); the shared `.fxpipe-params` area below the stack is skipped.
      JS gated on `matchMedia(≤640px)` read per-render (tab switch/resize reapply);
      desktop DOM + behavior unchanged. manual.js updated (signal-path drag→▲/▼,
      inline params, bin desktop-only, FX-as-phone-tab). **Awaiting in-browser
      verify, NOT committed.**
- [~] **F.1 — FX refinements (design alignment + add-menu width).**
      - **+ADD FX menu was tiny on phone:** desktop caps it `max-width:240px` /
        `width:max-content`. On ≤640px give ADD its own full-width tray row (so
        its absolutely-positioned dropdown spans the whole pane), then the dropdown
        goes `left/right:0; max-width:none; max-height:60vh` as a **2-column grid**
        (category headers `grid-column:1/-1`) with bigger items (1rem / 9px pad).
      - **Aligned FX cards with the synth pane:** the selected-effect params header
        (`.fxpipe-params-head`) now matches the synth section headers
        (`.param-group-label`) — uppercase, letter-spaced, **underlined** bottom
        border — so an FX param block reads as a titled section like OSC 1 / OUTPUT
        (kept the FX teal accent). Inline FX knobs shrunk to 52px to match the
        synth-pane phone knob size (they're nested too deep for the .panel-content
        shrink rule); FX enum buttons bumped to touch size inside cards. Pure CSS.
      **Awaiting in-browser verify.**
- [~] **F.2 — Card width bug (selected card shrink-wraps).** A selected card
      returns the `.fxpipe-block-unit` wrapper (block + inline params), the flex
      child of the `align-items:stretch` column path. The unit had no width, so
      when its inline params had a narrow intrinsic width (e.g. a re-added base FX
      with few/short params) the column shrink-wrapped the unit to ~60% instead of
      filling; cards with wider params happened to fill — hence "re-add base
      shrinks, new FX doesn't". Fix: `.fxpipe-block-unit { width:100% }` pins every
      card full-width regardless of param content. Pure CSS. **Awaiting verify.**
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
- 2026-06-16: Surface B (transport wrap + overflow menu + compact BPM) — landed +
  committed (`e1595ca`).
- 2026-06-16: Surface C v1 (header fluff + scrollable tab strip + knob→48px) —
  landed but the synth panel was still invisible on phone.
- 2026-06-16: Surface C v2 — root cause found: the 4×4 step grid was crushing the
  flex:1 synth panel. Added **STEPS pseudo-tab** so the grid + synth panel are
  mutually-exclusive surfaces on phone (default = STEPS).
- 2026-06-16: Surface C v3 (real-device feedback) — (a) STEPS lockout fixed:
  hiding #synth-panel hid the tab strip with no way back; now STEPS collapses
  only the panel BODY (.panel-content + .fx-bar), header/tabs stay on screen.
  (b) Step grid no longer crimps the bar above (flex:0 1 auto + max-height:65vh,
  was greedy flex:1). (c) Knobs 48→52px. (d) **Param groups:** opt-in `group`
  field on SPEC → DefaultMachinePanel renders labelled rows. Moogish tagged
  OSC 1/2/3 + TEXTURE + OUTPUT (each osc row led by its waveform dropdown).
  Generic + applies on desktop too; machines with no groups unchanged.
  **Done, awaiting in-browser verify, NOT yet committed.**
- 2026-06-16: Surface C.4 — rolled `group:` out to all 22 other
  DefaultMachinePanel machines (tonal + synth drums + analogue drums). Every
  machine now sections + has its own OUTPUT row, matching Moogish. Pure SPEC
  additions (no CSS/JS); hidden params untouched; FM/Sampler/etc deferred.
  **Awaiting in-browser verify, NOT yet committed.**
- 2026-06-16: Surface C.5 — sampler-family custom panels onto the `.param-group`
  section language via a new `.sampler-groups` row. Sampler canvas 80→64px
  (TRIM/PLAYBACK/OUTPUT); SampleSwarm swarm row → SWARM/NOISE; WT-Sampler slots
  now stack vertically (canvas 72px) + MORPH/SLOT A/SLOT B/SWEEP groups. Dead
  CSS removed. **Awaiting in-browser verify, NOT yet committed.**
- 2026-06-16: Surface C.7 — FX as a phone tab + squish ROOT CAUSE found. The
  squish was the header losing the FX bar's height on STEPS, not just tab padding;
  and hiding the FX bar there left FX unreachable. Now: FX is a phone tab
  (`.tab-fx`, mirrors STEPS), the FX bar is hidden on phone entirely (header =
  always just the tab strip → uniform height), and the squish padding applies to
  the whole phone header. Desktop unchanged.
- 2026-06-16: Surface C.8 — FILTER + AMP panes refactored onto `.param-group`
  sections (FILTER/RESPONSE/BASE/FILTER ENV; AMP/ENVELOPE), matching FM/Default.
  Bespoke flex-row layout classes + `.filter-env-label` removed. Logic unchanged.
- 2026-06-16: Surface C.9 — overflow-menu IMPORT alignment: it's a `<label>` not
  a `<button>`, so it missed the UA center default in the stretched dropdown;
  center `.transport-overflow > .btn`. Pure CSS.
- 2026-06-16: Surface C.10 — oscilloscope hidden on iPad (≤1024) too, not just
  phone; it overlapped the synth pane on the right. Pure CSS.
- 2026-06-16: Surface F — FX pane phone reflow: single column, ADD/LOAD/SAVE
  function row on top, vertical INPUT→OUTPUT full-width card stack, ▲/▼ reorder
  (phone-only, `_moveByOffset`), inline accordion params under the selected card,
  bin hidden. Desktop unchanged. manual.js updated.
- 2026-06-16: Surface F.1 — FX refinements: +ADD FX menu widened on phone (own
  full-width row → dropdown spans pane, 2-col grid, bigger items); FX params
  header aligned with the synth section headers (underlined `.param-group-label`
  look); inline FX knobs→52px, enum buttons touch-sized. Pure CSS.
- 2026-06-16: Surface F.2 — fixed selected FX card shrink-wrapping to ~60% when
  its inline params were narrow (re-added base FX); `.fxpipe-block-unit` had no
  width so the stretch column shrink-wrapped it. `width:100%` pins it. Pure CSS.
- 2026-06-16: Surface C.6 — FM panel reflowed: operators → `.param-group`
  sections (2 knob rows each), OUTPUT its own section, per-op ADSR canvas +
  schematic moved to phone-collapsible `<details>` (schematic now at bottom).
  Canvas redraws on `<details>` expand. Dead CSS removed. **Awaiting in-browser
  verify, NOT yet committed.**

## Next up

- **Verify Surface C** at phone width (≤640px): app opens on STEPS; tapping
  SYNTH/FILTER/etc swaps to the synth panel (grid hidden) and STEPS swaps back;
  STEPS tab highlights when active; tab strip scrolls; scope/COPY-PASTE gone;
  knobs sit 3-wide and legible on MoogishMachine/analogue + a drum machine.
  Hard-refresh to dodge CSS module cache. Then commit.
- **Custom synth panels (FM, Sampler) on phone.** They pin their own canvas sizes
  and lay out imperatively — likely need per-panel compact paths. Fold into
  Surface E (JS `size:`) or Phase 3.
- Then D — Keyboard (live-play strip), E — knob/component sizes (JS `size:`).
- Verify pattern: resize desktop browser across desktop/tablet/phone widths;
  user verifies in-browser (no headless). Hard-refresh to dodge CSS module cache.
