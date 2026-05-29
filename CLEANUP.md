# Webtakt — Code Cleanup Report

> Audit date: 2026-05-29. Scope: full `js/` tree (~17.4k LOC), `DESIGN.md`, `index.html`.
> Goal: flag code that will or can bite us later. Ranked by impact, not effort.
> Bar: "4/5 is good enough" — this list is what to fix to clear that bar, not a repaint.
>
> **Status (updated):** P1 #1, #2, #3 done; P2 #4, #5, #6 done; P3 #8 (SynthPanel
> split) done. Remaining: P2 #7 (timer-contract doc), P3 #9/#10 (watch-only).

The codebase is in good shape overall: clear module boundaries, the ownership graph
in DESIGN.md matches reality, p-lock dispatch is well-documented, and the voice-pool
architecture is sound. The issues below are real but mostly localized.

---

## P1 — Fix soon (correctness / drift / leaks)

### 1. Inconsistent note-cleanup: 5 machines still use wall-clock `setTimeout`
You already built the **right** tool for this — `scheduleCallback()` in
`js/util/AudioBuffers.js`, which fires on the audio thread via a 1-sample buffer's
`onended` and avoids wall-clock drift. Six machines use it (Kick×2, HiHat, Snare,
Clapp). But five still hand-roll `setTimeout` for node disconnect:

- `js/machines/NoiseMachine.js:150`
- `js/machines/TransientMachine.js:153`
- `js/machines/WoodMachine.js:144`
- `js/machines/MarimbaMachine.js:152`
- `js/machines/CymbalMachine.js:114`

**Why it matters:** `setTimeout` cleanup drifts under load and against scheduled
(look-ahead) note times — the disconnect can fire early and cut a tail, or late and
leak nodes. It also keeps machine references alive across a tab-stall. This is the
single most repeated smell in the machine layer.

**Fix:** replace each `setTimeout(() => {disconnect}, ms)` with
`scheduleCallback(this.context, cleanupTime, () => {disconnect})`. Mechanical, low-risk,
and makes all 11 percussion-style machines consistent.

### 2. `Clock.start` / `Clock.stop` are monkey-patched by MidiEngine
`js/core/MidiEngine.js:181-196` reassigns `clock.start`/`clock.stop` to inject MIDI
transport messages, saving the originals to restore in `disconnectClock()`.

**Why it matters:** this is brittle. If anything else ever wraps those methods (or
`connectClock` runs after another patcher), the save/restore pairing breaks and you
get either lost transport messages or a permanently-patched method. It's invisible
coupling that won't show up until someone touches the Clock.

**Fix:** give `Clock` real start/stop listener hooks (`onStart(fn)` / `onStop(fn)`,
mirroring the existing `register()`/`unregister()` callback set) and have MidiEngine
subscribe instead of overwriting methods. ~15 lines, removes the only monkey-patch in
the codebase.

### 3. MIDI note-out timing uses `setTimeout` — jitter is real, and undocumented
`MidiEngine.sendNoteOn/sendNoteOff` (`:121`, `:138`) and the 24-PPQN clock pulses
(`:174`) all schedule via `setTimeout(delayMs)`. The Web MIDI API has no
sample-accurate send, so this is a genuine platform limitation — *not* a bug to fix.

**Why it matters:** DESIGN.md's own "Capability warnings" principle says to flag
Web-Audio/Web-MIDI limitations rather than ship a silent workaround. Right now the
jitter is silently baked in, and the whole MIDI subsystem is still marked `UNTESTED`
in the last commit message. A future maintainer will hunt for a timing "bug" that
can't be fixed in the browser.

