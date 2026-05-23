/**
 * KarplusMachine.js
 * -----------------
 * Karplus-Strong plucked string synthesis. A short noise burst excites a
 * tuned comb filter (DelayNode + feedback loop with LP filter), which
 * models the resonance and decay of a plucked string.
 *
 * The delay time is computed from the MIDI note frequency at noteOn to
 * track pitch accurately. The LP filter in the feedback path models string
 * stiffness — lower cutoff = warmer, rounder sound (nylon); higher cutoff
 * = brighter, harder sound (steel).
 *
 * This machine is self-enveloping: the pluck decays naturally from the
 * comb filter's feedback loss. The track Envelope is still in-chain for
 * optional additional shaping.
 *
 * Audio graph (per note):
 *   ExciterGain (noise burst, per-note) ──────────────────────────────┐
 *   DelayNode (_delay, per-note) ← FeedbackGain ← LP (_fbLP) ←───────┤
 *                                                                      ↓
 *   DelayNode → _outputGain → [Filter]
 *
 * The delay time = 1/freq − LP correction offset. A new set of nodes
 * is created per noteOn because delay time changes mid-sustain would
 * detune the pitch.
 *
 * Parameters:
 *   'damping'      — LP cutoff in feedback path Hz (200–20000): warmth/brightness
 *   'feedback'     — feedback gain (0.8–0.999): how long the string rings
 *   'excite'       — noise burst length in ms (1–50): pluck character
 *   'excite.tone'  — LP filter on exciter noise (200–20000 Hz): pluck brightness
 *   'stretch'      — slight pitch detune on feedback in cents (-12 to +12): chorus
 *   'output.level' — 0–1
 */

import { Machine }        from './Machine.js';
import { getNoiseBuffer } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoise   = ctx => getNoiseBuffer(ctx, _noiseCache, 0.1);

