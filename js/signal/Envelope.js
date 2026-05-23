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
 * Filter modulation fix: we drive filter.node.frequency AudioParam directly
 * with scheduled ramps rather than via a GainNode (which had no input and
 * therefore always produced silence regardless of its gain value).
 */

export class Envelope {
  constructor(context) {
    this.context = context;

    this._params = {
      'env.attack':   0.01,
      'env.decay':    0.1,
      'env.sustain':  0.7,
      'env.release':  0.3,
      'fenv.attack':  0.01,
      'fenv.decay':   0.2,
      'fenv.sustain': 0.0,
      'fenv.release': 0.3,
    };

    this.ampGain = context.createGain();
    this.ampGain.gain.value = 0;

    this._filter = null;
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
   */
  _scheduleADS(param, time, a, d, peakVal, sustainVal) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(param.value, time);
    }
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
    // ── Amp envelope ──
    const a = overrides['env.attack']  ?? this._params['env.attack'];
    const d = overrides['env.decay']   ?? this._params['env.decay'];
    const s = overrides['env.sustain'] ?? this._params['env.sustain'];
    const r = overrides['env.release'] ?? this._params['env.release'];

    const g = this.ampGain.gain;
    this._scheduleADS(g, time, a, d, 1.0, s);
    this._scheduleR(g, offTime, s, r, 0);

    // ── Filter envelope ──
    if (this._filter) {
      const fa = overrides['fenv.attack']  ?? this._params['fenv.attack'];
      const fd = overrides['fenv.decay']   ?? this._params['fenv.decay'];
      const fs = overrides['fenv.sustain'] ?? this._params['fenv.sustain'];
      const fr = overrides['fenv.release'] ?? this._params['fenv.release'];

      const envAmt    = overrides['filter.envAmount'] ?? this._filter.getParam('filter.envAmount');
      // trueCut: the persistent cutoff that the filter returns to after the note.
      // baseCut: the cutoff from which the envelope sweep is anchored (may be p-locked).
      const trueCut = this._filter.getParam('filter.cutoff');
      const baseCut = overrides['filter.cutoff'] ?? trueCut;

      // modDepth: how many Hz above (or below) baseCut the peak reaches.
      // Positive envAmt opens the filter; negative closes it.
      const modDepth   = baseCut * envAmt;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      const freq = this._filter.node.frequency;
      this._scheduleADS(freq, time, fa, fd, peakCut, sustainCut);
      // Release ramps back to the true (non-p-locked) cutoff so subsequent steps
      // are not affected by this step's p-locked cutoff.
      this._scheduleR(freq, offTime, sustainCut, fr, trueCut);
    }
  }

  // ── Live keyboard ───────────────────────────────────────────────────────

  /**
   * Live noteOn (keyboard). Cancels any prior events and restarts.
   */
  noteOn(time) {
    // Amp
    const a = this._params['env.attack'];
    const d = this._params['env.decay'];
    const s = this._params['env.sustain'];

    const g = this.ampGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(1.0, time + a);
    g.linearRampToValueAtTime(s,   time + a + d);

    // Filter
    if (this._filter) {
      const fa = this._params['fenv.attack'];
      const fd = this._params['fenv.decay'];
      const fs = this._params['fenv.sustain'];

      const envAmt  = this._filter.getParam('filter.envAmount');
      const baseCut = this._filter.getParam('filter.cutoff');
      const modDepth  = baseCut * envAmt;
      const peakCut    = baseCut + modDepth;
      const sustainCut = baseCut + modDepth * fs;

      const freq = this._filter.node.frequency;
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
    const r = this._params['env.release'];
    const g = this.ampGain.gain;

    if (typeof g.cancelAndHoldAtTime === 'function') {
      g.cancelAndHoldAtTime(time);
    } else {
      g.cancelScheduledValues(time);
      g.setValueAtTime(g.value, time);
    }
    g.linearRampToValueAtTime(0, time + r);

    if (this._filter) {
      const fr      = this._params['fenv.release'];
      const baseCut = this._filter.getParam('filter.cutoff');
      const freq    = this._filter.node.frequency;

      if (typeof freq.cancelAndHoldAtTime === 'function') {
        freq.cancelAndHoldAtTime(time);
      } else {
        freq.cancelScheduledValues(time);
        freq.setValueAtTime(freq.value, time);
      }
      freq.linearRampToValueAtTime(baseCut, time + fr);
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
