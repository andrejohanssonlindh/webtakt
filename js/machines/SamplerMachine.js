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
 *   'sample.start'   — normalized start point (0–1)
 *   'sample.end'     — normalized end point (0–1)
 *   'sample.speed'   — playback rate multiplier (0.125–4)
 *   'sample.reverse' — boolean (play backwards)
 *   'sample.loop'    — boolean (loop between start/end)
 *   'output.level'   — 0–1
 */

import { Machine } from './Machine.js';

export class SamplerMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'sampler';
    this.label = 'Sampler';

    this._params = {
      'sample.start':   0,
      'sample.end':     1,
      'sample.speed':   1,
      'sample.gain':    1,      // pre-amp multiplier (0–4), boosts quiet recordings
      'sample.reverse': false,
      'sample.loop':    false,
      'sample.pitch':   true,   // when true: track keyboard note; false = fixed pitch (drum mode)
      'sample.root':    60,     // MIDI root note the sample is tuned to (C4 = 60)
      'output.level':   0.85,
    };

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

    const startSec = startNorm * dur;
    const endSec   = endNorm   * dur;
    const lengthSec = endSec - startSec;

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
      // loopStart/End are in source-buffer time (not playback time).
      const revBuf = this._buildReversed(buf, startNorm, endNorm);
      src.buffer = revBuf;
      src.loop = isLoop;
      if (isLoop) {
        src.loopStart = 0;
        src.loopEnd   = revBuf.duration; // full reversed buffer
      }
      // Without loop: play the whole reversed buffer (no duration cap — let it finish naturally)
      src.start(time, 0, isLoop ? undefined : undefined);
    } else {
      src.buffer = buf;
      src.loop = isLoop;
      if (isLoop) {
        src.loopStart = startSec;
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

  setParam(path, value, time) {
    this._params[path] = value;
    // output.level and sample.gain both feed outputGain — recompute on either change.
    // We don't touch the AudioParam here for gain (no scheduled automation needed);
    // the combined level × gain is applied fresh on every noteOn.
  }

  getParam(path) {
    return this._params[path];
  }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    return null;
  }

  getParamList() {
    return [
      { path: 'sample.start',   label: 'Start',   type: 'number',  min: 0,   max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.end',     label: 'End',     type: 'number',  min: 0,   max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',   label: 'Speed',   type: 'number',  min: 0.125, max: 4, default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.gain',    label: 'Gain',    type: 'number',  min: 0,   max: 20,  default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.root',    label: 'Root',    type: 'number',  min: 0,   max: 127, default: 60,   modulatable: false, plockMode: 'js' },
      { path: 'sample.reverse', label: 'Reverse', type: 'boolean', default: false,                    plockMode: 'js' },
      { path: 'sample.loop',    label: 'Loop',    type: 'boolean', default: false,                    plockMode: 'js' },
      { path: 'sample.pitch',   label: 'Pitch',   type: 'boolean', default: true,                     plockMode: 'js' },
      { path: 'output.level',   label: 'Level',   type: 'number',  min: 0,   max: 1,   default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    ];
  }

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
}
