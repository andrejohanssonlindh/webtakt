/**
 * SwarmMachine.js
 * ---------------
 * Seven sawtooth oscillators in a detuned cluster — inspired by the Syntakt
 * Super Swarm machine. One root oscillator tracks pitch exactly; six swarm
 * voices are spread symmetrically above and below it at a fixed cent interval.
 *
 * Persistent oscillator architecture (like SynthMachine): all seven oscs run
 * continuously, amplitude gated by the track Envelope. LFOs can connect to
 * any AudioParam permanently.
 *
 * Audio graph:
 *   _root (osc)        ────────────────────────────────┐
 *   _swarm[0..5] (osc) → _swarmGain (shared gain) ─────┴→ _mix → outputGain → [Filter]
 *
 * Noise modulation:
 *   A setInterval timer fires periodically and writes random detune targets to
 *   each swarm osc via setTargetAtTime. noise.amount controls the depth (cents),
 *   noise.color controls how fast the targets change (interval rate 50–800 ms).
 *   The setTargetAtTime time-constant smooths transitions so there are no clicks.
 *
 * Parameters:
 *   'osc.detune'    — root detune in cents (-100–+100), hidden (trig tab)
 *   'spread'        — cent gap between adjacent swarm voices (0–100¢)
 *   'height'        — swarm voice level relative to root (0–1)
 *   'noise.amount'  — drift depth in cents applied to swarm voices (0–50¢)
 *   'noise.color'   — drift rate: 0–1 (slow→fast, interval 800→50 ms)
 *   'output.level'  — master output level (0–1)
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

const NUM_SWARM = 6; // voices around the root (3 above, 3 below)

export class SwarmMachine extends Machine {
  static SPEC = {
    'osc.detune':   { label: 'Detune', type: 'number', min: -100, max: 100, default: 0,
                      modulatable: true, lfoMin: -100, lfoMax: 100, hidden: true,
                      target: m => m._root.detune, schedule: 'setTarget', tc: 0.005 },
    'spread':       { label: 'Spread', type: 'number', min: 0, max: 100, default: 15, plockMode: 'js',
                      apply: (v, t, m) => { m._applySpread(t); } },
    'height':       { label: 'Height', type: 'number', min: 0, max: 1, default: 0.7,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._swarmGain.gain, schedule: 'setTarget', tc: 0.005 },
    'noise.amount': { label: 'Noise Amt', type: 'number', min: 0, max: 50, default: 8,
                      modulatable: true, lfoMin: 0, lfoMax: 50, plockMode: 'js' },
    'noise.color':  { label: 'Noise Rate', type: 'number', min: 0, max: 1, default: 0.15,
                      modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                      apply: (v, t, m) => { m._driftInterval = m._colorToMs(v); m._startDriftTimer(); } },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'swarm';
    this.label = 'Swarm';

    this._initSpec();

    this._baseFreq = 440;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix node — all oscs sum here before outputGain
    // Normalise by voice count so volume stays consistent regardless of spread
    this._mix = context.createGain();
    this._mix.gain.value = 1 / (NUM_SWARM + 1);
    this._mix.connect(this.outputGain);

    // ── Root oscillator ──
    this._root = context.createOscillator();
    this._root.type            = 'sawtooth';
    this._root.frequency.value = 440;
    this._root.detune.value    = 0;
    this._root.connect(this._mix);
    this._root.start();

    // ── Swarm gain (controls height of the 6 satellite voices) ──
    this._swarmGain = context.createGain();
    this._swarmGain.gain.value = this._params['height'];
    this._swarmGain.connect(this._mix);

    // ── Six swarm oscillators ──
    // Voices paired: +1/-1, +2/-2, +3/-3 semitone slots
    // Actual cent offsets set in _applySpread()
    this._swarm = Array.from({ length: NUM_SWARM }, (_, i) => {
      const osc = context.createOscillator();
      osc.type            = 'sawtooth';
      osc.frequency.value = 440;
      osc.connect(this._swarmGain);
      osc.start();
      return osc;
    });

    this._applySpread();

    // ── Noise drift modulation ──
    // Timer fires at _driftInterval ms and writes a fresh random detune target
    // to each swarm osc via setTargetAtTime. Smooth transitions via time constant.
    this._driftInterval = this._colorToMs(this._params['noise.color']);
    this._driftTimer    = null;
    this._startDriftTimer();
  }

  // Map noise.color (0–1) to timer interval in ms: 800 ms (slow) → 50 ms (fast)
  _colorToMs(v) {
    return Math.round(800 * Math.pow(50 / 800, v));
  }

  _startDriftTimer() {
    if (this._driftTimer !== null) clearInterval(this._driftTimer);
    this._driftTimer = setInterval(() => this._tickDrift(), this._driftInterval);
  }

  _tickDrift() {
    const amount = this._params['noise.amount'];
    if (amount <= 0) return;
    const t  = this.context.currentTime;
    const tc = this._driftInterval / 1000 * 0.4; // smooth over ~40% of interval
    this._swarm.forEach((osc, i) => {
      const base = this._spreadBase[i] ?? 0;
      const rand = (Math.random() * 2 - 1) * amount;
      osc.detune.setTargetAtTime(base + rand, t, tc);
    });
  }

  // Compute detune offset for each swarm voice from spread param.
  // Voices: [ +1s, -1s, +2s, -2s, +3s, -3s ] where s = spread cents.
  // Also stores base offsets in _spreadBase so the drift timer can add on top.
  _applySpread(time) {
    const s = this._params['spread'];
    const t = time ?? this.context.currentTime;
    if (!this._spreadBase) this._spreadBase = new Array(NUM_SWARM).fill(0);
    this._swarm.forEach((osc, i) => {
      const slot  = Math.floor(i / 2) + 1;
      const sign  = (i % 2 === 0) ? 1 : -1;
      const cents = sign * slot * s;
      this._spreadBase[i] = cents;
      osc.detune.setValueAtTime(cents, t);
    });
  }

  noteOn(midiNote, velocity, time) {
    const freq = Machine.midiToFreq(midiNote);
    this._baseFreq = freq;
    this._root.frequency.setValueAtTime(freq, time);
    this._swarm.forEach(osc => osc.frequency.setValueAtTime(freq, time));
    // Re-anchor spread detunes at this time so drift doesn't fight frequency changes
    this._applySpread(time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode)  { this._trimGain.connect(destinationNode); }

  disconnect() {
    if (this._driftTimer !== null) { clearInterval(this._driftTimer); this._driftTimer = null; }
    try { this._root.stop(); } catch (_) {}
    this._swarm.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
