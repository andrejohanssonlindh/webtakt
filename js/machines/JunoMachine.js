/**
 * JunoMachine.js
 * --------------
 * Juno-style analogue PWM/string voice — the lush, wide counterpart to Moogish's
 * 3-osc growl. A single pulse-width-modulated oscillator + a square sub + a touch
 * of pink hiss, drift-detuned with per-instance component tolerance. Pairs with
 * the per-track BBD ChorusFX (auto-enabled by the analogue flow) for the classic
 * Juno pad/string shimmer.
 *
 * Built on the shared analogue toolkit (AnalogueParts.js) + the Phase-1 Moogish
 * PWM primitive: the pulse is `saw − saw_delayed(width/freq)` from ONE saw split
 * into a direct path and a delayed+inverted copy of itself, so the width is
 * continuously modulatable (a static `pulse` PeriodicWave can't be). A slow LFO on
 * `pwm.width` is the signature moving-PWM string sound.
 *
 * Persistent-oscillator architecture (like Moogish/Synth/Strings): all nodes run
 * continuously and amplitude is gated by the track Envelope. noteOn retunes;
 * noteOff is a no-op. LFOs / mod-wheel bind permanently.
 *
 * Audio graph:
 *   pwmOsc ─┬─────────────→ _pwmGain ─┐
 *           └→ delay → ×−1 ───────────┘ (= variable-width pulse)
 *   subOsc (square) → _subGain ────────┼→ _mixGain → outputGain → _trimGain → [Filter]
 *   pinkNoise       → _noiseGain ──────┘
 *
 * Parameters:
 *   'pwm.width'    — pulse duty cycle (0.05–0.95); LFO this for the moving string
 *   'octave'       — main-osc octave offset (−2..+2)
 *   'detune'       — fine detune cents (±50)
 *   'sub.level'    — square sub one octave below (0–1)
 *   'sub.waveform' — sub wave: square | triangle | sine
 *   'noise.level'  — pink-noise hiss (0–1)
 *   'drift'        — thermal pitch wander (0–1)
 *   'osc.detune'   — hidden trig-tab master detune (−100..+100)
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

const SUB_WAVES = ['square', 'triangle', 'sine'];

export class JunoMachine extends Machine {
  static SPEC = {
    'pwm.width':     { label: 'PW', type: 'number', min: 0.05, max: 0.95, default: 0.5, group: 'OSC',
                       modulatable: true, lfoMin: 0.05, lfoMax: 0.95, plockMode: 'js',
                       apply: (v, t, m) => m._applyPwmWidth(t) },
    'octave':        { label: 'Octave', type: 'number', min: -2, max: 2, default: 0, group: 'OSC',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'detune':        { label: 'Detune', type: 'number', min: -50, max: 50, default: 0, group: 'OSC',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._pwmOsc.detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'sub.level':     { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.3, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'sub.waveform':  { label: 'Sub Wave', type: 'enum', options: SUB_WAVES, default: 'square',
                       group: 'TEXTURE', plockMode: 'js', apply: (v, t, m) => m._setSubWave(v) },
    'noise.level':   { label: 'Noise', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._noiseGain.gain, schedule: 'setTarget', tc: 0.01 },
    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.4, group: 'TEXTURE',
                       plockMode: 'js' },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._pwmOsc.detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT', ampMaster: true,
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'juno';
    this.label = 'Juno';

    this._initSpec();
    this._rootMidi = 60;   // needed before any _retune (setParam during fromJSON)

    // Fixed per-instance "component tolerance" — like one slot in a vintage poly.
    this._tolTune = rand() * 4;            // cents
    this._tolSub  = rand() * 2;            // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix bus — sums the PWM osc + sub + noise into outputGain.
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1;
    this._mixGain.connect(this.outputGain);

    // ── PWM oscillator (the Phase-1 primitive) ───────────────────────────────
    // ONE imperfect saw split into a direct path and a delayed+inverted copy of
    // itself; their difference is a pulse of duty `pwm.width`. The delay tracks
    // pitch so the duty stays constant across the keyboard.
    this._pwmOsc = context.createOscillator();
    this._pwmOsc.setPeriodicWave(makeImperfectWave(context, 'saw', { tolerance: 0.04 }));
    this._pwmOsc.frequency.value = 261.63;
    this._pwmOsc.detune.value    = this._tolTune;
    this._pwmDelay  = context.createDelay(0.05);          // max 50 ms (≥ one period of 20 Hz)
    this._pwmInvert = context.createGain();
    this._pwmInvert.gain.value = -1;                      // subtract the delayed copy
    this._pwmGain   = context.createGain();
    this._pwmGain.gain.value = 1;                         // the PWM osc is the main voice
    this._pwmOsc.connect(this._pwmGain);                  // direct path
    this._pwmOsc.connect(this._pwmDelay);                 // delayed copy of the SAME saw
    this._pwmDelay.connect(this._pwmInvert);
    this._pwmInvert.connect(this._pwmGain);
    this._pwmGain.connect(this._mixGain);
    this._pwmOsc.start();

    // ── Sub oscillator — square (Juno sub), one octave below the main osc ─────
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this._mixGain);
    this._subWave = this._params['sub.waveform'];
    this._oscSub  = context.createOscillator();
    this._oscSub.setPeriodicWave(makeImperfectWave(context, this._subWave, { tolerance: 0.02 }));
    this._oscSub.frequency.value = 130.81;
    this._oscSub.detune.value    = this._tolSub;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();

    // ── Circuit hiss — looped pink noise, gated by _noiseGain ────────────────
    this._noiseGain = context.createGain();
    this._noiseGain.gain.value = this._params['noise.level'];
    this._noiseGain.connect(this._mixGain);
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = makePinkBuffer(context, 2);
    this._noiseSrc.loop   = true;
    this._noiseSrc.playbackRate.value = 1 + rand() * 0.1; // decorrelate
    this._noiseSrc.connect(this._noiseGain);
    this._noiseSrc.start();

    // Thermal drift on the main osc + sub detune (~12×/s), scaled by `drift`.
    this._drift = new DriftClock(
      context,
      [this._pwmOsc.detune, this._oscSub.detune],
      { baseFor: i => this._driftBase(i), amountFor: () => this._params['drift'] * 3.0 },
    );

    this._retune(context.currentTime);
  }

  /** Base detune (excluding wander) for drift index i: 0 = main osc, 1 = sub. */
  _driftBase(i) {
    if (i === 0) return this._params['detune'] + this._params['osc.detune'] + this._tolTune;
    return this._tolSub;
  }

  /** Swap the sub waveform (regenerates its imperfect spectrum); no-op if unchanged. */
  _setSubWave(type) {
    if (this._subWave === type) return;
    this._subWave = type;
    this._oscSub.setPeriodicWave(makeImperfectWave(this.context, type, { tolerance: 0.02 }));
  }

  /**
   * Set the PWM delay so duty = `pwm.width` of one period. delay = width/freq;
   * clamped to the delay node's max (50 ms). Short setTargetAtTime keeps live
   * width-knob / LFO moves click-free.
   */
  _applyPwmWidth(time) {
    const t     = time ?? this.context.currentTime;
    const width = this._params['pwm.width'];
    const oct   = this._params['octave'];
    const freq  = Machine.midiToFreq(this._rootMidi + oct * 12);
    const delay = Math.min(0.05, Math.max(0, width / Math.max(freq, 1e-6)));
    this._pwmDelay.delayTime.setTargetAtTime(delay, t, 0.005);
  }

  /** Retune main osc + sub (one octave below) to the current root note. */
  _retune(time) {
    const t      = time ?? this.context.currentTime;
    const oct    = this._params['octave'];
    const master = this._params['osc.detune'];
    const det    = this._params['detune'];
    const freq   = Machine.midiToFreq(this._rootMidi + oct * 12);
    this._pwmOsc.frequency.cancelScheduledValues(t);
    this._pwmOsc.frequency.setValueAtTime(freq, t);
    this._pwmOsc.detune.setValueAtTime(det + master + this._tolTune, t);

    const subFreq = Machine.midiToFreq(this._rootMidi + oct * 12 - 12);
    this._oscSub.frequency.cancelScheduledValues(t);
    this._oscSub.frequency.setValueAtTime(subFreq, t);

    this._applyPwmWidth(t);   // duty tracks pitch
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
    try { this._pwmOsc.stop();   } catch (_) {}
    try { this._oscSub.stop();   } catch (_) {}
    try { this._noiseSrc.stop(); } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
