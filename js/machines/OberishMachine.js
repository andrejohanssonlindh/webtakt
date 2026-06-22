/**
 * OberishMachine.js
 * -----------------
 * SEM/Oberheim-leaning analogue voice — fatter and more aggressive than the Juno,
 * less growl than Moogish's 3-osc stack. Two detuned oscillators (saw + a static
 * pulse) with a WIDE drift-detune spread, voiced for brass/pad stabs. Tuned to
 * lean on the analogue ladder's drive + self-oscillation (it's analogue-family, so
 * it auto-gets the ladder + BBD chorus), which is where the "Ob" honk comes from.
 *
 * Two oscillators rather than one (Juno) or three (Moogish): the pair beating
 * against each other under a heavy drift is the signature Oberheim width. Osc2
 * defaults a pulse for the reedy edge; both pass through their own imperfect
 * spectra + per-instance tolerance.
 *
 * Persistent-oscillator architecture (like Moogish/Juno/Synth): all nodes run
 * continuously, amplitude gated by the track Envelope. noteOn retunes; noteOff is
 * a no-op. LFOs / mod-wheel bind permanently.
 *
 * Audio graph:
 *   osc1 (saw)   → g1 ─┐
 *   osc2 (pulse) → g2 ─┼→ _mixGain → outputGain → _trimGain → [Filter (ladder)]
 *   pinkNoise    → gN ─┘
 *
 * Parameters:
 *   'osc1.waveform' 'osc1.octave' 'osc1.detune' 'osc1.level'
 *   'osc2.waveform' 'osc2.octave' 'osc2.detune' 'osc2.level'
 *   'spread'        — extra symmetric detune between the two oscs (cents, the Ob width)
 *   'noise.level'   — pink-noise hiss (0–1)
 *   'drift'         — thermal pitch wander (0–1), wide by default
 *   'osc.detune'    — hidden trig-tab master detune (−100..+100)
 *   'output.level'  — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

const WAVEFORMS = ['saw', 'square', 'triangle', 'pulse', 'sine'];

export class OberishMachine extends Machine {
  static SPEC = {
    'osc1.waveform': { label: 'O1 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       group: 'OSC 1', plockMode: 'js', apply: (v, t, m) => m._setWave(0, v) },
    'osc1.octave':   { label: 'O1 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 1',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc1.detune':   { label: 'O1 Detune', type: 'number', min: -50, max: 50, default: -8, group: 'OSC 1',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc1.level':    { label: 'O1 Level', type: 'number', min: 0, max: 1, default: 0.5, group: 'OSC 1',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[0].gain, schedule: 'setTarget', tc: 0.005 },

    'osc2.waveform': { label: 'O2 Wave', type: 'enum', options: WAVEFORMS, default: 'pulse',
                       group: 'OSC 2', plockMode: 'js', apply: (v, t, m) => m._setWave(1, v) },
    'osc2.octave':   { label: 'O2 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 2',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc2.detune':   { label: 'O2 Detune', type: 'number', min: -50, max: 50, default: 9, group: 'OSC 2',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[1].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc2.level':    { label: 'O2 Level', type: 'number', min: 0, max: 1, default: 0.5, group: 'OSC 2',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[1].gain, schedule: 'setTarget', tc: 0.005 },

    // The Oberheim width: an extra symmetric detune pushing osc1 down / osc2 up
    // by `spread` cents on top of their own detune. Big values = lush, beating pad.
    'spread':        { label: 'Spread', type: 'number', min: 0, max: 50, default: 12, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 50, plockMode: 'js',
                       apply: (v, t, m) => m._retune(t) },
    'noise.level':   { label: 'Noise', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._noiseGain.gain, schedule: 'setTarget', tc: 0.01 },
    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.6, group: 'TEXTURE',
                       plockMode: 'js' },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT', ampMaster: true,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'oberish';
    this.label = 'Oberish';

    this._initSpec();
    this._rootMidi = 60;

    // Fixed per-instance component tolerance.
    this._tolTune = [rand() * 5, rand() * 5];   // cents, per osc

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1;
    this._mixGain.connect(this.outputGain);

    // Two persistent oscillators, each with its own imperfect spectrum.
    this._oscs     = [];
    this._gains    = [];
    this._waveType = [];
    for (let i = 0; i < 2; i++) {
      const osc = context.createOscillator();
      const wf  = this._params[`osc${i + 1}.waveform`];
      osc.setPeriodicWave(makeImperfectWave(context, wf, { tolerance: 0.05 }));
      this._waveType[i] = wf;
      osc.frequency.value = 261.63;
      osc.detune.value    = this._params[`osc${i + 1}.detune`] + this._tolTune[i];

      const g = context.createGain();
      g.gain.value = this._params[`osc${i + 1}.level`];
      osc.connect(g);
      g.connect(this._mixGain);
      osc.start();

      this._oscs.push(osc);
      this._gains.push(g);
    }

    // Circuit hiss.
    this._noiseGain = context.createGain();
    this._noiseGain.gain.value = this._params['noise.level'];
    this._noiseGain.connect(this._mixGain);
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = makePinkBuffer(context, 2);
    this._noiseSrc.loop   = true;
    this._noiseSrc.playbackRate.value = 1 + rand() * 0.1;
    this._noiseSrc.connect(this._noiseGain);
    this._noiseSrc.start();

    // Thermal drift on both osc detunes — wider amount than Moogish/Juno (the Ob
    // pair beating heavily under temperature wander is the character).
    this._drift = new DriftClock(
      context,
      this._oscs.map(o => o.detune),
      { baseFor: i => this._driftBase(i), amountFor: () => this._params['drift'] * 4.5 },
    );

    this._retune(context.currentTime);
  }

  /** Base detune for drift index i (0/1 = oscs), including spread + master + tolerance. */
  _driftBase(i) {
    const spread = this._params['spread'] * (i === 0 ? -1 : 1);   // osc1 down, osc2 up
    return this._params[`osc${i + 1}.detune`] + this._params['osc.detune'] + spread + this._tolTune[i];
  }

  /** Swap one oscillator's waveform (regenerates its imperfect spectrum); no-op if unchanged. */
  _setWave(idx, type) {
    if (this._waveType[idx] === type) return;
    this._waveType[idx] = type;
    this._oscs[idx].setPeriodicWave(makeImperfectWave(this.context, type, { tolerance: 0.05 }));
  }

  /** Retune both oscillators to the current root note (octave + detune + spread + master + tolerance). */
  _retune(time) {
    const t      = time ?? this.context.currentTime;
    const master = this._params['osc.detune'];
    const spread = this._params['spread'];
    for (let i = 0; i < 2; i++) {
      const oct = this._params[`osc${i + 1}.octave`];
      const det = this._params[`osc${i + 1}.detune`];
      const sp  = spread * (i === 0 ? -1 : 1);   // osc1 down, osc2 up
      const freq = Machine.midiToFreq(this._rootMidi + oct * 12);
      this._oscs[i].frequency.cancelScheduledValues(t);
      this._oscs[i].frequency.setValueAtTime(freq, t);
      this._oscs[i].detune.setValueAtTime(det + master + sp + this._tolTune[i], t);
    }
  }

  /** Retune to the played note. Amplitude gating handled by the track Envelope. */
  noteOn(midiNote, velocity, time) {
    this._rootMidi = midiNote;
    this._retune(time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._drift.stop();
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    try { this._noiseSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
