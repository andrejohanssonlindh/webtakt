/**
 * GranularMachine.js
 * ------------------
 * Granular sample machine — a continuous cloud of short, overlapping,
 * windowed grains read from one loaded buffer. The defining feature of an
 * Octatrack-style granular engine: the scan `position` (where in the sample
 * grains are taken from) and `pitch` (how fast each grain plays) are fully
 * decoupled, so you can freeze the playhead and still play melodies, or sweep
 * the playhead at any speed without changing pitch.
 *
 * Runs an AudioWorkletNode (granular-processor.js). The worklet's `gain`
 * AudioParam only gates the cloud open (held velocity level) — the audible amp
 * SHAPE (attack/release) is the downstream track Envelope (ampGain) that the
 * whole signal chain runs through, exactly like an oscillator machine. On
 * noteOff the cloud keeps spawning grains for a short release tail so that
 * envelope's release has signal to fade (raise the AMP-page RELEASE for a soft
 * tail). Hold the trig long for a drone, short for a textured stab.
 *
 * `position` is a worklet AudioParam → it is an LFO / p-lock / mod-wheel
 * target. Assign an LFO to `position` for an evolving pad; p-lock it per step
 * to jump grain regions; or just dial it on the panel for a frozen texture.
 *
 * Audio graph:
 *   AudioWorkletNode (persistent, stereo) → outputGain → [Filter]
 *
 * Single-buffer protocol (getBuffer/setBuffer/clearBuffer/hasBuffer/syncFrom,
 * sampleId/sampleName, toJSON carrying sampleId) — identical to SamplerMachine,
 * so VoicePool carries the sample across same-type rebuilds and cross-type
 * swaps with other single-buffer samplers, and SampleStore reloads it on
 * project load.
 *
 * NOTE: not covered by the audio test suite (AudioWorklet is unavailable in
 * OfflineAudioContext) — same exclusion as WavetableSamplerMachine. The
 * param/JSON contract is unit-tested in tests/tests/machines/granular.js.
 */

import { Machine } from './Machine.js';

const WORKLET_PATH = 'js/worklets/granular-processor.js';

