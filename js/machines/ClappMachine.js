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
import { makeTrimGain } from './LoudnessTrim.js';
import { getNoiseBuffer, scheduleCallback } from '../util/AudioBuffers.js';

const _noiseCache = { buf: null };
const _getNoiseBuffer = ctx => getNoiseBuffer(ctx, _noiseCache, 0.5);

export class ClappMachine extends Machine {
  static SPEC = {
    'tone':         { label: 'Tone', type: 'number', min: 800, max: 6000, default: 3000,
                      modulatable: true, lfoMin: 800, lfoMax: 6000,
                      target: m => m._bp.frequency, schedule: 'setTarget', tc: 0.01 },
    'snap':         { label: 'Snap', type: 'number', min: 0.3, max: 4, default: 1.2,
                      modulatable: true, lfoMin: 0.3, lfoMax: 4,
                      target: m => m._bp.Q, schedule: 'setTarget', tc: 0.01 },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 1.0, default: 0.3, plockMode: 'js' },
    'spread':       { label: 'Spread', type: 'number', min: 0, max: 30, default: 8, plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'clapp';
    this.label = 'Clapp';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

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

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
