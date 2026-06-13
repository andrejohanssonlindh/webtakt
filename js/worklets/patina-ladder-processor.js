/**
 * patina-ladder-processor.js
 * --------------------------
 * Huovilainen-style 4-pole transistor-ladder lowpass filter (Moog topology),
 * ported verbatim from PATINA's LADDER_WORKLET_SRC (js/patina/patina.js).
 *
 *   · tanh saturation in the input/feedback path (the "Moog growl")
 *   · resonance > 1.0 pushes it into self-oscillation
 *   · a slow thermal random walk modulates the cutoff (the `drift` param)
 *   · a whisper of noise keeps self-oscillation alive and denormals away
 *
 * Per-sample DSP — NOT a clean biquad. Used by Filter.js when its `filter.engine`
 * param is 'analogue'. Loaded once at app boot by AudioEngine (addModule) so that
 * `new AudioWorkletNode(ctx, 'patina-ladder')` is synchronous when a track switches
 * to the analogue engine.
 *
 * AudioParams:
 *   cutoff    — Hz, 10–18000, a-rate (envelope/LFO ride this)
 *   resonance — 0–1.15, k-rate (> ~1.0 self-oscillates)
 *   drive     — 0.1–12, k-rate (input gain into the tanh stage)
 *   drift     — 0–0.08, k-rate (thermal cutoff wander amount)
 *   shape     — 0–4, k-rate (filter response, see SHAPE_* below)
 *
 * Filter shape (Oberheim-Xpander-style pole mixing): the ladder is a 4-pole
 * lowpass by nature (output = s4), but weighted sums of the input `x` and the
 * four pole states s1..s4 yield other responses without leaving the Moog
 * topology. `shape` selects the mix:
 *   0 = LP  (s4)                         — 4-pole lowpass (default Moog)
 *   1 = HP  (x − 4s1 + 6s2 − 4s3 + s4)   — 4-pole highpass
 *   2 = BP  (4s2 − 8s3 + 4s4)            — band-pass
 *   3 = Notch (HP + LP)                  — band-reject
 *   4 = AP  (x − 8s1 + 24s2 − 32s3 + 16s4)— all-pass-ish (phase, flat-ish mag)
 * Self-oscillation (resonance > 1) rides every shape since the feedback path is
 * unchanged. The makeup gain stays tuned to the LP path; HP/BP/notch sit a touch
 * quieter, which is musically fine for a character filter.
 */

class PatinaLadder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff',    defaultValue: 1200, minValue: 10,  maxValue: 18000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.2,  minValue: 0,   maxValue: 1.15,  automationRate: 'k-rate' },
      { name: 'drive',     defaultValue: 1.0,  minValue: 0.1, maxValue: 12,    automationRate: 'k-rate' },
      { name: 'drift',     defaultValue: 0.004,minValue: 0,   maxValue: 0.08,  automationRate: 'k-rate' },
      { name: 'shape',     defaultValue: 0,    minValue: 0,   maxValue: 4,     automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0;
    this.thermal = 0;
    this.thermalTarget = 0;
    this.thermalClock = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'kill') this.alive = false; };
  }
  process(inputs, outputs, p) {
    if (!this.alive) return false;
    const inCh  = (inputs[0] && inputs[0][0]) || null;
    const out   = outputs[0];
    if (!out || !out[0]) return true;
    const n     = out[0].length;
    const res   = p.resonance[0];
    const drive = p.drive[0];
    const driftAmt = p.drift[0];
    const shape = Math.round(p.shape[0]) | 0;
    const cut   = p.cutoff;

    // Pole-mix coefficients (b0·x + b1·s1 + b2·s2 + b3·s3 + b4·s4) selecting the
    // filter response. Computed once per block (shape is k-rate).
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 1;   // default: LP (s4)
    switch (shape) {
      case 1: b0 = 1; b1 = -4; b2 = 6;  b3 = -4;  b4 = 1;  break; // HP
      case 2: b0 = 0; b1 = 0;  b2 = 4;  b3 = -8;  b4 = 4;  break; // BP
      case 3: b0 = 1; b1 = -4; b2 = 6;  b3 = -4;  b4 = 2;  break; // Notch (HP+LP)
      case 4: b0 = 1; b1 = -8; b2 = 24; b3 = -32; b4 = 16; break; // AP-ish
      default: b0 = 0; b1 = 0; b2 = 0;  b3 = 0;   b4 = 1;  break; // LP
    }
    const aRate = cut.length > 1;
    const sr    = sampleRate;
    const fMax  = sr * 0.45;
    const fb    = res * 4.2;                    // > 4 → self-oscillation
    const makeup = (1 + res * 0.85) / Math.max(1, Math.sqrt(drive));

    let s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4;

    for (let i = 0; i < n; i++) {
      /* thermal drift: bounded random walk, new target every ~25–50 ms */
      if (--this.thermalClock <= 0) {
        this.thermalTarget = Math.random() * 2 - 1;
        this.thermalClock = 1024 + ((Math.random() * 1024) | 0);
      }
      this.thermal += (this.thermalTarget - this.thermal) * 0.0006;

      let fc = (aRate ? cut[i] : cut[0]) * (1 + this.thermal * driftAmt);
      if (fc < 10) fc = 10; else if (fc > fMax) fc = fMax;
      const g = 1 - Math.exp(-6.283185307179586 * fc / sr);

      const xin = inCh ? inCh[i] : 0;
      /* tiny noise: seeds self-oscillation, kills denormals */
      let x = xin * drive + (Math.random() - 0.5) * 2e-6;
      x = Math.tanh(x - fb * Math.tanh(s4));

      s1 += g * (x  - s1);
      s2 += g * (s1 - s2);
      s3 += g * (s2 - s3);
      s4 += g * (s3 - s4);

      // Oberheim-style pole mix selects the response (LP/HP/BP/notch/AP).
      const y = (b0 * x + b1 * s1 + b2 * s2 + b3 * s3 + b4 * s4) * makeup;
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = y;
    }
    this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
    return true;
  }
}
registerProcessor('patina-ladder', PatinaLadder);
