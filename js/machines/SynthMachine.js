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
  // Declarative param spec — see Machine._initSpec/setParam/getParamList.
  static SPEC = {
    'osc.waveform': { label: 'Waveform', type: 'enum', options: ['sine','sawtooth','square','triangle'],
                      default: 'sawtooth', group: 'OSC', plockMode: 'js', apply: (v, t, m) => { m._oscMain.type = v; } },
    'osc.detune':   { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                      modulatable: true, lfoMin: -100, lfoMax: 100,
                      target: m => m._oscMain.detune, schedule: 'setTarget', tc: 0.005 },
    'sub.level':    { label: 'Sub Level', type: 'number', min: 0, max: 1, default: 0.3, group: 'SUB',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'sub.waveform': { label: 'Sub Waveform', type: 'enum', options: ['sine','sawtooth','square','triangle'],
                      default: 'square', group: 'SUB', plockMode: 'js', apply: (v, t, m) => { m._oscSub.type = v; } },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'synth';
    this.label = 'Synth';

    this._initSpec();

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
    // Cancel any frequency events scheduled at/after `time` before retuning. The
    // oscillators are persistent and shared across notes on this slot; LiveArp
    // schedules a whole cycle ahead in one burst, so a slot reused for the next
    // chord could still carry stale future setValueAtTime events from the PREVIOUS
    // held chord (e.g. an octave-7 note queued later than this octave-3 note's
    // time). Without cancelling, the osc would hop back to the old pitch when that
    // stale event fires — heard as the previous octave bleeding into the first
    // notes of the new arp. cancelScheduledValues(time) drops only events ≥ time,
    // leaving any still-valid earlier note untouched.
    this._oscMain.frequency.cancelScheduledValues(time);
    this._oscMain.frequency.setValueAtTime(freq,     time);
    this._oscSub.frequency.cancelScheduledValues(time);
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

  // setParam / getParam / getParamList / resolveAudioParam / toJSON / fromJSON
  // are all derived from `static SPEC` by the Machine base class.
}
