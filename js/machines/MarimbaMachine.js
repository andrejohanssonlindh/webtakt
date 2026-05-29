/**
 * MarimbaMachine.js
 * -----------------
 * Marimba bar synthesis using tuned inharmonic partials.
 *
 * A real marimba bar has partials at unusual ratios due to the undercut arch:
 *   Mode 1 (fundamental):  1×
 *   Mode 2 (first overtone): ~3.9× (tuned to a 10th above, not an octave)
 *   Mode 3:                ~9.9×
 *
 * Each mode decays at a different rate — the overtones die much faster than
 * the fundamental, giving the characteristic "thud then pure tone" shape.
 * A short soft-noise mallet burst provides the attack transient.
 *
 * Architecture — all persistent oscillators, per-note GainNode envelopes:
 *
 *   _osc1 (sine, fund)   → _env1 (per-note decay) ─┐
 *   _osc2 (sine, ~3.9×)  → _env2 (per-note decay)  ├→ outputGain → [Filter]
 *   _osc3 (sine, ~9.9×)  → _env3 (per-note decay)  ┘
 *   _malletSrc (noise loop) → _malletFilter (LP) → _malletEnv (per-note) ─┘
 *
 * Parameters:
 *   'p2ratio'      — 2nd partial ratio (2.0–6.0, default 3.9)
 *   'p3ratio'      — 3rd partial ratio (5.0–15.0, default 9.9)
 *   'decay1'       — fundamental decay in seconds (0.2–8.0)
 *   'decay2'       — 2nd partial decay in seconds (0.05–2.0)
 *   'decay3'       — 3rd partial decay in seconds (0.01–0.5)
 *   'p2level'      — 2nd partial level (0–1)
 *   'p3level'      — 3rd partial level (0–1)
 *   'mallet'       — mallet transient level (0–1)
 *   'mallet.tone'  — mallet LP cutoff Hz (500–8000)
 *   'output.level' — 0–1
 */

import { Machine }        from './Machine.js';
import { getNoiseBuffer } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };

