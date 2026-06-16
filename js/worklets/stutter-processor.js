/**
 * stutter-processor.js
 * --------------------
 * AudioWorkletProcessor for StutterFX — a beat-repeat / glitch-roll effect. It
 * keeps a rolling capture buffer; when "latched" it freezes the most recent slice
 * and loops it (the stutter), otherwise it passes audio through and keeps
 * capturing. The main thread sets the slice length (tempo-synced) and toggles the
 * latch (p-lockable per step → sequenced glitch rolls).
 *
 * Two ways to drive it:
 *   · 'auto' mode (chance > 0): at each slice boundary it randomly decides to
 *     latch-and-repeat the just-captured slice for a few divisions, or pass thru.
 *   · manual latch: messages { type:'latch', on:true|false } freeze/release now.
 *
 * AudioParams (k-rate):
 *   wet    — 0..1 dry/wet
 *   chance — 0..1 probability of an auto stutter at each slice boundary
 *
 * Messages in:
 *   { type:'config', sliceSamples:number, repeats:number }
 *   { type:'latch', on:boolean }
 *
 * Mono-summed capture, played to all output channels (glitch FX rarely needs
 * stereo capture and this keeps the buffer small/simple).
 */

const MAX_SLICE = 96000;   // ~2 s at 48 k — generous upper bound

class StutterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'wet',    defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'chance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._buf      = new Float32Array(MAX_SLICE);
    this._writePos = 0;          // capture write head (ring)
    this._slice    = 12000;      // current slice length in samples
    this._repeats  = 4;          // how many times a latched slice loops
    this._latched  = false;      // currently repeating?
    this._playPos  = 0;          // read head while latched
    this._repsLeft = 0;
    this._sinceBoundary = 0;     // samples since last slice boundary
    this.alive = true;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'kill') { this.alive = false; return; }
      if (d.type === 'config') {
        this._slice   = Math.max(64, Math.min(MAX_SLICE, d.sliceSamples | 0));
        this._repeats = Math.max(1, d.repeats | 0);
      } else if (d.type === 'latch') {
        this._setLatched(!!d.on);
      }
    };
  }

  _setLatched(on) {
    if (on && !this._latched) {
      // Freeze: the slice is the last `_slice` samples ending at writePos.
      this._latched  = true;
      this._playPos  = 0;
      this._repsLeft = this._repeats;
    } else if (!on) {
      this._latched = false;
    }
  }

  /** Read a sample from the captured slice at offset i (0.._slice-1). */
  _readSlice(i) {
    // Slice start = writePos - _slice (mod buffer), wrapped.
    let idx = (this._writePos - this._slice + i);
    idx %= MAX_SLICE; if (idx < 0) idx += MAX_SLICE;
    return this._buf[idx];
  }

  process(inputs, outputs, p) {
    if (!this.alive) return false;
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    const n   = output[0].length;
    const wet = p.wet[0];
    const dry = 1 - wet;
    const chance = p.chance[0];

    // Mono sum of the input for capture.
    const ch0 = input && input[0] ? input[0] : null;
    const ch1 = input && input[1] ? input[1] : ch0;

    for (let i = 0; i < n; i++) {
      const inMono = ch0 ? (ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]) : 0;

      // Always keep capturing into the ring (so the next freeze has fresh audio).
      this._buf[this._writePos] = inMono;
      this._writePos = (this._writePos + 1) % MAX_SLICE;

      // Slice-boundary bookkeeping drives auto-stutter decisions.
      if (++this._sinceBoundary >= this._slice) {
        this._sinceBoundary = 0;
        if (!this._latched && chance > 0 && Math.random() < chance) {
          this._setLatched(true);
        }
      }

      let wetSample;
      if (this._latched) {
        wetSample = this._readSlice(this._playPos);
        if (++this._playPos >= this._slice) {
          this._playPos = 0;
          if (--this._repsLeft <= 0) this._latched = false;
        }
      } else {
        wetSample = inMono;
      }

      const y = wet * wetSample + dry * inMono;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = y;
    }
    return true;
  }
}

registerProcessor('stutter', StutterProcessor);