export class GranularMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'granular';
    this.label = 'Granular';

    this._params = {
      'position':      0,      // 0–1 playhead into the buffer (AudioParam)
      'grain.size':    40,     // grain length ms
      'grain.density': 25,     // grains per second
      'spray':         0.02,   // position jitter (fraction of buffer)
      'spread':        0.4,    // stereo spread 0–1
      'pitch.jitter':  0,      // per-grain pitch randomisation 0–1
      'scan':          0,      // auto-advance: fraction of buffer per second (0 = frozen)
      'sample.start':  0,      // trim region start (0–1); grains/position confined here
      'sample.end':    1,      // trim region end   (0–1)
      'sample.speed':  1,      // pitch multiplier (with note tracking)
      'sample.pitch':  true,   // track MIDI note for grain pitch
      'sample.root':   60,     // root note when pitch-tracking
      'sample.reverse': false, // grains read backwards
      'output.level':  0.85,
    };

    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;

    this._workletNode  = null;
    this._workletReady = false;
    this._gated        = false;   // currently holding a note

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    this._loadWorklet();
  }

  async _loadWorklet() {
    try {
      await this.context.audioWorklet.addModule(WORKLET_PATH);
      this._workletNode = new AudioWorkletNode(this.context, 'granular-processor', {
        numberOfInputs:  0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this._workletNode.connect(this.outputGain);
      this._workletReady = true;
      if (this._buffer) this._sendBuffer(this._buffer);
      // Push the current position so a frozen pad sits where the knob is.
      const posParam = this._workletNode.parameters.get('position');
      if (posParam) posParam.setValueAtTime(this._params['position'], this.context.currentTime);
    } catch (err) {
      console.error('GranularMachine: worklet load failed', err);
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

  // ── Single-buffer protocol ─────────────────────────────────────────────────

  setBuffer(buffer, id, name) {
    this._buffer    = buffer;
    this.sampleId   = id;
    this.sampleName = name;
    this._duration  = buffer.duration;
    if (this._workletReady) this._sendBuffer(buffer);
  }

  get hasBuffer() { return this._buffer !== null; }
  getBuffer() { return this._buffer; }

  clearBuffer() {
    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';
    this.sampleUrl  = null;  // remote source URL, persisted for re-fetch
    this._duration  = 0;
    if (this._workletReady) {
      this._workletNode.port.postMessage({ type: 'stop' });
    }
    this._gated = false;
  }

  // ── Machine protocol ───────────────────────────────────────────────────────

  noteOn(midiNote, velocity, time) {
    if (!this._workletReady || !this._buffer) return;

    const pitchRate = this._params['sample.pitch']
      ? Math.pow(2, (midiNote - this._params['sample.root']) / 12)
      : 1;

    this._workletNode.port.postMessage({
      type:        'trigger',
      grainSizeMs: this._params['grain.size'],
      density:     this._params['grain.density'],
      sprayFrac:   this._params['spray'],
      pitchRate:   this._params['sample.speed'] * pitchRate,
      spread:      this._params['spread'],
      jitterFrac:  this._params['pitch.jitter'],
      scanFrac:    this._params['scan'],
      reverse:     this._params['sample.reverse'],
      startFrac:   this._params['sample.start'],
      endFrac:     this._params['sample.end'],
    });

    const gainParam = this._workletNode.parameters.get('gain');
    const posParam  = this._workletNode.parameters.get('position');
    const velGain   = (velocity / 127) * this._params['output.level'];
    if (gainParam) gainParam.setValueAtTime(velGain, time);
    // Anchor position at note start so a freshly held note starts where the
    // knob/LFO currently points (LFO automation continues on top of this).
    if (posParam) posParam.setValueAtTime(this._params['position'], time);
    this._gated = true;
  }

  noteOff(time) {
    if (!this._workletReady) return;
    // Note-off. The AMP-page release is NOT shaped here — the audible fade is
    // the downstream amp envelope (ampGain) the whole chain runs through, just
    // like an oscillator machine. The worklet keeps the cloud spawning for a
    // release tail (see granular-processor's RELEASE_TAIL_SEC) so that envelope
    // has live signal to fade instead of silence; grains past the envelope's
    // zero point are multiplied by ~0 and inaudible.
    this._workletNode.port.postMessage({ type: 'release' });
    this._gated = false;
  }

  connect(destinationNode) {
    this.outputGain.connect(destinationNode);
  }

  disconnect() {
    if (this._workletNode) {
      try { this._workletNode.disconnect(); } catch (_) {}
    }
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    if (path === 'output.level') {
      this.outputGain.gain.setTargetAtTime(value, t, 0.01);
    } else if (path === 'position' && this._workletReady) {
      const p = this._workletNode.parameters.get('position');
      if (p) p.setTargetAtTime(value, t, 0.01);
    }
    // All other params are read fresh on the next noteOn trigger.
  }

  getParam(path) { return this._params[path]; }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    if (path === 'position' && this._workletReady) {
      return this._workletNode.parameters.get('position');
    }
    return null;
  }

  getParamList() {
    return [
      { path: 'position',      label: 'Position', type: 'number', min: 0,    max: 1,   default: 0,    modulatable: true,  lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
      { path: 'grain.size',    label: 'Size',     type: 'number', min: 2,    max: 500, default: 40,   modulatable: false, plockMode: 'js' },
      { path: 'grain.density', label: 'Density',  type: 'number', min: 1,    max: 200, default: 25,   modulatable: false, plockMode: 'js' },
      { path: 'spray',         label: 'Spray',    type: 'number', min: 0,    max: 1,   default: 0.02, modulatable: false, plockMode: 'js' },
      { path: 'spread',        label: 'Spread',   type: 'number', min: 0,    max: 1,   default: 0.4,  modulatable: false, plockMode: 'js' },
      { path: 'pitch.jitter',  label: 'P.Jitter', type: 'number', min: 0,    max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'scan',          label: 'Scan',     type: 'number', min: -2,   max: 2,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.start',  label: 'Start',    type: 'number', min: 0,    max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.end',    label: 'End',      type: 'number', min: 0,    max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',  label: 'Speed',    type: 'number', min: 0.125, max: 4,  default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.root',   label: 'Root',     type: 'number', min: 0,    max: 127, default: 60,   modulatable: false, plockMode: 'js' },
      { path: 'sample.pitch',  label: 'Pitch',    type: 'boolean', default: true,                     plockMode: 'js' },
      { path: 'sample.reverse',label: 'Reverse',  type: 'boolean', default: false,                    plockMode: 'js' },
      { path: 'output.level',  label: 'Level',    type: 'number', min: 0,    max: 1,   default: 0.85, modulatable: true,  lfoMin: 0, lfoMax: 1, plockMode: 'audioParam', ampMaster: true },
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

  /** Copy the AudioBuffer reference from another GranularMachine (VoicePool sync). */
  syncFrom(other) {
    if (!(other instanceof GranularMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
