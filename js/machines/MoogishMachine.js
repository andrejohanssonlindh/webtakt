/**
 * MoogishMachine.js
 * -----------------
 * Analogue-modelling oscillator machine — the tone-generator section of the
 * PATINA engine (js/patina/patina.js) adapted to the Webtakt machine contract.
 *
 * The analogue character comes from shared building blocks in AnalogueParts.js
 * (extracted from here / PATINA so the analogue drums reuse them too):
 *   - Custom oscillator spectra (`makeImperfectWave`): real analogue waveforms
 *     are never textbook-perfect. Component tolerance skews harmonic amplitudes,
 *     comparator asymmetry leaks even harmonics into "square" waves, and op-amp
 *     slew limiting rounds off the very top. Each oscillator gets a fresh,
 *     slightly different PeriodicWave so no two are identical.
 *   - Slow thermal pitch DRIFT (`DriftClock`): a bounded random walk nudges every
 *     oscillator's detune ~12×/s (own setInterval, like SwarmMachine). `drift` scales it.
 *   - Per-instance component TOLERANCE: fixed random tuning/level offsets baked
 *     in at construction, so two MoogishMachine instances differ subtly.
 *   - Pink-noise hiss layer (circuit noise) blended in pre-filter.
 *
 * This machine is the OSCILLATOR section only. It deliberately does NOT include
 * Patina's ladder filter, envelopes, LFO, or FX — those are owned by the
 * Webtakt Track (Filter / Envelope / LFO / FX), so the existing GUI tabs,
 * p-locks and LFO routing drive this machine's tone for free. The analogue
 * ladder filter is a separate, later phase (see project_patina_analogue memory
 * / DESIGN.md). For now Moogish feeds the standard biquad Filter chain.
 *
 * Persistent-oscillator architecture (like SynthMachine / StringsMachine): all
 * nodes run continuously and amplitude is gated entirely by the track Envelope.
 * noteOn just retunes; noteOff is a no-op. LFOs / mod-wheel bind permanently.
 *
 * Audio graph:
 *   Osc1 → g1 ─┐
 *   Osc2 → g2 ─┤
 *   Osc3 → g3 ─┤
 *   Sub  → gS ─┼→ _mixGain → outputGain → _trimGain → [Filter]
 *   Noise→ gN ─┤
 *   Hum  → gH ─┤
 *   Hum2 → gH2─┘
 *
 * Parameters (all p-lockable + LFO-assignable where they back an AudioParam):
 *   'osc1.waveform' 'osc1.octave' 'osc1.detune' 'osc1.level'
 *   'osc2.waveform' 'osc2.octave' 'osc2.detune' 'osc2.level'
 *   'osc3.waveform' 'osc3.octave' 'osc3.detune' 'osc3.level'
 *   'sub.level'     — sub sine, one octave below osc1 (0–1)
 *   'noise.level'   — circuit hiss (0–1)
 *   'drift'         — thermal pitch wander amount (0–1)
 *   'hum'           — mains hum level (0–1): sine at humFreq + 2nd harmonic
 *   'humFreq'       — 50 (Europe) | 60 (Americas) Hz
 *   'osc.detune'    — master detune cents (hidden, trig tab), -100..+100
 *   'output.level'  — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

const WAVEFORMS = ['saw', 'square', 'triangle', 'pulse', 'sine'];

export class MoogishMachine extends Machine {
  // Per-osc waveform/octave are JS side-effects (PeriodicWave swap / retune);
  // detune/level back AudioParams so they p-lock + LFO natively. 'osc.detune' is
  // the hidden trig-tab master detune; like other persistent-osc machines it is
  // manualTarget so the per-osc offsets are preserved (written via _retune).
  static SPEC = {
    'osc1.waveform': { label: 'O1 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       group: 'OSC 1', plockMode: 'js', apply: (v, t, m) => m._setWave(0, v) },
    'osc1.octave':   { label: 'O1 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 1',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc1.detune':   { label: 'O1 Detune', type: 'number', min: -50, max: 50, default: -6, group: 'OSC 1',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc1.level':    { label: 'O1 Level', type: 'number', min: 0, max: 1, default: 0.45, group: 'OSC 1',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[0].gain, schedule: 'setTarget', tc: 0.005 },

    'osc2.waveform': { label: 'O2 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       group: 'OSC 2', plockMode: 'js', apply: (v, t, m) => m._setWave(1, v) },
    'osc2.octave':   { label: 'O2 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 2',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc2.detune':   { label: 'O2 Detune', type: 'number', min: -50, max: 50, default: 7, group: 'OSC 2',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[1].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc2.level':    { label: 'O2 Level', type: 'number', min: 0, max: 1, default: 0.45, group: 'OSC 2',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[1].gain, schedule: 'setTarget', tc: 0.005 },

    'osc3.waveform': { label: 'O3 Wave', type: 'enum', options: WAVEFORMS, default: 'triangle',
                       group: 'OSC 3', plockMode: 'js', apply: (v, t, m) => m._setWave(2, v) },
    'osc3.octave':   { label: 'O3 Oct', type: 'number', min: -2, max: 2, default: -1, group: 'OSC 3',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc3.detune':   { label: 'O3 Detune', type: 'number', min: -50, max: 50, default: 2, group: 'OSC 3',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[2].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc3.level':    { label: 'O3 Level', type: 'number', min: 0, max: 1, default: 0.0, group: 'OSC 3',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[2].gain, schedule: 'setTarget', tc: 0.005 },

    'sub.level':     { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'noise.level':   { label: 'Noise', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._noiseGain.gain, schedule: 'setTarget', tc: 0.01 },
    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.5, group: 'TEXTURE',
                       plockMode: 'js' },
    // Mains hum (ported from Patina): a sine at humFreq + its 2nd harmonic, the
    // "circuit is never entirely quiet" floor. hum scales both levels; humFreq is
    // 50 Hz (Europe) or 60 Hz (Americas). _hum (a fixed scalar) drives the gains.
    'hum':           { label: 'Hum', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applyHum(t) },
    'humFreq':       { label: 'Hum Hz', type: 'enum', options: [50, 60], default: 50, group: 'TEXTURE',
                       plockMode: 'js', apply: (v, t, m) => m._applyHum(t) },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'moogish';
    this.label = 'Moogish';

    this._initSpec();
    this._rootMidi = 60;   // needed before any _retune (setParam during fromJSON)

    // Fixed per-instance "component tolerance" — like one slot in a vintage poly.
    this._tolTune  = rand() * 4;            // cents
    this._tolSub   = rand() * 2;            // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix bus — sums the three oscillators + sub + noise into outputGain.
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1;
    this._mixGain.connect(this.outputGain);

    // Three persistent main oscillators, each with its own imperfect spectrum.
    // _waveType[i] tracks the current waveform string so _setWave only rebuilds
    // the (randomised) PeriodicWave when the type actually changes — see _setWave.
    this._oscs       = [];
    this._gains      = [];
    this._waveType   = [];
    for (let i = 0; i < 3; i++) {
      const osc = context.createOscillator();
      const wf  = this._params[`osc${i + 1}.waveform`];
      osc.setPeriodicWave(makeImperfectWave(context, wf, { tolerance: 0.04 }));
      this._waveType[i] = wf;
      osc.frequency.value = 261.63;
      osc.detune.value    = this._params[`osc${i + 1}.detune`] + this._tolTune;

      const g = context.createGain();
      g.gain.value = this._params[`osc${i + 1}.level`];
      osc.connect(g);
      g.connect(this._mixGain);
      osc.start();

      this._oscs.push(osc);
      this._gains.push(g);
    }

    // Sub oscillator — sine, one octave below osc1.
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this._mixGain);
    this._oscSub = context.createOscillator();
    this._oscSub.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.02 }));
    this._oscSub.frequency.value = 130.81;
    this._oscSub.detune.value    = this._tolSub;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();

    // Circuit hiss — looped pink noise, gated by _noiseGain.
    this._noiseGain = context.createGain();
    this._noiseGain.gain.value = this._params['noise.level'];
    this._noiseGain.connect(this._mixGain);
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = makePinkBuffer(context, 2);
    this._noiseSrc.loop   = true;
    this._noiseSrc.playbackRate.value = 1 + rand() * 0.1; // decorrelate
    this._noiseSrc.connect(this._noiseGain);
    this._noiseSrc.start();

    // Mains hum — a sine at humFreq plus its 2nd harmonic (real hum is never a
    // pure tone), summed into the mix bus. Levels driven by _applyHum from the
    // `hum` param; ported from Patina (0.0011 / 0.0004 × hum). Off by default.
    this._humOsc  = context.createOscillator();
    this._humOsc2 = context.createOscillator();
    this._humOsc.type  = 'sine';
    this._humOsc2.type = 'sine';
    this._humGain  = context.createGain();
    this._humGain2 = context.createGain();
    this._humGain.gain.value  = 0;
    this._humGain2.gain.value = 0;
    this._humOsc.connect(this._humGain).connect(this._mixGain);
    this._humOsc2.connect(this._humGain2).connect(this._mixGain);
    this._humOsc.start();
    this._humOsc2.start();
    this._applyHum(context.currentTime);

    // Thermal drift clock — bounded random walk on every osc detune (3 main +
    // sub), ~12×/s. Each tick DriftClock adds a small wander on top of the
    // per-osc base detune supplied by _driftBase(). Released in disconnect()
    // (Machine base warns: un-released timers leak).
    this._drift = new DriftClock(
      context,
      [...this._oscs, this._oscSub].map(o => o.detune),
      { baseFor: i => this._driftBase(i), amountFor: () => this._params['drift'] * 3.5 },
    );

    this._retune(context.currentTime);
  }

  /** Base detune (excluding wander) for drift index i: 0–2 = main oscs, 3 = sub. */
  _driftBase(i) {
    if (i < 3) {
      return this._params[`osc${i + 1}.detune`] + this._params['osc.detune'] + this._tolTune;
    }
    return this._tolSub;
  }

  /**
   * Swap one oscillator's waveform (regenerates its imperfect spectrum).
   * No-op if the type is unchanged: makeImperfectWave bakes a *fresh random*
   * tolerance each call, so rebuilding on an identical type would re-randomise the
   * voice's character. VoicePool.nextVoice() re-applies every JS param (incl.
   * waveform) to non-canonical slots on every note via fromJSONSafe — without this
   * guard slots 1..N got a new spectrum per hit while the canonical slot 0 kept its
   * construction-time wave, so every Nth note (slot 0) audibly stood out.
   */
  _setWave(idx, type) {
    if (this._waveType[idx] === type) return;
    this._waveType[idx] = type;
    this._oscs[idx].setPeriodicWave(makeImperfectWave(this.context, type, { tolerance: 0.04 }));
  }

  /**
   * Retune all oscillators to the current root note, applying per-osc octave +
   * detune (+ master detune + component tolerance). Sub tracks osc1 one octave
   * below. Mirrors StringsMachine._applyTuning.
   */
  _retune(time) {
    const t = time ?? this.context.currentTime;
    const master = this._params['osc.detune'];
    for (let i = 0; i < 3; i++) {
      const oct  = this._params[`osc${i + 1}.octave`];
      const det  = this._params[`osc${i + 1}.detune`];
      const freq = Machine.midiToFreq(this._rootMidi + oct * 12);
      // Drop stale future frequency events from a previous held chord before
      // retuning — see SynthMachine.noteOn for the LiveArp octave-bleed rationale.
      this._oscs[i].frequency.cancelScheduledValues(t);
      this._oscs[i].frequency.setValueAtTime(freq, t);
      this._oscs[i].detune.setValueAtTime(det + master + this._tolTune, t);
    }
    const subOct = this._params['osc1.octave'];
    const subFreq = Machine.midiToFreq(this._rootMidi + subOct * 12 - 12);
    this._oscSub.frequency.cancelScheduledValues(t);
    this._oscSub.frequency.setValueAtTime(subFreq, t);
  }

  /**
   * Apply the mains-hum level + frequency. hum scales both the fundamental and
   * its (quieter) 2nd harmonic; humFreq selects 50/60 Hz. Levels ported from
   * Patina. setTargetAtTime so live `hum` knob moves don't click.
   */
  _applyHum(time) {
    const t    = time ?? this.context.currentTime;
    const hum  = this._params['hum'];
    const freq = Number(this._params['humFreq']);
    this._humOsc.frequency.setTargetAtTime(freq,     t, 0.05);
    this._humOsc2.frequency.setTargetAtTime(freq * 2, t, 0.05);
    this._humGain.gain.setTargetAtTime(0.0011 * hum, t, 0.1);
    this._humGain2.gain.setTargetAtTime(0.0004 * hum, t, 0.1);
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
    try { this._oscSub.stop();   } catch (_) {}
    try { this._noiseSrc.stop(); } catch (_) {}
    try { this._humOsc.stop();   } catch (_) {}
    try { this._humOsc2.stop();  } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). Per-osc
  // retune side-effects live in _retune, referenced by the spec apply hooks.
}
