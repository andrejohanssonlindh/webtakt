/**
 * TomFMMachine.js
 * ---------------
 * FM tom — a metallic, synthetic tuned drum. A single modulator→carrier FM pair
 * gives a harder, more inharmonic timbre than either the clean digital TomMachine
 * or the warm AnalogueTomMachine: at high `ratio` the sidebands are non-integer
 * multiples of the carrier, so the body rings with a bell/metal edge. A short
 * modulator decay makes the metallic content bloom on the attack then settle to
 * a purer tone — the classic FM-percussion gesture.
 *
 * Persistent carrier + modulator oscillators (LFO binds to the carrier's
 * frequency); per-note GainNodes shape the amp + FM-depth envelopes each hit.
 *
 * Audio graph:
 *   _modOsc (persistent) → _modGain (per-note, = FM depth) → _carOsc.frequency
 *   _carOsc (persistent) → _ampGain (per-note) → outputGain → [Filter]
 *
 * Parameters:
 *   'tune'         — carrier base frequency in Hz (60–400) — tom pitch
 *   'decay'        — amp decay time in seconds (0.1–1.5)
 *   'sweep'        — carrier pitch sweep multiplier (1–4)
 *   'ratio'        — modulator : carrier frequency ratio (0.5–12) — high = metallic
 *   'fm'           — FM index / depth (0–1) — amount of metallic sideband content
 *   'fm.decay'     — fraction of decay the FM depth envelope spans (0.05–1)
 *   'output.level' — 0–1
 */

import { Machine }      from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { scheduleCallback } from '../util/AudioBuffers.js';

export class TomFMMachine extends Machine {
  static SPEC = {
    'tune':         { label: 'Tune', type: 'number', min: 60, max: 400, default: 120, group: 'TONE',
                      modulatable: true, lfoMin: 60, lfoMax: 400, plockMode: 'audioParam',
                      target: m => m._carOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => {
                        m._carOsc.frequency.setTargetAtTime(v, t, 0.01);
                        m._modOsc.frequency.setTargetAtTime(v * m._params['ratio'], t, 0.01);
                      } },
    'decay':        { label: 'Decay', type: 'number', min: 0.1, max: 1.5, default: 0.4, group: 'TONE', plockMode: 'js' },
    'sweep':        { label: 'Sweep', type: 'number', min: 1, max: 4, default: 1.6, group: 'TONE', plockMode: 'js' },
    'ratio':        { label: 'Ratio', type: 'number', min: 0.5, max: 12, default: 2.5, group: 'FM', plockMode: 'js',
                      apply: (v, t, m) => m._modOsc.frequency.setTargetAtTime(m._params['tune'] * v, t, 0.01) },
    'fm':           { label: 'FM', type: 'number', min: 0, max: 1, default: 0.5, group: 'FM', plockMode: 'js' },
    'fm.decay':     { label: 'FM Decay', type: 'number', min: 0.05, max: 1, default: 0.35, group: 'FM', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'tom.fm';
    this.label = 'Tom FM';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Persistent carrier. LFO binds to .frequency (the canonical `tune` target).
    this._carOsc = context.createOscillator();
    this._carOsc.type = 'sine';
    this._carOsc.frequency.value = this._params['tune'];
    this._carOsc.start();

    // Persistent modulator at ratio × tune. Its output feeds _modGain (the
    // per-note FM depth, in Hz of carrier-frequency deviation).
    this._modOsc = context.createOscillator();
    this._modOsc.type = 'sine';
    this._modOsc.frequency.value = this._params['tune'] * this._params['ratio'];
    this._modOsc.start();

    // Per-note nodes (recreated each hit).
    this._modGain = null;
    this._ampGain = null;
  }

  // Map the 0–1 `fm` index to a peak frequency-deviation in Hz, scaled by the
  // carrier pitch so the timbre stays consistent across the tom's range.
  _fmPeakHz(fmIndex, tune) {
    return fmIndex * tune * 8;
  }

  noteOn(midiNote, velocity, time) {
    const velScale = velocity / 127;
    const t        = time;
    const tune     = this._params['tune'];
    const decay    = this._params['decay'];
    const sweep    = this._params['sweep'];
    const ratio    = this._params['ratio'];
    const fm       = this._params['fm'];
    const fmDecay  = this._params['fm.decay'];

    // Disconnect old per-note nodes (mod→carrier.frequency and car→amp→out).
    if (this._modGain) {
      try { this._modOsc.disconnect(this._modGain); } catch (_) {}
      try { this._modGain.disconnect(); } catch (_) {}
      this._modGain = null;
    }
    if (this._ampGain) {
      try { this._carOsc.disconnect(this._ampGain); } catch (_) {}
      try { this._ampGain.disconnect(); } catch (_) {}
      this._ampGain = null;
    }

    // ── Carrier pitch sweep ──
    // Note-tracked base freq: C4 (60) plays at `tune`, ±1:1 semitones either side.
    // FM depth (_fmPeakHz) also scales by `f` so the timbre tracks across the range.
    const f         = tune * Machine.noteRatio(midiNote);
    const startFreq = Math.max(f * sweep, 30);
    const endFreq   = Math.max(f, 30);
    this._carOsc.frequency.cancelScheduledValues(t);
    this._carOsc.frequency.setValueAtTime(startFreq, t);
    this._carOsc.frequency.exponentialRampToValueAtTime(endFreq, t + decay * 0.3);
    // Modulator tracks the carrier sweep at `ratio` so the spectrum keeps its
    // shape as the pitch drops.
    this._modOsc.frequency.cancelScheduledValues(t);
    this._modOsc.frequency.setValueAtTime(startFreq * ratio, t);
    this._modOsc.frequency.exponentialRampToValueAtTime(endFreq * ratio, t + decay * 0.3);

    // ── FM depth envelope: blooms on attack, decays faster than the amp so the
    // metallic content settles to a purer tone (the FM-percussion gesture). ──
    this._modGain = this.context.createGain();
    const peak = this._fmPeakHz(fm, f);
    if (peak > 0) {
      // Exponential decay of the FM depth. Both endpoints must be > 0 (an
      // exponential ramp from/to 0 is invalid and misbehaves in Chrome).
      this._modGain.gain.setValueAtTime(peak, t);
      this._modGain.gain.exponentialRampToValueAtTime(peak * 0.001, t + decay * fmDecay);
    } else {
      // fm = 0 → no modulation at all (pure carrier).
      this._modGain.gain.setValueAtTime(0, t);
    }
    this._modOsc.connect(this._modGain);
    this._modGain.connect(this._carOsc.frequency);

    // ── Amp envelope ──
    this._ampGain = this.context.createGain();
    this._ampGain.gain.setValueAtTime(velScale, t);
    this._ampGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    this._carOsc.connect(this._ampGain);
    this._ampGain.connect(this.outputGain);

    // Disconnect after decay tail using AudioContext-time callback.
    const modGainRef = this._modGain, ampGainRef = this._ampGain;
    const modRef = this._modOsc, carRef = this._carOsc;
    scheduleCallback(this.context, t + decay * 1.3 + 0.1, () => {
      try { modRef.disconnect(modGainRef); } catch (_) {}
      try { modGainRef.disconnect(); }       catch (_) {}
      try { carRef.disconnect(ampGainRef); } catch (_) {}
      try { ampGainRef.disconnect(); }       catch (_) {}
    });
  }

  noteOff(time) {} // Self-enveloping

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    try { this._carOsc.stop(); } catch (_) {}
    try { this._modOsc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
