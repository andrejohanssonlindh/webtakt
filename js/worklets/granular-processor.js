/**
 * granular-processor.js
 * ---------------------
 * AudioWorkletProcessor for GranularMachine.
 *
 * A grain cloud: while a note is held (gated open by the `gain` AudioParam)
 * the processor keeps spawning short, windowed grains read from the loaded
 * buffer. Each grain:
 *   - starts at buffer position `position` (param) + auto-`scan` offset +
 *     random `spray`,
 *   - is `grainSize` ms long with a raised-cosine (Hann) amplitude window,
 *   - is pitch-shifted by `pitchRate` (independent of position — the whole
 *     point of granular: scan-position and pitch are decoupled),
 *   - is panned by a random amount up to `spread` for a wide stereo cloud.
 *
 * `density` grains/sec sets how often a new grain launches; grains longer than
 * the spawn interval overlap into a smooth texture.
 *
 * `position` is a k-rate AudioParam so the main graph (LFO, p-lock, mod-wheel,
 * the panel knob) can scan the playhead with sample-thread precision — frozen
 * pads, slow sweeps, or fast scrubbing all come for free.
 *
 * `scan` (fraction of buffer per second, set at trigger) drifts an internal
 * offset forward automatically, so the machine doubles as a granular loop
 * player; scan = 0 → fully frozen at `position`.
 *
 * Messages in (from main thread):
 *   { type: 'buffer', pcm: Float32Array[], length, channels }
 *   { type: 'trigger', gain, grainSizeMs, density, sprayFrac, pitchRate,
 *                       spread, jitterFrac, scanFrac, reverse }
 *   { type: 'release', releaseTailFrames? }  // note-off: keep spawning for a
 *                       tail so the downstream amp envelope has signal to fade
 *   { type: 'stop' }    // hard kill (sample cleared)
 *
 * The cloud's amplitude SHAPE (attack/release) is the downstream Envelope's
 * ampGain, identical to oscillator machines — this worklet only opens/holds the
 * cloud, it does not shape the amp tail.
 *
 * AudioParams (k-rate):
 *   position — 0–1 normalised playhead into the buffer (LFO/p-lock target)
 *   gain     — output amplitude (set per-noteOn; 0 = silent)
 */

const TWO_PI = Math.PI * 2;

