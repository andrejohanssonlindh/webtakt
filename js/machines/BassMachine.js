/**
 * BassMachine.js
 * --------------
 * Dedicated bass voice inspired by TB-303 and analogue bassline machines.
 * Features a main oscillator (saw/square) with a sub sine underneath,
 * hard-clip saturation for distortion, and built-in portamento (glide)
 * between notes.
 *
 * Unlike SynthMachine, BassMachine has:
 *   - Built-in portamento/glide (slides between notes on consecutive triggers)
 *   - Accent: velocity above a threshold boosts the output level on that step
 *   - Hard clip waveshaper distortion (drive param)
 *   - Sub oscillator always sine, two octaves below (bassline character)
 *
 * Persistent oscillator architecture — amplitude gated by track Envelope.
 *
 * Audio graph:
 *   _oscMain  → _mainGain ─┐
 *   _oscSub   → _subGain  ─┴→ _distortion (WaveShaperNode) → outputGain → [Filter]
 *
 * Parameters:
 *   'osc.detune'   — coarse detune in cents (-100 to +100), hidden (trig tab)
 *   'waveform'     — 'sawtooth' | 'square'
 *   'sub.level'    — sub oscillator level (0–1)
 *   'drive'        — distortion drive amount (0–1, 0 = clean, 1 = full clip)
 *   'glide'        — portamento time in ms (0–500)
 *   'accent'       — accent velocity threshold (0–127): notes at or above get +6dB boost
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

function _buildClipCurve(drive) {
  const CURVE_LEN = 512;
  const curve     = new Float32Array(CURVE_LEN);
  const gain      = 1 + drive * 15; // 1× (clean) to 16× (heavy clip)
  for (let i = 0; i < CURVE_LEN; i++) {
    const x       = (i / (CURVE_LEN - 1)) * 2 - 1;
    const driven  = x * gain;
    // Soft clip with tanh, approach hard clip at high drive
    const clip    = Math.tanh(driven * (1 + drive * 4));
    curve[i]      = Math.max(-1, Math.min(1, clip));
  }
  return curve;
}

export class BassMachine extends Machine {
  static SPEC = {
    'osc.detune':   { label: 'Detune', type: 'number', min: -100, max: 100, default: 0,
                      modulatable: true, lfoMin: -100, lfoMax: 100, hidden: true,
                      target: m => m._oscMain.detune, schedule: 'setTarget', tc: 0.005 },
    'waveform':     { label: 'Waveform', type: 'enum', options: ['sawtooth','square'], plockMode: 'js',
                      apply: (v, t, m) => { m._oscMain.type = v; } },
    'sub.level':    { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.4,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'drive':        { label: 'Drive', type: 'number', min: 0, max: 1, default: 0.0, plockMode: 'js',
                      apply: (v, t, m) => { m._distortion.curve = _buildClipCurve(v); } },
    'glide':        { label: 'Glide', type: 'number', min: 0, max: 500, default: 0, plockMode: 'js' },
    'accent':       { label: 'Accent', type: 'number', min: 0, max: 127, default: 100, plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'bass';
    this.label = 'Bass';

    this._initSpec();

    this._lastFreq = 440; // for glide: freq of previous note

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Distortion waveshaper — persistent
    this._distortion            = context.createWaveShaper();
    this._distortion.curve      = _buildClipCurve(0);
    this._distortion.oversample = '4x';
    this._distortion.connect(this.outputGain);

    // Main oscillator
    this._mainGain = context.createGain();
    this._mainGain.gain.value = 0.8;
    this._mainGain.connect(this._distortion);

    this._oscMain = context.createOscillator();
    this._oscMain.type            = this._params['waveform'];
    this._oscMain.frequency.value = 440;
    this._oscMain.detune.value    = this._params['osc.detune'];
    this._oscMain.connect(this._mainGain);
    this._oscMain.start();

    // Sub oscillator — sine, 2 octaves below
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this._distortion);

    this._oscSub = context.createOscillator();
    this._oscSub.type            = 'sine';
    this._oscSub.frequency.value = 110;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();
  }

  noteOn(midiNote, velocity, time) {
    const freq       = Machine.midiToFreq(midiNote);
    const glideMs    = this._params['glide'];
    const glideTime  = glideMs / 1000;

    if (glideTime > 0.001) {
      // Portamento — ramp from last frequency
      this._oscMain.frequency.setValueAtTime(this._lastFreq, time);
      this._oscMain.frequency.exponentialRampToValueAtTime(freq, time + glideTime);
      this._oscSub.frequency.setValueAtTime(this._lastFreq / 4, time);
      this._oscSub.frequency.exponentialRampToValueAtTime(freq / 4, time + glideTime);
    } else {
      this._oscMain.frequency.setValueAtTime(freq,     time);
      this._oscSub.frequency.setValueAtTime(freq / 4,  time);
    }

    this._lastFreq = freq;

    // Accent: velocity at or above threshold boosts output +6dB on this step
    const accentThresh = this._params['accent'];
    if (velocity >= accentThresh) {
      const baseLevel = this._params['output.level'];
      this.outputGain.gain.setValueAtTime(Math.min(1, baseLevel * 1.5), time);
      // Restore after a short time so the accent doesn't persist into the release tail
      this.outputGain.gain.setTargetAtTime(baseLevel, time + 0.05, 0.02);
    }
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._oscMain.stop(); } catch (_) {}
    try { this._oscSub.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
