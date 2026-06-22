/**
 * AnalogueClappMachine.js
 * -----------------------
 * Analogue-modelled clap — the analogue counterpart to ClappMachine, built on
 * the shared PATINA building blocks in AnalogueParts.js.
 *
 * Same 808-style three-burst structure as Clapp (three short noise bursts
 * staggered by `spread` ms through a shared bandpass), but the noise is **pink**
 * (makePinkBuffer) instead of white — the noise colour of analogue clap circuits,
 * which rounds off the harsh top of a white-noise clap. Per-instance tolerance is
 * baked into the burst timing so the layered claps don't sound mechanically even.
 *
 * Self-enveloping. noteOff is a no-op. No persistent oscillators, so no drift
 * clock (there is no pitched layer to wander).
 *
 * Audio graph (per-note, three burst layers):
 *   PinkNoiseSource × 3 → BandpassFilter (persistent) → ampGain (exp decay) → outputGain → [Filter]
 *
 * Parameters (mirror Clapp):
 *   'tone'         — bandpass center frequency Hz (800–6000)
 *   'snap'         — bandpass Q / tightness (0.3–4)
 *   'decay'        — tail decay in seconds (0.05–1.0)
 *   'spread'       — time gap between burst layers in ms (0–30)
 *   'output.level' — output gain 0–1
 */

import { Machine }              from './Machine.js';
import { makeTrimGain }         from './LoudnessTrim.js';
import { scheduleCallback }     from '../util/AudioBuffers.js';
import { makePinkBuffer, rand } from './AnalogueParts.js';

export class AnalogueClappMachine extends Machine {
  static SPEC = {
    'tone':         { label: 'Tone', type: 'number', min: 800, max: 6000, default: 1800, group: 'TONE',
                      modulatable: true, lfoMin: 800, lfoMax: 6000,
                      target: m => m._bp.frequency, schedule: 'setTarget', tc: 0.01 },
    'snap':         { label: 'Snap', type: 'number', min: 0.3, max: 4, default: 0.8, group: 'TONE',
                      modulatable: true, lfoMin: 0.3, lfoMax: 4,
                      target: m => m._bp.Q, schedule: 'setTarget', tc: 0.01 },
    'note.track':   { label: 'Note Track', type: 'boolean', default: false, group: 'TONE', plockMode: 'js' },
    'decay':        { label: 'Decay', type: 'number', min: 0.05, max: 1.0, default: 0.3, group: 'SHAPE', plockMode: 'js' },
    'spread':       { label: 'Spread', type: 'number', min: 0, max: 30, default: 8, group: 'SHAPE', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT', ampMaster: true,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'clapp.analogue';
    this.label = 'Clapp Analogue';

    this._initSpec();

    // Per-instance burst-timing tolerance — a small fixed jitter (±8%) on the
    // inter-burst gap so the layered claps aren't mechanically even.
    this._tolSpread = 1 + rand() * 0.08;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent bandpass — tone shaping shared across all layers.
    this._bp      = context.createBiquadFilter();
    this._bp.type = 'bandpass';
    this._bp.frequency.value = this._params['tone'];
    this._bp.Q.value         = this._params['snap'];

    // Pink-noise burst buffer.
    this._pinkBuf = makePinkBuffer(context, 0.5);
  }

  noteOn(midiNote, velocity, time) {
    const velScale  = velocity / 127;
    const t         = time;
    const decay     = this._params['decay'];
    const spreadSec = (this._params['spread'] / 1000) * this._tolSpread;
    const noiseBuf  = this._pinkBuf;

    // Opt-in note tracking: shift the bandpass center (the clap's only "pitch") by
    // the note ratio (C4 = the resting `tone`). Off → fixed tone as before.
    // cancelScheduledValues kills the setTargetAtTime tail syncParamsAt scheduled
    // for `tone`, which would otherwise drag the centre back over ~10ms.
    if (this._params['note.track']) {
      this._bp.frequency.cancelScheduledValues(t);
      this._bp.frequency.setValueAtTime(this._params['tone'] * Machine.noteRatio(midiNote), t);
    }

    // ONE continuous pink-noise stream shaped into the whole clap gesture, rather
    // than three separate bursts. Separate sources read as discrete noise clicks;
    // a single source ridden by a multi-peak attack envelope FUSES the slaps into
    // one homogenous clap (the dips between slaps don't return to silence, so the
    // noise never stops — it just swells in a row, the way real hands fuse into a
    // single clap). After the slaps, one exponential tail is the reverberant body.
    // Pink noise (not white) keeps the top rounded off — the analogue clap colour.
    const src = this.context.createBufferSource();
    src.buffer = noiseBuf;

    const amp = this.context.createGain();
    const g   = amp.gain;

    // Four attack "slaps" spaced by `spread` (per-instance tolerance baked in via
    // _tolSpread). Each rises fast to its peak then dips only partway (to
    // FLOOR×peak) before the next — so the noise stays continuous and the slaps
    // blur into one attack instead of separate ticks.
    const SLAPS = 4;
    const FLOOR = 0.55;            // dip between slaps (fraction of the slap peak)
    const RISE  = 0.0008;          // 0.8ms rise — fast enough to feel snappy
    const slapPeak = velScale * 0.9;

    g.setValueAtTime(0.0001, t);
    let lastT = t;
    for (let i = 0; i < SLAPS; i++) {
      const peak = slapPeak * (1 - i * 0.12);   // gentle front-loaded taper
      const onset = t + i * spreadSec;
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
