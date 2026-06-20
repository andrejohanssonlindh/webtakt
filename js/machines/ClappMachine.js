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
    'tone':         { label: 'Tone', type: 'number', min: 800, max: 6000, default: 2800, group: 'TONE',
                      modulatable: true, lfoMin: 800, lfoMax: 6000,
                      target: m => m._bp.frequency, schedule: 'setTarget', tc: 0.01 },
    'snap':         { label: 'Snap', type: 'number', min: 0.3, max: 4, default: 0.8, group: 'TONE',
                      modulatable: true, lfoMin: 0.3, lfoMax: 4,
                      target: m => m._bp.Q, schedule: 'setTarget', tc: 0.01 },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 1.0, default: 0.3, group: 'SHAPE', plockMode: 'js' },
    'spread':       { label: 'Spread', type: 'number', min: 0, max: 30, default: 8, group: 'SHAPE', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT',
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

    // Persistent resonant LOWPASS — tone shaping shared across all layers.
    // White noise has little low energy and a bandpass throws away everything
    // BELOW its centre, so a bandpass'd white-noise clap is thin and all-top. A
    // lowpass keeps the low/mid noise body (the clap's weight) and rolls off the
    // bright fizz above the cutoff — full-bodied but still white-noise crisp (the
    // digital clap's brighter character vs the pink analogue one). Tone = cutoff,
    // Snap = resonance.
    this._bp      = context.createBiquadFilter();
    this._bp.type = 'lowpass';
    this._bp.frequency.value = this._params['tone'];
    this._bp.Q.value         = this._params['snap'];
  }

  noteOn(midiNote, velocity, time) {
    const velScale  = velocity / 127;
    const t         = time;
    const decay     = this._params['decay'];
    const spreadSec = this._params['spread'] / 1000;
    const noiseBuf  = _getNoiseBuffer(this.context);

    // ONE continuous noise stream shaped into the whole clap gesture, rather than
    // three separate noise bursts. Separate sources read as discrete noise clicks;
    // a single source ridden by a multi-peak attack envelope FUSES the slaps into
    // one homogenous clap (the dips between slaps don't return to silence, so the
    // noise never stops — it just swells in a row, the way real hands fuse into a
    // single clap). After the slaps, one exponential tail is the reverberant body.
    const src = this.context.createBufferSource();
    src.buffer = noiseBuf;

    const amp = this.context.createGain();
    const g   = amp.gain;

    // Four attack "slaps" spaced by `spread`. Each rises fast to its peak then dips
    // only partway (to FLOOR×peak) before the next — so the noise stays continuous
    // and the slaps blur into one attack instead of separate ticks. Slaps taper in
    // level across the row so the gesture has a front-loaded shape.
    const SLAPS = 4;
    const FLOOR = 0.55;            // dip between slaps (fraction of the slap peak)
    const RISE  = 0.0008;          // 0.8ms rise — fast enough to feel snappy
    const slapPeak = velScale * 0.9;

    g.setValueAtTime(0.0001, t);
    let lastT = t;
    for (let i = 0; i < SLAPS; i++) {
      const peak = slapPeak * (1 - i * 0.12);   // gentle front-loaded taper
      const onset = t + i * spreadSec;
      // Dip down to the floor on the way into this slap (skip for the first), then
      // ramp up to the peak. Continuous: gain never hits zero between slaps.
      if (i > 0) g.linearRampToValueAtTime(peak * FLOOR, onset);
      g.linearRampToValueAtTime(peak, onset + RISE);
      lastT = onset + RISE;
    }

    // Reverberant tail: exponential decay from the last slap peak to silence.
    g.exponentialRampToValueAtTime(0.001, lastT + decay);

    src.connect(this._bp);
    this._bp.connect(amp);
    amp.connect(this.outputGain);

    const totalLen = (SLAPS - 1) * spreadSec + RISE + decay;
    src.start(t);
    src.stop(t + totalLen + 0.02);

    scheduleCallback(this.context, t + totalLen + 0.05, () => {
      try { src.disconnect(); }        catch (_) {}
      try { this._bp.disconnect(amp); } catch (_) {}
      try { amp.disconnect(); }        catch (_) {}
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
