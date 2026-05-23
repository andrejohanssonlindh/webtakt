/**
 * CombMachine.js
 * --------------
 * Resonator / comb filter synthesizer. An exciter signal (white noise or
 * an impulse) is fed continuously through a tuned comb filter (DelayNode +
 * feedback) to produce metallic, bell, or vocal-formant textures.
 *
 * Unlike KarplusMachine (pluck/decay), CombMachine is sustained — the
 * resonator runs as long as the note is held. The track Envelope controls
 * amplitude normally.
 *
 * Two exciter types:
 *   'noise'   — continuous white noise: airy, vocal, wind-instrument character
 *   'impulse' — single-sample impulse at noteOn: bell/metallic ring
 *
 * Persistent node architecture — comb filter runs continuously.
 *
 * Audio graph:
 *   _exciter (noise, persistent) → _exGain → _inputGain ─┐
 *   _impulseSrc (per-note)       → _inputGain             ┤
 *   DelayNode (_comb)            ← FeedbackGain ← _combLP ←┘
 *   _comb → outputGain → [Filter]
 *
 * Parameters:
 *   'freq'         — comb filter resonant frequency Hz (note-tracked + offset)
 *   'feedback'     — feedback amount (0–0.98): brightness and sustain
 *   'damping'      — LP cutoff in feedback (200–20000 Hz): brightness
 *   'exciter'      — 'noise' | 'impulse'
 *   'excite.level' — exciter level (0–1)
 *   'excite.tone'  — LP on exciter noise (200–20000 Hz)
 *   'output.level' — 0–1
 */

import { Machine }        from './Machine.js';
import { getNoiseBuffer } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoise   = ctx => getNoiseBuffer(ctx, _noiseCache, 2.0);

const MIN_DELAY = 0.0005; // ~20 Hz minimum resonant frequency (1/20000 sr buffer)

export class CombMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'comb';
    this.label = 'Comb';

    this._params = {
      'freq':          440,
      'feedback':      0.88,
      'damping':       8000,
      'exciter':       'noise',
      'excite.level':  0.3,
      'excite.tone':   6000,
      'output.level':  0.8,
    };

    this._currentFreq = 440;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // ── Comb filter ──
    this._comb = context.createDelay(2);
    this._comb.delayTime.value = 1 / this._params['freq'];

    this._combLP = context.createBiquadFilter();
    this._combLP.type            = 'lowpass';
    this._combLP.frequency.value = this._params['damping'];
    this._combLP.Q.value         = 0.7071;

    this._fbGain = context.createGain();
    this._fbGain.gain.value = this._params['feedback'];

    // Feedback loop: comb → combLP → fbGain → comb
    this._comb.connect(this._combLP);
    this._combLP.connect(this._fbGain);
    this._fbGain.connect(this._comb);

    // Comb output → master
    this._comb.connect(this.outputGain);

    // ── Noise exciter ──
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = _getNoise(context);
    this._noiseSrc.loop   = true;
    this._noiseSrc.start();

    // Exciter LP filter
    this._exLP = context.createBiquadFilter();
    this._exLP.type            = 'lowpass';
    this._exLP.frequency.value = this._params['excite.tone'];
    this._exLP.Q.value         = 0.7071;
    this._noiseSrc.connect(this._exLP);

    // Exciter level gain
    this._exGain = context.createGain();
    this._exGain.gain.value = this._params['exciter'] === 'noise' ? this._params['excite.level'] : 0;
    this._exLP.connect(this._exGain);
    this._exGain.connect(this._comb);

    // Per-note impulse (for 'impulse' mode)
    this._impulseSrc = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const freq     = Machine.midiToFreq(midiNote);
    this._currentFreq = freq;

    // Update comb delay time for this pitch
    const delayTime = Math.max(MIN_DELAY, 1 / freq);
    this._comb.delayTime.setValueAtTime(delayTime, time);

    const mode = this._params['exciter'];

    if (mode === 'impulse') {
      // Brief noise burst to excite the resonator at this pitch
      const buf   = _getNoise(this.context);
      const impSrc = this.context.createBufferSource();
      impSrc.buffer = buf;
      impSrc.loop   = false;

      const impGain = this.context.createGain();
      impGain.gain.setValueAtTime(this._params['excite.level'] * velScale * 4, time);
      // Very short gate — just needs to knock the resonator
      impGain.gain.exponentialRampToValueAtTime(0.001, time + 0.01);

      impSrc.connect(impGain);
      impGain.connect(this._comb);
      impSrc.start(time);

      const cleanupMs = 100 + Math.max(time - this.context.currentTime, 0) * 1000;
      setTimeout(() => {
        try { impSrc.stop();       } catch (_) {}
        try { impGain.disconnect(); } catch (_) {}
      }, cleanupMs);

      // Silence continuous noise in impulse mode
      this._exGain.gain.setValueAtTime(0, time);
    } else {
      // Noise mode — set exciter level
      this._exGain.gain.setValueAtTime(this._params['excite.level'] * velScale, time);
    }
  }

  noteOff(time) {
    // Fade out exciter on note release; comb resonance decays naturally from feedback
    if (this._params['exciter'] === 'noise') {
      this._exGain.gain.setTargetAtTime(0, time, 0.02);
    }
  }

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    try { this._noiseSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'freq':
        // Update comb delay time (absolute freq override, not note-tracked here)
        this._comb.delayTime.setTargetAtTime(Math.max(MIN_DELAY, 1 / value), t, 0.005);
        break;
      case 'feedback':
        this._fbGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'damping':
        this._combLP.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'excite.level':
        if (this._params['exciter'] === 'noise') {
          this._exGain.gain.setTargetAtTime(value, t, 0.01);
        }
        break;
      case 'excite.tone':
        this._exLP.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'exciter':
        // Switch mode — silence or restore noise exciter
        if (value === 'noise') {
          this._exGain.gain.setTargetAtTime(this._params['excite.level'], t, 0.01);
        } else {
          this._exGain.gain.setTargetAtTime(0, t, 0.01);
        }
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'feedback',     label: 'Feedback',    type: 'number', min: 0,    max: 0.98,  default: 0.88, modulatable: true,  lfoMin: 0,    lfoMax: 0.98,  plockMode: 'audioParam' },
      { path: 'damping',      label: 'Damping',     type: 'number', min: 200,  max: 20000, default: 8000, modulatable: true,  lfoMin: 200,  lfoMax: 20000, plockMode: 'audioParam' },
      { path: 'exciter',      label: 'Exciter',     type: 'enum',   options: ['noise','impulse'],                                                          plockMode: 'js'        },
      { path: 'excite.level', label: 'Excite Lvl',  type: 'number', min: 0,    max: 1,     default: 0.3,  modulatable: true,  lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
      { path: 'excite.tone',  label: 'Excite Tone', type: 'number', min: 200,  max: 20000, default: 6000, modulatable: true,  lfoMin: 200,  lfoMax: 20000, plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',       type: 'number', min: 0,    max: 1,     default: 0.8,  modulatable: true,  lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'feedback':     return this._fbGain.gain;
      case 'damping':      return this._combLP.frequency;
      case 'excite.level': return this._exGain.gain;
      case 'excite.tone':  return this._exLP.frequency;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
