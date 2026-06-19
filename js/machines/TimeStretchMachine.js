/**
 * TimeStretchMachine.js
 * ---------------------
 * Tempo-locked loop player. Plays a loaded loop at the project BPM regardless
 * of the loop's original tempo, with pitch independent of tempo — the classic
 * Octatrack/Ableton "warp" behaviour. Stretch ratio is:
 *
 *     ratio = origBpm / projectBpm
 *
 * so a 90-BPM loop in a 120-BPM project plays 1.33× faster (ratio 0.75 fed to
 * the OLA stretcher, which slows/speeds without repitching).
 *
 * Original tempo is found by AUTO-DETECT + manual override:
 *   - 'bars' (1/2/4/8) says how many bars the trimmed loop is assumed to span.
 *   - origBpm is then derived from the trimmed region's duration:
 *         beats   = bars * 4
 *         origBpm = beats / durationSec * 60
 *   - 'orig.bpm' is a manual override knob; pressing DETECT writes the derived
 *     value into it. So you can let it guess, then nudge.
 *
 * Runs an AudioWorkletNode (time-stretch-processor.js). Self-enveloping: amp
 * is the worklet `gain` AudioParam, gated open on noteOn, released on noteOff
 * (hold the trig for the loop to keep running).
 *
 * Pitch: when `sample.pitch` is on, the played MIDI note transposes the loop
 * (intra-grain resample) WITHOUT changing its tempo lock. `transpose` adds a
 * fixed semitone offset on top.
 *
 * Audio graph:
 *   AudioWorkletNode (persistent, stereo) → outputGain → [Filter]
 *
 * Single-buffer protocol (getBuffer/setBuffer/clearBuffer/hasBuffer/syncFrom).
 * NOT covered by the audio test suite (AudioWorklet unavailable offline — same
 * exclusion as wt-sampler). Param/JSON/ratio contract tested in
 * tests/tests/machines/time_stretch.js.
 */

import { Machine } from './Machine.js';

const WORKLET_PATH = 'js/worklets/time-stretch-processor.js';

