/**
 * Envelope.js
 * -----------
 * Per-track ADSR envelope.
 *
 * Owns TWO independent envelopes:
 *   - Amp envelope  (env.*)   — controls ampGain
 *   - Filter envelope (fenv.*) — modulates filter cutoff frequency
 *
 * scheduleNote(time, offTime) atomically queues both envelopes for one note.
 * It does NOT cancel prior events before `time`, so a previous note's release
 * tail keeps running right up until this note's attack overwrites it.
 *
 * noteOn / noteOff are kept for live keyboard playing (they do cancel,
 * which is fine for interactive use).
 *
 * Filter modulation fix: we drive the active engine's cutoff AudioParam directly
 * with scheduled ramps rather than via a GainNode (which had no input and
 * therefore always produced silence regardless of its gain value). The sequencer
 * path goes through Filter.scheduleFrequency; the live keyboard path uses
 * Filter.cutoffParam() — both resolve to the biquad (digital) or ladder (analogue)
 * cutoff depending on filter.engine.
 *
 * Tempo-sync (per stage): each timed stage (attack/decay/release of both the
 * amp and filter envelopes) can be locked to tempo. When
 * `<prefix>.<stage>.syncMode === 'bpm'`, the stage duration is resolved at
 * note-fire time from `<prefix>.<stage>.bpmCount32` (an integer count of 1/32
 * notes) via count32ToSeconds(count, bpm). The seconds param stays the source
 * of truth in 'ms' mode. Sustain has no duration, so it is never synced.
 * See js/util/BpmSync.js and design/sync-knob-rollout.md.
 */

import { count32ToSeconds } from '../util/BpmSync.js';

export class Envelope {
  constructor(context) {
    this.context = context;
    this._bpm    = 120;

    this._params = {
      'env.attack':   0.01,
      'env.decay':    0.1,
      'env.sustain':  0.7,
      'env.release':  0.3,
      'fenv.attack':  0.01,
      'fenv.decay':   0.2,
      'fenv.sustain': 0.0,
      'fenv.release': 0.3,

      // Per-stage tempo-sync: mode ('ms' | 'bpm') + 1/32 count per timed stage.
      // Default count 4 = 1/8. Resolved to seconds at note-fire when mode='bpm'.
      'env.attack.syncMode':   'ms', 'env.attack.bpmCount32':   4,
      'env.decay.syncMode':    'ms', 'env.decay.bpmCount32':    4,
      'env.release.syncMode':  'ms', 'env.release.bpmCount32':  4,
      'fenv.attack.syncMode':  'ms', 'fenv.attack.bpmCount32':  4,
      'fenv.decay.syncMode':   'ms', 'fenv.decay.bpmCount32':   4,
      'fenv.release.syncMode': 'ms', 'fenv.release.bpmCount32': 4,

      // Velocity sensitivity (analogue flow): how much note velocity scales the
      // amp-envelope peak and filter-envelope depth. 0 = velocity ignored (the
      // original behaviour, kept for the digital path), 1 = full range. Only
      // applied when the track is analogue. See scheduleNote.
      'env.velSens': 0.0,
    };

    this.ampGain = context.createGain();
    this.ampGain.gain.value = 0;

    this._filter = null;
    // Last keytracked base cutoff from a live noteOn, used by the live noteOff
    // release target (analogue keytrack). null until the first analogue noteOn.
    this._liveBaseCut = null;
  }

  /** Update BPM used to resolve tempo-synced stage durations. */
  setBpm(bpm) {
    this._bpm = bpm;
  }

  /**
   * Resolve a stage duration to seconds, honouring its sync mode. `prefix` is
   * 'env' or 'fenv'; `stage` is 'attack' | 'decay' | 'release'. When the stage
   * is BPM-synced the duration comes from its 1/32 count at the current BPM;
   * otherwise the plain seconds param (with optional p-lock override) is used.
   */
  _stageSeconds(prefix, stage, overrides = {}) {
    const secKey  = `${prefix}.${stage}`;
    const modeKey = `${secKey}.syncMode`;
    const cntKey  = `${secKey}.bpmCount32`;
    const mode = overrides[modeKey] ?? this._params[modeKey];
    if (mode === 'bpm') {
      const count = overrides[cntKey] ?? this._params[cntKey];
      return count32ToSeconds(count, this._bpm);
    }
    return overrides[secKey] ?? this._params[secKey];
  }

  connectToFilter(filter) {
    this._filter = filter;
  }

  /**
   * Whether this envelope's track is in the analogue flow. Read from the linked
   * filter's engine (the track-level analogue flag drives filter.engine, mirrored
   * to every voice slot), so no extra per-slot wiring is needed. Gates the RC
   * envelope curves, filter keytrack, and velocity sensitivity — when false the
   * envelope behaves exactly as the original digital path.
   */
  _isAnalogue() {
    return this._filter?.getParam('filter.engine') === 'analogue';
  }

