/**
 * Filter.js
 * ---------
 * Per-track filter wrapping up to 4 cascaded BiquadFilterNodes for the main filter,
 * plus base HPF + base LPF nodes before them.
 *
 * `filter.slope` (0–1) controls how many extra poles are active:
 *   0   → 1 pole  (12 dB/oct)  — only the primary node
 *   0.33 → 2 poles (24 dB/oct)
 *   0.66 → 3 poles (36 dB/oct)
 *   1   → 4 poles  (48 dB/oct)
 * Intermediate values blend continuously via per-stage dry/wet GainNodes.
 *
 * All extra stages track the same type/cutoff/Q/gain as node.
 * LFO and envelope modulation connect only to node.frequency — the extra stages
 * are matched via setParam calls.
 *
 * Signal chain:
 *   [input] → _baseHPF → _baseLPF → node → _extra[0..2] (wet-blended) → [output]
 *
 * Public:
 *   .node             — primary BiquadFilterNode (for LFO/env connections)
 *   connect(dest)     — connect filter output to next node
 *   disconnect()
 *   setParam(path, value, time)
 *   getParam(path)
 *   getParamList()
 *
 * Parameters:
 *   'filter.type'       — 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'allpass'
 *   'filter.cutoff'     — Hz, 20–20000
 *   'filter.resonance'  — Q, 0.1–20
 *   'filter.gain'       — dB, -30–+30 (peaking only)
 *   'filter.envAmount'  — -1.0 to 1.0
 *   'filter.slope'      — 0–1 (continuous pole count, default 0 = 1 pole / 12dB/oct)
 *   'base.lpf'          — Hz, 200–20000 (base lowpass, no resonance, default 20000)
 *   'base.hpf'          — Hz, 20–8000  (base highpass, no resonance, default 20)
 */

const EXTRA_STAGES = 7; // 7 extra → 8 poles max (96 dB/oct)

