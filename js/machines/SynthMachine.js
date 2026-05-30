/**
 * SynthMachine.js
 * ---------------
 * Digital oscillator synth machine. One main oscillator + sub-oscillator.
 *
 * Oscillators are PERSISTENT (started once, never stopped until machine is
 * disconnected). Amplitude is gated entirely by the track's Envelope ampGain.
 * This means LFOs can connect directly and permanently to any AudioParam:
 *   - _oscMain.detune
 *   - _subGain.gain
 *   - outputGain.gain
 *
 * noteOn just updates frequency and detune. noteOff is a no-op (envelope handles amp).
 *
 * Audio graph:
 *   OscillatorNode (main) ──────────────────────────┐
 *   OscillatorNode (sub) → _subGain (sub level) ────┴→ outputGain → [Filter]
 *
 * Parameters:
 *   'osc.waveform'   — 'sine' | 'sawtooth' | 'square' | 'triangle'
 *   'osc.detune'     — cents, -100 to +100
 *   'sub.level'      — 0.0 to 1.0
 *   'sub.waveform'   — 'sine' | 'sawtooth' | 'square' | 'triangle'
 *   'output.level'   — 0.0 to 1.0
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

export class SynthMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'synth';
    this.label = 'Synth';

    this._params = {
      'osc.waveform':  'sawtooth',
      'osc.detune':    0,
      'sub.level':     0.3,
      'sub.waveform':  'square',
      'output.level':  0.8,
    };

    // Persistent output gain
    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent sub gain — LFO connects here
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];

    // Persistent main oscillator
    this._oscMain = context.createOscillator();
    this._oscMain.type            = this._params['osc.waveform'];
    this._oscMain.frequency.value = 440;
    this._oscMain.detune.value    = this._params['osc.detune'];
    this._oscMain.connect(this.outputGain);
    this._oscMain.start();

    // Persistent sub oscillator
    this._oscSub = context.createOscillator();
    this._oscSub.type            = this._params['sub.waveform'];
    this._oscSub.frequency.value = 220;
    this._oscSub.connect(this._subGain);
    this._subGain.connect(this.outputGain);
    this._oscSub.start();
  }

  /**
   * Update oscillator frequencies at the scheduled time.
   * Amplitude gating is handled by the track Envelope — no gain changes here.
   */
  noteOn(midiNote, velocity, time) {
    const freq = Machine.midiToFreq(midiNote);
    this._oscMain.frequency.setValueAtTime(freq,     time);
    this._oscSub.frequency.setValueAtTime(freq / 2,  time);
  }

  /** Envelope handles amp — nothing to do here. */
  noteOff(time) {}

  connect(destinationNode) {
    this._trimGain.connect(destinationNode);
  }

  disconnect() {
    try { this._oscMain.stop(); } catch (_) {}
    try { this._oscSub.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'osc.waveform':
        this._oscMain.type = value;
        break;
      case 'osc.detune':
        this._oscMain.detune.setTargetAtTime(value, t, 0.005);
        break;
      case 'sub.level':
        this._subGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'sub.waveform':
        this._oscSub.type = value;
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
    }
  }

  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'osc.waveform',  label: 'Waveform',    type: 'enum',   options: ['sine','sawtooth','square','triangle'],                                   plockMode: 'js'        },
      { path: 'osc.detune',    label: 'Detune',       type: 'number', min: -100, max: 100, default: 0,   modulatable: true, lfoMin: -100, lfoMax: 100,   plockMode: 'audioParam', hidden: true },
      { path: 'sub.level',     label: 'Sub Level',    type: 'number', min: 0,    max: 1,   default: 0.3, modulatable: true, lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
      { path: 'sub.waveform',  label: 'Sub Waveform', type: 'enum',   options: ['sine','sawtooth','square','triangle'],                                   plockMode: 'js'        },
      { path: 'output.level',  label: 'Level',        type: 'number', min: 0,    max: 1,   default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'osc.detune':   return this._oscMain.detune;
      case 'sub.level':    return this._subGain.gain;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON() {
    return { type: this.type, params: { ...this._params } };
  }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }
}
