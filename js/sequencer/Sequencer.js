/**
 * Sequencer.js
 * ------------
 * Per-track step sequencer. Registers with the master Clock and fires
 * machine note events at the correct scheduled AudioContext time.
 *
 * Supports polyrhythm: each Sequencer has its own step count (1–N).
 *
 * P-lock dispatch framework
 * ─────────────────────────
 * Every param descriptor in getParamList() carries a `plockMode` field that
 * tells _fireStep() exactly how to apply and restore it at note time:
 *
 *   'envelope'   — collected into envOverrides, passed to scheduleNote()
 *                  (env.*, fenv.*, filter.envAmount — never touch _params directly)
 *   'filter'     — scheduled set at `time`, scheduled restore at `offTime`
 *                  via filter.setParam (resonance, gain, type — NOT cutoff)
 *                  Note: filter.cutoff uses 'envelope' so scheduleNote controls
 *                  the frequency AudioParam without conflict
 *   'audioParam' — MACHINE-owned: collected into machineParamPlocks and applied
 *                  to the FIRING voice's machine at note time (after syncParamsAt),
 *                  because each voice has its own machine and the pool round-robins
 *                  which slot plays. FX-owned: obj.setParam(path, value, time) then
 *                  restore at offTime (FX nodes are shared post-pool).
 *   'js'         — MACHINE-owned: collected into machineJsPlocks, applied to the
 *                  firing voice's machine before noteOn. FX/filter-owned: immediate
 *                  setParam before noteOn, immediate restore after.
 *                  (waveforms, curve rebuilds, IR rebuilds, JS-only timing values)
 *                  The canonical slot-0 machine is restored after the loop so it
 *                  stays a clean baseline for syncing other voices.
 *   'pan'        — direct panner.pan.setValueAtTime schedule + restore
 *   'trig'       — handled below the loop (trig.tone transpose, not a param restore)
 *
 * To add a new param: add plockMode to its descriptor in getParamList().
 * No changes to _fireStep() are needed.
 *
 * Release behaviour: the envelope noteOff is scheduled at offTime (end of note
 * gate). The oscillator is kept alive until offTime + release so the tail has
 * audio to shape. The next noteOn will cancel the release ramp only if another
 * note actually fires on this track — correct monophonic behaviour.
 */

import { Step } from './Step.js';

const DEFAULT_STEP_COUNT = 16;
const STEPS_PER_PAGE     = 16;

export class Sequencer {
  constructor(track, clock) {
    this.track          = track;
    this.clock          = clock;
    this._stepCount     = DEFAULT_STEP_COUNT;
    this.pageOffset     = 0;
    this._stepIndex     = 0;
    this._playCount     = 0;
    this._tickBound     = this._onTick.bind(this);
    this._projectTracks = null;  // set by Project after construction
    this._plockModeMapCache = null;  // lazily built, invalidated on machine swap

    // Wall-clock trigger state — read by TrackRow for the trig glow animation
    this.lastFireTime     = 0;   // performance.now() at last fire
    this.lastFireDuration = 0;   // gate length in ms
    this.lastScheduledTime = null;  // AudioContext time of the most recently scheduled tick (null = not ticked yet)

    // Active gate windows — read by StepGrid to show sustain dots on steps
    // Each entry: { absStep, voiceCount, endMs }
    this._activeGates = [];

    this.steps = Array.from({ length: DEFAULT_STEP_COUNT }, (_, i) => new Step(i));
  }

  get stepCount() { return this._stepCount; }

  set stepCount(n) {
    this._stepCount = n;
    // Grow steps array on demand — never shrink (preserves authored data)
    while (this.steps.length < n) {
      this.steps.push(new Step(this.steps.length));
    }
  }

  get currentStep() {
    return this._stepIndex;
  }