**Fix:** no code change required for the timing itself — add a short comment block at
the top of `MidiEngine.js` stating the `setTimeout` jitter is a Web MIDI limitation
(typical 1–15ms), and add a line to `design/` documenting it. Then actually test the
MIDI path and drop the UNTESTED flag (or note what's unverified).

---

## P2 — Should fix (maintainability / consistency)

### 4. DESIGN.md "Current Status" table is stale — contradicts itself
`DESIGN.md:185` says `| MIDI | Out of scope |`, while the scope paragraph (`:27`),
the file list (`:42`, `:64`), and three shipped files describe full MIDI out + CC in
+ clock sync. Stale docs are flagged as bugs by your own maintenance rule (`:3`).

**Fix:** update the status row to "MIDI | Out (MidiMachine), CC in, 24-PPQN clock
sync — see design notes". Also "Analogue emulation | Out of scope" is fine to keep.

### 5. Hot-path allocation in the sequencer p-lock dispatcher
`Sequencer._fireStep()` calls `_buildPlockModeMap()` (`:189`) on **every fired step
that has p-locks**. That method calls `getParamList()` on 5 objects (`:159`), each of
which allocates a fresh array of descriptor objects, then builds a new `Map`. With
8–12 tracks at high BPM this is dozens of throwaway arrays/maps per beat on the audio
scheduling path.

**Why it matters:** not a correctness bug today, but it's avoidable GC pressure right
where you least want a pause. `getParamList()` is called 63 times across the codebase;
several are in per-note paths.

**Fix:** cache the plock-mode map on the track and invalidate it on `setMachine()`
(the only time the param set changes). Or have machines return a cached/static param
list instead of rebuilding the array each call.

### 6. Default `condition` object is duplicated in 3 places
The "always" condition literal appears at `Track.js:492`, `SynthPanel.js:214`, and
`Condition.js:53`. Two of them include an inline `evaluate()`, one doesn't — so they
aren't even identical, which is exactly how a subtle bug enters.

**Fix:** export a single `Condition.always()` factory (or a frozen constant) from
`Condition.js` and use it everywhere.

### 7. Drift timers in Swarm / SampleSwarm rely on `disconnect()` being called
`SwarmMachine.js:103` and `SampleSwarmMachine.js:119` run a `setInterval` drift timer,
cleared only in `disconnect()`. `VoicePool.setMachine()` does call
`slot.machine.disconnect()` before swapping, so this is currently safe — but it's an
implicit contract: any new code path that drops a machine without calling
`disconnect()` leaks a live interval forever.

**Fix:** document the contract on `Machine.disconnect()` ("must release all timers /
intervals"), and consider asserting it. Low urgency since the one call site is correct.

---

## P3 — Nice to have (no current risk)

### 8. `SynthPanel.js` is 2,674 lines — 6× the next-largest UI file
It owns 14 tab renderers plus the mixer, copy/paste, and sound-load snapshot logic. It
works and is reasonably organized by `_renderX()` methods, but it's the obvious "things
get added here forever" file. Not urgent. If it grows again, peel the self-contained
tabs (mixer, scales, MIDI-in) out into `panels/` like the machine panels already are.

### 9. `render()` rebuilds the panel via `innerHTML = ''` on every track/tab/step change
`SynthPanel.js:75,308`, and most UI files do the same. Fine at this scale; full DOM
teardown + listener re-attach on `stepSelected` could get janky if panels grow. Watch,
don't fix.

### 10. Listener balance: 112 `addEventListener` vs 23 `removeEventListener`
Most are on long-lived singletons (keyboard, transport) so this isn't a leak per se,
but the `innerHTML=''` rebuild pattern (#9) drops DOM nodes with attached listeners. GC
handles detached-node listeners, so no action needed — noted only so it's not mistaken
for a problem later.

---

## Explicitly NOT problems (checked, fine)
- **Clock** uses the correct look-ahead scheduler pattern — no audio drift.
- **VoicePool** round-robin + steal logic and the canonical-slot mirroring are sound
  and well-commented.
- **P-lock restore** timing logic in `_fireStep` is intricate but correct and documented.
- Only **9 `console.*`** calls total — no debug-log spam left in.
- Only **1 real TODO** (`DrumMachine.js`, an intentional stub).

---

## Suggested order of work
1. #4 (doc fix, 2 min) and #3-doc (comment, 5 min) — clear the easy correctness/doc debt.
2. #1 (setTimeout → scheduleCallback in 5 machines) — biggest consistency win, low risk.
3. #2 (Clock listener hooks) and #6 (shared condition factory) — remove the brittle bits.
4. #5 (cache plock map) — perf hardening before track count grows.
5. #8/#9/#10 — only if those files start growing again.
