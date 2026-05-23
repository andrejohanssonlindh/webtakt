/**
 * WavetableMachine.js
 * -------------------
 * Wavetable oscillator with morphing between stored single-cycle waveforms.
 * Uses the Web Audio PeriodicWave API to define custom waveforms via
 * Fourier partial series. The 'pos' parameter sweeps the wavetable position
 * and is the primary modulation target — LFO/mod-wheel sweeps produce
 * the characteristic wavetable morphing sound.
 *
 * Wavetable bank (8 entries):
 *   0 — Sine
 *   1 — Triangle (odd harmonics, 1/n² rolloff)
 *   2 — Sawtooth (all harmonics, 1/n rolloff)
 *   3 — Square (odd harmonics, 1/n rolloff)
 *   4 — Pulse 25% (PWM-like partial series)
 *   5 — Bright Saw (emphasised upper harmonics)
 *   6 — Hollow (even harmonics suppressed, nasal)
 *   7 — Vocal / formant (boosted 3rd–5th harmonics)
 *
 * Morphing implementation:
 *   Two persistent OscillatorNodes (_oscA, _oscB) hold adjacent wavetable
 *   entries and a crossfade GainNode pair blends between them based on the
 *   fractional wavetable position. This gives continuous morphing through
 *   the table without clicks.
 *
 * Persistent node architecture — amplitude gated by track Envelope.
 *
 * Audio graph:
 *   _oscA → _gainA ─┐
 *   _oscB → _gainB ─┴→ _mix → outputGain → [Filter]
 *
 * Parameters:
 *   'osc.detune'   — coarse detune in cents (-100 to +100), hidden (trig tab)
 *   'pos'          — wavetable position (0.0 – 7.0, float), morphs between entries
 *   'sub.level'    — sub oscillator level (0–1), one octave below, pure sine
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';

const NUM_WAVETABLES = 8;
const PARTIAL_COUNT  = 32; // harmonics to use when building PeriodicWave

function _buildWave(context, index) {
  const real = new Float32Array(PARTIAL_COUNT + 1);
  const imag = new Float32Array(PARTIAL_COUNT + 1);
  // imag[0] and real[0] are DC offset — always 0

  switch (index) {
    case 0: // Sine — single partial
      imag[1] = 1;
      break;

    case 1: // Triangle — odd harmonics, 1/n² with alternating sign
      for (let n = 1; n <= PARTIAL_COUNT; n += 2) {
        const k = Math.floor(n / 2);
        imag[n] = (k % 2 === 0 ? 1 : -1) / (n * n);
      }
      break;

    case 2: // Sawtooth — all harmonics 1/n
      for (let n = 1; n <= PARTIAL_COUNT; n++) {
        imag[n] = 1 / n;
      }
      break;

    case 3: // Square — odd harmonics 1/n
      for (let n = 1; n <= PARTIAL_COUNT; n += 2) {
        imag[n] = 1 / n;
      }
      break;

    case 4: // Pulse 25% — Fourier series for 25% duty cycle
      for (let n = 1; n <= PARTIAL_COUNT; n++) {
        imag[n] = Math.sin(Math.PI * n * 0.25) / (Math.PI * n * 0.25) / n;
      }
      break;

    case 5: // Bright Saw — sawtooth with boosted upper harmonics
      for (let n = 1; n <= PARTIAL_COUNT; n++) {
        const boost = 1 + (n / PARTIAL_COUNT) * 1.5;
        imag[n] = (1 / n) * boost;
      }
      break;

    case 6: // Hollow — even harmonics reduced, nasal character
      for (let n = 1; n <= PARTIAL_COUNT; n++) {
        const isodd = n % 2 === 1;
        imag[n] = isodd ? 1 / n : 0.15 / n;
      }
      break;

    case 7: // Vocal/formant — emphasised 3rd–5th harmonics
      for (let n = 1; n <= PARTIAL_COUNT; n++) {
        let amp = 1 / n;
        if (n >= 3 && n <= 5) amp *= 3.5;
        if (n >= 6 && n <= 9) amp *= 1.8;
        imag[n] = amp;
      }
      break;
  }

  // Normalise
  let peak = 0;
  for (let i = 0; i <= PARTIAL_COUNT; i++) peak = Math.max(peak, Math.abs(real[i]), Math.abs(imag[i]));
  if (peak > 0) {
    for (let i = 0; i <= PARTIAL_COUNT; i++) { real[i] /= peak; imag[i] /= peak; }
  }

  return context.createPeriodicWave(real, imag, { disableNormalization: true });
}

export class WavetableMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'wavetable';
    this.label = 'Wavetable';

    this._params = {
      'osc.detune':   0,
      'pos':          2.0,    // start at sawtooth position
      'sub.level':    0.25,
      'output.level': 0.8,
    };

    // Pre-build all PeriodicWave objects
    this._waves = Array.from({ length: NUM_WAVETABLES }, (_, i) => _buildWave(context, i));

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Mix node
    this._mix = context.createGain();
    this._mix.gain.value = 0.5;
    this._mix.connect(this.outputGain);

    // Crossfade gain A (current table)
    this._gainA = context.createGain();
    this._gainA.gain.value = 1.0;
    this._gainA.connect(this._mix);

    // Crossfade gain B (next table)
    this._gainB = context.createGain();
    this._gainB.gain.value = 0.0;
    this._gainB.connect(this._mix);

    // Oscillator A
    this._oscA = context.createOscillator();
    this._oscA.setPeriodicWave(this._waves[2]); // sawtooth
    this._oscA.frequency.value = 440;
    this._oscA.detune.value    = 0;
    this._oscA.connect(this._gainA);
    this._oscA.start();

    // Oscillator B
    this._oscB = context.createOscillator();
    this._oscB.setPeriodicWave(this._waves[3]); // square (next from saw)
    this._oscB.frequency.value = 440;
    this._oscB.detune.value    = 0;
    this._oscB.connect(this._gainB);
    this._oscB.start();

    // Sub oscillator — persistent pure sine, one octave below
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this.outputGain);

    this._oscSub = context.createOscillator();
    this._oscSub.type            = 'sine';
    this._oscSub.frequency.value = 220;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();

    // Apply initial position
    this._applyPos(this._params['pos']);

    // Track which table indices are loaded in A/B
    this._tableA = 2;
    this._tableB = 3;
  }

  _applyPos(pos) {
    const clamped = Math.max(0, Math.min(NUM_WAVETABLES - 1 - 1e-6, pos));
    const idxA    = Math.floor(clamped);
    const idxB    = Math.min(idxA + 1, NUM_WAVETABLES - 1);
    const frac    = clamped - idxA;

    // Reload PeriodicWave if the integer table changed
    if (idxA !== this._tableA) {
      this._oscA.setPeriodicWave(this._waves[idxA]);
      this._tableA = idxA;
    }
    if (idxB !== this._tableB) {
      this._oscB.setPeriodicWave(this._waves[idxB]);
      this._tableB = idxB;
    }

    const t = this.context.currentTime;
    this._gainA.gain.setTargetAtTime(1 - frac, t, 0.005);
    this._gainB.gain.setTargetAtTime(frac,     t, 0.005);
  }

  noteOn(midiNote, velocity, time) {
    const freq = Machine.midiToFreq(midiNote);
    this._oscA.frequency.setValueAtTime(freq,     time);
    this._oscB.frequency.setValueAtTime(freq,     time);
    this._oscSub.frequency.setValueAtTime(freq / 2, time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    try { this._oscA.stop();   } catch (_) {}
    try { this._oscB.stop();   } catch (_) {}
    try { this._oscSub.stop(); } catch (_) {}
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'osc.detune':
        this._oscA.detune.setTargetAtTime(value, t, 0.005);
        this._oscB.detune.setTargetAtTime(value, t, 0.005);
        break;
      case 'pos':
        this._applyPos(value);
        break;
      case 'sub.level':
        this._subGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'osc.detune',   label: 'Detune',    type: 'number', min: -100, max: 100,                  default: 0,   modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
      { path: 'pos',          label: 'Pos',        type: 'number', min: 0,    max: NUM_WAVETABLES - 1,   default: 2.0, modulatable: true, lfoMin: 0,    lfoMax: NUM_WAVETABLES - 1, plockMode: 'js' },
      { path: 'sub.level',    label: 'Sub Level',  type: 'number', min: 0,    max: 1,                    default: 0.25, modulatable: true, lfoMin: 0,   lfoMax: 1,   plockMode: 'audioParam' },
      { path: 'output.level', label: 'Level',      type: 'number', min: 0,    max: 1,                    default: 0.8,  modulatable: true, lfoMin: 0,   lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'osc.detune':   return this._oscA.detune;
      case 'sub.level':    return this._subGain.gain;
      case 'output.level': return this.outputGain.gain;
      // 'pos' crossfade uses JS (PeriodicWave swap) — no single AudioParam
      default: return null;
    }
  }

  toJSON()      { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
