/**
 * SlicerMachine.js
 * ----------------
 * Slice-and-trigger sample machine. The loaded buffer is divided into N equal
 * slices; each noteOn plays one slice (one-shot, optionally looped). This is
 * the classic breakbeat-chop / drum-from-a-loop workflow: drop in a drum loop,
 * set `slices` to 16, and every step can fire a different slice.
 *
 * Slice selection (two ways, per the SLICE BY mode):
 *   - 'note'  : the MIDI note picks the slice. note == `slice.base` plays slice
 *               0, each semitone up advances one slice (chromatic chopping from
 *               a keyboard or note rows). Wraps modulo the slice count.
 *   - 'fixed' : the `slice` param picks the slice. P-lock `slice` per step for
 *               per-step slice locks regardless of the played note.
 * Either way `slice` is an enum param so it shows in the UI and is p-lockable;
 * in 'note' mode it just tracks whatever the note selected (display only).
 *
 * Self-enveloping (like SamplerMachine): one AudioBufferSourceNode per noteOn,
 * amplitude set on outputGain at note start; noteOff is a no-op (the slice
 * plays to its end, or loops until the next note).
 *
 * Audio graph:
 *   AudioBufferSourceNode (per-note) → outputGain → [Filter]
 *
 * Single-buffer protocol (getBuffer/setBuffer/clearBuffer/hasBuffer/syncFrom,
 * sampleId/sampleName) — same as SamplerMachine, so it gets VoicePool carry-over
 * and SampleStore reload for free.
 */

import { Machine } from './Machine.js';

const MAX_SLICES = 64;