  /**
   * Map an AudioContext time to the absolute step index playing at that time,
   * plus the sub-step nudge (fractional tick offset, clamped ±0.99). Projects
   * forward from the last scheduled tick — the step scheduled at
   * `lastScheduledTime` is `(_stepIndex - 1)` (the tick handler records the time,
   * fires that step, then increments). Returns null if the clock hasn't ticked.
   *
   * Used by live-input-arp recording (Keyboard.captureArpNote): a whole arp cycle
   * is scheduled in one synchronous burst, so each note must be placed by its own
   * scheduled time rather than "now" (else they pile onto one step as a chord).
   *
   * @param {number} time — AudioContext scheduled time
   * @returns {{ absStep: number, nudge: number } | null}
   */
  stepIndexAtTime(time) {
    if (this.lastScheduledTime === null || this.stepCount <= 0) return null;
    const secondsPerTick = this.clock._secondsPerTick;
    const lastFired  = (this._stepIndex - 1 + this.stepCount) % this.stepCount;
    const deltaTicks = (time - this.lastScheduledTime) / secondsPerTick;
    const wholeTicks = Math.round(deltaTicks);
    const absStep    = ((lastFired + wholeTicks) % this.stepCount + this.stepCount) % this.stepCount;
    const nudge      = Math.max(-0.99, Math.min(0.99, deltaTicks - wholeTicks));
    return { absStep, nudge };
  }

getVisibleSteps() {
    const start = this.pageOffset * STEPS_PER_PAGE;
    // Ensure steps array covers this page
    while (this.steps.length < start + STEPS_PER_PAGE) {
      this.steps.push(new Step(this.steps.length));
    }
    return this.steps.slice(start, start + STEPS_PER_PAGE);
  }

  /**
   * Move the trigger at `fromAbs` one slot in `dir` (+1 right / -1 left), wrapping
   * at the pattern boundary (stepCount), with collision-push:
   *   - If the adjacent slot is empty, the trigger slides into it (the in-between
   *     steps are untouched — moving A right in `(A)()()(B)` lands `()(A)()(B)`).
   *   - If the adjacent slot is occupied, the contiguous run of occupied steps in
   *     front of it is pushed along by one until the first empty slot absorbs the
   *     cascade. Steps beyond that first gap never move.
   * "Occupied" = step.active. Wrap is over the whole pattern (mod stepCount), so
   * the last step moves to the first and vice-versa — never page-local.
   *
   * Operates on whole Step objects (then reindexes) so a step's notes, p-locks,
   * condition, etc. travel together.
   *
   * @param {number} fromAbs  absolute index of the step to move (0 .. stepCount-1)
   * @param {number} dir      +1 (right) or -1 (left)
   * @returns {number} the new absolute index of the moved step (== fromAbs if the
   *                   move was a no-op, e.g. pattern full in that direction)
   */
  moveStep(fromAbs, dir) {
    const n = this.stepCount;
    if (n <= 1) return fromAbs;
    const step = (dir > 0) ? 1 : -1;
    const to   = ((fromAbs + step) % n + n) % n;

    // Walk from the destination onward (wrapping) to the first empty slot. Stop if
    // we loop all the way back to `fromAbs` — the pattern is full, nothing moves.
    let gap = to;
    while (this.steps[gap].active) {
      const next = ((gap + step) % n + n) % n;
      if (next === fromAbs) return fromAbs;   // no empty slot ahead → no-op
      gap = next;
    }

    // Rotate the chain [fromAbs → … → gap] (in `dir` order) by one: the gap (empty)
    // is pulled back to fromAbs, every occupied step in between shifts one toward
    // the gap, and the moved step lands on `to`.
    const empty = this.steps[gap];          // the empty slot that absorbs the cascade
    let cur = gap;
    while (cur !== fromAbs) {
      const prev = ((cur - step) % n + n) % n;
      this.steps[cur] = this.steps[prev];
      cur = prev;
    }
    this.steps[fromAbs] = empty;            // vacated origin holds the now-empty step
    for (let i = 0; i < this.steps.length; i++) this.steps[i].index = i;
    return to;
  }

  /**
   * Rotate the WHOLE pattern by one step in `dir` (+1 right / -1 left). The step
   * that falls off one end wraps to the other. Used by the TRIG SHIFT buttons /
   * ←→ keys when no step is selected. Operates on whole Step objects + reindexes.
   * @param {number} dir  +1 (right) or -1 (left)
   */
  shiftAll(dir) {
    const count = this.stepCount;
    if (count <= 1) return;
    if (dir > 0) {
      const last = this.steps[count - 1];
      for (let i = count - 1; i > 0; i--) { this.steps[i] = this.steps[i - 1]; this.steps[i].index = i; }
      this.steps[0] = last; last.index = 0;
    } else {
      const first = this.steps[0];
      for (let i = 0; i < count - 1; i++) { this.steps[i] = this.steps[i + 1]; this.steps[i].index = i; }
      this.steps[count - 1] = first; first.index = count - 1;
    }
  }

