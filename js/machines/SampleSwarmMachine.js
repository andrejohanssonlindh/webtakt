/**
 * SampleSwarmMachine.js
 * ----------------------
 * Sample-playback version of SwarmMachine. Plays a loaded AudioBuffer through
 * seven voices in a detuned cluster. One root voice plays at nominal pitch;
 * six swarm voices are spread symmetrically above and below it.
 *
 * Per-noteOn architecture (like SamplerMachine): seven AudioBufferSourceNodes
 * are created on each noteOn and stopped / replaced on the next noteOn.
 * An internal GainNode (_mix) sums all voices and feeds outputGain → [Filter].
 *
 * Audio graph (per noteOn):
 *   src_root (BufferSource) ──────────────────────────────────┐
 *   src_swarm[0..5] (BufferSource) → _swarmGain (height) ─────┴→ _mix → outputGain
 *
 * Noise drift: same setInterval pattern as SwarmMachine — periodically writes
 * fresh random detune targets to the active swarm sources.
 *
 * Parameters:
 *   'sample.start'     — normalised start point (0–1)
 *   'sample.end'       — normalised end point (0–1)
 *   'sample.loopStart' — normalised loop-resume point; first pass starts at 'start',
 *                        subsequent loops restart here (intro plays once)
 *   'sample.speed'     — playback rate multiplier (0.125–4)
 *   'sample.gain'      — pre-amp (0–4)
 *   'sample.root'      — MIDI root note the sample is tuned to (C4 = 60)
 *   'sample.reverse'   — boolean: play region backwards
 *   'sample.loop'      — boolean: loop between start/end
 *   'sample.pitch'     — boolean: track keyboard note (false = drum mode)
 *   'spread'         — cent gap between adjacent swarm voices (0–100¢)
 *   'swarm.detune'   — random start-detune jitter per voice per noteOn (0–50¢)
 *   'height'         — swarm voice level relative to root (0–1)
 *   'noise.amount'   — drift depth in cents (0–50¢)
 *   'noise.color'    — drift rate: 0–1 (slow→fast)
 *   'output.level'   — master output level (0–1)
 */

import { Machine } from './Machine.js';

const NUM_SWARM = 6; // voices around root (3 above, 3 below)

