/**
 * KarplusMachine.js
 * -----------------
 * Karplus-Strong plucked string synthesis.
 *
 * The algorithm is implemented entirely in JavaScript (not via WebAudio feedback
 * loops, which are unstable in OfflineAudioContext and accumulate floating-point
 * DC drift over time). On each noteOn, the full decay is synthesised into an
 * AudioBuffer and played back via a BufferSourceNode — this is the standard
 * reliable approach for browser Karplus-Strong.
 *
 * Algorithm:
 *   1. Fill a wavetable of length = round(sampleRate / freq) with band-limited
 *      noise (lowpass-filtered white noise to model exciter tone).
 *   2. Repeatedly apply the Karplus-Strong update rule across the wavetable until
 *      amplitude falls below a threshold:
 *        y[n] = feedback × 0.5 × (y[n] + y[(n+1) % L])   [average filter]
 *      The average filter (b = [0.5, 0.5]) acts as the string's loss mechanism.
 *      'damping' controls how much LP filtering: fully warm = 0.5/0.5 average;
 *      fully bright = pass-through (no averaging).
 *   3. The resulting PCM is loaded into an AudioBuffer and played once.
 *
 * Parameters:
 *   'damping'      — blend 0–1: 0 = no damping (bright), 1 = full averaging (warm)
 *   'feedback'     — loop gain 0.8–0.999: how many cycles before silence
 *   'excite'       — noise burst length in ms (1–50): affects attack character
 *   'excite.tone'  — LP cutoff on initial noise (200–20000 Hz): pluck brightness
 *   'stretch'      — pitch stretch in cents (-12 to +12): slight detune/chorus
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { noiseRandomValue } from '../util/AudioBuffers.js';

export class KarplusMachine extends Machine {
  // All synthesis params are JS-only (read per-noteOn during buffer synthesis).
  static SPEC = {
    'damping':      { label: 'Damping', type: 'number', min: 0, max: 1, default: 0.5, group: 'STRING', plockMode: 'js' },
    'feedback':     { label: 'Feedback', type: 'number', min: 0.8, max: 0.999, default: 0.985, group: 'STRING', plockMode: 'js' },
    'excite':       { label: 'Excite', type: 'number', min: 1, max: 50, default: 8, group: 'EXCITE', plockMode: 'js' },
    'excite.tone':  { label: 'Excite Tone', type: 'number', min: 200, max: 20000, default: 8000, group: 'EXCITE', plockMode: 'js' },
    'stretch':      { label: 'Stretch', type: 'number', min: -12, max: 12, default: 0, group: 'STRING', plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT', ampMaster: true,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'karplus';
    this.label = 'Karplus';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    this._activeSrc = null;
  }

  noteOn(midiNote, velocity, time) {
    // Stop any previous note
    if (this._activeSrc) {
      try { this._activeSrc.stop(time); } catch (_) {}
      this._activeSrc = null;
    }

    const velScale   = velocity / 127;
    const sampleRate = this.context.sampleRate;

    // Apply stretch: slightly detune the frequency used for wavetable length
    const freq       = Machine.midiToFreq(midiNote);
    const stretchRatio = Math.pow(2, this._params['stretch'] / 1200);
    const effFreq    = freq * stretchRatio;

    const period     = Math.round(sampleRate / effFreq);   // wavetable length in samples
    const feedback   = this._params['feedback'];
    const damping    = this._params['damping'];             // 0=bright, 1=warm
    const exciteCut  = this._params['excite.tone'];
    // excite ms: how long to inject noise. Longer = softer, bowed attack. Shorter = sharp pluck.
    const exciteLen  = Math.max(period, Math.round(sampleRate * this._params['excite'] / 1000));

    // ── 1. Generate exciter: band-limited white noise ──
    // One-pole lowpass: y[n] = alpha*x[n] + (1-alpha)*y[n-1]
    const rcAlpha    = (2 * Math.PI * exciteCut / sampleRate);
    const lpAlpha    = rcAlpha / (1 + rcAlpha);

    const wavetable  = new Float32Array(exciteLen);
    let   lpState    = 0;
    for (let i = 0; i < exciteLen; i++) {
      const noise = noiseRandomValue() * 2 - 1;  // seeded in tests (deterministic), Math.random in app
      lpState     = lpAlpha * noise + (1 - lpAlpha) * lpState;
      wavetable[i] = lpState;
    }

    // Normalise wavetable to [-1, 1]
    let peak = 0;
    for (let i = 0; i < exciteLen; i++) peak = Math.max(peak, Math.abs(wavetable[i]));
    if (peak > 0) for (let i = 0; i < exciteLen; i++) wavetable[i] /= peak;

    // ── 2. Run Karplus-Strong iterations until inaudible ──
    // decay threshold: amplitude < -60 dB relative to velScale
    const threshold  = 0.001 * velScale;
    // max samples to generate (cap at 10 s to avoid huge buffers)
    const maxSamples = Math.min(sampleRate * 10, Math.ceil(
      period * Math.log(threshold) / Math.log(feedback * (1 - damping * 0.5))
    ));
    const totalLen   = Math.max(period * 4, isFinite(maxSamples) && maxSamples > 0 ? maxSamples : sampleRate * 3);

    const buf        = this.context.createBuffer(1, totalLen, sampleRate);
    const out        = buf.getChannelData(0);

    // Copy initial exciter noise into the output buffer
    for (let i = 0; i < exciteLen; i++) out[i] = wavetable[i] * velScale;

    // Karplus-Strong update: weighted average of two consecutive samples one period back.
    // avgCoeff=0.5 → full two-point average (warm/lossy); avgCoeff=0 → copy only (bright).
    const avgCoeff   = damping * 0.5;   // 0..0.5
    const passCoeff  = 1 - avgCoeff;    // 0.5..1

    // KS update starts after the exciter region; uses period (not exciteLen) as the delay
    for (let n = exciteLen; n < totalLen; n++) {
      // y[n-L] and y[n-L+1] are both already written (they are in the past)
      out[n] = feedback * (passCoeff * out[n - period] + avgCoeff * out[n - period + 1]);
    }

    // Scale to avoid clipping the output gain stage
    const outPeak = (() => { let p = 0; for (let i = 0; i < totalLen; i++) p = Math.max(p, Math.abs(out[i])); return p; })();
    if (outPeak > 0.98) { const s = 0.98 / outPeak; for (let i = 0; i < totalLen; i++) out[i] *= s; }

    // ── 3. Play back the buffer ──
    const src    = this.context.createBufferSource();
    src.buffer   = buf;
    src.loop     = false;
    src.connect(this.outputGain);
    src.start(time);
    src.stop(time + totalLen / sampleRate + 0.05);

    src.onended = () => {
      try { src.disconnect(); } catch (_) {}
      if (this._activeSrc === src) this._activeSrc = null;
    };

    this._activeSrc = src;
  }

  noteOff(time) {} // Self-decaying

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    if (this._activeSrc) {
      try { this._activeSrc.stop(); } catch (_) {}
      try { this._activeSrc.disconnect(); } catch (_) {}
      this._activeSrc = null;
    }
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class).
}