  start() {
    this.clock.register(this._tickBound);
  }

  stop() {
    this.clock.unregister(this._tickBound);
    this._stepIndex  = 0;
    this._playCount  = 0;
  }

  reset() {
    this._stepIndex   = 0;
    this._playCount   = 0;
    this._activeGates = [];
  }

  _onTick(tickIndex, scheduledTime) {
    this.lastScheduledTime = scheduledTime;
    const step = this.steps[this._stepIndex];

    if (step.active) {
      const context = { playCount: this._playCount };
      const condPass   = step.condition.evaluate(context);
      const chancePass = condPass && (step.chance >= 100 || Math.random() * 100 < step.chance);
      if (chancePass) {
        this._fireStep(step, scheduledTime);
      }
    }

    this._stepIndex++;
    if (this._stepIndex >= this.stepCount) {
      this._stepIndex = 0;
      this._playCount++;
    }
  }

  /**
   * Resolve a param path to whichever track object owns it.
   * Used by the p-lock dispatcher to call setParam/getParam on the right object.
   */
  _resolveParamOwner(path) {
    if (path.startsWith('env.') || path.startsWith('fenv.')) return this.track.envelope;
    if (path.startsWith('filter.') || path === 'base.lpf' || path === 'base.hpf') return this.track.filter;
    if (path.startsWith('arp.'))    return this.track.arp;
    // FX blocks (base four by type prefix, added instances by 'fxN.' prefix).
    const fxObj = this.track.fxObjForPath(path);
    if (fxObj) return fxObj;
    return this.track.machine;
  }

  /**
   * Cached path→plockMode map (see _buildPlockModeMap). Built lazily on first
   * fire and reused — the param set only changes when the machine type changes,
   * so Track.setMachine() calls invalidatePlockModeMap(). Avoids rebuilding the
   * map (and re-allocating every machine/filter/FX getParamList()) on every
   * p-locked step fire, which is on the audio scheduling path.
   */
  _plockModeMap() {
    if (!this._plockModeMapCache) this._plockModeMapCache = this._buildPlockModeMap();
    return this._plockModeMapCache;
  }

  /** Drop the cached plock-mode map so it rebuilds on next use. */
  invalidatePlockModeMap() {
    this._plockModeMapCache = null;
  }

  /**
   * Build a flat path→plockMode map from all param lists the track exposes.
   * env.*, fenv.*, and filter.cutoff are not raw AudioParam dispatches — they
   * go through scheduleNote() as 'envelope' overrides.
   * amp.pan and trig.tone are virtual — handled explicitly by mode.
   */
  _buildPlockModeMap() {
    const map = new Map();
    const sources = [
      this.track.machine,
      this.track.filter,
      // All FX blocks (base four + added instances) — paths already namespaced
      // by the FXInstance proxy for added ones.
      ...this.track.getFXBlockIds().map(id => this.track.getFXBlock(id)),
    ];
    for (const src of sources) {
      for (const p of src.getParamList()) {
        if (p.plockMode) map.set(p.path, p.plockMode);
      }
    }
    // Virtual params not in any getParamList
    map.set('amp.pan',       'pan');
    map.set('trig.tone',     'trig');
    map.set('trig.velocity', 'trig');
    // Arp rate/gate/variance — js-mode: set on the arp before buildEvents() reads
    // it, restored after the voice loop via jsRestores (see _fireStep).
    map.set('arp.rate',     'js');
    map.set('arp.gate',     'js');
    map.set('arp.variance', 'js');
    return map;
  }

