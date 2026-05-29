/**
 * TransientMachine.js
 * -------------------
 * Transient / click / percussion synthesizer. Specialised for punchy attack
 * sounds: snappy clicks, wood blocks, rimshots, toms, electronic percussion.
 *
 * Two-layer design:
 *   1. CLICK — very short sine burst with pitch drop (attack transient)
 *   2. BODY  — tuned sine or triangle with exponential pitch sweep (resonant body)
 *
 * Unlike drum machines with fixed character, TransientMachine is highly tuneable:
 *   - 'pitch' sets the note frequency (overrides midiNote when > 0)
 *   - 'pitch.end' sets the pitch sweep endpoint ratio
 *   - 'click.freq' controls click burst frequency (bright vs. thuddy)
 *   - 'click.decay' controls click length (snappy click vs. soft attack)
 *   - 'body.decay' controls body ring-out
 *   - 'body.wave' selects waveform (sine = pure, triangle = slightly gritty)
 *   - 'attack' controls how hard the body hits (shape of volume attack)
 *   - 'noise.click' adds a noise burst mixed with the sine click (adds crack)
 *
 * All nodes except per-note gain ramps are persistent for LFO connection.
 *
 * Audio graph:
 *   _clickOsc (persistent, sine) → _clickGain (per-note) ─┐
 *   _noiseSrc (persistent, loop) → _noiseGain (per-note)  ─┤
 *   _bodyOsc (persistent)        → _bodyAmp (per-note)    ─┴→ outputGain → [Filter]
 *
 * Parameters:
 *   'pitch'         — body pitch Hz (0 = follow note, 20–2000)
 *   'pitch.end'     — pitch sweep end ratio (0.1–1.0, relative to start pitch)
 *   'body.decay'    — body decay in seconds (0.01–2.0)
 *   'body.wave'     — 'sine' | 'triangle'
 *   'click.freq'    — click oscillator frequency Hz (100–8000)
 *   'click.decay'   — click decay in seconds (0.001–0.05)
 *   'noise.click'   — noise amount mixed into click (0–1)
 *   'output.level'  — 0–1
 */

