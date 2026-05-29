# Sequencer & Clock

## Clock & Sequencer Architecture

The master `Clock` uses `AudioContext.currentTime` for scheduling — not `setInterval`.
This gives sample-accurate timing regardless of JS event loop jitter.

```
Clock.start()
  → schedules ticks ahead in time using a lookahead window (~100ms)
  → each registered Sequencer._onTick(tickIndex, scheduledTime) is called
  → Sequencer resolves which step fires, evaluates Condition then Chance
  → _fireStep() dispatches p-locks and calls:
      machine.noteOn(note, velocity, time)
      machine.noteOff(oscOffTime)          ← kept alive through release tail
      envelope.scheduleNote(time, offTime, envOverrides)
```

**P-lock dispatch** in `_fireStep`: driven by the `plockMode` field on each param descriptor
(see **P-Lock Architecture** section). `_buildPlockModeMap()` collects all modes from the
track's param lists once per fired step, then a single `switch(mode)` loop handles all cases.
Adding a new param only requires `plockMode` in its `getParamList()` — no sequencer changes.

Polyrhythm: each Sequencer has its own `stepCount` (1–64). The Clock fires a global tick at
the smallest subdivision; each Sequencer increments its own counter independently.

Step pages: Sequencer holds 64 steps total. `pageOffset` selects which 16 are visible.

---

## Step Data Model

```
Step {
  index      — position in steps array (0–63)
  active     — fires a note?
  note       — MIDI note number (0–127), default 60
  velocity   — 0–127, default 100
  length     — gate duration in ticks (fractional ok), default 1
  nudge      — signed tick offset in ticks, default 0
               UI exposes as -99%..+99% of one step interval.
               -99% = nudge ≈ one step back (plays just after the previous step).
               +99% = nudge ≈ one step forward (plays just before the next step).
               Stored as ticks: nudge = percent / 100.
               Original nudge is never modified by quantize — quantize is non-destructive.
  nudgeQuantize — 0.0–1.0, track-level. Applied at fire time: effectiveNudge = step.nudge × (1 − nudgeQuantize).
               0% = use recorded nudge as-is. 100% = ignore nudge (all steps play on the grid).
               Serialised in Track.toJSON(). Reset to 0 by resetTrack().
  retrigger  — { count, rate } or null
  condition  — Condition instance (type: 'always' | 'ratio')
  chance     — 0–100 percent, evaluated after condition, default 100
  plocks     — Map<string, number|string>  (parameter locks)
}
```

Condition is evaluated first (ratio logic), then chance (random). Both must pass for the step to fire.

---

## P-Lock Architecture

P-locks are per-step parameter overrides stored in `step.plocks` (a `Map<string, value>`).
They are applied at fire time by `Sequencer._fireStep()` using a data-driven dispatch
framework: **each param descriptor in `getParamList()` carries a `plockMode` field**
that tells the sequencer exactly how to apply and restore it.

### plockMode values

| Mode | Who uses it | Behaviour |
|---|---|---|
| `'envelope'` | `env.*`, `fenv.*`, `filter.envAmount`, `filter.cutoff` | Collected into `envOverrides`, passed to `scheduleNote()`. Never touches `_params` directly. `filter.cutoff` must go here (not `'filter'`) because `scheduleNote` calls `cancelAndHoldAtTime` on the filter frequency AudioParam — any `setTargetAtTime` scheduled before it would be cancelled. `scheduleNote` reads `overrides['filter.cutoff']` as the sweep base and ramps back to the true (non-locked) cutoff at release. |
| `'filter'` | `filter.resonance`, `filter.gain`, `base.lpf`, `base.hpf` | `filter.setParam(path, value, time)` + restore at `offTime`. Web Audio automation handles timing. Only valid for filter AudioParams that `scheduleNote` does NOT touch. |
| `'audioParam'` | Any param backed by a live `AudioParam` (detune, gains, FX params) | `obj.setParam(path, value, time)` schedules the lock; restore is pushed as `() => obj.setParam(path, old, offTime)`. |
| `'js'` | Waveform strings, envelope timing values, curve/IR rebuilds, JS-only timing | `obj.setParam(path, value)` immediately before `noteOn`; `() => obj.setParam(path, old)` added to restore queue (no time arg — runs synchronously). |
| `'pan'` | `amp.pan` | `pannerNode.pan.setValueAtTime(value, time)` + restore at `offTime` via the restore queue. |
| `'trig'` | `trig.tone` | Handled separately below the loop (semitone transpose). No restore needed. |

### Extending the framework

To add a new param to p-lock support: add `plockMode: '<mode>'` to its descriptor in
`getParamList()` in the owning class. No changes to `Sequencer._fireStep()` are needed.

To add an entirely new plockMode: add a `case` to the `switch(mode)` block in
`_fireStep()` and document it here.

`env.*` / `fenv.*` paths are not in any `getParamList()` — `_fireStep` treats unmapped
paths matching those prefixes as `'envelope'` automatically.

---

## Note Follow

A track can mirror notes from another track via `track.followSource` (an integer track index, or `null`).

### Where follow is triggered

| Source | Mechanism |
|---|---|
| Sequencer step | After `_fireStep()` completes, `Sequencer` iterates `_projectTracks` and calls `follower.fireFollowNote(note, vel, time, offTime)` for each track whose `followSource === this.track.index`. |
| Live keyboard (chromatic / folded) | `Keyboard._noteOn` calls `_fireFollowers(sourceTrack, note, vel, audioTime)` after playing the selected track's note. |
| Drum-mode finger drumming | Same `_fireFollowers` call after the drum note fires. |
| MIDI In note-on | `index.html` MIDI init loop: after routing a note to the mapped track, iterates `project.tracks` and fires `fireFollowNote` on followers. |