export class TimeStretchMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'stretch';
    this.label = 'TimeStretch';

    this._params = {
      'orig.bpm':     120,     // loop's original tempo (manual / DETECT writes here)
      'bars':         2,       // assumed bar count of the trimmed loop (detect basis)
      'sync':         true,    // lock to project BPM (false → play at orig speed)
      'transpose':    0,       // semitone offset (independent of tempo)
      'grain.size':   80,      // OLA grain length ms (texture vs smearing trade-off)
      'sample.start': 0,
      'sample.end':   1,
      'sample.pitch': false,   // track MIDI note for pitch (off → fixed pitch loop)
      'sample.root':  60,
      'sample.loop':  true,
      'sample.reverse': false,
      'output.level': 0.85,
    };

    this._bpm = 120;          // project tempo (via setBpm)

    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;

    this._workletNode  = null;
    this._workletReady = false;

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    this._loadWorklet();
  }

  async _loadWorklet() {
    try {
      await this.context.audioWorklet.addModule(WORKLET_PATH);
      this._workletNode = new AudioWorkletNode(this.context, 'time-stretch-processor', {
        numberOfInputs:  0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this._workletNode.connect(this.outputGain);
      this._workletReady = true;
      if (this._buffer) this._sendBuffer(this._buffer);
      this._sendConfig();
    } catch (err) {
      console.error('TimeStretchMachine: worklet load failed', err);
    }
  }

  _sendBuffer(buffer) {
    const pcm = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      pcm.push(new Float32Array(buffer.getChannelData(c)));
    }
    this._workletNode.port.postMessage(
      { type: 'buffer', pcm, length: buffer.length, channels: buffer.numberOfChannels },
      pcm.map(a => a.buffer)
    );
  }

  // ── Tempo / ratio ──────────────────────────────────────────────────────────

  setBpm(bpm) {
    this._bpm = bpm;
    if (this._workletReady) this._sendConfig();
  }

  /** Stretch factor handed to the OLA processor (ratio = origBpm / projectBpm). */
  computeRatio() {
    if (!this._params['sync']) return 1;
    const orig = this._params['orig.bpm'] || 120;
    const proj = this._bpm || 120;
    return orig / proj;
  }

  /**
   * Estimate the loop's original BPM from the trimmed region duration and the
   * assumed bar count (4 beats/bar). Returns 120 if no buffer.
   */
  detectBpm() {
    if (!this._buffer) return 120;
    const start = Math.min(this._params['sample.start'], this._params['sample.end']);
    const end   = Math.max(this._params['sample.start'], this._params['sample.end']);
    const durSec = Math.max(0.05, (end - start) * this._buffer.duration);
    const beats  = Math.max(1, Math.round(this._params['bars'])) * 4;
    return beats / durSec * 60;
  }

  _sendConfig() {
    if (!this._workletReady) return;
    const transposeRate = Math.pow(2, this._params['transpose'] / 12);
    this._workletNode.port.postMessage({
      type:      'config',
      ratio:     this.computeRatio(),
      pitchRate: transposeRate,     // base pitch (note tracking added at noteOn)
      grainMs:   this._params['grain.size'],
      loop:      this._params['sample.loop'],
      startFrac: this._params['sample.start'],
      endFrac:   this._params['sample.end'],
      reverse:   this._params['sample.reverse'],
    });
  }

  // ── Single-buffer protocol ─────────────────────────────────────────────────

  setBuffer(buffer, id, name) {
    this._buffer    = buffer;
    this.sampleId   = id;
    this.sampleName = name;
    this._duration  = buffer.duration;
    if (this._workletReady) { this._sendBuffer(buffer); this._sendConfig(); }
  }

  get hasBuffer() { return this._buffer !== null; }
  getBuffer() { return this._buffer; }

  clearBuffer() {
    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;
    if (this._workletReady) this._workletNode.port.postMessage({ type: 'release' });
  }

  // ── Machine protocol ───────────────────────────────────────────────────────

  noteOn(midiNote, velocity, time) {
    if (!this._workletReady || !this._buffer) return;

    // Note tracking pitch (independent of tempo) folded into the grain pitch.
    const notePitch = this._params['sample.pitch']
      ? Math.pow(2, (midiNote - this._params['sample.root']) / 12)
      : 1;
    const transposeRate = Math.pow(2, this._params['transpose'] / 12);

    this._workletNode.port.postMessage({
      type:      'config',
      ratio:     this.computeRatio(),
      pitchRate: transposeRate * notePitch,
      grainMs:   this._params['grain.size'],
      loop:      this._params['sample.loop'],
      startFrac: this._params['sample.start'],
      endFrac:   this._params['sample.end'],
      reverse:   this._params['sample.reverse'],
    });
    this._workletNode.port.postMessage({ type: 'trigger' });

    const gainParam = this._workletNode.parameters.get('gain');
    if (gainParam) gainParam.setValueAtTime((velocity / 127) * this._params['output.level'], time);
  }

  noteOff(_time) {
    if (this._workletReady) this._workletNode.port.postMessage({ type: 'release' });
  }

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    if (this._workletNode) { try { this._workletNode.disconnect(); } catch (_) {} }
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    if (path === 'output.level') {
      this.outputGain.gain.setTargetAtTime(value, time ?? this.context.currentTime, 0.01);
      return;
    }
    // Any config-affecting param re-pushes config to the worklet.
    this._sendConfig();
  }

  getParam(path) { return this._params[path]; }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    return null;
  }

  getParamList() {
    return [
      { path: 'orig.bpm',     label: 'Orig BPM', type: 'number', min: 40,  max: 300, default: 120, modulatable: false, plockMode: 'js' },
      { path: 'bars',         label: 'Bars',     type: 'number', min: 1,   max: 8,   default: 2,   modulatable: false, plockMode: 'js' },
      { path: 'transpose',    label: 'Transpose',type: 'number', min: -24, max: 24,  default: 0,   modulatable: false, plockMode: 'js' },
      { path: 'grain.size',   label: 'Grain',    type: 'number', min: 20,  max: 200, default: 80,  modulatable: false, plockMode: 'js' },
      { path: 'sample.start', label: 'Start',    type: 'number', min: 0,   max: 1,   default: 0,   modulatable: false, plockMode: 'js' },
      { path: 'sample.end',   label: 'End',      type: 'number', min: 0,   max: 1,   default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'sample.root',  label: 'Root',     type: 'number', min: 0,   max: 127, default: 60,  modulatable: false, plockMode: 'js' },
      { path: 'sync',         label: 'Sync',     type: 'boolean', default: true,                   plockMode: 'js' },
      { path: 'sample.pitch', label: 'Pitch',    type: 'boolean', default: false,                  plockMode: 'js' },
      { path: 'sample.loop',  label: 'Loop',     type: 'boolean', default: true,                   plockMode: 'js' },
      { path: 'sample.reverse',label: 'Reverse', type: 'boolean', default: false,                  plockMode: 'js' },
      { path: 'output.level', label: 'Level',    type: 'number', min: 0,   max: 1,   default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
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
    if (!(other instanceof TimeStretchMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
