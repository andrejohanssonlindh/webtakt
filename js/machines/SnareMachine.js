/**
 * SnareMachine.js
 * ---------------
 * Synthesis snare drum. Two-layer design:
 *   1. Persistent tuned oscillator (body / tone)
 *   2. Persistent noise source through persistent HP filter (snap / rattle)
 *
 * Persistent nodes allow LFOs to connect permanently:
 *   _tuneOsc.frequency  — tune
 *   _toneGain.gain      — tone level
 *   _snapGain.gain      — snap level
 *   _noiseHP.frequency  — noise.cutoff
 *   outputGain.gain     — output.level
 *
 * Per-note: only the amp decay GainNodes (_bodyAmp, _noiseAmp) are created
 * each hit to shape the decay envelope.
 *
 * Audio graph:
 *   _tuneOsc → _toneGain → _bodyAmp (per-note) ─┐
 *   _noiseSrc → _noiseHP → _snapGain             │
 *                        → _noiseAmp (per-note) ─┴→ outputGain → [Filter]
 *
 * Parameters:
 *   'tune'         — body oscillator Hz (100–400)
 *   'decay'        — overall decay in seconds (0.05–1.0)
 *   'tone'         — body level (0–1)
 *   'snap'         — noise level (0–1)
 *   'noise.cutoff' — HP filter cutoff Hz (200–8000)
 *   'output.level' — 0–1
 */

import { Machine }                        from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class SnareMachine extends Machine {
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 100, max: 400, default: 200, group: 'TONE',
                      modulatable: true, lfoMin: 100, lfoMax: 400,
                      target: m => m._tuneOsc.frequency, schedule: 'setTarget', tc: 0.01 },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 1.0, default: 0.18, group: 'TONE',
                      plockMode: 'js' },
    'tone':         { label: 'Tone', type: 'number', min: 0, max: 1, default: 0.4, group: 'TONE',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._toneGain.gain, schedule: 'setTarget', tc: 0.01 },
    'snap':         { label: 'Snap', type: 'number', min: 0, max: 1, default: 0.8, group: 'NOISE',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._snapGain.gain, schedule: 'setTarget', tc: 0.01 },
    'noise.cutoff': { label: 'Noise Cut', type: 'number', min: 200, max: 8000, default: 2000, group: 'NOISE',
                      modulatable: true, lfoMin: 200, lfoMax: 8000,
                      target: m => m._noiseHP.frequency, schedule: 'setTarget', tc: 0.01 },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'snare';
    this.label = 'Snare';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // ── Persistent body oscillator ──
    this._tuneOsc = context.createOscillator();
    this._tuneOsc.type = 'triangle';
    this._tuneOsc.frequency.value = this._params['tune'];
    this._tuneOsc.start();

    // Persistent tone level — LFO connects here
    this._toneGain = context.createGain();
    this._toneGain.gain.value = this._params['tone'];
    this._tuneOsc.connect(this._toneGain);

    // ── Persistent noise source (looping) ──
    this._noiseSrc = context.createBufferSource();
    this._noiseSrc.buffer = _getNoiseBuffer(context);
    this._noiseSrc.loop = true;
    this._noiseSrc.start();

    // Persistent HP filter — LFO connects to frequency
    this._noiseHP = context.createBiquadFilter();
    this._noiseHP.type = 'highpass';
    this._noiseHP.frequency.value = this._params['noise.cutoff'];
    this._noiseHP.Q.value = 0.5;
    this._noiseSrc.connect(this._noiseHP);

    // Persistent snap level — LFO connects here
    this._snapGain = context.createGain();
    this._snapGain.gain.value = this._params['snap'];
    this._noiseHP.connect(this._snapGain);

    // Per-note amp nodes (replaced each hit)
    this._bodyAmp = null;
    this._noiseAmp = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const decay    = this._params['decay'];
    const tune     = this._params['tune'];

    // Disconnect old per-note amps — both the source→amp and amp→output connections
    if (this._bodyAmp)  {
      try { this._toneGain.disconnect(this._bodyAmp); } catch (_) {}
      try { this._bodyAmp.disconnect(); } catch (_) {}
    }
    if (this._noiseAmp) {
      try { this._snapGain.disconnect(this._noiseAmp); } catch (_) {}
      try { this._noiseAmp.disconnect(); } catch (_) {}
    }

    // Pitch drop on persistent osc — note-tracked body (C4 = `tune`, noise stays fixed)
    const f = tune * Machine.noteRatio(midiNote);
    this._tuneOsc.frequency.setValueAtTime(f, t);
    this._tuneOsc.frequency.exponentialRampToValueAtTime(
      Math.max(f * 0.5, 40), t + decay * 0.3
    );

    // Per-note body amp
    this._bodyAmp = this.context.createGain();
    this._bodyAmp.gain.setValueAtTime(velScale, t);
    this._bodyAmp.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._toneGain.connect(this._bodyAmp);
    this._bodyAmp.connect(this.outputGain);

    // Per-note noise amp
    this._noiseAmp = this.context.createGain();
    this._noiseAmp.gain.setValueAtTime(velScale, t);
    this._noiseAmp.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._snapGain.connect(this._noiseAmp);
    this._noiseAmp.connect(this.outputGain);

    // Disconnect after decay tail using AudioContext-time callback (not wall clock)
    const bodyAmp  = this._bodyAmp;
    const noiseAmp = this._noiseAmp;
    const toneGain = this._toneGain;
    const snapGain = this._snapGain;
    scheduleCallback(this.context, t + decay + 0.15, () => {
      try { toneGain.disconnect(bodyAmp);  } catch (_) {}
      try { snapGain.disconnect(noiseAmp); } catch (_) {}
      try { bodyAmp.disconnect();          } catch (_) {}
      try { noiseAmp.disconnect();         } catch (_) {}
    });
  }

  noteOff(time) {}  // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._tuneOsc.stop();   } catch (_) {}
    try { this._noiseSrc.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