### Track.fireFollowNote(note, velocity, audioTime, offTime)

Fires immediately on the follower track with an optional delay:
```
delaySec = track.followDelay / 1000
startTime = audioTime + delaySec
stopTime  = offTime + delaySec
```
Uses the follower's own machine, envelope, and LFOs — same voice pool mechanism as a normal note.

### Follow properties (Track)

| Property | Type | Default | Description |
|---|---|---|---|
| `followSource` | `number\|null` | `null` | Index of the source track to follow, or null to disable |
| `followDelay` | `number` | `0` | Delay in milliseconds applied to the follower's note start and end |

Both are serialised in `Track.toJSON()` and restored by `fromJSON()`.

### UI

Located in the TRIG tab, visible only when no step is selected:
- **NOTE FOLLOW** dropdown: `OFF` or any other track listed as `T{n} (machine-type)`. The current track is excluded.
- **FLW DLY** knob: 0–500 ms delay, applied to follower playback.

### Project wiring

`Project._wireFollowTracks()` assigns `sequencer._projectTracks = this.tracks` to every sequencer. Called after initial construction and after `setTrackCount()`.

---

## Track Nav (Page Counter + Length Control)

The right side of the middle row holds a `#track-nav` panel:

| Element | Function |
|---|---|
| Page counter (`1/N`) | Shows current page / total pages. Pages = `ceil(stepCount / 16)`. |
| `▶` (next) button | Advances to the next page, wrapping from last page back to page 1. |
| `LEN` button | Toggles the length popup. |

**Length popup** (`#length-popup`): floating panel anchored above the LEN button.
- Shows current step count as a large number.
- Four buttons: `-16`, `-1`, `+1`, `+16` (clamped to 1–64).
- Closing: click LEN again, or click outside the popup.

**Step count rules:**
- Stored in `Sequencer.stepCount` (1–64, default 16). Serialised in `toJSON()`.
- `pageOffset` is **never** clamped when stepCount changes — all 4 pages remain navigable at all times.
- The sequencer's `_onTick` loop (`_stepIndex >= stepCount`) is the only place that wraps.

**Active vs inactive pages:**
- "Active pages" = `ceil(stepCount / 16)`. Steps at index ≥ stepCount are inactive.
- All 4 pages are always navigable and editable. Inactive steps are dimly styled but otherwise normal.
- Intended use: pre-author steps on inactive pages, then increase stepCount to unlock them live.

**Page counter format:**
- `1/2(4)` — current / active pages (total slots). `(4)` shows inactive pages exist.
- `1/4` — shown when all pages are active (no parens needed).

**Inactive step appearance** (`.step-cell.inactive`):
- Darker bg, dim border, 55% opacity. has-note/has-data borders preserved desaturated.
- Fully interactive — click, dblclick, p-lock all work normally.

**Keyboard shortcut**: `Shift+1` through `Shift+4` jump directly to pages 1–4, including inactive pages.

**Step highlight**: clock callback converts absolute step index to visible cell index. Off-page → `highlightStep(-1)`.

**Step numbers in grid**: cells always show absolute step number (e.g. page 2 shows 17–32).

---

## Record Mode

A **REC** button sits next to PLAY in the transport bar. Clicking it toggles `AppState.recording`.

**Behaviour when recording is ON and sequencer is playing:**
- The clock tick callback in `index.html` tracks which step just fired (`justFired`).
- On each new step, `state.selectedStepIndex` is silently updated to match the currently playing step on the visible page. A `stepSelected` event is emitted so `StepGrid` and `SynthPanel` (TRIG tab) update.
- Playing a note on the Keyboard (or computer keys) writes the note into the currently selected step as normal — the record-step tracking means the step advances automatically each beat, so no manual step selection is needed.
- If the playing step is outside the visible page (polyrhythm / page offset), no forced selection occurs (the user can scroll pages manually).

**When recording is OFF:** no step-advance side effect — step selection behaves as normal.

**Visual:** the REC button gains a pulsing red style (`#btn-rec.recording`) to make the armed state obvious.

---

## Drum Mode

A **DRUM** button sits next to TAPE in the transport bar. Clicking it toggles `AppState.drumMode`.

**Behaviour when drum mode is ON:**
- Computer digit keys `1`–`N` (up to the current track count) trigger a note on that track number at **C4 (MIDI 60)** without changing the selected track.
- The normal mute shortcut (digit keys 1–N = toggle mute) is suspended.
- `Shift+1..N` page-jump still works as usual (Shift takes priority).
- Notes are fired live via the track's VoicePool — self-enveloping drum machines (kick/snare/hihat) will ignore noteOff, melodic machines will sustain until the key is released.
- When REC is also active, drum key presses write C4 into the step currently playing on **that track's own sequencer** (using each track's own `pageOffset` and `_stepIndex`). Nudge and gate length are recorded exactly as with the piano keyboard. This lets you finger-drum multiple tracks simultaneously while the sequencer rolls.
- Each track's `Sequencer.lastScheduledTime` stores the AudioContext time of its most recently scheduled tick — used to compute nudge offset for drum recording.

**When drum mode is OFF:** digit keys revert to the mute toggle behaviour.

**Visual:** the DRUM button gains a blue active style (`#btn-drum.drum-active`) to make the armed state obvious.

---

## Double-Click Step to Add Note

In `StepGrid`, double-clicking a step cell:
1. Activates the step
2. Sets its note to the **lowest note** among all currently active steps on that track
3. Falls back to MIDI 36 (C2) if no active steps exist
4. Selects the step so the TRIG tab updates

Useful for drum tracks where you want to quickly add hits at the track's established pitch.