export class Filter {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'filter.type':      'lowpass',
      'filter.cutoff':    8000,
      'filter.resonance': 1.0,
      'filter.gain':      0,
      'filter.envAmount': 0.3,
      'filter.slope':     0,
      'base.lpf':         20000,
      'base.hpf':         20,
    };

    // Primary filter node — LFO + env connect here
    this.node = context.createBiquadFilter();
    this.node.type            = this._params['filter.type'];
    this.node.frequency.value = this._params['filter.cutoff'];
    this.node.Q.value         = this._params['filter.resonance'];
    this.node.gain.value      = this._params['filter.gain'];

    // Base filter nodes — fixed Q, no resonance
    this._baseLPF = context.createBiquadFilter();
    this._baseLPF.type            = 'lowpass';
    this._baseLPF.frequency.value = this._params['base.lpf'];
    this._baseLPF.Q.value         = 0.7071;

    this._baseHPF = context.createBiquadFilter();
    this._baseHPF.type            = 'highpass';
    this._baseHPF.frequency.value = this._params['base.hpf'];
    this._baseHPF.Q.value         = 0.7071;

    // Extra slope stages — each is a dry/wet blend
    // dry path: passthrough GainNode (gain = 1 - wetGain)
    // wet path: BiquadFilterNode → wetGainNode
    // both sum into next stage's input
    this._stages = [];
    for (let i = 0; i < EXTRA_STAGES; i++) {
      const biquad  = context.createBiquadFilter();
      biquad.type            = this._params['filter.type'];
      biquad.frequency.value = this._params['filter.cutoff'];
      biquad.Q.value         = this._params['filter.resonance'];
      biquad.gain.value      = this._params['filter.gain'];

      const dryGain = context.createGain();
      dryGain.gain.value = 1;

      const wetGain = context.createGain();
      wetGain.gain.value = 0;

      // sumNode receives dry + wet, feeds into next stage or output
      const sumNode = context.createGain();
      sumNode.gain.value = 1;

      this._stages.push({ biquad, dryGain, wetGain, sumNode });
    }

    // Output node — final connection point
    this._outputGain = context.createGain();
    this._outputGain.gain.value = 1;

    // Sibling filters (other voice slots) that mirror this one's params.
    // The canonical slot-0 filter is the only one the UI/sequencer writes to;
    // it fans every setParam out to its mirrors so all voices stay identical.
    this._mirrors = [];

    // Wire signal chain
    // base: _baseHPF → _baseLPF → node
    this._baseHPF.connect(this._baseLPF);
    this._baseLPF.connect(this.node);

    // node → stage[0] → stage[1] → stage[2] → _outputGain
    let prev = this.node;
    for (const { biquad, dryGain, wetGain, sumNode } of this._stages) {
      // dry path: prev → dryGain → sumNode
      prev.connect(dryGain);
      dryGain.connect(sumNode);
      // wet path: prev → biquad → wetGain → sumNode
      prev.connect(biquad);
      biquad.connect(wetGain);
      wetGain.connect(sumNode);
      prev = sumNode;
    }
    prev.connect(this._outputGain);
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    this._outputGain.connect(destinationNode);
  }

  /** Connect an incoming node to the filter input (base HPF entry point) */
  connectInput(sourceNode) {
    sourceNode.connect(this._baseHPF);
  }

  disconnect() {
    this._outputGain.disconnect();
  }

  /**
   * Register a sibling filter that should mirror every param change made here.
   * Used by VoicePool so all voice-slot filters track the canonical slot-0 filter.
   * @param {Filter} filter
   */
  mirrorTo(filter) {
    if (filter && filter !== this) this._mirrors.push(filter);
  }

  /** @param {string} path @param {number|string} value @param {number} [time] */
  setParam(path, value, time) {
    // Fan out to mirror filters (other voice slots) so all voices stay identical.
    for (const m of this._mirrors) m.setParam(path, value, time);

    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'filter.type':
        this.node.type = value;
        for (const { biquad } of this._stages) biquad.type = value;
        break;
      case 'filter.cutoff':
        this.node.frequency.setTargetAtTime(value, t, 0.005);
        for (const { biquad } of this._stages) biquad.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.resonance':
        this.node.Q.setTargetAtTime(value, t, 0.005);
        for (const { biquad } of this._stages) biquad.Q.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.gain':
        this.node.gain.setTargetAtTime(value, t, 0.005);
        for (const { biquad } of this._stages) biquad.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.envAmount':
        break;
      case 'filter.slope':
        this._applySlope(value, t);
        break;
      case 'base.lpf':
        this._baseLPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'base.hpf':
        this._baseHPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
    }
  }

  /**
   * Slope 0–1 maps to 1–4 active poles continuously.
   * Stage i (0-indexed) becomes fully wet when slope >= (i+1)/EXTRA_STAGES.
   * It ramps in over the preceding 1/EXTRA_STAGES range.
   */
  _applySlope(slope, t) {
    const tc = 0.008;
    for (let i = 0; i < EXTRA_STAGES; i++) {
      const { dryGain, wetGain } = this._stages[i];
      // Stage i activates in the range [i/N, (i+1)/N] where N = EXTRA_STAGES
      const lo = i / EXTRA_STAGES;
      const hi = (i + 1) / EXTRA_STAGES;
      const wet = Math.max(0, Math.min(1, (slope - lo) / (hi - lo)));
      wetGain.gain.setTargetAtTime(wet, t, tc);
      dryGain.gain.setTargetAtTime(1 - wet, t, tc);
    }
  }

  /** @param {string} path */
  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'filter.type',      label: 'Type',      type: 'enum',   options: ['lowpass','highpass','bandpass','notch','peaking','allpass'], plockMode: 'js'        },
      { path: 'filter.cutoff',    label: 'Cutoff',    type: 'number', min: 20,  max: 20000, default: 8000,  modulatable: true, lfoMin: 20,   lfoMax: 20000, plockMode: 'envelope' },
      { path: 'filter.resonance', label: 'Resonance', type: 'number', min: 0.1, max: 20,    default: 1.0,   modulatable: true, lfoMin: 0.1,  lfoMax: 20,    plockMode: 'filter'   },
      { path: 'filter.gain',      label: 'Gain',      type: 'number', min: -30, max: 30,    default: 0,     modulatable: true, lfoMin: -30,  lfoMax: 30,    plockMode: 'filter'   },
      { path: 'filter.envAmount', label: 'Env Amt',   type: 'number', min: -1,  max: 1,     default: 0.3,                                                   plockMode: 'envelope' },
      { path: 'filter.slope',     label: 'Slope',     type: 'number', min: 0,   max: 1,     default: 0,     modulatable: true, lfoMin: 0,    lfoMax: 1,     plockMode: 'filter'   },
      { path: 'base.lpf',         label: 'Base LPF',  type: 'number', min: 200, max: 20000, default: 20000, modulatable: true, lfoMin: 200,  lfoMax: 20000, plockMode: 'filter'   },
      { path: 'base.hpf',         label: 'Base HPF',  type: 'number', min: 20,  max: 8000,  default: 20,    modulatable: true, lfoMin: 20,   lfoMax: 8000,  plockMode: 'filter'   },
    ];
  }

  /**
   * Schedule a complete filter-envelope sweep across all filter nodes (primary + slope stages).
   * Called by Envelope.scheduleNote so that slope stages track the envelope identically.
   *
   * @param {number} time       — note-on time
   * @param {number} a          — fenv attack
   * @param {number} d          — fenv decay
   * @param {number} peakCut    — Hz at peak of envelope
   * @param {number} sustainCut — Hz at sustain
   * @param {number} offTime    — note-off time (start of release)
   * @param {number} fr         — fenv release
   * @param {number} trueCut    — Hz to restore to after release
   */
  scheduleFrequency(time, a, d, peakCut, sustainCut, offTime, fr, trueCut) {
    const nodes = [this.node, ...this._stages.map(s => s.biquad)];
    for (const n of nodes) {
      const freq = n.frequency;
      if (typeof freq.cancelAndHoldAtTime === 'function') {
        freq.cancelAndHoldAtTime(time);
      } else {
        freq.cancelScheduledValues(time);
        freq.setValueAtTime(freq.value, time);
      }
      freq.linearRampToValueAtTime(peakCut,    time + a);
      freq.linearRampToValueAtTime(sustainCut, time + a + d);
      freq.setValueAtTime(sustainCut, offTime);
      freq.linearRampToValueAtTime(trueCut, offTime + fr);
    }
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'filter.cutoff':    return this.node.frequency;
      case 'filter.resonance': return this.node.Q;
      case 'base.lpf':         return this._baseLPF.frequency;
      case 'base.hpf':         return this._baseHPF.frequency;
      default: return null;
    }
  }

  toJSON() {
    return { params: { ...this._params } };
  }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }
}
