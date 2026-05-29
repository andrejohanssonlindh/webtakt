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
 *   'audioParam' — same pattern: obj.setParam(path, value, time) then restore at offTime
 *   'js'         — immediate setParam before noteOn, immediate restore after
 *                  (waveforms, curve rebuilds, IR rebuilds, JS-only timing values)
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
    // ── P-lock dispatch (shared across all voices) ─────────────
    const envOverrides = {};
    const jsRestores   = [];
    // We need a representative time for filter/pan p-lock restores — use voice[0]
    const v0nudge  = step.voices[0].nudge * (1 - (this.track.nudgeQuantize ?? 0));
    const v0time   = scheduledTime + (v0nudge * this.clock._secondsPerTick);
    const v0off    = v0time + (step.voices[0].length * this.clock._secondsPerTick);

    if (step.hasPLocks) {
      const modeMap = this._buildPlockModeMap();
      for (const [path, value] of step.plocks) {
        const mode = modeMap.get(path)
          ?? (path.startsWith('env.') || path.startsWith('fenv.') ? 'envelope' : 'js');

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
            const obj = this._resolveParamOwner(path);
            const old = obj.getParam(path);
            obj.setParam(path, value, v0time);
            jsRestores.push(() => obj.setParam(path, old, v0off));
            break;
          }
          case 'js': {
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

    const release = envOverrides['env.release'] ?? this.track.envelope?.getParam('env.release') ?? 0;

    // trig.tone transpose (shared)
    let tone = step.plocks.has('trig.tone') ? step.plocks.get('trig.tone') : (this.track.trigTone ?? 0);
    this.track.lfos.forEach((lfo, i) => {
      if (this.track._lfoDestPaths[i] === 'trig.tone') tone += lfo.getCurrentValue();
    });

    // ── Fire each voice ────────────────────────────────────────
    step.voices.forEach((sv, vi) => {
      const effectiveNudge = sv.nudge * (1 - (this.track.nudgeQuantize ?? 0));
      const time    = scheduledTime + (effectiveNudge * this.clock._secondsPerTick);
      const offTime = time + (sv.length * this.clock._secondsPerTick);
      const oscOffTime = offTime + release;

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

      const voice    = this.track._pool?.nextVoice();
      if (voice) voice.claim(oscOffTime);

      const finalNote = Math.max(0, Math.min(127, sv.note + Math.round(tone)));
      const machine   = voice?.machine  ?? this.track.machine;
      const envelope  = voice?.envelope ?? this.track.envelope;

      machine?.noteOn(finalNote, sv.velocity, time, offTime);
      machine?.noteOff(oscOffTime);
      envelope?.scheduleNote(time, offTime, envOverrides);

      const ampParams = envelope?._params ?? {};
      this.track.lfos.forEach(lfo => {
        lfo.noteOn(time, offTime, { ...ampParams, ...envOverrides });
        lfo.noteOff(offTime);
      });
    });

    jsRestores.forEach(fn => fn());

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
