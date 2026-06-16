/**
 * StutterFX.js
 * ------------
 * Per-track beat-repeat / glitch-roll — worklet-backed (stutter-processor.js). It
 * captures a rolling buffer and, when latched, loops the most recent tempo-synced
 * slice (the stutter), then releases. Two ways to play it:
 *   · auto: `chance` > 0 randomly fires a stutter at each slice boundary.
 *   · sequenced: `latch` is an enum param — p-lock it ON for the steps you want
 *     to glitch, and the effect becomes part of the pattern (the signature use on
 *     a step sequencer).
 *
 * Slice size is a BPM sync knob; the resolved seconds are converted to samples and
 * pushed to the worklet as a config message (on tempo / division change).
 *
 * If the worklet is unavailable the block degrades to a dry passthrough (mirrors
 * Crush2FX / the ladder filter fallback).
 *
 * Parameters:
 *   'stut.wet'        — 0..1, default 0
 *   'stut.chance'     — 0..1 auto-stutter probability, default 0
 *   'stut.repeats'    — 1..16 loops per latched slice, default 4
 *   'stut.latch'      — 'off' | 'on' manual/sequenced latch, default 'off'
 *   'stut.syncMode'   — 'bpm' (only)
 *   'stut.bpmCount32' — 1/32 count = slice length, default 2 (= 1/16)
 *
 * Public: the standard FX block interface.
 */

import { count32ToSeconds, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

export class StutterFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'stut.wet':        0,
      'stut.chance':     0,
      'stut.repeats':    4,
      'stut.latch':      'off',
      'stut.syncMode':   'bpm',
      'stut.bpmCount32': 2,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;

    // Dry path always carries audio (also the fallback if the worklet is missing).
    this.inputNode.connect(this._dryGain).connect(this.outputNode);

    // Wet path: worklet runs fully wet; the JS wetGain does the dry/wet blend so a
    // disabled or worklet-less block is transparent (a dead node can't silence it).
    this._node = null;
    if (!this._buildNode()) {
      // Module not registered yet (block added before AudioEngine's fire-and-forget
      // addModule resolved) — otherwise the block was stuck dry forever. Register
      // it ourselves (idempotent) and build the node when ready.
      context.audioWorklet?.addModule('js/worklets/stutter-processor.js')
        .then(() => { this._buildNode(); if (this.enabled) this.setEnabled(true); })
        .catch(err => console.warn('StutterFX: stutter worklet unavailable, passing dry.', err));
    }
  }

  /** Construct + wire the worklet node. Returns true on success. */
  _buildNode() {
    if (this._node) return true;
    const context = this.context;
    try {
      // Match the PROVEN-working worklet pattern (patina-ladder filter,
      // wavetable-sampler): numberOfInputs/Outputs + an explicit outputChannelCount.
      // The earlier `channelCount:2, channelCountMode:'explicit'` override left the
      // output channel count unstable and the wet branch silent live. The processor
      // mono-sums the input and writes every output channel, so [2] is safe.
      this._node = new AudioWorkletNode(context, 'stutter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      // A processor that throws emits `processorerror` and then outputs SILENCE for
      // the rest of its life (per the Web Audio spec) — exactly the "no effect,
      // just quieter" symptom, with no normal console error. Surface it loudly.
      // A throwing processor emits `processorerror` then outputs silence for life
      // (per spec) — surface it; it's a real, otherwise-invisible failure.
      this._node.onprocessorerror = (e) =>
        console.error('StutterFX: stutter processor errored → silent for life.', e);
      this.inputNode.connect(this._node);
      this._node.connect(this._wetGain).connect(this.outputNode);
      this._node.parameters.get('wet').setValueAtTime(1, context.currentTime);
      this._node.parameters.get('chance').setValueAtTime(0, context.currentTime);
      this._pushConfig();
      return true;
    } catch (_) {
      this._node = null;
      return false;
    }
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  // Audio detach ONLY — must NOT kill the worklet (see Crush2FX.disconnect). Killing
  // here on every _rewireFXChain made process() return false forever → silent wet.
  disconnect() {
    this.outputNode.disconnect();
  }

  /** Permanent teardown — kill the processor. Only on actual removal (removeFX). */
  destroy() {
    try { this._node?.port.postMessage('kill'); } catch (_) {}
    this.outputNode.disconnect();
  }

  _sliceSamples() {
    const secs = Math.max(0.01, count32ToSeconds(this._params['stut.bpmCount32'], this._bpm));
    return Math.round(secs * this.context.sampleRate);
  }

  _pushConfig() {
    this._node?.port.postMessage({
      type: 'config',
      sliceSamples: this._sliceSamples(),
      repeats: this._params['stut.repeats'],
    });
  }

  setBpm(bpm) {
    this._bpm = bpm;
    this._pushConfig();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled && this._node ? this._params['stut.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.01);
    this._dryGain.gain.setTargetAtTime(enabled && this._node ? 1 - wet * 0.5 : 1, t, 0.01);
    if (!this._node) return;
    this._node.parameters.get('chance').setTargetAtTime(enabled ? this._params['stut.chance'] : 0, t, 0.02);
    if (!enabled) this._node.port.postMessage({ type: 'latch', on: false });
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'stut.wet':
        if (this.enabled && this._node) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.01);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.01);
        }
        break;
      case 'stut.chance':
        if (this.enabled) this._node?.parameters.get('chance').setTargetAtTime(value, t, 0.02);
        break;
      case 'stut.repeats':
        this._pushConfig();
        break;
      case 'stut.bpmCount32':
      case 'stut.syncMode':
        this._pushConfig();
        break;
      case 'stut.latch':
        this._node?.port.postMessage({ type: 'latch', on: value === 'on' });
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'stut.wet',    label: 'Wet',     type: 'number', min: 0, max: 1,  default: 0, modulatable: true, lfoMin: 0, lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'stut.chance', label: 'Chance',  type: 'number', min: 0, max: 1,  default: 0, modulatable: true, lfoMin: 0, lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'stut.repeats',label: 'Repeats', type: 'number', min: 1, max: 16, default: 4, modulatable: false,                       plockMode: 'js' },
      // Slice size as a BPM sync knob (no MS mode; a stutter is always tempo-locked).
      {
        path: 'stut.sync', label: 'Slice', type: 'sync', noToggle: true,
        modePath: 'stut.syncMode',
        msPath:   'stut.bpmCount32',
        bpmPath:  'stut.bpmCount32',
        bpmMin: 1, bpmMax: 32, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'stut.syncMode',   label: 'Sync',     type: 'enum',   options: ['bpm'], default: 'bpm', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'stut.bpmCount32', label: 'Division', type: 'number', min: 1, max: 32, default: 2, modulatable: false, plockMode: 'js', hidden: true },
      // Manual latch toggle. (Enum p-lock isn't wired in the FX panel yet, so
      // for hands-free sequenced glitching use `chance`; latch is the live grab.)
      { path: 'stut.latch', label: 'Latch', type: 'enum', options: ['off','on'], default: 'off', modulatable: false, plockMode: 'js' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'stut.wet':    return this._wetGain.gain;
      case 'stut.chance': return this._node?.parameters.get('chance') ?? null;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