export class KarplusMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'karplus';
    this.label = 'Karplus';

    this._params = {
      'damping':      6000,
      'feedback':     0.985,
      'excite':       8,
      'excite.tone':  8000,
      'stretch':      0,
      'output.level': 0.8,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Hold references to active per-note nodes so they can be cleaned up
    this._activeNodes = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale   = velocity / 127;
    const freq       = Machine.midiToFreq(midiNote);
    // Karplus-Strong: delay time = 1/freq. Subtract a small correction for
    // the LP filter group delay (approximately 1 sample at low cutoff).
    const sampleRate = this.context.sampleRate;
    const delayTime  = Math.max(1 / freq - 1 / sampleRate, 0.0001);

    const exciteMs   = this._params['excite'];
    const exciteDur  = exciteMs / 1000;

    // Stop and disconnect previous note nodes
    if (this._activeNodes) {
      const { exciterSrc, exciterLP, exciterGain, delay, fbLP, fbGain } = this._activeNodes;
      const stopTime = time + exciteDur + 0.01;
      // Schedule a fade — exponential decay will have handled cleanup already,
      // but we need to disconnect to avoid double-output on rapid retriggering.
      const now = this.context.currentTime;
      setTimeout(() => {
        try { exciterSrc.stop();          } catch (_) {}
        try { exciterGain.disconnect();   } catch (_) {}
        try { exciterLP.disconnect();     } catch (_) {}
        try { delay.disconnect();         } catch (_) {}
        try { fbLP.disconnect();          } catch (_) {}
        try { fbGain.disconnect();        } catch (_) {}
      }, Math.max(0, (stopTime - now) * 1000 + 50));
      this._activeNodes = null;
    }

    // ── Exciter: short noise burst ──
    const exciterSrc    = this.context.createBufferSource();
    exciterSrc.buffer   = _getNoise(this.context);
    exciterSrc.loop     = false;

    const exciterLP       = this.context.createBiquadFilter();
    exciterLP.type        = 'lowpass';
    exciterLP.frequency.value = this._params['excite.tone'];
    exciterLP.Q.value     = 0.7071;

    const exciterGain     = this.context.createGain();
    exciterGain.gain.setValueAtTime(velScale, time);
    exciterGain.gain.setValueAtTime(0, time + exciteDur);

    exciterSrc.connect(exciterLP);
    exciterLP.connect(exciterGain);

    // ── Comb filter: tuned delay + feedback LP ──
    const delay       = this.context.createDelay(2);
    delay.delayTime.value = delayTime;

    const fbLP        = this.context.createBiquadFilter();
    fbLP.type         = 'lowpass';
    fbLP.frequency.value = this._params['damping'];
    fbLP.Q.value      = 0.7071;

    const fbGain      = this.context.createGain();
    fbGain.gain.value = this._params['feedback'];

    // Apply stretch (slight detune on feedback loop — subtle chorusing)
    if (this._params['stretch'] !== 0) {
      const detuneRatio = Math.pow(2, this._params['stretch'] / 1200);
      delay.delayTime.value = delayTime * detuneRatio;
    }

    // Feedback loop: delay → fbLP → fbGain → delay (back into itself)
    delay.connect(fbLP);
    fbLP.connect(fbGain);
    fbGain.connect(delay);

    // Exciter feeds into delay
    exciterGain.connect(delay);

    // Delay output → master output
    delay.connect(this.outputGain);

    exciterSrc.start(time);

    this._activeNodes = { exciterSrc, exciterLP, exciterGain, delay, fbLP, fbGain };

    // Auto-cleanup after ~feedback decay time
    // feedback^n = 0.001 → n = log(0.001)/log(feedback)
    const fb = this._params['feedback'];
    const decayCycles = fb > 0.001 ? Math.log(0.001) / Math.log(fb) : 100;
    const decayTime   = decayCycles / freq;
    const cleanupMs   = (exciteDur + decayTime + 0.3) * 1000 + Math.max(time - this.context.currentTime, 0) * 1000;
    const nodes       = this._activeNodes;
    setTimeout(() => {
      try { nodes.exciterSrc.stop();        } catch (_) {}
      try { nodes.exciterGain.disconnect(); } catch (_) {}
      try { nodes.exciterLP.disconnect();   } catch (_) {}
      try { nodes.delay.disconnect();       } catch (_) {}
      try { nodes.fbLP.disconnect();        } catch (_) {}
      try { nodes.fbGain.disconnect();      } catch (_) {}
    }, cleanupMs);
  }

  noteOff(time) {} // Self-decaying

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    if (this._activeNodes) {
      const { exciterSrc, exciterGain, exciterLP, delay, fbLP, fbGain } = this._activeNodes;
      try { exciterSrc.stop();        } catch (_) {}
      try { exciterGain.disconnect(); } catch (_) {}
      try { exciterLP.disconnect();   } catch (_) {}
      try { delay.disconnect();       } catch (_) {}
      try { fbLP.disconnect();        } catch (_) {}
      try { fbGain.disconnect();      } catch (_) {}
      this._activeNodes = null;
    }
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    // All params are JS-only — read at noteOn time. No live AudioParam to update.
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'damping',      label: 'Damping',     type: 'number', min: 200,  max: 20000, default: 6000,  plockMode: 'js' },
      { path: 'feedback',     label: 'Feedback',    type: 'number', min: 0.8,  max: 0.999, default: 0.985, plockMode: 'js' },
      { path: 'excite',       label: 'Excite',      type: 'number', min: 1,    max: 50,    default: 8,     plockMode: 'js' },
      { path: 'excite.tone',  label: 'Excite Tone', type: 'number', min: 200,  max: 20000, default: 8000,  plockMode: 'js' },
      { path: 'stretch',      label: 'Stretch',     type: 'number', min: -12,  max: 12,    default: 0,     plockMode: 'js' },
      { path: 'output.level', label: 'Level',       type: 'number', min: 0,    max: 1,     default: 0.8,   modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
