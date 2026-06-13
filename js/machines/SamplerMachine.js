/**
 * SamplerMachine.js
 * -----------------
 * Sample playback machine. Plays a loaded AudioBuffer triggered per noteOn.
 * Self-enveloping: internal gain ramps handle amplitude; the track envelope
 * still sits in-chain for optional shaping (same pattern as drum machines).
 *
 * Audio graph:
 *   AudioBufferSourceNode (per-note) → outputGain → [Filter]
 *
 * Sample storage: AudioBuffer is decoded once; raw PCM float arrays are kept
 * in _channelData for waveform rendering and serialization. Serialized to
 * localStorage via SampleStore under a separate key ('webtakt_samples').
 *
 * Parameters:
 *   'sample.start'     — normalized start point (0–1)
 *   'sample.end'       — normalized end point (0–1)
 *   'sample.loopStart' — normalized loop-resume point (0–1); first pass plays from start,
 *                        subsequent loops restart here (must be >= sample.start)
 *   'sample.speed'     — playback rate multiplier (0.125–4)
 *   'sample.reverse'   — boolean (play backwards)
 *   'sample.loop'      — boolean (loop between start/end)
 *   'output.level'     — 0–1
 */

import { Machine } from './Machine.js';

export class SamplerMachine extends Machine {
  // All params are store-only (read fresh per-noteOn) — setParam writes no
  // AudioParam, so no entry has a non-manual `target`. output.level is
  // manualTarget: exposed to resolveAudioParam/LFO via `target`, but setParam
  // must NOT auto-schedule it (combined level × gain is applied per-noteOn).
  static SPEC = {
    'sample.start':     { label: 'Start',    type: 'number',  min: 0,   max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
    'sample.end':       { label: 'End',      type: 'number',  min: 0,   max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
    'sample.loopStart': { label: 'Loop Strt',type: 'number',  min: 0,   max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
    'sample.speed':     { label: 'Speed',    type: 'number',  min: 0.125, max: 4, default: 1,    modulatable: false, plockMode: 'js' },
    'sample.gain':      { label: 'Gain',     type: 'number',  min: 0,   max: 20,  default: 1,    modulatable: false, plockMode: 'js' },
    'sample.root':      { label: 'Root',     type: 'number',  min: 0,   max: 127, default: 60,   modulatable: false, plockMode: 'js' },
    'sample.reverse':   { label: 'Reverse',  type: 'boolean', default: false,                    plockMode: 'js' },
    'sample.loop':      { label: 'Loop',     type: 'boolean', default: false,                    plockMode: 'js' },
    'sample.pitch':     { label: 'Pitch',    type: 'boolean', default: true,                     plockMode: 'js' },
    'output.level':     { label: 'Level',    type: 'number',  min: 0,   max: 1,   default: 0.85,
                          modulatable: true, lfoMin: 0, lfoMax: 1,
                          target: m => m.outputGain.gain, manualTarget: true },
  };

  constructor(context) {
    super(context);
    this.type  = 'sampler';
    this.label = 'Sampler';

    this._initSpec();

    // The decoded AudioBuffer (or null if no sample loaded)
    this._buffer = null;
    // Unique id referencing the stored sample, for serialisation
    this.sampleId = null;
    // Human-readable name (filename or 'mic recording')
    this.sampleName = '';
    // Duration cached from buffer
    this._duration = 0;

    // Active source node (one at a time — cancel previous on new noteOn)
    this._source = null;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
  }

  /** @param {AudioBuffer} buffer  @param {string} id  @param {string} name */
  setBuffer(buffer, id, name) {
    this._buffer   = buffer;
    this.sampleId  = id;
    this.sampleName = name;
    this._duration = buffer.duration;
  }

  get hasBuffer() {
    return this._buffer !== null;
  }

  /** The loaded AudioBuffer (or null). Used by the panel's download button. */
  getBuffer() {
    return this._buffer;
  }

  /** Drop the loaded sample (panel RESET). Params are reset separately. */
  clearBuffer() {
    try { this._source?.stop(); } catch (_) {}
    this._source    = null;
    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this._duration  = 0;
  }

  noteOn(midiNote, velocity, time) {
    if (!this._buffer) return;

    // Stop any active source
    if (this._source) {
      try { this._source.stop(time); } catch (_) {}
      this._source = null;
    }

    const buf  = this._buffer;
    const dur  = buf.duration;
    const src  = this.context.createBufferSource();

    let startNorm = Math.min(this._params['sample.start'], this._params['sample.end']);
    let endNorm   = Math.max(this._params['sample.start'], this._params['sample.end']);
    if (endNorm - startNorm < 0.001) endNorm = Math.min(1, startNorm + 0.001);

    // loopStart clamped to [startNorm, endNorm] — first pass plays from startSec,
    // loop wraps to loopStartSec so an intro region is only heard once.
    const loopStartNorm = Math.max(startNorm, Math.min(endNorm, this._params['sample.loopStart']));

    const startSec     = startNorm     * dur;
    const endSec       = endNorm       * dur;
    const loopStartSec = loopStartNorm * dur;
    const lengthSec    = endSec - startSec;

    // Pitch tracking: multiply playbackRate by interval from root note
    const pitchRate = this._params['sample.pitch']
      ? Math.pow(2, (midiNote - this._params['sample.root']) / 12)
      : 1;
    const totalRate = this._params['sample.speed'] * pitchRate;

    const isReverse = this._params['sample.reverse'];
    const isLoop    = this._params['sample.loop'];

    src.playbackRate.value = totalRate;

    if (isReverse) {
      // Reversed: build a new buffer containing just the trimmed region, reversed.
      // loopStart in the reversed buffer corresponds to (endNorm - loopStartNorm).
      const revBuf       = this._buildReversed(buf, startNorm, endNorm);
      const revLoopStart = (endNorm - loopStartNorm) * dur;
      src.buffer = revBuf;
      src.loop = isLoop;
      if (isLoop) {
        src.loopStart = revLoopStart;
        src.loopEnd   = revBuf.duration;
      }
      src.start(time, 0, isLoop ? undefined : undefined);
    } else {
      src.buffer = buf;
      src.loop = isLoop;
      if (isLoop) {
        src.loopStart = loopStartSec;
        src.loopEnd   = endSec;
      }
      // Without loop: pass duration so playback stops at endSec even at non-1x rate.
      // lengthSec is buffer-time; the API's duration arg is also buffer-time (independent of playbackRate).
      src.start(time, startSec, isLoop ? undefined : lengthSec);
    }

    src.connect(this.outputGain);

    const velScale = velocity / 127;
    const gain     = this._params['sample.gain'] ?? 1;
    this.outputGain.gain.setValueAtTime(this._params['output.level'] * velScale * gain, time);

    this._source = src;
    src.onended = () => { if (this._source === src) this._source = null; };
  }

  noteOff(time) {
    // Self-enveloping — no-op (let buffer play to end or loop until next noteOn)
  }

  /** Build a new reversed AudioBuffer slice. Cheap for trim region. */
  _buildReversed(buf, startNorm, endNorm) {
    const sampleRate = buf.sampleRate;
    const startFrame = Math.floor(startNorm * buf.length);
    const endFrame   = Math.ceil(endNorm   * buf.length);
    const length     = endFrame - startFrame;
    const reversed   = this.context.createBuffer(buf.numberOfChannels, length, sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src  = buf.getChannelData(ch);
      const dst  = reversed.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        dst[i] = src[endFrame - 1 - i];
      }
    }
    return reversed;
  }

  connect(destinationNode) {
    this.outputGain.connect(destinationNode);
  }

  disconnect() {
    if (this._source) {
      try { this._source.stop(); } catch (_) {}
      this._source = null;
    }
    this.outputGain.disconnect();
  }

  // setParam/getParam/getParamList/resolveAudioParam derived from `static SPEC`.
  // toJSON/fromJSON stay overridden (carry sampleId/sampleName, not just params).

  toJSON() {
    return {
      type:       this.type,
      sampleId:   this.sampleId,
      sampleName: this.sampleName,
      params:     { ...this._params },
    };
  }

  fromJSON(obj) {
    // sampleId is handled externally (SampleStore loads and calls setBuffer)
    this.sampleId   = obj.sampleId   ?? null;
    this.sampleName = obj.sampleName ?? '';
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }

  /**
   * Copy the AudioBuffer reference from another SamplerMachine instance.
   * Called by VoicePool.nextVoice() so non-canonical slots stay in sync with slot 0.
   * AudioBuffers are immutable and safe to share across instances.
   */
  syncFrom(other) {
    if (!(other instanceof SamplerMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
