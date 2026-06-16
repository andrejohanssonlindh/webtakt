/**
 * WoodMachine.js
 * --------------
 * Wood / clave / rimshot / cowbell percussion synthesizer.
 * Uses a short resonant bandpass ring to simulate the acoustic character of
 * hard struck wood or metal objects. Two tunable resonator bands are mixed
 * to allow tonal shaping — one for the fundamental ring, one for the body.
 *
 * Self-enveloping — manages its own amp per hit via very short, hard decay.
 * The track Envelope is still in-chain for optional shaping but this machine
 * sounds correct at envelope defaults.
 *
 * Audio graph:
 *   _clickOsc (persistent, sine) → _clickGain (per-note attack burst)─┐
 *   _ring1 (BP, persistent)      → _ring1Gain (per-note decay)        ─┤
 *   _ring2 (BP, persistent)      → _ring2Gain (per-note decay)        ─┴→ outputGain → [Filter]
 *
 * The click oscillator provides the hard initial strike transient.
 * ring1 and ring2 are driven by the same persistent noise burst
 * through per-note gain nodes that decay independently.
 *
 * Parameters:
 *   'freq1'        — primary resonator center Hz (200–4000)
 *   'freq2'        — secondary resonator center Hz (400–8000)
 *   'ring'         — resonator Q — how tight/ringy (1–30)
 *   'mix'          — blend of ring2 vs ring1 (0 = ring1 only, 1 = ring2 only)
 *   'decay'        — body ring decay in seconds (0.001–0.4)
 *   'click'        — click transient level (0–1)
 *   'click.freq'   — click burst frequency Hz (500–12000)
 *   'output.level' — 0–1
 */

import { Machine }        from './Machine.js';
import { makeTrimGain }   from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class WoodMachine extends Machine {
  // 'ring' = manualTarget: resolves to _ring1.Q for LFO, but setParam sets Q on
  // both resonators via apply.
  static SPEC = {
    'freq1':        { label: 'Freq 1', type: 'number', min: 200, max: 4000, default: 600, group: 'RESONATOR',
                      modulatable: true, lfoMin: 200, lfoMax: 4000,
                      target: m => m._ring1.frequency, schedule: 'setTarget', tc: 0.005 },
    'freq2':        { label: 'Freq 2', type: 'number', min: 400, max: 8000, default: 1400, group: 'RESONATOR',
                      modulatable: true, lfoMin: 400, lfoMax: 8000,
                      target: m => m._ring2.frequency, schedule: 'setTarget', tc: 0.005 },
    'ring':         { label: 'Ring', type: 'number', min: 1, max: 30, default: 12, group: 'RESONATOR',
                      modulatable: true, lfoMin: 1, lfoMax: 30, plockMode: 'audioParam',
                      target: m => m._ring1.Q, manualTarget: true,
                      apply: (v, t, m) => {
                        m._ring1.Q.setTargetAtTime(v, t, 0.005);
                        m._ring2.Q.setTargetAtTime(v, t, 0.005);
                      } },
    'mix':          { label: 'Mix', type: 'number', min: 0, max: 1, default: 0.35, group: 'RESONATOR', plockMode: 'js' },
    'decay':        { label: 'Decay', type: 'number', min: 0.001, max: 0.4, default: 0.08, group: 'STRIKE', plockMode: 'js' },
    'click':        { label: 'Click', type: 'number', min: 0, max: 1, default: 0.6, group: 'STRIKE', plockMode: 'js' },
    'click.freq':   { label: 'Click Freq', type: 'number', min: 500, max: 12000, default: 3000, group: 'STRIKE',
                      modulatable: true, lfoMin: 500, lfoMax: 12000,
                      target: m => m._clickOsc.frequency, schedule: 'setTarget', tc: 0.005 },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 1.0, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'wood';
    this.label = 'Wood';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output,
    // untouched by output.level / p-locks / LFOs.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent noise source — driven through per-note gains into the resonators
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = _getNoiseBuffer(context);
    this._noiseSrc.loop   = true;
    this._noiseSrc.start();

    // Primary resonator (ring1)
    this._ring1      = context.createBiquadFilter();
    this._ring1.type = 'bandpass';
    this._ring1.frequency.value = this._params['freq1'];
    this._ring1.Q.value         = this._params['ring'];
    this._noiseSrc.connect(this._ring1);

    // Secondary resonator (ring2)
    this._ring2      = context.createBiquadFilter();
    this._ring2.type = 'bandpass';
    this._ring2.frequency.value = this._params['freq2'];
    this._ring2.Q.value         = this._params['ring'];
    this._noiseSrc.connect(this._ring2);

    // Click oscillator — persistent
    this._clickOsc       = context.createOscillator();
    this._clickOsc.type  = 'sine';
    this._clickOsc.frequency.value = this._params['click.freq'];
    this._clickOsc.start();

    // Per-note nodes
    this._ring1Gain = null;
    this._ring2Gain = null;
    this._clickGain = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const decay    = this._params['decay'];
    const mix      = this._params['mix'];
    const clickAmt = this._params['click'];

    // Detach old per-note nodes
    if (this._ring1Gain) {
      try { this._ring1.disconnect(this._ring1Gain); } catch (_) {}
      try { this._ring1Gain.disconnect();             } catch (_) {}
    }
    if (this._ring2Gain) {
      try { this._ring2.disconnect(this._ring2Gain); } catch (_) {}
      try { this._ring2Gain.disconnect();             } catch (_) {}
    }
    if (this._clickGain) {
      try { this._clickOsc.disconnect(this._clickGain); } catch (_) {}
      try { this._clickGain.disconnect();                } catch (_) {}
    }

    const amp = velScale * 8;

    // Ring1
    this._ring1Gain = this.context.createGain();
    this._ring1Gain.gain.setValueAtTime((1 - mix) * amp, t);
    this._ring1Gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._ring1.connect(this._ring1Gain);
    this._ring1Gain.connect(this.outputGain);

    // Ring2
    this._ring2Gain = this.context.createGain();
    this._ring2Gain.gain.setValueAtTime(mix * amp, t);
    this._ring2Gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._ring2.connect(this._ring2Gain);
    this._ring2Gain.connect(this.outputGain);

    // Click burst — very short
    if (clickAmt > 0.001) {
      this._clickGain = this.context.createGain();
      this._clickGain.gain.setValueAtTime(clickAmt * amp, t);
      this._clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.004);
      this._clickOsc.connect(this._clickGain);
      this._clickGain.connect(this.outputGain);
    }

    // Cleanup
    const refs = {
      r1: this._ring1, r1g: this._ring1Gain,
      r2: this._ring2, r2g: this._ring2Gain,
      co: this._clickOsc, cg: this._clickGain,
    };
    // Cleanup on the audio thread at note end (avoids wall-clock setTimeout drift).
    scheduleCallback(this.context, t + decay + 0.1, () => {
      try { refs.r1.disconnect(refs.r1g); } catch (_) {}
      try { refs.r1g.disconnect();        } catch (_) {}
      try { refs.r2.disconnect(refs.r2g); } catch (_) {}
      try { refs.r2g.disconnect();        } catch (_) {}
      if (refs.cg) {
        try { refs.co.disconnect(refs.cg); } catch (_) {}
        try { refs.cg.disconnect();        } catch (_) {}
      }
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._noiseSrc.stop(); } catch (_) {}
    try { this._clickOsc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