  /**
   * Keytracked base cutoff: in analogue mode, shift the cutoff the filter
   * envelope sweeps from by the played note, so the (possibly self-oscillating)
   * ladder tracks pitch. keytrack 0 = no tracking (cutoff fixed), 1 = cutoff
   * follows pitch exactly. midi 60 (C4) is the neutral reference, so a patch
   * sounds the same at C4 regardless of keytrack. Returns baseCut unchanged when
   * not analogue or no note was supplied (e.g. the live keyboard path).
   */
  _keytrackCut(baseCut, note, ktOverride) {
    if (!this._isAnalogue() || note == null) return baseCut;
    const kt = ktOverride ?? this._filter.getParam('filter.keytrack') ?? 0;
    if (kt <= 0) return baseCut;
    const tracked = baseCut * Math.pow(2, ((note - 60) / 12) * kt);
    return Math.min(Math.max(tracked, 20), 20000);
  }

  connect(destinationNode) { this.ampGain.connect(destinationNode); }
  disconnect() {
    this.ampGain.disconnect();
  }

  // ── Shared helper: schedule ADSR ramps on an AudioParam ────────────────

  /**
   * Schedule A→D→S ramps on `param` starting at `time`.
   * `peakVal`    — value at end of attack (full open)
   * `sustainVal` — value at end of decay
   * Uses cancelAndHoldAtTime so an overlapping new note starts from wherever
   * the param currently is.
   *
   * After cancelAndHoldAtTime we ALWAYS re-assert an explicit setValueAtTime
   * anchor at `time`. Without it Chrome's linearRampToValueAtTime ramps from the
   * time of the previous automation event (the prior note's release, now in the
   * past) instead of from `time` — so the attack rises ~one lookahead early and
   * you hear a soft "pre-note" before the real onset. Firefox inserts an implicit
   * hold and was unaffected, which is why the glitch was Chrome-only. Pinning the
   * start here makes both engines ramp from `time`. (snapshot() reads the value
   * cancelAndHold settled to; for an idle gate that's the held 0.)
   */
  _scheduleADS(param, time, a, d, peakVal, sustainVal, analogue = false) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
    }
    param.setValueAtTime(param.value, time);
    if (analogue) {
      // RC (exponential) attack + decay — the shape of a capacitor charging
      // through a resistor, the way an analogue ADSR actually moves. setTargetAtTime
      // approaches its target asymptotically, so we use a time-constant that
      // substantially completes within the stage (tc = dur/3 ≈ 95% reached) and
      // then pin the exact endpoint with setValueAtTime so the following segment
      // starts from a known value (and the decay→sustain→release chain stays exact).
      this._rcSegment(param, time, a, peakVal);
      this._rcSegment(param, time + a, d, sustainVal);
    } else {
      param.linearRampToValueAtTime(peakVal,    time + a);
      param.linearRampToValueAtTime(sustainVal, time + a + d);
    }
  }

  /**
   * Schedule release ramp on `param` starting at `offTime`.
   * `endVal` — value to ramp toward (0 for amp, baseCutoff for filter).
   */
  _scheduleR(param, offTime, sustainVal, r, endVal, analogue = false) {
    param.setValueAtTime(sustainVal, offTime);
    if (analogue) {
      this._rcSegment(param, offTime, r, endVal);
    } else {
      param.linearRampToValueAtTime(endVal, offTime + r);
    }
  }

  /**
   * One RC (exponential-approach) envelope segment from the param's current
   * value toward `target`, started at `start` and pinned to exactly `target` at
   * `start + dur`. A near-zero duration degrades to an instant step. The pin is
   * what keeps multi-segment envelopes (A→D→S→R) exact despite setTargetAtTime's
   * asymptotic nature.
   */
  _rcSegment(param, start, dur, target) {
    if (dur <= 0.0005) {
      param.setValueAtTime(target, start);
      return;
    }
    param.setTargetAtTime(target, start, dur / 3);
    param.setValueAtTime(target, start + dur);
  }

  // ── Sequencer scheduling ────────────────────────────────────────────────

  /**
   * Schedule a complete note from the sequencer.
   * Queues A→D→S starting at `time`, then R starting at `offTime`.
   * Does NOT cancel prior scheduled events — the previous note's release
   * tail runs until `time` when the new attack overwrites it.
   */
  scheduleNote(time, offTime, overrides = {}) {
    const analogue = this._isAnalogue();

    // Note + velocity (analogue flow) ride in on the overrides object so the four
    // scheduleNote call sites need no signature change. velocity is 0–127 (as the
    // sequencer carries it); normalise to 0–1. Both absent on the live-keyboard
    // path, which uses noteOn/noteOff instead.
    const note = overrides['note'] ?? null;
    const vel  = (overrides['velocity'] ?? 127) / 127;
    // velFactor: velocity always scales amplitude (1 = full, lower vel = quieter).
    // velSens (analogue-only) adds extra sensitivity — 0 = linear, 1 = full curve.
    // On the digital path velSens is 0 so the formula reduces to plain vel/127.
    const velSens   = analogue ? (overrides['env.velSens'] ?? this._params['env.velSens'] ?? 0) : 0;
    const velFactor = vel * (1 - velSens) + vel * velSens * vel;

    // ── Amp envelope ── (timed stages resolve sync mode → seconds)
    const a = this._stageSeconds('env', 'attack',  overrides);
    const d = this._stageSeconds('env', 'decay',   overrides);
    const s = overrides['env.sustain'] ?? this._params['env.sustain'];
    const r = this._stageSeconds('env', 'release', overrides);

    const g = this.ampGain.gain;
    const peak = 1.0 * velFactor;
    this._scheduleADS(g, time, a, d, peak, s * velFactor, analogue);
    this._scheduleR(g, offTime, s * velFactor, r, 0, analogue);

    // ── Filter envelope ──
    if (this._filter) {
      const fa = this._stageSeconds('fenv', 'attack',  overrides);
      const fd = this._stageSeconds('fenv', 'decay',   overrides);
      const fs = overrides['fenv.sustain'] ?? this._params['fenv.sustain'];
      const fr = this._stageSeconds('fenv', 'release', overrides);

      const envAmt    = overrides['filter.envAmount'] ?? this._filter.getParam('filter.envAmount');
      // baseCut: the cutoff the envelope sweep is anchored from (may be p-locked).
      // trueCut: the cutoff the filter rests at once the note's release ends.
      // Keytrack (analogue) shifts both by the played note so the ladder tracks
      // pitch — a no-op when not analogue, keytrack 0, or no note was supplied.
      const persistentCut = this._filter.getParam('filter.cutoff');
      const rawBase = overrides['filter.cutoff'] ?? persistentCut;
      const baseCut = this._keytrackCut(rawBase, note, overrides['filter.keytrack']);
      // When the cutoff is p-locked, the release tail must stay at the p-locked
      // value too — otherwise the filter springs back to the persistent cutoff at
      // note-off while the amp is still ringing, and you hear an unfiltered tail
      // ("dark plop, then the note"). The persistent param is untouched, so the
      // NEXT (non-p-locked) note sweeps from/to the real baseline correctly.
      const trueCut = baseCut;

      // Positive envAmt sweeps toward 20000 Hz, negative toward 20 Hz.
      // 100% always reaches the limit of the range from the current cutoff position.
      // Velocity (analogue) scales how far the filter envelope opens.
      const headroom   = envAmt >= 0 ? (20000 - baseCut) : (baseCut - 20);
      const modDepth   = headroom * envAmt * velFactor;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      // Schedule across primary node + all slope stages via Filter.scheduleFrequency
      this._filter.scheduleFrequency(time, fa, fd, peakCut, sustainCut, offTime, fr, trueCut, baseCut, analogue);
    }
  }

  // ── Live keyboard ───────────────────────────────────────────────────────

  /**
   * Live noteOn (keyboard). Cancels any prior events and restarts. `note` (the
   * played MIDI number) is optional and drives analogue keytrack; when absent
   * keytrack is skipped. Live playing uses a fixed velocity, so velocity scaling
   * is intentionally not applied here — only keytrack and RC curves carry over.
   */
  noteOn(time, note = null) {
    const analogue = this._isAnalogue();
    // Amp
    const a = this._stageSeconds('env', 'attack');
    const d = this._stageSeconds('env', 'decay');
    const s = this._params['env.sustain'];

    const g = this.ampGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0, time);
    if (analogue) {
      this._rcSegment(g, time,     a, 1.0);
      this._rcSegment(g, time + a, d, s);
    } else {
      g.linearRampToValueAtTime(1.0, time + a);
      g.linearRampToValueAtTime(s,   time + a + d);
    }

    // Filter
    if (this._filter) {
      const fa = this._stageSeconds('fenv', 'attack');
      const fd = this._stageSeconds('fenv', 'decay');
      const fs = this._params['fenv.sustain'];

      const envAmt  = this._filter.getParam('filter.envAmount');
      const baseCut = this._keytrackCut(this._filter.getParam('filter.cutoff'), note);
      // Remember the keytracked base so the live noteOff release lands here rather
      // than springing to the raw (un-keytracked) cutoff.
      this._liveBaseCut = baseCut;
      const headroom   = envAmt >= 0 ? (20000 - baseCut) : (baseCut - 20);
      const modDepth   = headroom * envAmt;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      const freq = this._filter.cutoffParam();
      freq.cancelScheduledValues(time);
      freq.setValueAtTime(baseCut, time);
      if (analogue) {
        this._rcSegment(freq, time,      fa, peakCut);
        this._rcSegment(freq, time + fa, fd, sustainCut);
      } else {
        freq.linearRampToValueAtTime(peakCut,    time + fa);
        freq.linearRampToValueAtTime(sustainCut, time + fa + fd);
      }
    }
  }

  /**
   * Live noteOff (keyboard).
   */
  noteOff(time) {
    const analogue = this._isAnalogue();
    const r = this._stageSeconds('env', 'release');
    const g = this.ampGain.gain;

    if (typeof g.cancelAndHoldAtTime === 'function') {
      g.cancelAndHoldAtTime(time);
    } else {
      g.cancelScheduledValues(time);
    }
    g.setValueAtTime(g.value, time);   // anchor so the release ramps from `time` (see _scheduleADS)
    if (analogue) this._rcSegment(g, time, r, 0);
    else          g.linearRampToValueAtTime(0, time + r);

    if (this._filter) {
      const fr      = this._stageSeconds('fenv', 'release');
      // Release toward the keytracked base the note played at (set in noteOn),
      // falling back to the raw cutoff for a noteOff with no preceding analogue
      // noteOn (e.g. engine switched mid-note).
      const baseCut = (analogue && this._liveBaseCut != null)
        ? this._liveBaseCut
        : this._filter.getParam('filter.cutoff');
      const freq    = this._filter.cutoffParam();

      if (typeof freq.cancelAndHoldAtTime === 'function') {
        freq.cancelAndHoldAtTime(time);
      } else {
        freq.cancelScheduledValues(time);
      }
      freq.setValueAtTime(freq.value, time);
      if (analogue) this._rcSegment(freq, time, fr, baseCut);
      else          freq.linearRampToValueAtTime(baseCut, time + fr);
    }
  }

  /**
   * Hard kill — immediately cancel all scheduled gain automation and force the
   * amp gate to 0 (and the filter back to its base cutoff). Used by the global
   * STOP/panic button to cut sounds that are ringing out, looping, or stuck. A
   * tiny ramp avoids a click.
   */
  silence(time) {
    const g = this.ampGain.gain;
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(time);
    else                                             g.cancelScheduledValues(time);
    g.setValueAtTime(g.value, time);
    g.linearRampToValueAtTime(0, time + 0.005);

    if (this._filter) {
      const baseCut = this._filter.getParam('filter.cutoff');
      const freq    = this._filter.cutoffParam();
      if (typeof freq.cancelAndHoldAtTime === 'function') freq.cancelAndHoldAtTime(time);
      else                                                freq.cancelScheduledValues(time);
      freq.setValueAtTime(baseCut, time);
    }
  }

  setParam(path, value) { this._params[path] = value; }
  getParam(path)        { return this._params[path]; }

  getParamList() {
    return [
      { path: 'env.attack',   label: 'Attack',   type: 'number', min: 0.001, max: 4.0, default: 0.01 },
      { path: 'env.decay',    label: 'Decay',    type: 'number', min: 0.001, max: 4.0, default: 0.1  },
      { path: 'env.sustain',  label: 'Sustain',  type: 'number', min: 0,     max: 1.0, default: 0.7  },
      { path: 'env.release',  label: 'Release',  type: 'number', min: 0.001, max: 8.0, default: 0.3  },
      { path: 'fenv.attack',  label: 'F.Attack',  type: 'number', min: 0.001, max: 4.0, default: 0.01 },
      { path: 'fenv.decay',   label: 'F.Decay',   type: 'number', min: 0.001, max: 4.0, default: 0.2  },
      { path: 'fenv.sustain', label: 'F.Sustain', type: 'number', min: 0,     max: 1.0, default: 0.0  },
      { path: 'fenv.release', label: 'F.Release', type: 'number', min: 0.001, max: 8.0, default: 0.3  },
      { path: 'env.velSens',  label: 'Vel Sens',  type: 'number', min: 0,     max: 1.0, default: 0.0  },
    ];
  }

  /**
   * Resolve a parameter path to a live AudioParam for LFO connection.
   * The amp gain AudioParam is directly modulatable.
   * ADSR values are JS-only (scheduled per note) and cannot be connected.
   * @param {string} path
   * @returns {AudioParam|null}
   */
  resolveAudioParam(path) {
    if (path === 'amp.gain') return this.ampGain.gain;
    return null;
  }

  toJSON()      { return { params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
