/**
 * BeatRepeatMachine.js
 * --------------------
 * Stutter / beat-repeat / retrigger machine. On each noteOn it captures a slice
 * of the loaded buffer (`sample.start` + `length`) and fires it back N times in
 * a rapid roll, the repeats spaced by a tempo-synced musical division (`rate`:
 * 1/4 … 1/32). This is the classic Elektron retrig / glitch-roll: drop it on a
 * step, p-lock `repeats` and `rate`, and you get drum rolls, stutters and fills.
 *
 * Each repeat is one `AudioBufferSourceNode` of the captured slice, scheduled up
 * front for the whole roll (no worklet). Per repeat:
 *   - `gate` shortens each hit (fraction of the repeat interval played),
 *   - `pitch.ramp` detunes each successive repeat (semitones/repeat) for rising
 *     or falling rolls,
 *   - `decay` fades the roll out across its repeats (level taper).
 *
 * Tempo-synced: `rate` resolves through BpmSync.divToSeconds, and `setBpm`
 * keeps the interval current. Self-enveloping (gains scheduled per repeat);
 * noteOff is a no-op — the roll is a fixed burst per trig.
 *
 * Audio graph (per repeat, fanned into a shared bus):
 *   AudioBufferSourceNode (per repeat) → repeatGain → outputGain → [Filter]
 *
 * Single-buffer protocol (setBuffer/getBuffer/clearBuffer/hasBuffer/syncFrom,
 * sampleId/sampleName) — VoicePool carry-over + SampleStore reload for free.
 */

import { Machine } from './Machine.js';
import { divToSeconds, SYNC_DIVISIONS } from '../util/BpmSync.js';

// The rate divisions offered (coarse → fine). Subset of SYNC_DIVISIONS that
// makes sense for rolls; 1/4 down to 1/32.
const RATE_DIVS = ['1/4', '1/8', '1/16', '1/32'];

export class BeatRepeatMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'beat-repeat';
    this.label = 'BeatRepeat';

    this._params = {
      'rate':        '1/16',    // interval between repeats (tempo-synced division)
      'repeats':     4,         // number of hits in the roll (1–32)
      'sample.start': 0,        // capture-region start (0–1)
      'length':      0.125,     // captured slice length as fraction of buffer (0–1)
      'gate':        0.9,       // fraction of each repeat interval the hit plays
      'pitch.ramp':  0,         // semitones added per successive repeat (±12)
      'decay':       0,         // 0 = flat roll, 1 = fade to silence by last repeat
      'sample.speed': 1,        // base playback rate
      'sample.reverse': false,  // capture played backwards
      'output.level': 0.85,
    };

    this._bpm = 120;

    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;

    this._voices = [];  // active { src, gain } for cleanup

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
  }

  setBpm(bpm) { this._bpm = bpm; }

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
    this._stopVoices();
    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;
  }

  _stopVoices() {
    for (const v of this._voices) {
      try { v.src.stop(); } catch (_) {}
      try { v.src.disconnect(); } catch (_) {}
      try { v.gain.disconnect(); } catch (_) {}
    }
    this._voices = [];
  }

  // ── Machine protocol ───────────────────────────────────────────────────────

  noteOn(midiNote, velocity, time) {
    if (!this._buffer) return;
    this._stopVoices();

    const dur      = this._buffer.duration;
    const startN   = Math.max(0, Math.min(1, this._params['sample.start']));
    const lenN     = Math.max(0.001, Math.min(1 - startN, this._params['length']));
    const startSec = startN * dur;
    const sliceSec = lenN * dur;

    const interval = Math.max(0.01, divToSeconds(this._params['rate'], this._bpm));
    const repeats  = Math.max(1, Math.round(this._params['repeats']));
    const gateFrac = Math.max(0.05, Math.min(1, this._params['gate']));
    const ramp     = this._params['pitch.ramp'];
    const decay    = Math.max(0, Math.min(1, this._params['decay']));
    const baseRate = (this._params['sample.speed'] || 1)
      * (this._params['sample.reverse'] ? -1 : 1);
    const isReverse = baseRate < 0;

    const velScale = velocity / 127;
    const baseGain = this._params['output.level'] * velScale;

    // The captured slice (reversed once if needed, shared across repeats).
    const sliceBuf = isReverse
      ? this._buildReversedSlice(this._buffer, startSec, sliceSec)
      : this._buffer;

    for (let i = 0; i < repeats; i++) {
      const at = time + i * interval;
      // Each repeat plays at most one interval (or the slice length), gated.
      const playLen = Math.min(sliceSec, interval * gateFrac);

      const src  = this.context.createBufferSource();
      const gain = this.context.createGain();

      // Pitch ramp: i × semitones (independent of the captured slice).
      const semis = ramp * i;
      src.playbackRate.value = Math.abs(baseRate) * Math.pow(2, semis / 12);

      if (isReverse) {
        src.buffer = sliceBuf;
        src.start(at, 0, playLen);
      } else {
        src.buffer = sliceBuf;
        src.start(at, startSec, playLen);
      }

      // Decay taper across the roll: repeat i gain = baseGain × (1 - decay·i/(n-1)).
      const t = repeats > 1 ? i / (repeats - 1) : 0;
      const lvl = baseGain * (1 - decay * t);
      gain.gain.setValueAtTime(Math.max(0, lvl), at);

      src.connect(gain);
      gain.connect(this.outputGain);
      this._voices.push({ src, gain });
      src.onended = () => {
        try { gain.disconnect(); } catch (_) {}
        this._voices = this._voices.filter(v => v.src !== src);
      };
    }
  }

  noteOff(_time) { /* fixed roll burst — nothing to release */ }

  /** Build a reversed AudioBuffer of [startSec, startSec+lenSec). */
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

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this._stopVoices();
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    if (path === 'output.level') {
      this.outputGain.gain.setTargetAtTime(value, time ?? this.context.currentTime, 0.01);
    }
  }

  getParam(path) { return this._params[path]; }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    return null;
  }

  getParamList() {
    return [
      { path: 'rate',          label: 'Rate',     type: 'enum',   options: RATE_DIVS, default: '1/16', plockMode: 'js' },
      { path: 'repeats',       label: 'Repeats',  type: 'number', min: 1,  max: 32,  default: 4,    modulatable: false, plockMode: 'js' },
      { path: 'sample.start',  label: 'Start',    type: 'number', min: 0,  max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'length',        label: 'Length',   type: 'number', min: 0.001, max: 1, default: 0.125, modulatable: false, plockMode: 'js' },
      { path: 'gate',          label: 'Gate',     type: 'number', min: 0.05, max: 1, default: 0.9,  modulatable: false, plockMode: 'js' },
      { path: 'pitch.ramp',    label: 'P.Ramp',   type: 'number', min: -12, max: 12, default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'decay',         label: 'Decay',    type: 'number', min: 0,  max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',  label: 'Speed',    type: 'number', min: 0.125, max: 4, default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'sample.reverse',label: 'Reverse',  type: 'boolean', default: false,                  plockMode: 'js' },
      { path: 'output.level',  label: 'Level',    type: 'number', min: 0,  max: 1,   default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam', ampMaster: true },
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
    if (!(other instanceof BeatRepeatMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