  /**
   * Pre-position a firing voice's filter cutoff to a p-locked value BEFORE the
   * note, while the slot's amp gate is still shut (so the move is silent). A fresh
   * pool slot's filter rests at its 8 kHz default; without this, a note p-locked to
   * a low cutoff plays its onset through the still-open filter → a short muffled
   * thump on the first 8 notes (once per slot). Pre-settling at scheduling time
   * (well ahead of the note via the scheduler lookahead) means scheduleNote's
   * envelope starts from the right cutoff with no audible transient. No-op unless
   * the step actually p-locks filter.cutoff. Slot-0 (canonical) is included — it
   * is never re-synced from siblings, so it can be stale too.
   *
   * Only runs when the slot was IDLE (gate shut) before this note — moving the
   * cutoff on a slot whose previous note is still ringing its release tail would
   * audibly alter that tail. A busy slot keeps the cancelAndHoldAtTime path in
   * scheduleFrequency, which at worst re-thumps that one note.
   */
  _anchorVoiceCutoff(voice, envOverrides, voiceWasIdle) {
    if (!voiceWasIdle) return;
    const cut = envOverrides['filter.cutoff'];
    if (cut === undefined || !voice?._filter) return;
    // Settle starting now (scheduling time), ahead of the scheduled note start.
    voice._filter.anchorFrequency(cut, this.clock.audio.context.currentTime);
  }

