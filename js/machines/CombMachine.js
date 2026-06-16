/**
 * CombMachine.js
 * --------------
 * Pitched resonator — bell, marimba, gamelan, music box.
 *
 * Two decaying sinusoidal partials are synthesised into an AudioBuffer on each
 * noteOn and played back once. This is numerically stable and pitch-accurate
 * (unlike a DelayNode feedback loop). The character of the instrument is shaped
 * by the ratio and relative decay of the two partials, plus a short noise burst
 * ("strike") at the attack.
 *
 * Partial structure:
 *   partial 1 — fundamental (MIDI note frequency)
 *   partial 2 — fundamental × ratio  (inharmonic interval)
 *
 * Example ratio presets:
 *   1.0   — unison / pure tone (flute-like)
 *   2.756 — church bell minor-third partial
 *   4.0   — marimba (4th harmonic, decays 6× faster)
 *   2.0   — octave (vibraphone-like)
 *
 * Audio graph:
 *   BufferSourceNode (pre-synthesised per note) → outputGain → [Filter]
 *
 * Parameters:
 *   'ratio'        — frequency ratio of partial 2 to partial 1 (0.5–8)
 *   'decay'        — decay time of partial 1 in seconds (0.1–8)
 *   'decay2'       — decay time of partial 2 relative to partial 1 (0.1–2 ×)
 *   'mix'          — blend 0=partial1 only, 1=partial2 only (0–1)
 *   'strike'       — noise burst level at attack (0–1)
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

export class CombMachine extends Machine {
  // All partial params are JS-only (read per-noteOn during buffer synthesis).
  // 'decay'/'mix' are modulatable but plockMode:'js' (no AudioParam target);
  // 'ratio'/'decay2'/'strike' emit modulatable:false explicitly.
  static SPEC = {
    'ratio':        { label: 'Ratio', type: 'number', min: 0.5, max: 8, default: 2.756, group: 'TUBE', modulatable: false, plockMode: 'js' },
    'decay':        { label: 'Decay', type: 'number', min: 0.1, max: 8, default: 1.8, group: 'TUBE', modulatable: true, lfoMin: 0.1, lfoMax: 8, plockMode: 'js' },
    'decay2':       { label: 'Decay 2', type: 'number', min: 0.1, max: 2, default: 0.35, group: 'TUBE', modulatable: false, plockMode: 'js' },
    'mix':          { label: 'Mix', type: 'number', min: 0, max: 1, default: 0.4, group: 'VOICE', modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
    'strike':       { label: 'Strike', type: 'number', min: 0, max: 1, default: 0.6, group: 'VOICE', modulatable: false, plockMode: 'js' },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'comb';
    this.label = 'Comb';

    this._initSpec();

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    this._activeSrc = null;
  }

  noteOn(midiNote, velocity, time) {
    if (this._activeSrc) {
      try { this._activeSrc.stop(time); } catch (_) {}
      this._activeSrc = null;
    }

    const velScale   = velocity / 127;
    const sampleRate = this.context.sampleRate;
    const freq       = Machine.midiToFreq(midiNote);

    const ratio      = this._params['ratio'];
    const decay1     = this._params['decay'];
    const decay2     = decay1 * this._params['decay2'];
    const mix        = this._params['mix'];          // 0 = p1 only, 1 = p2 only
    const strikeAmt  = this._params['strike'];

    // Total length: render until both partials are inaudible (-72 dB)
    const longerDecay = Math.max(decay1, decay2);
    const totalLen    = Math.min(
      Math.ceil(sampleRate * (longerDecay * 5 + 0.05)),
      sampleRate * 12
    );

    const buf = this.context.createBuffer(1, totalLen, sampleRate);
    const out = buf.getChannelData(0);

    // ── Partial 1: fundamental ──
    const w1     = 2 * Math.PI * freq / sampleRate;
    const env1   = Math.exp(-1 / (decay1 * sampleRate));   // per-sample decay factor
    const amp1   = (1 - mix) * velScale;

    // ── Partial 2: inharmonic overtone ──
    const freq2  = freq * ratio;
    const w2     = 2 * Math.PI * freq2 / sampleRate;
    const env2   = Math.exp(-1 / (decay2 * sampleRate));
    const amp2   = mix * velScale;

    // ── Strike: very short bandpass noise burst ──
    // Rendered directly into out[] then left to decay with the sinusoids
    const strikeSamples = Math.min(Math.round(sampleRate * 0.008), totalLen);
    if (strikeAmt > 0) {
      // One-pole LP + HP to make a bandpass centred near partial 1–2 midpoint
      const centreHz   = freq * Math.sqrt(ratio);    // geometric mean of the two partials
      const lpC        = 2 * Math.PI * Math.min(centreHz * 2, 18000) / sampleRate;
      const lpA        = lpC / (1 + lpC);
      const hpC        = 2 * Math.PI * Math.max(freq * 0.5, 40) / sampleRate;
      const hpA        = 1 / (1 + hpC);
      let lp = 0, hp = 0, hpPrev = 0;
      const strikeDecay = Math.exp(-1 / (0.003 * sampleRate));
      let strikeEnv = strikeAmt * velScale;
      for (let i = 0; i < strikeSamples; i++) {
        const noise = Math.random() * 2 - 1;
        lp = lpA * noise + (1 - lpA) * lp;
        const hpIn = lp;
        hp = hpA * (hp + hpIn - hpPrev);
        hpPrev = hpIn;
        out[i] += hp * strikeEnv;
        strikeEnv *= strikeDecay;
      }
    }

    // ── Sum decaying sinusoids into buffer ──
    let a1 = amp1, a2 = amp2;
    for (let n = 0; n < totalLen; n++) {
      out[n] += a1 * Math.sin(w1 * n) + a2 * Math.sin(w2 * n);
      a1 *= env1;
      a2 *= env2;
    }

    // ── Normalise peak to 0.95 ──
    let peak = 0;
    for (let i = 0; i < totalLen; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0.95) {
      const s = 0.95 / peak;
      for (let i = 0; i < totalLen; i++) out[i] *= s;
    }

    const src  = this.context.createBufferSource();
    src.buffer = buf;
    src.loop   = false;
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
