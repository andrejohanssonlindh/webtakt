/**
 * Filter.js
 * ---------
 * Per-track filter wrapping a Web Audio BiquadFilterNode.
 * Sits between the machine output and the amplitude envelope gain node.
 *
 * Filter cutoff can be modulated by:
 *   - The amplitude envelope (via envAmount)
 *   - LFOs (connected directly to filter.frequency AudioParam)
 *   - Mod wheels (same mechanism as LFOs)
 *   - P-locks (via setParam at step fire time)
 *
 * Owns:    BiquadFilterNode
 * Depends: nothing (uses Web Audio API directly)
 * Used by: Track.js (connects machine → filter → envelope)
 *          Envelope.js (drives cutoff via envAmount)
 *          LFO.js (connects to filter.frequency AudioParam)
 *
 * Public:
 *   .node             — the BiquadFilterNode (expose for LFO connection)
 *   connect(dest)     — connect filter output to next node
 *   disconnect()
 *   setParam(path, value, time)
 *   getParam(path)
 *   getParamList()
 *
 * Parameters:
 *   'filter.type'       — 'lowpass' | 'highpass' | 'bandpass'
 *   'filter.cutoff'     — Hz, 20–20000
 *   'filter.resonance'  — Q, 0.1–20
 *   'filter.envAmount'  — -1.0 to 1.0 (scales envelope's cutoff modulation)
 *   'base.lpf'          — Hz, 20–20000 (base lowpass, no resonance, default 20000)
 *   'base.hpf'          — Hz, 20–20000 (base highpass, no resonance, default 20)
 */

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
      'base.lpf':         20000,
      'base.hpf':         20,
    };

    // Main filter node
    this.node = context.createBiquadFilter();
    this.node.type            = this._params['filter.type'];
    this.node.frequency.value = this._params['filter.cutoff'];
    this.node.Q.value         = this._params['filter.resonance'];
    this.node.gain.value      = this._params['filter.gain'];

    // Base filter nodes — no resonance (Butterworth Q = 0.7071)
    this._baseLPF = context.createBiquadFilter();
    this._baseLPF.type            = 'lowpass';
    this._baseLPF.frequency.value = this._params['base.lpf'];
    this._baseLPF.Q.value         = 0.7071;

    this._baseHPF = context.createBiquadFilter();
    this._baseHPF.type            = 'highpass';
    this._baseHPF.frequency.value = this._params['base.hpf'];
    this._baseHPF.Q.value         = 0.7071;

    // Signal chain: baseHPF → baseLPF → main node
    this._baseHPF.connect(this._baseLPF);
    this._baseLPF.connect(this.node);
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    // Input enters at baseHPF; main node output goes to destination
    this.node.connect(destinationNode);
  }

  /** Connect an incoming node to the filter input (base HPF entry point) */
  connectInput(sourceNode) {
    sourceNode.connect(this._baseHPF);
  }

  disconnect() {
    this.node.disconnect();
  }

  /** @param {string} path @param {number|string} value @param {number} [time] */
  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'filter.type':
        this.node.type = value;
        break;
      case 'filter.cutoff':
        this.node.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.resonance':
        this.node.Q.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.gain':
        this.node.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.envAmount':
        // envAmount is read by Envelope.js when it applies its modulation
        break;
      case 'base.lpf':
        this._baseLPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'base.hpf':
        this._baseHPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
    }
  }

  /** @param {string} path */
  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'filter.type',      label: 'Type',      type: 'enum',   options: ['lowpass','highpass','bandpass','notch','peaking','allpass'], plockMode: 'js'        },
      { path: 'filter.cutoff',    label: 'Cutoff',    type: 'number', min: 20,  max: 20000, default: 8000, modulatable: true, lfoMin: 20,  lfoMax: 20000, plockMode: 'envelope'  },
      { path: 'filter.resonance', label: 'Resonance', type: 'number', min: 0.1, max: 20,    default: 1.0,  modulatable: true, lfoMin: 0.1, lfoMax: 20,    plockMode: 'filter'    },
      { path: 'filter.gain',      label: 'Gain',      type: 'number', min: -30, max: 30,    default: 0,    modulatable: true, lfoMin: -30, lfoMax: 30,    plockMode: 'filter'    },
      { path: 'filter.envAmount', label: 'Env Amt',   type: 'number', min: -1,  max: 1,     default: 0.3,                                                  plockMode: 'envelope'  },
      { path: 'base.lpf',         label: 'Base LPF',  type: 'number', min: 200, max: 20000, default: 20000, modulatable: true, lfoMin: 200, lfoMax: 20000, plockMode: 'filter'    },
      { path: 'base.hpf',         label: 'Base HPF',  type: 'number', min: 20,  max: 8000,  default: 20,    modulatable: true, lfoMin: 20,  lfoMax: 8000,  plockMode: 'filter'    },
    ];
  }

  /**
   * Resolve a parameter path to a live AudioParam for LFO/mod-wheel connection.
   * @param {string} path
   * @returns {AudioParam|null}
   */
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

  /** @param {object} obj */
  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }
}
