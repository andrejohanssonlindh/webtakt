/**
 * NoiseMachine.js
 * ---------------
 * Noise synthesizer. Shaped white noise with two independent resonant bandpass
 * filters (color + body), a variable noise character control, and a bitcrush
 * effect that adds digital grit.
 *
 * All parameters are LFO-assignable and p-lockable. Self-enveloping (manages
 * its own amp decay per hit) so it works well as a drum voice, but also
 * sounds good through the track envelope for textural pads.
 *
 * Persistent node architecture (follows SnareMachine pattern):
 *   _noiseSrc → _colorBP → _colorGain ─┐
 *                                       ├→ _mixGain → _ampGain (per-note) → _crusher → outputGain
 *   _noiseSrc → _bodyBP  → _bodyGain  ─┘
 *
 * _ampGain is the per-note envelope; it gates the signal so noise is silent
 * between hits. _crusher is persistent (post-gate so the waveshaper shapes
 * the decaying signal correctly).
 *
 * Noise character ('color' param) controls Q of both bandpass filters:
 *   0 = low Q (wider, more white)
 *   1 = high Q (narrow, resonant peaks)
 *
 * Bitcrush is a WaveShaperNode with a step-quantise curve. At 0 = bypass.
 *
 * Parameters:
 *   'color'         — noise color / resonance character (0–1)
 *   'color.freq'    — color bandpass center Hz (200–8000)
 *   'body.freq'     — body bandpass center Hz (80–2000)
 *   'body.level'    — body mix level (0–1)
 *   'crush'         — bitcrush depth (0–1)
 *   'decay'         — amp decay time in seconds (0.01–4.0)
 *   'output.level'  — 0–1
 */

import { Machine }         from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 2.0);

function _buildCrusherCurve(amount) {
  const CURVE_LEN = 256;
  const curve     = new Float32Array(CURVE_LEN);
  if (amount < 0.01) {
    for (let i = 0; i < CURVE_LEN; i++) curve[i] = (i / (CURVE_LEN - 1)) * 2 - 1;
    return curve;
  }
  const steps = Math.max(2, Math.round((1 - amount) * 64 + 2));
  for (let i = 0; i < CURVE_LEN; i++) {
    const x       = (i / (CURVE_LEN - 1)) * 2 - 1;
    const stepped = Math.round(x * steps) / steps;
    curve[i]      = Math.max(-1, Math.min(1, stepped));
  }
  return curve;
}

export class NoiseMachine extends Machine {
  // 'color' is modulatable but JS-only (no AudioParam): it sets Q on both
  // bandpass filters via apply. 'crush' rebuilds the waveshaper curve.
  static SPEC = {
    'color':        { label: 'Color', type: 'number', min: 0, max: 1, default: 0.3, group: 'COLOR',
                      modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                      apply: (v, t, m) => {
                        m._colorBP.Q.setTargetAtTime(m._colorQ(), t, 0.01);
                        m._bodyBP.Q.setTargetAtTime(m._bodyQ(), t, 0.01);
                      } },
    'color.freq':   { label: 'Color Freq', type: 'number', min: 200, max: 8000, default: 2000, group: 'COLOR',
                      modulatable: true, lfoMin: 200, lfoMax: 8000,
                      target: m => m._colorBP.frequency, schedule: 'setTarget', tc: 0.01 },
    'body.freq':    { label: 'Body Freq', type: 'number', min: 80, max: 2000, default: 400, group: 'BODY',
                      modulatable: true, lfoMin: 80, lfoMax: 2000,
                      target: m => m._bodyBP.frequency, schedule: 'setTarget', tc: 0.01 },
    'body.level':   { label: 'Body', type: 'number', min: 0, max: 1, default: 0.5, group: 'BODY',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._bodyGain.gain, schedule: 'setTarget', tc: 0.01 },
    'crush':        { label: 'Crush', type: 'number', min: 0, max: 1, default: 0.0, group: 'SHAPE', plockMode: 'js',
                      apply: (v, t, m) => { m._crusher.curve = _buildCrusherCurve(v); } },
    'decay':        { label: 'Decay', type: 'number', min: 0.01, max: 4.0, default: 0.25, group: 'SHAPE', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'noise';
    this.label = 'Noise';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Bitcrush waveshaper — persistent, sits after per-note amp gate
    this._crusher            = context.createWaveShaper();
    this._crusher.curve      = _buildCrusherCurve(0);
    this._crusher.oversample = '2x';
    this._crusher.connect(this.outputGain);

    // Mix gain collects filtered branches; per-note amp gates it
    this._mixGain       = context.createGain();
    this._mixGain.gain.value = 1.0;
    // NOTE: _mixGain does NOT connect anywhere permanently; it connects to
    // per-note _ampGain each hit (and _ampGain → _crusher → outputGain).

    // Persistent noise source (looping)
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = _getNoiseBuffer(context);
    this._noiseSrc.loop   = true;
    this._noiseSrc.start();

    // Color bandpass — LFO → frequency
    this._colorBP              = context.createBiquadFilter();
    this._colorBP.type         = 'bandpass';
    this._colorBP.frequency.value = this._params['color.freq'];
    this._colorBP.Q.value      = this._colorQ();
    this._noiseSrc.connect(this._colorBP);

    this._colorGain            = context.createGain();
    this._colorGain.gain.value = 1.0;
    this._colorBP.connect(this._colorGain);
    this._colorGain.connect(this._mixGain);

    // Body bandpass — LFO → frequency
    this._bodyBP              = context.createBiquadFilter();
    this._bodyBP.type         = 'bandpass';
    this._bodyBP.frequency.value = this._params['body.freq'];
    this._bodyBP.Q.value      = this._bodyQ();
    this._noiseSrc.connect(this._bodyBP);

    this._bodyGain            = context.createGain();
    this._bodyGain.gain.value = this._params['body.level'];
    this._bodyBP.connect(this._bodyGain);
    this._bodyGain.connect(this._mixGain);

    // Per-note amp — gates noise; replaced each hit
    this._ampGain = null;
  }

  _colorQ() { return 0.3 + this._params['color'] * 7.7; }
  _bodyQ()  { return 0.5 + this._params['color'] * 4.5; }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const decay    = this._params['decay'];

    // Disconnect old per-note amp from mix and crusher
    if (this._ampGain) {
      try { this._mixGain.disconnect(this._ampGain); } catch (_) {}
      try { this._ampGain.disconnect();               } catch (_) {}
    }

    // Per-note amp: gates and shapes the decay
    this._ampGain = this.context.createGain();
    this._ampGain.gain.setValueAtTime(velScale, t);
    this._ampGain.gain.exponentialRampToValueAtTime(0.001, t + decay);

    this._mixGain.connect(this._ampGain);
    this._ampGain.connect(this._crusher); // amp → crusher → outputGain

    const ampGain = this._ampGain;
    const mixGain = this._mixGain;
    const crusher = this._crusher;
    // Cleanup on the audio thread at note end (avoids wall-clock setTimeout drift).
    scheduleCallback(this.context, t + decay + 0.15, () => {
      try { mixGain.disconnect(ampGain); } catch (_) {}
      try { ampGain.disconnect(crusher); } catch (_) {}
      try { ampGain.disconnect();        } catch (_) {}
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode)  { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._noiseSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). _colorQ/
  // _bodyQ helpers above are referenced by the 'color' apply hook.
}
