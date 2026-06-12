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
    };

    this.ampGain = context.createGain();
    this.ampGain.gain.value = 0;

    this._filter = null;
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
  _scheduleADS(param, time, a, d, peakVal, sustainVal) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
    }
    param.setValueAtTime(param.value, time);
    param.linearRampToValueAtTime(peakVal,    time + a);
    param.linearRampToValueAtTime(sustainVal, time + a + d);
  }

  /**
   * Schedule release ramp on `param` starting at `offTime`.
   * `endVal` — value to ramp toward (0 for amp, baseCutoff for filter).
   */
  _scheduleR(param, offTime, sustainVal, r, endVal) {
    param.setValueAtTime(sustainVal, offTime);
    param.linearRampToValueAtTime(endVal, offTime + r);
  }

  // ── Sequencer scheduling ────────────────────────────────────────────────

  /**
   * Schedule a complete note from the sequencer.
   * Queues A→D→S starting at `time`, then R starting at `offTime`.
   * Does NOT cancel prior scheduled events — the previous note's release
   * tail runs until `time` when the new attack overwrites it.
   */
  scheduleNote(time, offTime, overrides = {}) {
    // ── Amp envelope ── (timed stages resolve sync mode → seconds)
    const a = this._stageSeconds('env', 'attack',  overrides);
    const d = this._stageSeconds('env', 'decay',   overrides);
    const s = overrides['env.sustain'] ?? this._params['env.sustain'];
    const r = this._stageSeconds('env', 'release', overrides);

    const g = this.ampGain.gain;
    this._scheduleADS(g, time, a, d, 1.0, s);
    this._scheduleR(g, offTime, s, r, 0);

    // ── Filter envelope ──
    if (this._filter) {
      const fa = this._stageSeconds('fenv', 'attack',  overrides);
      const fd = this._stageSeconds('fenv', 'decay',   overrides);
      const fs = overrides['fenv.sustain'] ?? this._params['fenv.sustain'];
      const fr = this._stageSeconds('fenv', 'release', overrides);

      const envAmt    = overrides['filter.envAmount'] ?? this._filter.getParam('filter.envAmount');
      // baseCut: the cutoff the envelope sweep is anchored from (may be p-locked).
      // trueCut: the cutoff the filter rests at once the note's release ends.
      const persistentCut = this._filter.getParam('filter.cutoff');
      const baseCut = overrides['filter.cutoff'] ?? persistentCut;
      // When the cutoff is p-locked, the release tail must stay at the p-locked
      // value too — otherwise the filter springs back to the persistent cutoff at
      // note-off while the amp is still ringing, and you hear an unfiltered tail
      // ("dark plop, then the note"). The persistent param is untouched, so the
      // NEXT (non-p-locked) note sweeps from/to the real baseline correctly.
      const trueCut = overrides['filter.cutoff'] ?? persistentCut;

      // Positive envAmt sweeps toward 20000 Hz, negative toward 20 Hz.
      // 100% always reaches the limit of the range from the current cutoff position.
      const headroom   = envAmt >= 0 ? (20000 - baseCut) : (baseCut - 20);
      const modDepth   = headroom * envAmt;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      // Schedule across primary node + all slope stages via Filter.scheduleFrequency
      this._filter.scheduleFrequency(time, fa, fd, peakCut, sustainCut, offTime, fr, trueCut, baseCut);
    }
  }

  // ── Live keyboard ───────────────────────────────────────────────────────

  /**
   * Live noteOn (keyboard). Cancels any prior events and restarts.
   */
  noteOn(time) {
    // Amp
    const a = this._stageSeconds('env', 'attack');
    const d = this._stageSeconds('env', 'decay');
    const s = this._params['env.sustain'];

    const g = this.ampGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(1.0, time + a);
    g.linearRampToValueAtTime(s,   time + a + d);

    // Filter
    if (this._filter) {
      const fa = this._stageSeconds('fenv', 'attack');
      const fd = this._stageSeconds('fenv', 'decay');
      const fs = this._params['fenv.sustain'];

      const envAmt  = this._filter.getParam('filter.envAmount');
      const baseCut = this._filter.getParam('filter.cutoff');
      const headroom   = envAmt >= 0 ? (20000 - baseCut) : (baseCut - 20);
      const modDepth   = headroom * envAmt;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      const freq = this._filter.cutoffParam();
      freq.cancelScheduledValues(time);
      freq.setValueAtTime(baseCut, time);
      freq.linearRampToValueAtTime(peakCut,    time + fa);
      freq.linearRampToValueAtTime(sustainCut, time + fa + fd);
    }
  }

  /**
   * Live noteOff (keyboard).
   */
  noteOff(time) {
    const r = this._stageSeconds('env', 'release');
    const g = this.ampGain.gain;

    if (typeof g.cancelAndHoldAtTime === 'function') {
      g.cancelAndHoldAtTime(time);
    } else {
      g.cancelScheduledValues(time);
    }
    g.setValueAtTime(g.value, time);   // anchor so the release ramps from `time` (see _scheduleADS)
    g.linearRampToValueAtTime(0, time + r);

    if (this._filter) {
      const fr      = this._stageSeconds('fenv', 'release');
      const baseCut = this._filter.getParam('filter.cutoff');
      const freq    = this._filter.cutoffParam();

      if (typeof freq.cancelAndHoldAtTime === 'function') {
        freq.cancelAndHoldAtTime(time);
      } else {
        freq.cancelScheduledValues(time);
      }
      freq.setValueAtTime(freq.value, time);
      freq.linearRampToValueAtTime(baseCut, time + fr);
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
