/**
 * wavetable-sampler-processor.js
 * --------------------------------
 * AudioWorkletProcessor for WavetableSamplerMachine.
 *
 * One playhead advances through a normalised 0–1 position space.
 * At each sample the playhead is scaled into each buffer's own trim region
 * independently, then the two values are linearly interpolated by `morph`.
 * This is true wavetable behaviour: morph sweeps between the two waveforms
 * without either buffer restarting — only the blend changes.
 *
 * Messages in  (from main thread):
 *   { type: 'bufferA', pcm: Float32Array[], length: number }
 *   { type: 'bufferB', pcm: Float32Array[], length: number }
 *   { type: 'trigger', rate, loop, startA, endA, loopStartA, startB, endB, loopStartB }
 *   { type: 'stop' }
 *
 * AudioParams (k-rate):
 *   morph — 0–1 crossfade (0 = full A, 1 = full B)
 *   gain  — output amplitude
 */

class WavetableSamplerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'morph', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain',  defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._bufA  = null;  // Float32Array[] channels
    this._bufB  = null;
    this._lenA  = 0;
    this._lenB  = 0;

    // Playhead lives in normalised space [0, 1] relative to the active region
    this._phase     = 0;
    this._active    = false;
    this._loop      = false;
    this._firstPass = true;  // true until the first loop wrap — intro region plays once
    this._baseRate  = 1;     // samples-per-sample advance (set at trigger)

    // Per-buffer trim regions, loop-start points, and gains
    this._startA = 0; this._endA = 1; this._loopStartA = 0; this._gainA = 1;
    this._startB = 0; this._endB = 1; this._loopStartB = 0; this._gainB = 1;

    // Pending trigger: held until currentTime reaches startTime
    this._pendingTrigger = null;

    this.port.onmessage = e => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === 'bufferA') {
      this._bufA = msg.pcm;
      this._lenA = msg.length;
    } else if (msg.type === 'bufferB') {
      this._bufB = msg.pcm;
      this._lenB = msg.length;
    } else if (msg.type === 'trigger') {
      // Store pending; process() will arm it when currentTime reaches startTime
      this._pendingTrigger = msg;
    } else if (msg.type === 'stop') {
      this._active = false;
      this._pendingTrigger = null;
    }
  }

  _armTrigger(msg) {
    this._baseRate   = msg.rate ?? 1;
    this._loop       = msg.loop ?? false;
    this._startA     = msg.startA     ?? 0;
    this._endA       = msg.endA       ?? 1;
    this._loopStartA = msg.loopStartA ?? this._startA;
    this._gainA      = msg.gainA      ?? 1;
    this._startB     = msg.startB     ?? 0;
    this._endB       = msg.endB       ?? 1;
    this._loopStartB = msg.loopStartB ?? this._startB;
    this._gainB      = msg.gainB      ?? 1;
    this._phase      = this._baseRate >= 0 ? 0 : 1;
    this._firstPass  = true;
    this._active     = true;
  }

  /** Read a sample from buf at normalised position p (0–1 within its trim region). */
  _read(buf, len, start, end, p) {
    if (!buf || len === 0) return 0;
    const regionStart = start * len;
    const regionLen   = (end - start) * len;
    if (regionLen <= 0) return 0;
    const pos     = regionStart + p * regionLen;
    const clamped = Math.max(0, Math.min(len - 1.001, pos));
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, len - 1);
    const t  = clamped - i0;
    return buf[0][i0] * (1 - t) + buf[0][i1] * t;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const ch = out[0];
    const n  = ch.length;

    // Arm a pending trigger once currentTime has reached its scheduled startTime
    if (this._pendingTrigger) {
      const startTime = this._pendingTrigger.startTime ?? 0;
      if (currentTime >= startTime) {
        this._armTrigger(this._pendingTrigger);
        this._pendingTrigger = null;
      }
    }

    if (!this._active || (!this._bufA && !this._bufB)) {
      ch.fill(0);
      for (let c = 1; c < out.length; c++) out[c].fill(0);
      return true;
    }

    const morph = params.morph[0];
    const gain  = params.gain[0];
    const rate  = this._baseRate;  // pitch + speed baked in at trigger time
    // Phase step per sample — normalised to region length
    // We need to advance 1/regionLen per sample at rate=1 to traverse the region
    // The reference region length is taken as a weighted blend of A and B lengths
    const refLen  = (this._lenA > 0 && this._lenB > 0)
      ? this._lenA * (1 - morph) + this._lenB * morph
      : Math.max(this._lenA, this._lenB, 1);
    const lenA    = (this._endA - this._startA) * this._lenA || 1;
    const lenB    = (this._endB - this._startB) * this._lenB || 1;
    const refRegion = lenA * (1 - morph) + lenB * morph;
    const phaseStep = rate / refRegion;   // normalised phase advance per sample

    const reverse = rate < 0;

    // Loop-start as a normalised phase fraction within region A and B.
    // We use an A/B weighted blend (same weight as refRegion) so the
    // restart point is consistent when morphing between the two buffers.
    const regionA = (this._endA - this._startA) || 1;
    const regionB = (this._endB - this._startB) || 1;
    const loopPhaseA = (this._loopStartA - this._startA) / regionA;
    const loopPhaseB = (this._loopStartB - this._startB) / regionB;
    const loopPhase  = Math.max(0, Math.min(1,
      loopPhaseA * (1 - morph) + loopPhaseB * morph));

    for (let i = 0; i < n; i++) {
      if (!this._active) { ch[i] = 0; continue; }

      const p = Math.max(0, Math.min(1, this._phase));

      const sA = this._read(this._bufA, this._lenA, this._startA, this._endA, p) * this._gainA;
      const sB = this._read(this._bufB, this._lenB, this._startB, this._endB, p) * this._gainB;

      ch[i] = (sA * (1 - morph) + sB * morph) * gain;

      this._phase += phaseStep;

      if (!reverse && this._phase >= 1) {
        if (this._loop) {
          this._phase = loopPhase + (this._phase - 1);
          this._firstPass = false;
        } else {
          this._active = false;
        }
      } else if (reverse && this._phase <= (this._firstPass ? 0 : loopPhase)) {
        // First reverse pass goes all the way to 0 (intro plays once).
        // Subsequent loops only go down to loopPhase then restart at 1.
        if (this._loop) {
          const overshoot = (this._firstPass ? 0 : loopPhase) - this._phase;
          this._phase = 1 - overshoot;
          this._firstPass = false;
        } else {
          this._active = false;
        }
      }
    }

    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor('wavetable-sampler-processor', WavetableSamplerProcessor);
