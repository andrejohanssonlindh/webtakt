/**
 * TapeFX.js
 * ---------
 * Per-track tape echo / tape-character block — a dub-style delay with vintage
 * colour: wow & flutter (slow + fast pitch wobble), tape saturation, and
 * high-frequency loss that compounds on each repeat. Covers both the "tape
 * character" idea and the ping-pong / filtered-feedback delay upgrades in a
 * single add-only block (the back-compat base DelayFX is left untouched).
 *
 * Signal chain (internal):
 *   input → drive(sat) → dryGain ─────────────────────────────→ output
 *   input → drive(sat) → delayL ┐                              ┌→ wetL
 *                                ├ cross-feedback (ping-pong) ─┤
 *                               delayR ┘  via fbFilter (HF loss) └→ wetR
 *   wow/flutter LFOs → delayL/R.delayTime  (pitch wobble)
 *
 * Cross-feedback: delayL's output feeds delayR's input and vice-versa, so a hit
 * bounces L↔R (ping-pong). A one-pole lowpass in the feedback path darkens each
 * repeat (the tape HF-loss that makes echoes decay into mush). `spread` sets how
 * hard-panned the two lines are.
 *
 * Parameters:
 *   'tape.time'       — s, used when sync='ms', default 0.3
 *   'tape.syncMode'   — 'ms' | 'bpm', default 'ms'
 *   'tape.bpmCount32' — 1/32 count (sync='bpm'), default 6 (= dotted 1/16)
 *   'tape.feedback'   — 0..0.95, default 0.4
 *   'tape.tone'       — Hz, feedback-path lowpass, 500..16000, default 6000
 *   'tape.wow'        — 0..1 wow+flutter depth, default 0.25
 *   'tape.drive'      — 1..10 tape saturation, default 2
 *   'tape.spread'     — 0..1 ping-pong stereo width, default 1
 *   'tape.wet'        — 0..1, default 0
 *
 * Public: the standard FX block interface.
 */