  _fireStep(step, scheduledTime) {
    // Muted track: the SEQUENCER is silenced (pattern-fired notes — including the
    // step-driven chord/manual/random arp, which fans out below — do not sound),
    // while live keyboard / MIDI-in and the input-mode LiveArp still play through
    // the open outputGain. Skip the whole fire — p-lock dispatch included — since
    // no note will sound; p-locks apply+restore within a single fire, so skipping
    // is self-consistent. Sequencer position still advances in tick().
    if (this.track.muted) return;

    // ── P-lock dispatch ────────────────────────────────────────
    // Shared-object p-locks (filter, pan, FX) are applied here once — they sit
    // downstream of the voice pool (or the filter mirrors to every slot), so a
    // single write reaches whatever voice plays. Machine p-locks are different:
    // each voice has its OWN machine, and the round-robin picks a different slot
    // per note, so machine p-locks must be applied to the actual firing voice's
    // machine inside the voice loop — not to slot 0. We collect them here and
    // apply them per-voice below. No machine restore is needed: each slot is
    // re-synced from the canonical slot-0 baseline by nextVoice() before reuse.
    const envOverrides     = {};
    const jsRestores       = [];
    const machineParamPlocks = {};  // audioParam-mode machine p-locks (scheduled at note time)
    const machineJsPlocks    = {};  // js-mode machine p-locks (immediate JS state)
    // We need a representative time for filter/pan p-lock restores — use voice[0]
    const v0nudge  = step.voices[0].nudge * (1 - (this.track.nudgeQuantize ?? 0));
    const v0time   = scheduledTime + (v0nudge * this.clock._secondsPerTick);
    const v0off    = v0time + (step.voices[0].length * this.clock._secondsPerTick);

    if (step.hasPLocks) {
      const modeMap = this._plockModeMap();
      for (const [path, value] of step.plocks) {
        const mode = modeMap.get(path)
          ?? (path.startsWith('env.') || path.startsWith('fenv.') ? 'envelope' : 'js');

        const ownerIsMachine = this._resolveParamOwner(path) === this.track.machine;

        switch (mode) {
          case 'envelope':
            envOverrides[path] = value;
            break;
          case 'filter': {
            const obj = this.track.filter;
            const old = obj.getParam(path);
            obj.setParam(path, value, v0time);
            obj.setParam(path, old,   v0off);
            break;
          }
          case 'audioParam': {
            if (ownerIsMachine) {
              // Defer to the firing voice's machine (applied per-voice below).
              machineParamPlocks[path] = value;
              break;
            }
            const obj = this._resolveParamOwner(path);
            const old = obj.getParam(path);
            obj.setParam(path, value, v0time);
            jsRestores.push(() => obj.setParam(path, old, v0off));
            break;
          }
          case 'js': {
            if (ownerIsMachine) {
              // Defer to the firing voice's machine (applied per-voice below).
              machineJsPlocks[path] = value;
              break;
            }
            const obj = this._resolveParamOwner(path);
            const old = obj.getParam(path);
            obj.setParam(path, value);
            jsRestores.push(() => obj.setParam(path, old));
            break;
          }
          case 'pan': {
            const panner = this.track.pannerNode;
            const old = panner.pan.value;
            panner.pan.setValueAtTime(value, v0time);
            jsRestores.push(() => panner.pan.setValueAtTime(old, v0off));
            break;
          }
          case 'trig':
            break;
        }
      }
    }

    const hasMachinePlocks =
      Object.keys(machineParamPlocks).length > 0 ||
      Object.keys(machineJsPlocks).length > 0;

    // Machine p-locks mutate the firing voice's machine. Non-canonical voices
    // self-heal — nextVoice() re-applies the canonical baseline (fromJSONSafe +
    // copyAudioParamState) before reuse. The canonical slot-0 machine is never
    // re-synced, so if a p-lock note fires on it we capture its baseline _params
    // and restore them (JS-state only) after the loop, keeping it pristine:
    //   - js p-locks: setParam(path, value) reverts the waveform/etc.
    //   - audioParam p-locks: restoring _params[path] (no time) leaves the
    //     already-scheduled p-lock ramp intact for this note but ensures the
    //     next note's syncParamsAt(time) schedules the true baseline value.
    const canonicalMachine = this.track._pool?.machine ?? this.track.machine;
    const jsBaseline    = {};  // js p-lock paths → baseline (reverted via setParam)
    const paramBaseline = {};  // audioParam p-lock paths → baseline (reverted in _params only)
    if (canonicalMachine) {
      for (const path of Object.keys(machineJsPlocks))    jsBaseline[path]    = canonicalMachine.getParam(path);
      for (const path of Object.keys(machineParamPlocks)) paramBaseline[path] = canonicalMachine.getParam(path);
    }

    const applyMachinePlocks = (machine, time) => {
      if (!machine) return;
      for (const [path, value] of Object.entries(machineJsPlocks))    machine.setParam(path, value);
      for (const [path, value] of Object.entries(machineParamPlocks)) machine.setParam(path, value, time);
    };

    // Restore the canonical slot-0 machine to its baseline after the loop so it
    // stays pristine for future notes (it is never re-synced from any other slot).
    const restoreCanonicalJs = () => {
      if (!canonicalMachine || canonicalMachine !== this.track._pool?.machine) return;
      // js p-locks: revert the audio node too (e.g. oscillator .type).
      for (const [path, value] of Object.entries(jsBaseline)) canonicalMachine.setParam(path, value);
      // audioParam p-locks: revert JS state ONLY — the scheduled p-lock ramp for
      // the just-fired note must survive; the next note's syncParamsAt(time) will
      // schedule this restored baseline at its own start.
      if (canonicalMachine._params) {
        for (const [path, value] of Object.entries(paramBaseline)) canonicalMachine._params[path] = value;
      }
    };

    const release = envOverrides['env.release'] ?? this.track.envelope?.getParam('env.release') ?? 0;

    // trig.tone transpose (shared)
    let tone = step.plocks.has('trig.tone') ? step.plocks.get('trig.tone') : (this.track.trigTone ?? 0);
    this.track.lfos.forEach((lfo, i) => {
      if (this.track._lfoDestPaths[i] === 'trig.tone') tone += lfo.getCurrentValue();
    });

    // Velocity resolution (per voice). Precedence:
    //   1. trig.velocity p-lock — explicit per-step override, wins for all voices
    //   2. the voice's own stored velocity — recorded/MIDI velocity sounds here
    //   3. track.trigVelocity — base default for steps with no recorded velocity
    // An LFO on trig.velocity adds a shared offset on top, sampled once per step.
    const velPLock = step.plocks.has('trig.velocity') ? step.plocks.get('trig.velocity') : null;
    let velLfoOffset = 0;
    this.track.lfos.forEach((lfo, i) => {
      if (this.track._lfoDestPaths[i] === 'trig.velocity') velLfoOffset += lfo.getCurrentValue();
    });
    const resolveVelocity = (sv) => {
      const base = velPLock ?? sv.velocity ?? (this.track.trigVelocity ?? 100);
      return Math.max(1, Math.min(127, Math.round(base + velLfoOffset)));
    };

    const arp = this.track.arp;
    // Input modes ('input' / 'input-manual' / 'input-random') are keyboard-driven (LiveArp), NOT
    // step-triggered — their buildEvents() returns []. So steps must fire NORMALLY
    // in those modes (this is also how recorded input-arp notes play back). Only
    // chord/manual/random fan a step through the arp.
    const arpFiresSteps = !!(arp?.enabled && !arp.isLiveInputMode());

    // ── Arp rate/gate/variance LFO (sample-and-hold) ────────────────────────
    // Arp timing is plain JS read once at build time, not an AudioParam, so an
    // LFO can only sample-and-hold per step-fire (like trig.tone). We collect the
    // per-path offset here and apply it transiently around buildEvents() below,
    // on top of any p-lock already set. Restored immediately so jsRestores (the
    // p-lock baseline) stays correct. (Input mode is keyboard-driven — LiveArp
    // does its own per-cycle sampling; this only covers step-triggered modes.)
    const arpLfoOffset = {};
    if (arpFiresSteps) {
      this.track.lfos.forEach((lfo, i) => {
        const p = this.track._lfoDestPaths[i];
        if (p === 'arp.rate' || p === 'arp.gate' || p === 'arp.variance') {
          arpLfoOffset[p] = (arpLfoOffset[p] ?? 0) + lfo.getCurrentValue();
        }
      });
    }
    const hasArpLfo = Object.keys(arpLfoOffset).length > 0;

    /** Run fn with arp params offset by the sampled LFO values, then restore. */
    const withArpLfo = (fn) => {
      if (!hasArpLfo) return fn();
      const saved = {};
      for (const path of Object.keys(arpLfoOffset)) {
        saved[path] = arp.getParam(path);
        arp.setParam(path, saved[path] + arpLfoOffset[path]);
      }
      try { return fn(); }
      finally { for (const path of Object.keys(saved)) arp.setParam(path, saved[path]); }
    };

    // ── Continuous Input machine: no per-note gating ───────────
    // A continuous live-input track (InputMachine, gate off) has no notes — its
    // amp gate is held open by Track._applyInputGate. Firing the voice loop here
    // would call envelope.scheduleNote and momentarily gate the live signal. So
    // we skip the voice/envelope firing entirely; the shared filter/pan/FX
    // p-locks dispatched above (scheduled at v0time, restored at v0off) still
    // sweep the continuous signal, which is exactly the desired behaviour.
    // (Gated Input — input.gate on — falls through and fires normally, chopping
    // the signal with the envelope like any other voice.)
    const inputMachine = this.track.machine;
    if (inputMachine?.type === 'input' && !inputMachine.gated) {
      jsRestores.forEach(fn => fn());
      restoreCanonicalJs();
      return;
    }

    // ── Fire each voice ────────────────────────────────────────
    step.voices.forEach((sv, vi) => {
      const effectiveNudge = sv.nudge * (1 - (this.track.nudgeQuantize ?? 0));
      const time    = scheduledTime + (effectiveNudge * this.clock._secondsPerTick);
      const offTime = time + (sv.length * this.clock._secondsPerTick);
      const stepLenSec = sv.length * this.clock._secondsPerTick;

      // Record wall-clock trigger state for the trig glow (using first voice)
      if (vi === 0) {
        const nowMs         = performance.now();
        const audioNow      = this.clock.audio.context.currentTime;
        const startOffsetMs = (time - audioNow) * 1000;
        this.lastFireTime     = nowMs + startOffsetMs;
        this.lastFireDuration = (offTime - time) * 1000;

        // Record active gate for sustain-dot rendering in StepGrid.
        // spanSteps = how many steps the note's gate reaches forward from its
        // origin (1 tick == 1 step). StepGrid paints a sustain dot only on the
        // steps actually inside this span — not on every other step — so a single
        // long note can't light up the whole row.
        const gateMs    = (offTime - time) * 1000;
        const spanSteps = Math.max(1, Math.ceil(step.voices[0].length));
        this._activeGates = this._activeGates.filter(g => g.endMs > nowMs);
        this._activeGates.push({
          absStep:   this._stepIndex,
          spanSteps,
          voiceCount: step.voices.length,
          endMs:     nowMs + startOffsetMs + gateMs,
        });
      }

      const finalNote = Math.max(0, Math.min(127, sv.note + Math.round(tone)));
      const trigVel   = resolveVelocity(sv);

      if (arpFiresSteps) {
        // Arpeggiator: fan the root note into a sequence of scheduled events.
        // Build under any sampled arp-LFO offset (p-lock is already applied).
        const events = withArpLfo(() => arp.buildEvents(finalNote, trigVel, time, offTime, stepLenSec));
        events.forEach(ev => {
          // Light the on-screen key green for the arp note (respects its gate).
          this.track.noteLightHook?.(ev.note, 'arp', ev.time, ev.offTime);
          const oscOff = ev.offTime + release;
          const voice  = this.track._pool?.nextVoice(ev.time);
          // Capture idle state BEFORE claim() overwrites _freeAt with this note's end.
          const voiceWasIdle = voice ? !voice.isBusy(ev.time) : false;
          if (voice) voice.claim(oscOff);
          const machine  = voice?.machine  ?? this.track.machine;
          const envelope = voice?.envelope ?? this.track.envelope;
          machine?.syncParamsAt?.(ev.time);
          if (hasMachinePlocks) applyMachinePlocks(machine, ev.time);
          this._anchorVoiceCutoff(voice, envOverrides, voiceWasIdle);
          machine?.noteOn(ev.note, ev.velocity, ev.time, ev.offTime);
          machine?.noteOff(oscOff);
          // note + velocity ride in via overrides for analogue keytrack/velocity
          // (ignored on the digital path). Spread, don't mutate the shared object.
          envelope?.scheduleNote(ev.time, ev.offTime, { ...envOverrides, note: ev.note, velocity: ev.velocity });
          const ampParams = envelope?._params ?? {};
          this.track.lfos.forEach(lfo => {
            lfo.noteOn(ev.time, ev.offTime, { ...ampParams, ...envOverrides });
            lfo.noteOff(ev.offTime);
          });
        });
      } else {
        // Light the on-screen key red for the plain sequencer note (its gate).
        this.track.noteLightHook?.(finalNote, 'seq', time, offTime);
        const oscOffTime = offTime + release;
        const voice    = this.track._pool?.nextVoice(time);
        // Capture idle state BEFORE claim() overwrites _freeAt with this note's end.
        const voiceWasIdle = voice ? !voice.isBusy(time) : false;
        if (voice) voice.claim(oscOffTime);
        const machine  = voice?.machine  ?? this.track.machine;
        const envelope = voice?.envelope ?? this.track.envelope;
        machine?.syncParamsAt?.(time);
        if (hasMachinePlocks) applyMachinePlocks(machine, time);
        this._anchorVoiceCutoff(voice, envOverrides, voiceWasIdle);
        machine?.noteOn(finalNote, trigVel, time, offTime);
        machine?.noteOff(oscOffTime);
        envelope?.scheduleNote(time, offTime, { ...envOverrides, note: finalNote, velocity: trigVel });
        const ampParams = envelope?._params ?? {};
        this.track.lfos.forEach(lfo => {
          lfo.noteOn(time, offTime, { ...ampParams, ...envOverrides });
          lfo.noteOff(offTime);
        });
      }
    });

    jsRestores.forEach(fn => fn());
    restoreCanonicalJs();

    // ── Notify follower tracks ─────────────────────────────────
    if (this._projectTracks) {
      this._projectTracks.forEach(follower => {
        if (follower.followSource !== this.track.index) return;
        step.voices.forEach(sv => {
          const effectiveNudge = sv.nudge * (1 - (this.track.nudgeQuantize ?? 0));
          const time      = scheduledTime + (effectiveNudge * this.clock._secondsPerTick);
          const offTime   = time + (sv.length * this.clock._secondsPerTick);
          const finalNote = Math.max(0, Math.min(127, sv.note + Math.round(tone)));
          follower.fireFollowNote(finalNote, resolveVelocity(sv), time, offTime);
        });
      });
    }
  }

  toJSON() {
    return {
      stepCount:  this.stepCount,
      pageOffset: this.pageOffset,
      steps:      this.steps.map(s => s.toJSON()),
    };
  }

  fromJSON(obj) {
    this.stepCount  = obj.stepCount  ?? DEFAULT_STEP_COUNT;
    this.pageOffset = obj.pageOffset ?? 0;
    obj.steps?.forEach((sObj, i) => {
      // steps array is grown by the stepCount setter, but saved projects may have
      // more step data than stepCount — ensure capacity for all saved steps.
      while (this.steps.length <= i) this.steps.push(new Step(this.steps.length));
      this.steps[i] = Step.fromJSON(sObj);
    });
  }
}
