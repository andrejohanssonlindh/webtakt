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

    // Wall-clock trigger state — read by TrackRow for the trig glow animation
    this.lastFireTime     = 0;   // performance.now() at last fire
    this.lastFireDuration = 0;   // gate length in ms
    this.lastScheduledTime = 0;  // AudioContext time of the most recently scheduled tick

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

getVisibleSteps() {
    const start = this.pageOffset * STEPS_PER_PAGE;
    // Ensure steps array covers this page
    while (this.steps.length < start + STEPS_PER_PAGE) {
      this.steps.push(new Step(this.steps.length));
    }
    return this.steps.slice(start, start + STEPS_PER_PAGE);
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
    if (path.startsWith('delay.'))  return this.track.delayFX;
    if (path.startsWith('crush.'))  return this.track.bitcrushFX;
    if (path.startsWith('reverb.')) return this.track.reverbFX;
    return this.track.machine;
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
      this.track.delayFX,
      this.track.bitcrushFX,
      this.track.reverbFX,
    ];
    for (const src of sources) {
      for (const p of src.getParamList()) {
        if (p.plockMode) map.set(p.path, p.plockMode);
      }
    }
    // Virtual params not in any getParamList
    map.set('amp.pan',  'pan');
    map.set('trig.tone', 'trig');
    return map;
  }

  _fireStep(step, scheduledTime) {
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
      const modeMap = this._buildPlockModeMap();
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

    const arp = this.track.arp;

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

        // Record active gate for sustain-dot rendering in StepGrid
        const gateMs = (offTime - time) * 1000;
        this._activeGates = this._activeGates.filter(g => g.endMs > nowMs);
        this._activeGates.push({ absStep: this._stepIndex, voiceCount: step.voices.length, endMs: nowMs + startOffsetMs + gateMs });
      }

      const finalNote = Math.max(0, Math.min(127, sv.note + Math.round(tone)));

      if (arp?.enabled) {
        // Arpeggiator: fan the root note into a sequence of scheduled events
        const events = arp.buildEvents(finalNote, sv.velocity, time, offTime, stepLenSec);
        events.forEach(ev => {
          const oscOff = ev.offTime + release;
          const voice  = this.track._pool?.nextVoice(ev.time);
          if (voice) voice.claim(oscOff);
          const machine  = voice?.machine  ?? this.track.machine;
          const envelope = voice?.envelope ?? this.track.envelope;
          machine?.syncParamsAt?.(ev.time);
          if (hasMachinePlocks) applyMachinePlocks(machine, ev.time);
          machine?.noteOn(ev.note, ev.velocity, ev.time, ev.offTime);
          machine?.noteOff(oscOff);
          envelope?.scheduleNote(ev.time, ev.offTime, envOverrides);
          const ampParams = envelope?._params ?? {};
          this.track.lfos.forEach(lfo => {
            lfo.noteOn(ev.time, ev.offTime, { ...ampParams, ...envOverrides });
            lfo.noteOff(ev.offTime);
          });
        });
      } else {
        const oscOffTime = offTime + release;
        const voice    = this.track._pool?.nextVoice(time);
        if (voice) voice.claim(oscOffTime);
        const machine  = voice?.machine  ?? this.track.machine;
        const envelope = voice?.envelope ?? this.track.envelope;
        machine?.syncParamsAt?.(time);
        if (hasMachinePlocks) applyMachinePlocks(machine, time);
        machine?.noteOn(finalNote, sv.velocity, time, offTime);
        machine?.noteOff(oscOffTime);
        envelope?.scheduleNote(time, offTime, envOverrides);
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
          follower.fireFollowNote(finalNote, sv.velocity, time, offTime);
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