import { count32ToSeconds, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

const MAX_DELAY = 2.0;
const WOW_HZ    = 0.6;     // slow wow
const FLUT_HZ   = 6.3;     // fast flutter
const WOW_S     = 0.004;   // seconds of delay-time swing at wow=1

export class TapeFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'tape.time':       0.3,
      'tape.syncMode':   'ms',
      'tape.bpmCount32': 6,
      'tape.feedback':   0.4,
      'tape.tone':       6000,
      'tape.wow':        0.25,
      'tape.drive':      2,
      'tape.spread':     1,
      'tape.wet':        0,
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

    // Tape saturation on the way in (waveshaper).
    this._sat = context.createWaveShaper();
    this._sat.oversample = '2x';
    this._buildSatCurve(this._params['tape.drive']);

    // Two delay lines for ping-pong.
    this._delayL = context.createDelay(MAX_DELAY);
    this._delayR = context.createDelay(MAX_DELAY);

    // Cross-feedback gains (L→R and R→L) through a shared tone lowpass.
    this._fbL = context.createGain();   // feeds the OTHER side
    this._fbR = context.createGain();
    this._fbL.gain.value = this._params['tape.feedback'];
    this._fbR.gain.value = this._params['tape.feedback'];

    this._toneL = context.createBiquadFilter();
    this._toneR = context.createBiquadFilter();
    this._toneL.type = 'lowpass'; this._toneR.type = 'lowpass';
    this._toneL.frequency.value = this._params['tape.tone'];
    this._toneR.frequency.value = this._params['tape.tone'];

    // Ping-pong panning of the two lines.
    this._panL = context.createStereoPanner();
    this._panR = context.createStereoPanner();
    this._applySpread();

    // Wow + flutter: two LFOs per line, summed into delayTime.
    this._wowLfo  = context.createOscillator();
    this._flutLfo = context.createOscillator();
    this._wowLfo.type = 'sine'; this._flutLfo.type = 'sine';
    this._wowLfo.frequency.value  = WOW_HZ;
    this._flutLfo.frequency.value = FLUT_HZ;
    this._wowDepth  = context.createGain();
    this._flutDepth = context.createGain();
    this._applyWow();
    this._wowLfo.connect(this._wowDepth);
    this._flutLfo.connect(this._flutDepth);
    // Both wobble both lines (flutter slightly stronger on R for tape-ish drift).
    this._wowDepth.connect(this._delayL.delayTime);
    this._wowDepth.connect(this._delayR.delayTime);
    this._flutDepth.connect(this._delayL.delayTime);
    this._flutDepth.connect(this._delayR.delayTime);
    this._wowLfo.start();
    this._flutLfo.start();

    // Wiring.
    this.inputNode.connect(this._sat);
    this._sat.connect(this._dryGain).connect(this.outputNode);

    // Input feeds the left line (mono-in → ping-pong develops via cross-feedback).
    this._sat.connect(this._delayL);

    // delayL → toneL → fbL → delayR  (and tap to wet via panL)
    this._delayL.connect(this._toneL);
    this._toneL.connect(this._fbL).connect(this._delayR);
    this._delayL.connect(this._panL);

    // delayR → toneR → fbR → delayL  (and tap to wet via panR)
    this._delayR.connect(this._toneR);
    this._toneR.connect(this._fbR).connect(this._delayL);
    this._delayR.connect(this._panR);

    this._panL.connect(this._wetGain);
    this._panR.connect(this._wetGain);
    this._wetGain.connect(this.outputNode);

    this._applyTime();
  }

  /** tanh saturation curve; gentler than DistortionFX (tape warmth, not fuzz). */
  _buildSatCurve(drive) {
    const k = Math.max(1, Math.min(10, drive));
    const N = 1024;
    const curve = new Float32Array(N);
    const norm = Math.tanh(k);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    this._sat.curve = curve;
  }

  _applySpread() {
    const s = this._params['tape.spread'];
    this._panL.pan.setTargetAtTime(-s, this.context.currentTime, 0.02);
    this._panR.pan.setTargetAtTime( s, this.context.currentTime, 0.02);
  }

  _applyWow() {
    const w = this._params['tape.wow'];
    this._wowDepth.gain.setTargetAtTime(WOW_S * w, this.context.currentTime, 0.05);
    // Flutter is shallower and faster than wow.
    this._flutDepth.gain.setTargetAtTime(WOW_S * w * 0.25, this.context.currentTime, 0.05);
  }

  _baseTimeSeconds() {
    if (this._params['tape.syncMode'] === 'bpm') {
      return count32ToSeconds(this._params['tape.bpmCount32'], this._bpm);
    }
    return this._params['tape.time'];
  }

  _applyTime() {
    const secs = Math.min(Math.max(this._baseTimeSeconds(), 0.001), MAX_DELAY - 0.05);
    const t = this.context.currentTime;
    this._delayL.delayTime.setTargetAtTime(secs, t, 0.02);
    this._delayR.delayTime.setTargetAtTime(secs, t, 0.02);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['tape.syncMode'] === 'bpm') this._applyTime();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['tape.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(enabled ? 1 - wet * 0.5 : 1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'tape.time':
        if (this._params['tape.syncMode'] === 'ms') this._applyTime();
        break;
      case 'tape.syncMode':
      case 'tape.bpmCount32':
        this._applyTime();
        break;
      case 'tape.feedback':
        this._fbL.gain.setTargetAtTime(value, t, 0.01);
        this._fbR.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'tape.tone':
        this._toneL.frequency.setTargetAtTime(value, t, 0.01);
        this._toneR.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'tape.wow':    this._applyWow();    break;
      case 'tape.drive':  this._buildSatCurve(value); break;
      case 'tape.spread': this._applySpread(); break;
      case 'tape.wet':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.005);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.005);
        }
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      {
        path: 'tape.sync', label: 'Time', type: 'sync',
        modePath: 'tape.syncMode',
        msPath:   'tape.time',
        bpmPath:  'tape.bpmCount32',
        bpmMin: 0.25, bpmMax: 64, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'tape.syncMode',   label: 'Sync',     type: 'enum',   options: ['ms','bpm'], default: 'ms', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'tape.time',       label: 'Time',     type: 'number', min: 0.02, max: MAX_DELAY, default: 0.3, modulatable: true, lfoMin: 0.05, lfoMax: 0.8, plockMode: 'audioParam', hidden: true },
      { path: 'tape.bpmCount32', label: 'Division', type: 'number', min: 1, max: 64, default: 6, modulatable: true, plockMode: 'js', hidden: true },
      { path: 'tape.feedback', label: 'Feedbk', type: 'number', min: 0,   max: 0.95,  default: 0.4,  modulatable: true, lfoMin: 0,   lfoMax: 0.95,  plockMode: 'audioParam' },
      { path: 'tape.tone',     label: 'Tone',   type: 'number', min: 500, max: 16000, default: 6000, modulatable: true, lfoMin: 500, lfoMax: 16000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'tape.wow',      label: 'Wow',    type: 'number', min: 0,   max: 1,     default: 0.25, modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'js' },
      { path: 'tape.drive',    label: 'Drive',  type: 'number', min: 1,   max: 10,    default: 2,    modulatable: false,                          plockMode: 'js' },
      { path: 'tape.spread',   label: 'Spread', type: 'number', min: 0,   max: 1,     default: 1,    modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'js' },
      { path: 'tape.wet',      label: 'Wet',    type: 'number', min: 0,   max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,     plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'tape.feedback': return this._fbL.gain;   // R tracks via setParam
      case 'tape.tone':     return this._toneL.frequency;
      case 'tape.wet':      return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
