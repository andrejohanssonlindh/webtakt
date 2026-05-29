/**
 * WavetableSamplerMachine.js
 * --------------------------
 * Sample-wavetable machine. Loads two audio samples (A and B) and morphs
 * between them in real time via a `morph` param (0 = A, 1 = B).
 *
 * Uses an AudioWorkletNode running wavetable-sampler-processor.js.
 * Self-enveloping: amplitude applied via the worklet's `gain` AudioParam.
 *
 * SampleSweep: a built-in sine LFO that automatically drives morph back and
 * forth. sweep.depth (0–1) sets the amplitude around the morph centre;
 * sweep.speed (0.05–20 Hz) sets the rate. Both are JS-only (not AudioParams)
 * and are driven by a persistent OscillatorNode → morph AudioParam path via
 * a GainNode scaling depth.
 *
 * Audio graph:
 *   AudioWorkletNode (persistent) → outputGain → [Filter]
 *   SweepOsc (sine, persistent)   → sweepDepthGain → morph AudioParam
 */

import { Machine } from './Machine.js';

const WORKLET_PATH = 'js/worklets/wavetable-sampler-processor.js';

export class WavetableSamplerMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'wt-sampler';
    this.label = 'WT Sampler';

    this._params = {
      'morph':               0.5,
      'sample.startA':       0,
      'sample.endA':         1,
      'sample.loopStartA':   0,
      'sample.gainA':        1,
      'sample.startB':       0,
      'sample.endB':         1,
      'sample.loopStartB':   0,
      'sample.gainB':        1,
      'sample.speed':   1,
      'sample.pitch':   true,
      'sample.rootA':   60,
      'sample.rootB':   60,
      'sample.loop':    false,
      'sample.reverse': false,
      'sweep.depth':    0,      // 0–1 (fraction of 0–1 morph range)
      'sweep.speed':    0.5,    // Hz
      'output.level':   0.85,
    };

    this._bufferA    = null;
    this._bufferB    = null;
    this.sampleIdA   = null;
    this.sampleIdB   = null;
    this.sampleNameA = '';
    this.sampleNameB = '';

    this._workletNode  = null;
    this._workletReady = false;

    // Sweep oscillator nodes — created after worklet is ready
    this._sweepOsc   = null;   // OscillatorNode (sine)
    this._sweepGain  = null;   // GainNode — scales depth

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    this._loadWorklet();
  }

  async _loadWorklet() {
    try {
      await this.context.audioWorklet.addModule(WORKLET_PATH);
      this._workletNode = new AudioWorkletNode(this.context, 'wavetable-sampler-processor', {
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this._workletNode.connect(this.outputGain);
      this._workletReady = true;

      // Push any already-set buffers
      if (this._bufferA) this._sendBuffer('bufferA', this._bufferA);
      if (this._bufferB) this._sendBuffer('bufferB', this._bufferB);

      this._buildSweep();
    } catch (err) {
      console.error('WavetableSamplerMachine: worklet load failed', err);
    }
  }

  // ── Sweep oscillator ───────────────────────────────────────────────────────

  _buildSweep() {
    if (!this._workletReady) return;
    const morphParam = this._workletNode.parameters.get('morph');
    if (!morphParam) return;

    // OscillatorNode can connect directly to an AudioParam — this gives
    // sample-accurate morph modulation at audio-thread precision with zero JS overhead.
    // The osc output is in range [-1, +1]; sweepGain scales it to [-depth/2, +depth/2].
    // The morph AudioParam's base value (set at noteOn) acts as the centre.
    this._sweepGain = this.context.createGain();
    this._sweepGain.gain.value = this._params['sweep.depth'] * 0.5;
    this._sweepGain.connect(morphParam);

    this._sweepOsc = this.context.createOscillator();
    this._sweepOsc.type = 'sine';
    this._sweepOsc.frequency.value = this._params['sweep.speed'];
    this._sweepOsc.connect(this._sweepGain);
    this._sweepOsc.start();
  }

  _teardownSweep() {
    if (this._sweepOsc) {
      try { this._sweepOsc.stop(); } catch (_) {}
      this._sweepOsc.disconnect();
      this._sweepOsc = null;
    }
    if (this._sweepGain) {
      this._sweepGain.disconnect();
      this._sweepGain = null;
    }
  }

  // ── Buffer management ──────────────────────────────────────────────────────

  setBufferA(buffer, id, name) {
    this._bufferA    = buffer;
    this.sampleIdA   = id;
    this.sampleNameA = name;
    if (this._workletReady) this._sendBuffer('bufferA', buffer);
  }

  setBufferB(buffer, id, name) {
    this._bufferB    = buffer;
    this.sampleIdB   = id;
    this.sampleNameB = name;
    if (this._workletReady) this._sendBuffer('bufferB', buffer);
  }

  _sendBuffer(type, buffer) {
    const pcm = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      pcm.push(new Float32Array(buffer.getChannelData(c)));
    }
    this._workletNode.port.postMessage(
      { type, pcm, length: buffer.length, sampleRate: buffer.sampleRate },
      pcm.map(a => a.buffer)
    );
  }

  get hasBufferA() { return this._bufferA !== null; }
  get hasBufferB() { return this._bufferB !== null; }

  // ── Machine protocol ───────────────────────────────────────────────────────

  noteOn(midiNote, velocity, time, overrideMorph) {
    if (!this._workletReady) return;

    const morph = overrideMorph ?? this._params['morph'];

    const startA = Math.min(this._params['sample.startA'], this._params['sample.endA']);
    const endA   = Math.max(this._params['sample.startA'], this._params['sample.endA']);
    const startB = Math.min(this._params['sample.startB'], this._params['sample.endB']);
    const endB   = Math.max(this._params['sample.startB'], this._params['sample.endB']);

    const rootA   = this._params['sample.rootA'];
    const rootB   = this._params['sample.rootB'];
    const rootMix = rootA * (1 - morph) + rootB * morph;

    const pitchRate = this._params['sample.pitch']
      ? Math.pow(2, (midiNote - rootMix) / 12)
      : 1;
    const baseRate = this._params['sample.speed'] * pitchRate
      * (this._params['sample.reverse'] ? -1 : 1);

    const velGain = (velocity / 127) * this._params['output.level'];

    const loopStartA = Math.max(startA, Math.min(endA, this._params['sample.loopStartA']));
    const loopStartB = Math.max(startB, Math.min(endB, this._params['sample.loopStartB']));

    this._workletNode.port.postMessage({
      type:      'trigger',
      startTime: time,
      rate:      baseRate,
      loop:      this._params['sample.loop'],
      startA, endA, loopStartA, gainA: this._params['sample.gainA'],
      startB, endB, loopStartB, gainB: this._params['sample.gainB'],
    });

    const gainParam  = this._workletNode.parameters.get('gain');
    const morphParam = this._workletNode.parameters.get('morph');
    if (gainParam)  gainParam.setValueAtTime(velGain, time);
    // Set morph base value — the sweep osc adds on top of this
    if (morphParam) morphParam.setValueAtTime(morph, time);
  }

  noteOff(_time) {}

  connect(destinationNode) {
    this.outputGain.connect(destinationNode);
  }

  disconnect() {
    this._teardownSweep();
    if (this._workletNode) {
      try { this._workletNode.disconnect(); } catch (_) {}
    }
    this.outputGain.disconnect();
  }

  setParam(path, value, _time) {
    this._params[path] = value;

    if (path === 'output.level') {
      this.outputGain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
    }
    if (path === 'morph' && this._workletReady) {
      const morphParam = this._workletNode.parameters.get('morph');
      if (morphParam) morphParam.setTargetAtTime(value, this.context.currentTime, 0.02);
    }
    if (path === 'sweep.depth' && this._sweepGain) {
      // gain = depth * 0.5 so the osc swings ±depth/2 around the morph centre
      this._sweepGain.gain.setTargetAtTime(value * 0.5, this.context.currentTime, 0.02);
    }
    if (path === 'sweep.speed' && this._sweepOsc) {
      this._sweepOsc.frequency.setTargetAtTime(value, this.context.currentTime, 0.02);
    }
  }

  getParam(path) {
    return this._params[path];
  }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    if (path === 'morph' && this._workletReady) {
      return this._workletNode.parameters.get('morph');
    }
    return null;
  }

  getParamList() {
    return [
      { path: 'morph',          label: 'Morph',       type: 'number',  min: 0,     max: 1,   default: 0.5,  modulatable: true,  lfoMin: 0, lfoMax: 1,   plockMode: 'audioParam' },
      { path: 'sweep.depth',    label: 'Swp Depth',   type: 'number',  min: 0,     max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sweep.speed',    label: 'Swp Speed',   type: 'number',  min: 0.05,  max: 20,  default: 0.5,  modulatable: false, plockMode: 'js' },
      { path: 'sample.startA',     label: 'Start A',    type: 'number',  min: 0,     max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.endA',       label: 'End A',      type: 'number',  min: 0,     max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.loopStartA', label: 'LpSt A',     type: 'number',  min: 0,     max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.gainA',      label: 'Gain A',     type: 'number',  min: 0,     max: 4,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.startB',     label: 'Start B',    type: 'number',  min: 0,     max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.endB',       label: 'End B',      type: 'number',  min: 0,     max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.loopStartB', label: 'LpSt B',     type: 'number',  min: 0,     max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.gainB',      label: 'Gain B',     type: 'number',  min: 0,     max: 4,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',   label: 'Speed',       type: 'number',  min: 0.125, max: 4,   default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.rootA',   label: 'Root A',      type: 'number',  min: 0,     max: 127, default: 60,   modulatable: false, plockMode: 'js' },
      { path: 'sample.rootB',   label: 'Root B',      type: 'number',  min: 0,     max: 127, default: 60,   modulatable: false, plockMode: 'js' },
      { path: 'sample.pitch',   label: 'Pitch',       type: 'boolean', default: true,                       plockMode: 'js' },
      { path: 'sample.loop',    label: 'Loop',        type: 'boolean', default: false,                      plockMode: 'js' },
      { path: 'sample.reverse', label: 'Reverse',     type: 'boolean', default: false,                      plockMode: 'js' },
      { path: 'output.level',   label: 'Level',       type: 'number',  min: 0,     max: 1,   default: 0.85, modulatable: true,  lfoMin: 0, lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  toJSON() {
    return {
      type:        this.type,
      sampleIdA:   this.sampleIdA,
      sampleIdB:   this.sampleIdB,
      sampleNameA: this.sampleNameA,
      sampleNameB: this.sampleNameB,
      params:      { ...this._params },
    };
  }

  fromJSON(obj) {
    this.sampleIdA   = obj.sampleIdA   ?? null;
    this.sampleIdB   = obj.sampleIdB   ?? null;
    this.sampleNameA = obj.sampleNameA ?? '';
    this.sampleNameB = obj.sampleNameB ?? '';
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }

  /**
   * Copy buffer references (and IDs/names) from another WavetableSamplerMachine.
   * Called by VoicePool.nextVoice() so non-canonical slots stay in sync with slot 0.
   * AudioBuffers are immutable and safe to share across machine instances.
   */
  syncFrom(other) {
    if (!(other instanceof WavetableSamplerMachine)) return;
    if (other._bufferA && other._bufferA !== this._bufferA) {
      this.setBufferA(other._bufferA, other.sampleIdA, other.sampleNameA);
    }
    if (other._bufferB && other._bufferB !== this._bufferB) {
      this.setBufferB(other._bufferB, other.sampleIdB, other.sampleNameB);
    }
  }
}