// How long the grain cloud keeps spawning after note-off so the downstream amp
// envelope (which owns the actual release shape) has signal to fade. Sized to
// cover the longest amp release (env.release max is 8 s) with headroom.
const RELEASE_TAIL_SEC = 8.5;

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'position', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain',     defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._buf      = null;   // Float32Array[] channels
    this._len      = 0;      // frames
    this._channels = 1;

    this._grains    = [];    // active grains
    this._maxGrains = 64;

    // Cloud state (set at trigger)
    this._active       = false;
    this._grainFrames  = 1764;  // ~40 ms @44.1k
    this._spawnEvery   = 441;   // frames between launches
    this._spawnAcc     = 0;
    this._sprayFrac    = 0;
    this._pitchRate    = 1;
    this._spread       = 0;
    this._jitterFrac   = 0;
    this._scanPerFrame = 0;     // auto-advance (fraction of buffer / frame)
    this._reverse      = false;
    this._startFrac    = 0;     // trim region start (0–1 of buffer)
    this._endFrac      = 1;     // trim region end   (0–1 of buffer)

    this._scanOffset   = 0;     // accumulated auto-scan (normalised, region-relative)
    this._envGain      = 0;     // smoothed output gate (de-click)
    this._releaseLeft  = 0;     // frames of post-noteOff tail still spawning grains

    this._rngState = 0x2545f491;

    this.port.onmessage = e => this._onMessage(e.data);
  }

  // xorshift PRNG — cheap, no Math.random in the audio hot path.
  _rand() {
    let x = this._rngState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rngState = x >>> 0;
    return (this._rngState & 0xffffff) / 0x1000000;
  }

  _onMessage(msg) {
    if (msg.type === 'buffer') {
      this._buf      = msg.pcm;
      this._len      = msg.length;
      this._channels = msg.channels ?? msg.pcm.length;
    } else if (msg.type === 'trigger') {
      this._grainFrames  = Math.max(8, Math.round((msg.grainSizeMs ?? 40) * 0.001 * sampleRate));
      const density      = Math.max(0.5, msg.density ?? 20);
      this._spawnEvery   = Math.max(1, Math.round(sampleRate / density));
      this._sprayFrac    = msg.sprayFrac ?? 0;
      this._pitchRate    = msg.pitchRate ?? 1;
      this._spread       = msg.spread ?? 0;
      this._jitterFrac   = msg.jitterFrac ?? 0;
      this._scanPerFrame = (msg.scanFrac ?? 0) / sampleRate;
      this._reverse      = !!msg.reverse;
      if (msg.startFrac != null) this._startFrac = msg.startFrac;
      if (msg.endFrac   != null) this._endFrac   = msg.endFrac;
      this._scanOffset   = 0;
      this._spawnAcc     = this._spawnEvery;  // launch one immediately
      this._active       = true;
      this._releaseLeft  = 0;
    } else if (msg.type === 'release') {
      // Note-off. We do NOT shape the fade here — the audible release is the
      // downstream amp envelope (Envelope.ampGain) that the whole signal chain
      // runs through, exactly like an oscillator machine whose oscillators keep
      // running while ampGain fades. To give that envelope signal to fade, we
      // keep spawning grains for a release TAIL rather than stopping at once
      // (the old behaviour killed the cloud in ~one grain length, so the amp
      // release had nothing left to act on). The tail is sized to cover the
      // longest amp release (env.release max is 8 s); residual grains past the
      // envelope's zero-crossing are multiplied by ~0 and inaudible, then we
      // idle. `releaseTailFrames` overrides the default when the caller knows
      // the exact release length.
      this._releaseLeft = msg.releaseTailFrames ?? Math.round(RELEASE_TAIL_SEC * sampleRate);
    } else if (msg.type === 'stop') {
      // Hard stop (sample cleared) — kill the cloud immediately.
      this._active      = false;
      this._releaseLeft = 0;
    }
  }

  _window(t) { return 0.5 - 0.5 * Math.cos(TWO_PI * t); }

  _spawnGrain(basePos) {
    if (!this._buf || this._len < 2) return;
    if (this._grains.length >= this._maxGrains) this._grains.shift();

    // Map the 0–1 base position into the trim region [start, end], then add
    // spray scaled to the region width, and wrap WITHIN the region so grains
    // never read outside the trimmed area.
    const lo  = Math.min(this._startFrac, this._endFrac);
    const hi  = Math.max(this._startFrac, this._endFrac);
    const span = Math.max(1e-6, hi - lo);
    let rel = (basePos - Math.floor(basePos));               // wrap base to [0,1)
    rel += (this._rand() * 2 - 1) * this._sprayFrac;          // spray (region-relative)
    rel = ((rel % 1) + 1) % 1;                                // wrap to [0,1)
    const posFrac = lo + rel * span;                          // into the region
    const startFrame = posFrac * this._len;

    const jitter = 1 + (this._rand() * 2 - 1) * this._jitterFrac;
    let step = this._pitchRate * jitter;
    if (this._reverse) step = -step;

    // Equal-power random pan within ±spread.
    const pan  = (this._rand() * 2 - 1) * this._spread;  // -spread..+spread
    const ang  = (pan + 1) * 0.25 * Math.PI;             // 0..π/2
    const gainL = Math.cos(ang);
    const gainR = Math.sin(ang);

    // Reverse grains read backwards from the far edge of their span.
    const read = step < 0 ? startFrame + this._grainFrames * Math.abs(step) : startFrame;

    this._grains.push({ read, step, age: 0, life: this._grainFrames, gainL, gainR });
  }

  _readMono(f) {
    let i = f;
    if (i < 0) i += this._len;
    if (i >= this._len) i -= this._len;
    if (i < 0 || i >= this._len) return 0;
    const i0 = Math.floor(i);
    const i1 = i0 + 1 >= this._len ? 0 : i0 + 1;
    const t  = i - i0;
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

    const posParam  = params.position;
    const gainParam = params.gain;

    if ((!this._active && this._grains.length === 0) || !this._buf) {
      outL.fill(0);
      if (stereo) outR.fill(0);
      this._envGain = 0;
      return true;
    }

    for (let i = 0; i < n; i++) {
      const position   = posParam[posParam.length > 1 ? i : 0];
      const targetGain = gainParam[gainParam.length > 1 ? i : 0] || 0;

      // De-click gate only. The gain AudioParam stays at the held velocity
      // level through the release tail — the audible fade is the DOWNSTREAM amp
      // envelope, not this gate. We just hold the cloud open so that envelope
      // has signal to fade, then de-click to 0 once the tail ends.
      const target = (this._active || this._releaseLeft > 0) ? targetGain : 0;
      this._envGain += (target - this._envGain) * 0.003;

      // Keep launching grains while held and through the release tail so the
      // downstream envelope's release acts on a live cloud, not silence.
      if (this._active || this._releaseLeft > 0) {
        if (++this._spawnAcc >= this._spawnEvery) {
          this._spawnAcc = 0;
          this._spawnGrain(position + this._scanOffset);
        }
        this._scanOffset += this._scanPerFrame;
        if (this._scanOffset > 1) this._scanOffset -= 1;
        else if (this._scanOffset < 0) this._scanOffset += 1;

        if (this._releaseLeft > 0 && --this._releaseLeft <= 0) {
          this._active      = false;
          this._releaseLeft = 0;
        }
      }

      let sL = 0, sR = 0;
      const grains = this._grains;
      for (let g = grains.length - 1; g >= 0; g--) {
        const gr = grains[g];
        if (gr.age >= gr.life) { grains.splice(g, 1); continue; }
        const w    = this._window(gr.age / gr.life);
        const mono = this._readMono(gr.read);
        sL += mono * w * gr.gainL;
        sR += mono * w * gr.gainR;
        gr.read += gr.step;
        gr.age++;
      }

      const og = this._envGain;
      outL[i] = sL * og;
      if (stereo) outR[i] = sR * og;
    }

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