export class SlicerMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'slicer';
    this.label = 'Slicer';

    this._params = {
      'slices':      16,        // number of equal slices (1–64)
      'slice':       0,         // active slice index (enum; p-lockable in 'fixed' mode)
      'slice.mode':  'note',    // 'note' | 'fixed'
      'slice.base':  60,        // MIDI note that maps to slice 0 (note mode)
      'sample.start': 0,        // trim region start (0–1); slices divide this region
      'sample.end':   1,        // trim region end   (0–1)
      'sample.speed': 1,        // playback rate multiplier
      'sample.gain':  1,        // pre-output gain
      'sample.reverse': false,  // play slice backwards
      'sample.loop':  false,    // loop the slice region
      'gate':        1,         // fraction of the slice length to play (0.05–1)
      'output.level': 0.85,
    };

    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;

    this._source = null;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
  }

  // ── Single-buffer protocol ─────────────────────────────────────────────────

  setBuffer(buffer, id, name) {
    this._buffer    = buffer;
    this.sampleId   = id;
    this.sampleName = name;
    this._duration  = buffer.duration;
  }

  get hasBuffer() { return this._buffer !== null; }
  getBuffer() { return this._buffer; }

  clearBuffer() {
    try { this._source?.stop(); } catch (_) {}
    this._source    = null;
    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;
  }

  /** Resolve the slice index for this note, clamped/wrapped to the slice count. */
  _resolveSlice(midiNote) {
    const count = Math.max(1, Math.round(this._params['slices']));
    let idx;
    if (this._params['slice.mode'] === 'note') {
      idx = midiNote - this._params['slice.base'];
    } else {
      idx = Math.round(this._params['slice']);
    }
    // Wrap into [0, count) so out-of-range notes still hit a valid slice.
    idx = ((idx % count) + count) % count;
    return { idx, count };
  }

  noteOn(midiNote, velocity, time) {
    if (!this._buffer) return;

    if (this._source) {
      try { this._source.stop(time); } catch (_) {}
      this._source = null;
    }

    const { idx, count } = this._resolveSlice(midiNote);
    // Keep `slice` param reflecting what actually played (so the UI/plock value
    // is meaningful in 'note' mode too).
    this._params['slice'] = idx;

    // Slices divide the TRIM region [start, end], not the whole buffer.
    const dur       = this._buffer.duration;
    const lo        = Math.min(this._params['sample.start'], this._params['sample.end']);
    const hi        = Math.max(this._params['sample.start'], this._params['sample.end']);
    const regionSec = Math.max(0.001, (hi - lo) * dur);
    const regionStartSec = lo * dur;
    const sliceLen  = regionSec / count;
    const startSec  = regionStartSec + idx * sliceLen;
    const gateFrac  = Math.max(0.02, Math.min(1, this._params['gate']));
    const playLen   = sliceLen * gateFrac;

    const rate   = this._params['sample.speed'] || 1;
    const isRev  = this._params['sample.reverse'];
    const isLoop = this._params['sample.loop'];

    const src = this.context.createBufferSource();
    src.playbackRate.value = rate;

    if (isRev) {
      // Build a reversed copy of just this slice region.
      const revBuf = this._buildReversedSlice(this._buffer, startSec, playLen);
      src.buffer = revBuf;
      src.loop = isLoop;
      if (isLoop) { src.loopStart = 0; src.loopEnd = revBuf.duration; }
      src.start(time, 0, isLoop ? undefined : revBuf.duration);
    } else {
      src.buffer = this._buffer;
      src.loop = isLoop;
      if (isLoop) { src.loopStart = startSec; src.loopEnd = startSec + playLen; }
      // duration arg is buffer-time, independent of playbackRate.
      src.start(time, startSec, isLoop ? undefined : playLen);
    }

    src.connect(this.outputGain);

    const velScale = velocity / 127;
    const gain     = this._params['sample.gain'] ?? 1;
    this.outputGain.gain.setValueAtTime(this._params['output.level'] * velScale * gain, time);

    this._source = src;
    src.onended = () => { if (this._source === src) this._source = null; };
  }

  noteOff(_time) { /* self-enveloping */ }

  /** Build a reversed AudioBuffer of the slice [startSec, startSec+lenSec). */
  _buildReversedSlice(buf, startSec, lenSec) {
    const sr         = buf.sampleRate;
    const startFrame = Math.floor(startSec * sr);
    const length     = Math.max(1, Math.floor(lenSec * sr));
    const endFrame   = Math.min(buf.length, startFrame + length);
    const realLen    = endFrame - startFrame;
    const rev        = this.context.createBuffer(buf.numberOfChannels, realLen, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = rev.getChannelData(ch);
      for (let i = 0; i < realLen; i++) dst[i] = src[endFrame - 1 - i];
    }
    return rev;
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
    if (path === 'output.level') {
      // manualTarget: scheduled per-noteOn (level × vel × gain). Still write a
      // direct value so a UI drag is audible on a held/looping slice.
      const t = time ?? this.context.currentTime;
      this.outputGain.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  getParam(path) { return this._params[path]; }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    return null;
  }

  getParamList() {
    // `slice` is a numeric index (0..slices-1) — p-lockable per step like any
    // JS number param, and the natural type for a slice selector. Kept to the
    // full MAX_SLICES range so a p-lock stays valid if `slices` changes later.
    return [
      { path: 'slices',        label: 'Slices',  type: 'number', min: 1,  max: MAX_SLICES, default: 16,  modulatable: false, plockMode: 'js' },
      { path: 'slice',         label: 'Slice',   type: 'number', min: 0,  max: MAX_SLICES - 1, default: 0, modulatable: false, plockMode: 'js' },
      { path: 'slice.mode',    label: 'SliceBy', type: 'enum',   options: ['note','fixed'], default: 'note', plockMode: 'js' },
      { path: 'slice.base',    label: 'Base',    type: 'number', min: 0,  max: 127, default: 60,  modulatable: false, plockMode: 'js' },
      { path: 'sample.start',  label: 'Start',   type: 'number', min: 0,  max: 1,   default: 0,   modulatable: false, plockMode: 'js' },
      { path: 'sample.end',    label: 'End',     type: 'number', min: 0,  max: 1,   default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'gate',          label: 'Gate',    type: 'number', min: 0.02, max: 1, default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',  label: 'Speed',   type: 'number', min: 0.125, max: 4, default: 1,  modulatable: false, plockMode: 'js' },
      { path: 'sample.gain',   label: 'Gain',    type: 'number', min: 0,  max: 20,  default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'sample.reverse',label: 'Reverse', type: 'boolean', default: false,             plockMode: 'js' },
      { path: 'sample.loop',   label: 'Loop',    type: 'boolean', default: false,             plockMode: 'js' },
      { path: 'output.level',  label: 'Level',   type: 'number', min: 0,  max: 1,   default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    ];
  }

  toJSON() {
    return {
      type:       this.type,
      sampleId:   this.sampleId,
      sampleName: this.sampleName,
      sampleUrl:  this.sampleUrl ?? null,  // remote source (archive.org); re-fetched if local copy is gone
      params:     { ...this._params },
    };
  }

  fromJSON(obj) {
    this.sampleId   = obj.sampleId   ?? null;
    this.sampleName = obj.sampleName ?? '';
    this.sampleUrl  = obj.sampleUrl  ?? null;
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }

  syncFrom(other) {
    if (!(other instanceof SlicerMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