export class MarimbaMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'marimba';
    this.label = 'Marimba';

    this._params = {
      'p2ratio':      3.9,
      'p3ratio':      9.9,
      'decay1':       1.8,
      'decay2':       0.18,
      'decay3':       0.05,
      'p2level':      0.45,
      'p3level':      0.15,
      'mallet':       0.5,
      'mallet.tone':  2500,
      'output.level': 0.9,
    };

    this._baseFreq = 440;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Persistent sine oscillators — frequency updated each noteOn
    this._osc1 = context.createOscillator();
    this._osc1.type = 'sine';
    this._osc1.frequency.value = 440;
    this._osc1.start();

    this._osc2 = context.createOscillator();
    this._osc2.type = 'sine';
    this._osc2.frequency.value = 440 * 3.9;
    this._osc2.start();

    this._osc3 = context.createOscillator();
    this._osc3.type = 'sine';
    this._osc3.frequency.value = 440 * 9.9;
    this._osc3.start();

    // Persistent noise source for mallet thump
    const noiseBuf = getNoiseBuffer(context, _noiseCache, 0.5);
    this._malletSrc = context.createBufferSource();
    this._malletSrc.buffer = noiseBuf;
    this._malletSrc.loop = true;
    this._malletSrc.start();

    this._malletFilter = context.createBiquadFilter();
    this._malletFilter.type = 'lowpass';
    this._malletFilter.frequency.value = this._params['mallet.tone'];
    this._malletFilter.Q.value = 0.5;
    this._malletSrc.connect(this._malletFilter);

    // Per-note envelope gains — replaced each noteOn
    this._env1 = null;
    this._env2 = null;
    this._env3 = null;
    this._malletEnv = null;
  }

  noteOn(midiNote, velocity, time) {
    const freq = Machine.midiToFreq(midiNote);
    this._baseFreq = freq;
    const t = time;
    const vel = velocity / 127;

    // Update oscillator frequencies
    this._osc1.frequency.setValueAtTime(freq, t);
    this._osc2.frequency.setValueAtTime(freq * this._params['p2ratio'], t);
    this._osc3.frequency.setValueAtTime(freq * this._params['p3ratio'], t);

    // Detach previous per-note nodes
    this._detachEnv(this._osc1, this._env1);
    this._detachEnv(this._osc2, this._env2);
    this._detachEnv(this._osc3, this._env3);
    this._detachEnv(this._malletFilter, this._malletEnv);

    const amp = vel * 1.2;

    // Fundamental — long decay
    this._env1 = this._makeEnv(t, amp, this._params['decay1']);
    this._osc1.connect(this._env1);
    this._env1.connect(this.outputGain);

    // 2nd partial — medium decay
    this._env2 = this._makeEnv(t, amp * this._params['p2level'], this._params['decay2']);
    this._osc2.connect(this._env2);
    this._env2.connect(this.outputGain);

    // 3rd partial — short decay
    this._env3 = this._makeEnv(t, amp * this._params['p3level'], this._params['decay3']);
    this._osc3.connect(this._env3);
    this._env3.connect(this.outputGain);

    // Mallet transient — very short noise burst
    const malletAmt = this._params['mallet'];
    if (malletAmt > 0.001) {
      const malletDecay = 0.025;
      this._malletEnv = this._makeEnv(t, amp * malletAmt * 1.5, malletDecay);
      this._malletFilter.connect(this._malletEnv);
      this._malletEnv.connect(this.outputGain);
    }

    // Schedule cleanup after the longest decay
    const longestDecay = this._params['decay1'];
    const delayMs = (longestDecay + 0.5) * 1000 + Math.max(t - this.context.currentTime, 0) * 1000;
    const refs = {
      o1: this._osc1, e1: this._env1,
      o2: this._osc2, e2: this._env2,
      o3: this._osc3, e3: this._env3,
      mf: this._malletFilter, me: this._malletEnv,
    };
    setTimeout(() => {
      this._detachEnv(refs.o1, refs.e1);
      this._detachEnv(refs.o2, refs.e2);
      this._detachEnv(refs.o3, refs.e3);
      if (refs.me) this._detachEnv(refs.mf, refs.me);
    }, delayMs);
  }

  _makeEnv(t, peak, decay) {
    const g = this.context.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    return g;
  }

  _detachEnv(src, env) {
    if (!env) return;
    try { src.disconnect(env); } catch (_) {}
    try { env.disconnect();    } catch (_) {}
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    try { this._osc1.stop(); } catch (_) {}
    try { this._osc2.stop(); } catch (_) {}
    try { this._osc3.stop(); } catch (_) {}
    try { this._malletSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'p2ratio':
        this._osc2.frequency.setTargetAtTime(this._baseFreq * value, t, 0.005);
        break;
      case 'p3ratio':
        this._osc3.frequency.setTargetAtTime(this._baseFreq * value, t, 0.005);
        break;
      case 'mallet.tone':
        this._malletFilter.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
      // decay1/2/3, p2level, p3level, mallet — JS-only, read in noteOn
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'decay1',       label: 'Decay 1',    type: 'number', min: 0.2,  max: 8.0,  default: 1.8,  plockMode: 'js'        },
      { path: 'decay2',       label: 'Decay 2',    type: 'number', min: 0.05, max: 2.0,  default: 0.18, plockMode: 'js'        },
      { path: 'decay3',       label: 'Decay 3',    type: 'number', min: 0.01, max: 0.5,  default: 0.05, plockMode: 'js'        },
      { path: 'p2ratio',      label: 'P2 Ratio',   type: 'number', min: 2.0,  max: 6.0,  default: 3.9,  modulatable: true, lfoMin: 2.0, lfoMax: 6.0,  plockMode: 'audioParam' },
      { path: 'p3ratio',      label: 'P3 Ratio',   type: 'number', min: 5.0,  max: 15.0, default: 9.9,  modulatable: true, lfoMin: 5.0, lfoMax: 15.0, plockMode: 'audioParam' },
      { path: 'p2level',      label: 'P2 Level',   type: 'number', min: 0,    max: 1,    default: 0.45, plockMode: 'js'        },
      { path: 'p3level',      label: 'P3 Level',   type: 'number', min: 0,    max: 1,    default: 0.15, plockMode: 'js'        },
      { path: 'mallet',       label: 'Mallet',     type: 'number', min: 0,    max: 1,    default: 0.5,  plockMode: 'js'        },
      { path: 'mallet.tone',  label: 'Mallet Tone',type: 'number', min: 500,  max: 8000, default: 2500, modulatable: true, lfoMin: 500, lfoMax: 8000, plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',      type: 'number', min: 0,    max: 1,    default: 0.9,  modulatable: true, lfoMin: 0,   lfoMax: 1,    plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'p2ratio':      return this._osc2.frequency;
      case 'p3ratio':      return this._osc3.frequency;
      case 'mallet.tone':  return this._malletFilter.frequency;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