import { Machine }         from './Machine.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class TransientMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'transient';
    this.label = 'Transient';

    this._params = {
      'pitch':        0,      // 0 = follow MIDI note
      'pitch.end':    0.4,    // sweep to 40% of start pitch
      'body.decay':   0.12,
      'body.wave':    'sine',
      'click.freq':   1200,
      'click.decay':  0.008,
      'noise.click':  0.3,
      'output.level': 0.85,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // ── Persistent click oscillator ──
    this._clickOsc       = context.createOscillator();
    this._clickOsc.type  = 'sine';
    this._clickOsc.frequency.value = this._params['click.freq'];
    this._clickOsc.start();

    // ── Persistent noise source (for click crack) ──
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = _getNoiseBuffer(context);
    this._noiseSrc.loop   = true;
    this._noiseSrc.start();

    // Noise gain — LFO connects here
    this._noiseClickGain       = context.createGain();
    this._noiseClickGain.gain.value = this._params['noise.click'];
    this._noiseSrc.connect(this._noiseClickGain);

    // ── Persistent body oscillator ──
    this._bodyOsc      = context.createOscillator();
    this._bodyOsc.type = this._params['body.wave'];
    this._bodyOsc.frequency.value = 200;
    this._bodyOsc.start();

    // Per-note nodes
    this._clickGain = null;
    this._noiseGain = null;
    this._bodyAmp   = null;
  }

  noteOn(midiNote, velocity, time) {
    const velScale  = velocity / 127;
    const t         = time;
    const clickFreq = this._params['click.freq'];
    const clickDec  = this._params['click.decay'];
    const bodyDec   = this._params['body.decay'];
    const pitchEnd  = this._params['pitch.end'];
    const nClick    = this._params['noise.click'];

    // Resolve body start frequency
    const startFreq = this._params['pitch'] > 0
      ? this._params['pitch']
      : Machine.midiToFreq(midiNote);
    const endFreq = Math.max(startFreq * pitchEnd, 20);

    // Disconnect old per-note nodes
    if (this._clickGain) { try { this._clickGain.disconnect(); } catch (_) {} }
    if (this._noiseGain) { try { this._noiseGain.disconnect(); } catch (_) {} }
    if (this._bodyAmp)   { try { this._bodyAmp.disconnect();   } catch (_) {} }

    // ── Click burst ──
    // Do NOT setValueAtTime on frequency here — that would cancel any LFO modulation.
    // The persistent _clickOsc already tracks click.freq via setParam / LFO AudioParam.
    this._clickGain = this.context.createGain();
    this._clickGain.gain.setValueAtTime(velScale, t);
    this._clickGain.gain.exponentialRampToValueAtTime(0.001, t + clickDec);
    this._clickOsc.connect(this._clickGain);
    this._clickGain.connect(this.outputGain);

    // ── Noise click ──
    // _noiseClickGain.gain is the LFO target; per-note envelope uses velocity only.
    if (nClick > 0.001) {
      this._noiseGain = this.context.createGain();
      this._noiseGain.gain.setValueAtTime(velScale, t);
      this._noiseGain.gain.exponentialRampToValueAtTime(0.001, t + clickDec * 2);
      this._noiseClickGain.connect(this._noiseGain);
      this._noiseGain.connect(this.outputGain);
    }

    // ── Body with pitch sweep ──
    this._bodyOsc.frequency.setValueAtTime(startFreq, t);
    this._bodyOsc.frequency.exponentialRampToValueAtTime(endFreq, t + bodyDec * 0.4);

    this._bodyAmp = this.context.createGain();
    this._bodyAmp.gain.setValueAtTime(velScale, t);
    this._bodyAmp.gain.exponentialRampToValueAtTime(0.001, t + bodyDec);
    this._bodyOsc.connect(this._bodyAmp);
    this._bodyAmp.connect(this.outputGain);

    // Cleanup
    const refs = {
      clickOsc: this._clickOsc,
      clickGain: this._clickGain,
      noiseClickGain: this._noiseClickGain,
      noiseGain: this._noiseGain,
      bodyOsc: this._bodyOsc,
      bodyAmp: this._bodyAmp,
    };
    // Cleanup on the audio thread at note end (avoids wall-clock setTimeout drift).
    scheduleCallback(this.context, t + bodyDec + 0.15, () => {
      try { refs.clickOsc.disconnect(refs.clickGain);             } catch (_) {}
      try { refs.clickGain.disconnect();                          } catch (_) {}
      if (refs.noiseGain) {
        try { refs.noiseClickGain.disconnect(refs.noiseGain);     } catch (_) {}
        try { refs.noiseGain.disconnect();                        } catch (_) {}
      }
      try { refs.bodyOsc.disconnect(refs.bodyAmp);                } catch (_) {}
      try { refs.bodyAmp.disconnect();                            } catch (_) {}
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode)  { this.outputGain.connect(destinationNode); }

  disconnect() {
    try { this._clickOsc.stop();  } catch (_) {}
    try { this._noiseSrc.stop();  } catch (_) {}
    try { this._bodyOsc.stop();   } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'click.freq':
        this._clickOsc.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'noise.click':
        this._noiseClickGain.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'body.wave':
        this._bodyOsc.type = value;
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
      // 'pitch', 'pitch.end', 'body.decay', 'click.decay' are JS-only — read in noteOn
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'pitch',        label: 'Pitch',       type: 'number', min: 0,     max: 2000, default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 2000, plockMode: 'js'        },
      { path: 'pitch.end',    label: 'Pitch End',   type: 'number', min: 0.05,  max: 1.0,  default: 0.4,                                               plockMode: 'js'        },
      { path: 'body.decay',   label: 'Body Decay',  type: 'number', min: 0.01,  max: 2.0,  default: 0.12,                                              plockMode: 'js'        },
      { path: 'body.wave',    label: 'Body Wave',   type: 'enum',   options: ['sine','triangle'],                                                       plockMode: 'js'        },
      { path: 'click.freq',   label: 'Click Freq',  type: 'number', min: 100,   max: 8000, default: 1200, modulatable: true, lfoMin: 100, lfoMax: 8000, plockMode: 'audioParam' },
      { path: 'click.decay',  label: 'Click Decay', type: 'number', min: 0.001, max: 0.05, default: 0.008,                                             plockMode: 'js'        },
      { path: 'noise.click',  label: 'Crack',       type: 'number', min: 0,     max: 1,    default: 0.3,  modulatable: true, lfoMin: 0,   lfoMax: 1,    plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',       type: 'number', min: 0,     max: 1,    default: 0.85, modulatable: true, lfoMin: 0,   lfoMax: 1,    plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'click.freq':   return this._clickOsc.frequency;
      case 'noise.click':  return this._noiseClickGain.gain;
      case 'output.level': return this.outputGain.gain;
      // 'pitch' is JS-only (used in noteOn), can't be an AudioParam target
      default: return null;
    }
  }

  toJSON() { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
