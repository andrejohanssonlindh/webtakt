/**
 * ClappMachine.js
 * ---------------
 * 808-style synthesized clap.
 * Three short noise bursts with small time offsets simulate the
 * layered hand claps of a Roland TR-808. Each burst goes through
 * a bandpass filter for that characteristic "papery" tone.
 *
 * Audio graph (per-note, three burst layers):
 *   AudioBufferSourceNode × 3 → BandpassFilter → ampGain (exp decay) → outputGain → [Filter]
 *
 * Self-enveloping. noteOff is a no-op.
 *
 * Parameters:
 *   'tone'         — bandpass center frequency Hz (800–6000)
 *   'snap'         — bandpass Q / tightness (0.3–4)
 *   'decay'        — tail decay in seconds (0.05–1.0)
 *   'spread'       — time gap between burst layers in ms (0–30)
 *   'output.level' — output gain 0–1
 */

import { Machine }                          from './Machine.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class ClappMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'clapp';
    this.label = 'Clapp';

    this._params = {
      'tone':         3000,
      'snap':         1.2,
      'decay':        0.3,
      'spread':       8,
      'output.level': 0.85,
    };

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Persistent bandpass — tone shaping shared across all layers
    this._bp      = context.createBiquadFilter();
    this._bp.type = 'bandpass';
    this._bp.frequency.value = this._params['tone'];
    this._bp.Q.value         = this._params['snap'];
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const decay    = this._params['decay'];
    const spreadSec = this._params['spread'] / 1000;
    const noiseBuf  = _getNoiseBuffer(this.context);

    // Three burst layers at t, t+spread, t+spread*2
    const offsets = [0, spreadSec, spreadSec * 2];

    offsets.forEach((offset, i) => {
      const burstStart = t + offset;
      // Burst duration: first two short, last one decays out
      const burstLen = i < 2 ? 0.012 : decay;

      const src = this.context.createBufferSource();
      src.buffer = noiseBuf;

      const amp = this.context.createGain();
      const peakGain = i < 2 ? velScale * 0.7 : velScale;
      amp.gain.setValueAtTime(peakGain, burstStart);
      amp.gain.exponentialRampToValueAtTime(0.001, burstStart + burstLen);

      src.connect(this._bp);
      this._bp.connect(amp);
      amp.connect(this.outputGain);

      src.start(burstStart);
      src.stop(burstStart + burstLen + 0.01);

      scheduleCallback(this.context, burstStart + burstLen + 0.05, () => {
        try { src.disconnect(); }  catch (_) {}
        try { this._bp.disconnect(amp); } catch (_) {}
        try { amp.disconnect(); }  catch (_) {}
      });
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'tone':
        this._bp.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'snap':
        this._bp.Q.setTargetAtTime(value, t, 0.01);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
      // 'decay', 'spread' — JS-only, read in noteOn
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'tone',         label: 'Tone',    type: 'number', min: 800,  max: 6000, default: 3000, modulatable: true,  lfoMin: 800,  lfoMax: 6000, plockMode: 'audioParam' },
      { path: 'snap',         label: 'Snap',    type: 'number', min: 0.3,  max: 4,    default: 1.2,  modulatable: true,  lfoMin: 0.3,  lfoMax: 4,    plockMode: 'audioParam' },
      { path: 'decay',        label: 'Decay',   type: 'number', min: 0.05, max: 1.0,  default: 0.3,                                                  plockMode: 'js'        },
      { path: 'spread',       label: 'Spread',  type: 'number', min: 0,    max: 30,   default: 8,                                                     plockMode: 'js'        },
      { path: 'output.level', label: 'Level',   type: 'number', min: 0,    max: 1,    default: 0.85, modulatable: true,  lfoMin: 0,    lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'tone':         return this._bp.frequency;
      case 'snap':         return this._bp.Q;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