export class SampleSwarmMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'sample-swarm';
    this.label = 'Smp Swarm';

    this._params = {
      'sample.start':     0,
      'sample.end':       1,
      'sample.loopStart': 0,
      'sample.speed':     1,
      'sample.gain':      1,
      'sample.root':      60,
      'sample.reverse':   false,
      'sample.loop':      false,
      'sample.pitch':     true,
      'spread':         15,
      'swarm.detune':   5,
      'height':         0.7,
      'noise.amount':   8,
      'noise.color':    0.15,
      'output.level':   0.8,
    };

    this._buffer    = null;
    this.sampleId   = null;
    this.sampleName = '';

    // Active sources from the last noteOn — replaced each trigger
    this._rootSrc  = null;
    this._swarmSrc = []; // length NUM_SWARM

    // Computed detune bases for swarm voices — rebuilt whenever spread changes
    this._spreadBase = new Array(NUM_SWARM).fill(0);

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Summing node — normalise by voice count
    this._mix = context.createGain();
    this._mix.gain.value = 1 / (NUM_SWARM + 1);
    this._mix.connect(this.outputGain);

    // Swarm height gain — shared multiplier for the 6 satellite voices
    this._swarmGain = context.createGain();
    this._swarmGain.gain.value = this._params['height'];
    this._swarmGain.connect(this._mix);

    // Drift timer — same pattern as SwarmMachine
    this._driftInterval = this._colorToMs(this._params['noise.color']);
    this._driftTimer    = null;
    this._startDriftTimer();

    this._applySpread();
  }

  // ── Sample buffer management ────────────────────────────────────────────────

  /** @param {AudioBuffer} buffer  @param {string} id  @param {string} name */
  setBuffer(buffer, id, name) {
    this._buffer    = buffer;
    this.sampleId   = id;
    this.sampleName = name;
  }

  get hasBuffer() {
    return this._buffer !== null;
  }

  // ── Drift helpers (mirrored from SwarmMachine) ──────────────────────────────

  _colorToMs(v) {
    return Math.round(800 * Math.pow(50 / 800, v));
  }

  _startDriftTimer() {
    if (this._driftTimer !== null) clearInterval(this._driftTimer);
    this._driftTimer = setInterval(() => this._tickDrift(), this._driftInterval);
  }

  _tickDrift() {
    const amount = this._params['noise.amount'];
    if (amount <= 0 || !this._swarmSrc.length) return;
    const t  = this.context.currentTime;
    const tc = this._driftInterval / 1000 * 0.4;
    this._swarmSrc.forEach((src, i) => {
      if (!src) return;
      const base = this._spreadBase[i] ?? 0;
      const rand = (Math.random() * 2 - 1) * amount;
      src.detune.setTargetAtTime(base + rand, t, tc);
    });
  }

  _applySpread() {
    const s = this._params['spread'];
    for (let i = 0; i < NUM_SWARM; i++) {
      const slot  = Math.floor(i / 2) + 1;
      const sign  = (i % 2 === 0) ? 1 : -1;
      this._spreadBase[i] = sign * slot * s;
    }
    // Apply to any currently-running swarm sources
    if (this._swarmSrc.length) {
      const t = this.context.currentTime;
      this._swarmSrc.forEach((src, i) => {
        if (src) src.detune.setValueAtTime(this._spreadBase[i], t);
      });
    }
  }

  // ── Machine protocol ────────────────────────────────────────────────────────

  noteOn(midiNote, velocity, time) {
    if (!this._buffer) return;

    // Stop previous sources
    this._stopActive(time);

    const buf  = this._buffer;
    const dur  = buf.duration;

    let startNorm = Math.min(this._params['sample.start'], this._params['sample.end']);
    let endNorm   = Math.max(this._params['sample.start'], this._params['sample.end']);
    if (endNorm - startNorm < 0.001) endNorm = Math.min(1, startNorm + 0.001);

    const loopStartNorm = Math.max(startNorm, Math.min(endNorm, this._params['sample.loopStart']));

    const startSec     = startNorm     * dur;
    const endSec       = endNorm       * dur;
    const loopStartSec = loopStartNorm * dur;
    const lengthSec    = endSec - startSec;

    const pitchRate = this._params['sample.pitch']
      ? Math.pow(2, (midiNote - this._params['sample.root']) / 12)
      : 1;
    const totalRate = this._params['sample.speed'] * pitchRate;

    const isReverse = this._params['sample.reverse'];
    const isLoop    = this._params['sample.loop'];

    const velScale = velocity / 127;
    const gainVal  = this._params['output.level'] * velScale * (this._params['sample.gain'] ?? 1);
    this.outputGain.gain.setValueAtTime(gainVal, time);

    // Reversed: build reversed slice once, share across all 7 voices
    const playBuf = isReverse ? this._buildReversed(buf, startNorm, endNorm) : buf;
    const revLoopStart = isReverse ? (endNorm - loopStartNorm) * dur : undefined;

    const jitter = this._params['swarm.detune'];

    // ── Root voice ──
    this._rootSrc = this._makeSource(playBuf, totalRate, isLoop,
      isReverse ? 0 : startSec, isReverse ? undefined : lengthSec, time,
      isReverse ? revLoopStart : loopStartSec, isReverse ? playBuf.duration : endSec);
    this._rootSrc.connect(this._mix);
    this._rootSrc.detune.value = (Math.random() * 2 - 1) * jitter;

    // ── Swarm voices ──
    this._swarmSrc = [];
    for (let i = 0; i < NUM_SWARM; i++) {
      const src = this._makeSource(playBuf, totalRate, isLoop,
        isReverse ? 0 : startSec, isReverse ? undefined : lengthSec, time,
        isReverse ? revLoopStart : loopStartSec, isReverse ? playBuf.duration : endSec);
      src.connect(this._swarmGain);
      src.detune.value = this._spreadBase[i] + (Math.random() * 2 - 1) * jitter;
      this._swarmSrc.push(src);
    }
  }

  noteOff(time) {
    // Self-enveloping — no-op
  }

  _makeSource(buf, rate, loop, offsetSec, durationSec, time, loopStartSec, loopEndSec) {
    const src          = this.context.createBufferSource();
    src.buffer         = buf;
    src.playbackRate.value = rate;
    src.loop           = loop;
    if (loop) {
      src.loopStart = loopStartSec ?? offsetSec ?? 0;
      src.loopEnd   = loopEndSec   ?? (offsetSec ?? 0) + (durationSec ?? buf.duration);
    }
    src.start(time, offsetSec ?? 0, loop ? undefined : durationSec);
    return src;
  }

  _stopActive(time) {
    if (this._rootSrc) {
      try { this._rootSrc.stop(time); } catch (_) {}
      this._rootSrc = null;
    }
    this._swarmSrc.forEach(src => {
      if (src) try { src.stop(time); } catch (_) {}
    });
    this._swarmSrc = [];
  }

  /** Build a reversed AudioBuffer slice (same as SamplerMachine). */
  _buildReversed(buf, startNorm, endNorm) {
    const sampleRate = buf.sampleRate;
    const startFrame = Math.floor(startNorm * buf.length);
    const endFrame   = Math.ceil(endNorm   * buf.length);
    const length     = endFrame - startFrame;
    const reversed   = this.context.createBuffer(buf.numberOfChannels, length, sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = reversed.getChannelData(ch);
      for (let i = 0; i < length; i++) dst[i] = src[endFrame - 1 - i];
    }
    return reversed;
  }

  connect(destinationNode) {
    this.outputGain.connect(destinationNode);
  }

  disconnect() {
    if (this._driftTimer !== null) { clearInterval(this._driftTimer); this._driftTimer = null; }
    this._stopActive(this.context.currentTime);
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'spread':
        this._applySpread();
        break;
      case 'height':
        this._swarmGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'noise.color':
        this._driftInterval = this._colorToMs(value);
        this._startDriftTimer();
        break;
      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;
      // noise.amount / swarm.detune / sample.* read directly at noteOn time — no audio node
    }
  }

  getParam(path) {
    return this._params[path];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'height':       return this._swarmGain.gain;
      case 'output.level': return this.outputGain.gain;
      default: return null;
    }
  }

  getParamList() {
    return [
      // Sample controls
      { path: 'sample.start',     label: 'Start',      type: 'number',  min: 0,     max: 1,    default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.end',       label: 'End',        type: 'number',  min: 0,     max: 1,    default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.loopStart', label: 'Loop Strt',  type: 'number',  min: 0,     max: 1,    default: 0,    modulatable: false, plockMode: 'js' },
      { path: 'sample.speed',   label: 'Speed',      type: 'number',  min: 0.125, max: 4,    default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.gain',    label: 'Gain',       type: 'number',  min: 0,     max: 4,    default: 1,    modulatable: false, plockMode: 'js' },
      { path: 'sample.root',    label: 'Root',       type: 'number',  min: 0,     max: 127,  default: 60,   modulatable: false, plockMode: 'js' },
      { path: 'sample.reverse', label: 'Reverse',    type: 'boolean', default: false,                       plockMode: 'js' },
      { path: 'sample.loop',    label: 'Loop',       type: 'boolean', default: false,                       plockMode: 'js' },
      { path: 'sample.pitch',   label: 'Pitch',      type: 'boolean', default: true,                        plockMode: 'js' },
      // Swarm controls
      { path: 'spread',         label: 'Spread',     type: 'number',  min: 0,     max: 100,  default: 15,   modulatable: false, plockMode: 'js' },
      { path: 'swarm.detune',   label: 'Detune',     type: 'number',  min: 0,     max: 50,   default: 5,    modulatable: false, plockMode: 'js' },
      { path: 'height',         label: 'Height',     type: 'number',  min: 0,     max: 1,    default: 0.7,  modulatable: true,  lfoMin: 0, lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'noise.amount',   label: 'Noise Amt',  type: 'number',  min: 0,     max: 50,   default: 8,    modulatable: false, plockMode: 'js' },
      { path: 'noise.color',    label: 'Noise Rate', type: 'number',  min: 0,     max: 1,    default: 0.15, modulatable: false, plockMode: 'js' },
      { path: 'output.level',   label: 'Level',      type: 'number',  min: 0,     max: 1,    default: 0.8,  modulatable: true,  lfoMin: 0, lfoMax: 1,  plockMode: 'audioParam' },
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
    this.sampleId   = obj.sampleId   ?? null;
    this.sampleName = obj.sampleName ?? '';
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }

  /**
   * Copy the AudioBuffer reference from another SampleSwarmMachine instance.
   * Called by VoicePool.nextVoice() so non-canonical slots stay in sync.
   */
  syncFrom(other) {
    if (!(other instanceof SampleSwarmMachine)) return;
    if (other._buffer && other._buffer !== this._buffer) {
      this.setBuffer(other._buffer, other.sampleId, other.sampleName);
    }
  }
}
