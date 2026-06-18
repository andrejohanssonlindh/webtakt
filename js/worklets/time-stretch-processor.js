/**
 * time-stretch-processor.js
 * -------------------------
 * AudioWorkletProcessor for TimeStretchMachine.
 *
 * Overlap-add (OLA / SOLA-lite) time stretching: the read pointer advances
 * through the buffer at `ratio` (the stretch factor), while overlapping Hann
 * grains are emitted at a fixed *synthesis* hop. ratio < 1 stretches (slows)
 * the loop without dropping pitch; ratio > 1 compresses (speeds) it. Pitch is
 * applied as a separate resampling factor *inside* each grain, so tempo and
 * pitch are fully independent.
 *
 * This is the "throw a loop in and it locks to the project BPM" behaviour:
 *   ratio = origBpm / projectBpm   (main thread computes and sends it)
 *
 * Grain model (per output sample, summed across overlapping grains):
 *   - synthesis hop  Hs = grainLen / overlap  (fixed in OUTPUT samples)
 *   - analysis hop   Ha = Hs * ratio           (advance of read pointer)
 *   - each grain reads grainLen analysis samples at `pitchRate` (resample),
 *     windowed by Hann; the window sum at `overlap`=4 is ~constant → no AM.
 *
 * Messages in:
 *   { type: 'buffer', pcm: Float32Array[], length, channels }
 *   { type: 'config', ratio, pitchRate, grainMs, loop, startFrac, endFrac, reverse }
 *   { type: 'trigger', gain }
 *   { type: 'release' }
 *
 * AudioParams (k-rate):
 *   gain — output amplitude (0 = silent)
 */

const TWO_PI = Math.PI * 2;
const OVERLAP = 4;   // grains overlapping at any time (4 = smooth, low AM)

class TimeStretchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._buf      = null;   // Float32Array[] channels
    this._len      = 0;
    this._channels = 1;

    this._active   = false;

    // Config (set via 'config')
    this._ratio     = 1;     // analysis-hop / synthesis-hop (stretch factor)
    this._pitchRate = 1;     // intra-grain resample (pitch)
    this._grainLen  = 2048;  // grain length in OUTPUT samples
    this._loop      = true;
    this._startFrac = 0;
    this._endFrac   = 1;
    this._reverse   = false;

    // Read pointer (in source frames), within [regionStart, regionEnd).
    this._readPos   = 0;

    // OLA scheduling: a small ring of active grains.
    this._grains    = [];
    this._sinceHop  = 0;     // output samples since last grain launch
    this._envGain   = 0;     // de-clicked gate

    this.port.onmessage = e => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === 'buffer') {
      this._buf      = msg.pcm;
      this._len      = msg.length;
      this._channels = msg.channels ?? msg.pcm.length;
    } else if (msg.type === 'config') {
      if (msg.ratio     != null) this._ratio     = Math.max(0.05, msg.ratio);
      if (msg.pitchRate != null) this._pitchRate = msg.pitchRate;
      if (msg.grainMs   != null) this._grainLen  = Math.max(128, Math.round(msg.grainMs * 0.001 * sampleRate));
      if (msg.loop      != null) this._loop      = !!msg.loop;
      if (msg.startFrac != null) this._startFrac = msg.startFrac;
      if (msg.endFrac   != null) this._endFrac   = msg.endFrac;
      if (msg.reverse   != null) this._reverse   = !!msg.reverse;
    } else if (msg.type === 'trigger') {
      this._active   = true;
      this._grains.length = 0;
      this._sinceHop = this._synthHop(); // launch immediately
      const rs = this._regionStart();
      const re = this._regionEnd();
      this._readPos  = this._reverse ? re : rs;
    } else if (msg.type === 'release') {
      this._active = false;
    }
  }

  _regionStart() { return Math.max(0, Math.min(this._endFrac, this._startFrac)) * this._len; }
  _regionEnd()   { return Math.max(this._startFrac, this._endFrac) * this._len; }
  _synthHop()    { return Math.max(1, Math.round(this._grainLen / OVERLAP)); }

  _window(t) { return 0.5 - 0.5 * Math.cos(TWO_PI * t); }

  _launchGrain() {
    if (!this._buf || this._len < 2) return;
    this._grains.push({
      src: this._readPos,   // source frame the grain starts reading from
      age: 0,               // output samples emitted from this grain
    });
    // Advance the read pointer by the analysis hop (= synthesis hop × ratio),
    // direction set by reverse. Wrap within the region when looping.
    const Ha = this._synthHop() * this._ratio;
    const rs = this._regionStart();
    const re = this._regionEnd();
    const span = Math.max(1, re - rs);
    if (this._reverse) {
      this._readPos -= Ha;
      if (this._readPos < rs) {
        if (this._loop) this._readPos = re - ((rs - this._readPos) % span);
        else this._active = false;
      }
    } else {
      this._readPos += Ha;
      if (this._readPos >= re) {
        if (this._loop) this._readPos = rs + ((this._readPos - re) % span);
        else this._active = false;
      }
    }
  }

  _readMono(f) {
    if (f < 0 || f >= this._len) return 0;
    const i0 = Math.floor(f);
    const i1 = i0 + 1 >= this._len ? i0 : i0 + 1;
    const t  = f - i0;
    if (this._channels > 1) {
      const a = this._buf[0], b = this._buf[1];
      const s0 = (a[i0] + b[i0]) * 0.5;
      const s1 = (a[i1] + b[i1]) * 0.5;
      return s0 * (1 - t) + s1 * t;
    }
    const a = this._buf[0];
    return a[i0] * (1 - t) + a[i1] * t;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const stereo = out.length > 1;
    const outR = stereo ? out[1] : out[0];
    const n    = outL.length;
    const gainParam = params.gain;

    if ((!this._active && this._grains.length === 0) || !this._buf) {
      outL.fill(0);
      if (stereo) outR.fill(0);
      this._envGain = 0;
      return true;
    }

    const grainLen = this._grainLen;
    const hop      = this._synthHop();
    const pitch    = this._pitchRate * (this._reverse ? -1 : 1);

    for (let i = 0; i < n; i++) {
      const targetGain = gainParam[gainParam.length > 1 ? i : 0] || 0;
      const target = this._active ? targetGain : 0;
      this._envGain += (target - this._envGain) * 0.003;

      // Launch new grains on the synthesis-hop schedule.
      if (this._active && ++this._sinceHop >= hop) {
        this._sinceHop = 0;
        this._launchGrain();
      }

      // Sum overlapping grains.
      let s = 0;
      const grains = this._grains;
      for (let g = grains.length - 1; g >= 0; g--) {
        const gr = grains[g];
        if (gr.age >= grainLen) { grains.splice(g, 1); continue; }
        const w = this._window(gr.age / grainLen);
        // Each grain reads forward at the pitch rate from its own start frame.
        const f = gr.src + gr.age * pitch;
        s += this._readMono(f) * w;
        gr.age++;
      }

      // OVERLAP=4 Hann window-sum ≈ 1.5 → normalise so level is consistent.
      const og = this._envGain * (2 / OVERLAP);
      outL[i] = s * og;
      if (stereo) outR[i] = s * og;
    }

    return true;
  }
}

registerProcessor('time-stretch-processor', TimeStretchProcessor);
