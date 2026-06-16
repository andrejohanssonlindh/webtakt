/**
 * bitcrush-processor.js
 * ---------------------
 * AudioWorkletProcessor for Crush2FX — a REAL bitcrusher, doing what the original
 * BitcrushFX could only approximate with a lowpass:
 *   · true sample-rate reduction via sample-and-hold (a held value for N samples)
 *   · true bit-depth reduction via quantisation to 2^bits levels
 *
 * Both are genuine per-sample DSP — the harsh aliasing and stair-step grit that a
 * filter can't fake. Mirrors the worklet conventions already in the project
 * (patina-ladder-processor.js): k-rate params, registered once at boot by
 * AudioEngine so construction is synchronous.
 *
 * AudioParams (k-rate):
 *   bits     — 1..16, output bit depth (16 ≈ clean)
 *   downsamp — 1..64, sample-and-hold factor (1 = no rate reduction)
 *   wet      — 0..1, dry/wet blend (dry passed through for parallel crush)
 *
 * Per-channel hold state persists across blocks so the hold phase is continuous.
 */

class BitcrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits',     defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'downsamp', defaultValue: 1,  minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'wet',      defaultValue: 1,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Per-channel sample-and-hold state.
    this._held    = [];   // last held output value per channel
    this._counter = [];   // samples since last hold update per channel
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'kill') this.alive = false; };
  }

  process(inputs, outputs, p) {
    if (!this.alive) return false;
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    const bits   = Math.max(1, Math.min(16, Math.round(p.bits[0])));
    const hold   = Math.max(1, Math.round(p.downsamp[0]));
    const wet    = p.wet[0];
    const dry    = 1 - wet;
    const levels = Math.pow(2, bits);
    const step   = 2 / levels;

    // Fallback to channel 0 when the input has fewer channels than the output
    // (mono source → stereo output): every output channel still gets real audio.
    const in0 = input && input[0] ? input[0] : null;
    for (let ch = 0; ch < output.length; ch++) {
      const out = output[ch];
      const inp = (input && input[ch]) ? input[ch] : in0;
      if (this._held[ch]    === undefined) this._held[ch]    = 0;
      if (this._counter[ch] === undefined) this._counter[ch] = 0;

      let held = this._held[ch];
      let cnt  = this._counter[ch];

      for (let i = 0; i < out.length; i++) {
        const x = inp ? inp[i] : 0;
        // Sample-and-hold: refresh the held sample every `hold` samples.
        if (cnt <= 0) {
          // Quantise to 2^bits levels (symmetric rounding, amplitude-preserving).
          let q = Math.round(x / step) * step;
          if (q >  1) q =  1; else if (q < -1) q = -1;
          held = q;
          cnt  = hold;
        }
        cnt--;
        out[i] = wet * held + dry * x;
      }
      this._held[ch]    = held;
      this._counter[ch] = cnt;
    }
    return true;
  }
}

registerProcessor('bitcrush', BitcrushProcessor);
