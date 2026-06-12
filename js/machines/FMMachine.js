/**
 * FMMachine.js
 * ------------
 * 4-operator FM synthesizer. Classic DX-style architecture with 4 operators
 * that can act as carriers (contribute to audio output) or modulators (modulate
 * the frequency of another operator).
 *
 * Algorithm (fixed — one musical topology inspired by DX7 alg 5):
 *
 *   OP4 (modulator) ──→ OP3 (modulator) ──┐
 *                                          ├──→ OP1 (carrier) → outputGain
 *   OP2 (modulator, self-feedback) ────────┘
 *
 * OP1 is the carrier (what you hear).
 * OP2+OP3+OP4 form a 3-op modulation chain feeding OP1.
 * OP2 also has self-feedback for metallic/noise-like timbres.
 *
 * Each operator has:
 *   - ratio  — frequency ratio to base note (1=root, 2=octave, 0.5=sub, etc.)
 *   - level  — modulation depth or carrier amplitude (0–1)
 *   - detune — fine-tune in cents (-50 to +50)
 *
 * Persistent oscillator architecture: all OscillatorNodes run continuously
 * (like SynthMachine), frequency updated on noteOn. This allows LFOs to connect
 * permanently to any AudioParam.
 *
 * Audio graph:
 *   op4Osc → op4EnvGain → op4LevelGain(0-1) → op4ScaleGain(freq×K) → op3Osc.frequency
 *   op3Osc → op3EnvGain → op3LevelGain(0-1) → op3ScaleGain(freq×K) ─┐
 *   op2Osc → op2EnvGain → op2LevelGain(0-1) → op2ScaleGain(freq×K) ─┴→ op1Osc.frequency
 *   op2Osc → op2FbLevelGain(0-1) → op2FbScaleGain(freq×K) → delay → op2Osc.frequency
 *   op1Osc → op1EnvGain → op1Gain → outputGain → [Filter]
 *   (LevelGain nodes are the LFO connection targets; ScaleGain updated each noteOn)
 *
 * Parameters (all p-lockable, many LFO-assignable):
 *   'op1.ratio'     — carrier frequency ratio (0.25–8)
 *   'op1.level'     — carrier output level (0–1)
 *   'op1.detune'    — fine detune cents (-50–+50)
 *
 *   'op2.ratio'     — modulator ratio (0.25–16)
 *   'op2.level'     — modulation index (0–1, maps to 0–semitone range × 12)
 *   'op2.feedback'  — self-feedback amount (0–1)
 *   'op2.detune'    — fine detune cents (-50–+50)
 *
 *   'op3.ratio'     — modulator ratio (0.25–16)
 *   'op3.level'     — modulation index (0–1)
 *   'op3.detune'    — fine detune cents (-50–+50)
 *
 *   'op4.ratio'     — modulator ratio (0.25–16)
 *   'op4.level'     — modulation index (0–1)
 *   'op4.detune'    — fine detune cents (-50–+50)
 *
 *   'output.level'  — master output level (0–1)
 *
 * Modulation depth scaling:
 *   FM modulation depth in Web Audio is in Hz added to the oscillator frequency.
 *   We scale: modDepth = opLevel * baseFreq * MAX_MOD_RATIO
 *   MAX_MOD_RATIO = 10 gives a comfortable 0–10× carrier frequency as maximum mod.
 *   This is set on noteOn so the mod tracks pitch.
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { count32ToSeconds } from '../util/BpmSync.js';

const MAX_MOD_RATIO = 10;

// Schedule ADSR on an AudioParam (same approach as Envelope.js)
function _scheduleADS(param, time, a, d, peak, sustain) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time);
  } else {
    param.cancelScheduledValues(time);
  }
  // Always anchor the start at `time`; cancelAndHoldAtTime alone is not a reliable
  // ramp anchor in Chrome (ramps early → "pre-note"). See Envelope._scheduleADS.
  param.setValueAtTime(param.value, time);
  param.linearRampToValueAtTime(peak,    time + a);
  param.linearRampToValueAtTime(sustain, time + a + d);
}

function _scheduleR(param, offTime, sustainVal, r, endVal) {
  param.setValueAtTime(sustainVal, offTime);
  param.linearRampToValueAtTime(endVal, offTime + r);
}

export class FMMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'fm';
    this.label = 'FM';

    this._params = {
      'op1.ratio':    1.0,
      'op1.level':    0.8,
      'op1.detune':   0,
      'op1.env.a':    0.01,
      'op1.env.d':    0.1,
      'op1.env.s':    0.8,
      'op1.env.r':    0.3,

      'op2.ratio':    1.5,
      'op2.level':    0.5,
      'op2.feedback': 0.0,
      'op2.detune':   0,
      'op2.env.a':    0.001,
      'op2.env.d':    0.3,
      'op2.env.s':    0.0,
      'op2.env.r':    0.1,

      'op3.ratio':    2.0,
      'op3.level':    0.3,
      'op3.detune':   0,
      'op3.env.a':    0.001,
      'op3.env.d':    0.2,
      'op3.env.s':    0.0,
      'op3.env.r':    0.1,

      'op4.ratio':    3.0,
      'op4.level':    0.2,
      'op4.detune':   0,
      'op4.env.a':    0.001,
      'op4.env.d':    0.15,
      'op4.env.s':    0.0,
      'op4.env.r':    0.05,

      'output.level': 0.8,

      // Per-stage tempo-sync: mode ('ms' | 'bpm') + 1/32 count for each timed
      // stage (A/D/R) of every operator. Default count 4 = 1/8. Resolved to
      // seconds at note-fire when mode='bpm' (see _scheduleOpADS/_scheduleOpR).
      // Sustain has no duration, so it is never synced.
      'op1.env.a.syncMode': 'ms', 'op1.env.a.bpmCount32': 4,
      'op1.env.d.syncMode': 'ms', 'op1.env.d.bpmCount32': 4,
      'op1.env.r.syncMode': 'ms', 'op1.env.r.bpmCount32': 4,
      'op2.env.a.syncMode': 'ms', 'op2.env.a.bpmCount32': 4,
      'op2.env.d.syncMode': 'ms', 'op2.env.d.bpmCount32': 4,
      'op2.env.r.syncMode': 'ms', 'op2.env.r.bpmCount32': 4,
      'op3.env.a.syncMode': 'ms', 'op3.env.a.bpmCount32': 4,
      'op3.env.d.syncMode': 'ms', 'op3.env.d.bpmCount32': 4,
      'op3.env.r.syncMode': 'ms', 'op3.env.r.bpmCount32': 4,
      'op4.env.a.syncMode': 'ms', 'op4.env.a.bpmCount32': 4,
      'op4.env.d.syncMode': 'ms', 'op4.env.d.bpmCount32': 4,
      'op4.env.r.syncMode': 'ms', 'op4.env.r.bpmCount32': 4,
    };

    this._baseFreq = 440;
    this._bpm      = 120;  // current tempo, for resolving BPM-synced env stages

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // ── OP1 (carrier) ──
    // Signal: op1Osc → op1EnvGain (ADSR on carrier level) → op1Gain (static level) → outputGain
    this._op1Osc  = context.createOscillator();
    this._op1Osc.type = 'sine';
    this._op1Osc.frequency.value = 440;
    this._op1Osc.detune.value    = this._params['op1.detune'];

    this._op1EnvGain = context.createGain();
    this._op1EnvGain.gain.value = this._params['op1.env.s'];

    this._op1Gain = context.createGain();
    this._op1Gain.gain.value = this._params['op1.level'];

    this._op1Osc.connect(this._op1EnvGain);
    this._op1EnvGain.connect(this._op1Gain);
    this._op1Gain.connect(this.outputGain);
    this._op1Osc.start();

    // ── OP2 (modulator with feedback) → op1.frequency ──
    // Chain: op2Osc → op2EnvGain → op2LevelGain (0-1, LFO target) → op2ScaleGain (freq×MAX_MOD_RATIO) → op1.frequency
    this._op2Osc  = context.createOscillator();
    this._op2Osc.type = 'sine';
    this._op2Osc.frequency.value = 440 * this._params['op2.ratio'];
    this._op2Osc.detune.value    = this._params['op2.detune'];

    this._op2EnvGain = context.createGain();
    this._op2EnvGain.gain.value = this._params['op2.env.s'];

    // _op2LevelGain: holds the 0-1 level param — LFO connects here so depthScale stays in 0-1 space
    this._op2LevelGain = context.createGain();
    this._op2LevelGain.gain.value = this._params['op2.level'];

    // _op2ScaleGain: holds the freq×MAX_MOD_RATIO factor — updated on each noteOn
    this._op2ScaleGain = context.createGain();
    this._op2ScaleGain.gain.value = 440 * MAX_MOD_RATIO;

    this._op2Osc.connect(this._op2EnvGain);
    this._op2EnvGain.connect(this._op2LevelGain);
    this._op2LevelGain.connect(this._op2ScaleGain);
    this._op2ScaleGain.connect(this._op1Osc.frequency);

    // Self-feedback: op2FbLevelGain (0-1) → op2FbScaleGain (freq×MAX_MOD_RATIO) → op2.frequency
    this._op2FbLevelGain  = context.createGain();
    this._op2FbLevelGain.gain.value = this._params['op2.feedback'];
    this._op2FbScaleGain  = context.createGain();
    this._op2FbScaleGain.gain.value = 440 * MAX_MOD_RATIO;
    this._op2FbDelay = context.createDelay(1);
    this._op2FbDelay.delayTime.value = 1 / context.sampleRate;
    this._op2Osc.connect(this._op2FbLevelGain);
    this._op2FbLevelGain.connect(this._op2FbScaleGain);
    this._op2FbScaleGain.connect(this._op2FbDelay);
    this._op2FbDelay.connect(this._op2Osc.frequency);

    this._op2Osc.start();

    // ── OP3 (modulator) → op1.frequency ──
    // Chain: op3Osc → op3EnvGain → op3LevelGain (0-1) → op3ScaleGain (freq×MAX_MOD_RATIO) → op1.frequency
    this._op3Osc  = context.createOscillator();
    this._op3Osc.type = 'sine';
    this._op3Osc.frequency.value = 880;
    this._op3Osc.detune.value    = this._params['op3.detune'];

    this._op3EnvGain = context.createGain();
    this._op3EnvGain.gain.value = this._params['op3.env.s'];

    this._op3LevelGain = context.createGain();
    this._op3LevelGain.gain.value = this._params['op3.level'];

    this._op3ScaleGain = context.createGain();
    this._op3ScaleGain.gain.value = 440 * MAX_MOD_RATIO;

    this._op3Osc.connect(this._op3EnvGain);
    this._op3EnvGain.connect(this._op3LevelGain);
    this._op3LevelGain.connect(this._op3ScaleGain);
    this._op3ScaleGain.connect(this._op1Osc.frequency);
    this._op3Osc.start();

    // ── OP4 (modulator) → op3.frequency ──
    // Chain: op4Osc → op4EnvGain → op4LevelGain (0-1) → op4ScaleGain (freq×MAX_MOD_RATIO) → op3.frequency
    this._op4Osc  = context.createOscillator();
    this._op4Osc.type = 'sine';
    this._op4Osc.frequency.value = 1320;
    this._op4Osc.detune.value    = this._params['op4.detune'];

    this._op4EnvGain = context.createGain();
    this._op4EnvGain.gain.value = this._params['op4.env.s'];

    this._op4LevelGain = context.createGain();
    this._op4LevelGain.gain.value = this._params['op4.level'];

    this._op4ScaleGain = context.createGain();
    this._op4ScaleGain.gain.value = 880 * MAX_MOD_RATIO;

    this._op4Osc.connect(this._op4EnvGain);
    this._op4EnvGain.connect(this._op4LevelGain);
    this._op4LevelGain.connect(this._op4ScaleGain);
    this._op4ScaleGain.connect(this._op3Osc.frequency);
    this._op4Osc.start();
  }

  /** Update BPM used to resolve tempo-synced operator envelope stages. */
  setBpm(bpm) {
    this._bpm = bpm;
  }

  /**
   * Resolve an operator stage duration to seconds, honouring its sync mode.
   * `op` is 'op1'..'op4'; `stage` is 'a' | 'd' | 'r'. When the stage is
   * BPM-synced the duration comes from its 1/32 count at the current BPM;
   * otherwise the plain seconds param is used. Mirrors Envelope._stageSeconds.
   */
  _stageSeconds(op, stage) {
    const secKey = `${op}.env.${stage}`;
    if (this._params[`${secKey}.syncMode`] === 'bpm') {
      return count32ToSeconds(this._params[`${secKey}.bpmCount32`], this._bpm);
    }
    return this._params[secKey];
  }

  // offTime is the gate-close time; when provided, the full ADSR (A+D+S+R) is
  // scheduled immediately so note length is respected regardless of when the
  // sequencer calls noteOff().
  noteOn(midiNote, velocity, time, offTime) {
    const freq   = Machine.midiToFreq(midiNote);
    this._baseFreq = freq;
    const t      = time;
    const velScl = velocity / 127;

    const f1 = freq * this._params['op1.ratio'];
    const f2 = freq * this._params['op2.ratio'];
    const f3 = freq * this._params['op3.ratio'];
    const f4 = freq * this._params['op4.ratio'];

    // Drop stale future frequency events from a previous held chord before
    // retuning — see SynthMachine.noteOn for the LiveArp octave-bleed rationale.
    for (const osc of [this._op1Osc, this._op2Osc, this._op3Osc, this._op4Osc]) {
      osc.frequency.cancelScheduledValues(t);
    }
    this._op1Osc.frequency.setValueAtTime(f1, t);
    this._op2Osc.frequency.setValueAtTime(f2, t);
    this._op3Osc.frequency.setValueAtTime(f3, t);
    this._op4Osc.frequency.setValueAtTime(f4, t);

    this._op1Gain.gain.setValueAtTime(this._params['op1.level'] * velScl, t);
    // Scale gains hold freq×MAX_MOD_RATIO; level gains hold the 0-1 param (LFO target)
    this._op2ScaleGain.gain.setValueAtTime(f1 * MAX_MOD_RATIO, t);
    this._op3ScaleGain.gain.setValueAtTime(f1 * MAX_MOD_RATIO, t);
    this._op4ScaleGain.gain.setValueAtTime(f3 * MAX_MOD_RATIO, t);
    this._op2FbScaleGain.gain.setValueAtTime(f2 * MAX_MOD_RATIO, t);

    this._scheduleOpADS('op1', t);
    this._scheduleOpADS('op2', t);
    this._scheduleOpADS('op3', t);
    this._scheduleOpADS('op4', t);

    if (offTime !== undefined) {
      this._scheduleOpR('op1', offTime);
      this._scheduleOpR('op2', offTime);
      this._scheduleOpR('op3', offTime);
      this._scheduleOpR('op4', offTime);
    }
  }

  _scheduleOpADS(op, time) {
    const a = this._stageSeconds(op, 'a');
    const d = this._stageSeconds(op, 'd');
    const s = this._params[`${op}.env.s`];
    _scheduleADS(this[`_${op}EnvGain`].gain, time, a, d, 1.0, s);
  }

  _scheduleOpR(op, offTime) {
    const s = this._params[`${op}.env.s`];
    const r = this._stageSeconds(op, 'r');
    _scheduleR(this[`_${op}EnvGain`].gain, offTime, s, r, 0);
  }

  noteOff(time) {
    this._scheduleOpR('op1', time);
    this._scheduleOpR('op2', time);
    this._scheduleOpR('op3', time);
    this._scheduleOpR('op4', time);
  }

  connect(destinationNode)  { this._trimGain.connect(destinationNode); }

  disconnect() {
    [this._op1Osc, this._op2Osc, this._op3Osc, this._op4Osc].forEach(osc => {
      try { osc.stop(); } catch (_) {}
    });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t    = time ?? this.context.currentTime;
    const freq = this._baseFreq;

    switch (path) {
      case 'op1.ratio':
        this._op1Osc.frequency.setTargetAtTime(freq * value, t, 0.005);
        break;
      case 'op1.level':
        this._op1Gain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'op1.detune':
        this._op1Osc.detune.setTargetAtTime(value, t, 0.005);
        break;

      case 'op2.ratio':
        this._op2Osc.frequency.setTargetAtTime(freq * value, t, 0.005);
        break;
      case 'op2.level':
        this._op2LevelGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'op2.feedback':
        this._op2FbLevelGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'op2.detune':
        this._op2Osc.detune.setTargetAtTime(value, t, 0.005);
        break;

      case 'op3.ratio':
        this._op3Osc.frequency.setTargetAtTime(freq * value, t, 0.005);
        break;
      case 'op3.level':
        this._op3LevelGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'op3.detune':
        this._op3Osc.detune.setTargetAtTime(value, t, 0.005);
        break;

      case 'op4.ratio':
        this._op4Osc.frequency.setTargetAtTime(freq * value, t, 0.005);
        break;
      case 'op4.level':
        this._op4LevelGain.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'op4.detune':
        this._op4Osc.detune.setTargetAtTime(value, t, 0.005);
        break;

      case 'output.level':
        this.outputGain.gain.setValueAtTime(value, t);
        break;

      // Per-op envelope params — JS-only (scheduled per noteOn/noteOff)
      case 'op1.env.a': case 'op1.env.d': case 'op1.env.s': case 'op1.env.r':
      case 'op2.env.a': case 'op2.env.d': case 'op2.env.s': case 'op2.env.r':
      case 'op3.env.a': case 'op3.env.d': case 'op3.env.s': case 'op3.env.r':
      case 'op4.env.a': case 'op4.env.d': case 'op4.env.s': case 'op4.env.r':
        break; // stored in _params above, applied on next noteOn
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    const envDef = (op, suffix, label, def) => ({
      path: `${op}.env.${suffix}`, label, type: 'number',
      min: suffix === 's' ? 0 : 0.001,
      max: suffix === 's' ? 1 : (suffix === 'r' ? 8 : 4),
      default: def, modulatable: false, hidden: true, plockMode: 'js',
    });
    // Per-stage tempo-sync siblings (A/D/R only — sustain has no duration).
    // JS-only + hidden like the seconds params; both modes are p-lockable.
    const syncDefs = (op, suffix) => [
      { path: `${op}.env.${suffix}.syncMode`,   label: `${suffix.toUpperCase()} Sync`,
        type: 'enum', default: 'ms', modulatable: false, hidden: true, plockMode: 'js' },
      { path: `${op}.env.${suffix}.bpmCount32`, label: `${suffix.toUpperCase()} Count`,
        type: 'number', min: 1, max: 128, default: 4,
        modulatable: false, hidden: true, plockMode: 'js' },
    ];
    const envDefs = (op, suffix, label, def) =>
      suffix === 's' ? [envDef(op, suffix, label, def)]
                     : [envDef(op, suffix, label, def), ...syncDefs(op, suffix)];
    return [
      // OP1 — carrier
      { path: 'op1.ratio',    label: 'Ratio',  type: 'number', min: 0.25, max: 8,  default: 1.0, modulatable: true, lfoMin: 0.25, lfoMax: 8,  plockMode: 'js'        },
      { path: 'op1.level',    label: 'Level',  type: 'number', min: 0,    max: 1,  default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'op1.detune',   label: 'Detune', type: 'number', min: -50,  max: 50, default: 0,   modulatable: true, lfoMin: -50,  lfoMax: 50, plockMode: 'audioParam' },
      ...envDefs('op1', 'a', 'A', 0.01), ...envDefs('op1', 'd', 'D', 0.1),
      ...envDefs('op1', 's', 'S', 0.8),  ...envDefs('op1', 'r', 'R', 0.3),
      // OP2 — modulator with feedback
      { path: 'op2.ratio',    label: 'Ratio',  type: 'number', min: 0.25, max: 16, default: 1.5, modulatable: true, lfoMin: 0.25, lfoMax: 16, plockMode: 'js'        },
      { path: 'op2.level',    label: 'Index',  type: 'number', min: 0,    max: 1,  default: 0.5, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'op2.feedback', label: 'FB',     type: 'number', min: 0,    max: 1,  default: 0.0, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'op2.detune',   label: 'Detune', type: 'number', min: -50,  max: 50, default: 0,   modulatable: true, lfoMin: -50,  lfoMax: 50, plockMode: 'audioParam' },
      ...envDefs('op2', 'a', 'A', 0.001), ...envDefs('op2', 'd', 'D', 0.3),
      ...envDefs('op2', 's', 'S', 0.0),   ...envDefs('op2', 'r', 'R', 0.1),
      // OP3 — modulator → op1
      { path: 'op3.ratio',    label: 'Ratio',  type: 'number', min: 0.25, max: 16, default: 2.0, modulatable: true, lfoMin: 0.25, lfoMax: 16, plockMode: 'js'        },
      { path: 'op3.level',    label: 'Index',  type: 'number', min: 0,    max: 1,  default: 0.3, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'op3.detune',   label: 'Detune', type: 'number', min: -50,  max: 50, default: 0,   modulatable: true, lfoMin: -50,  lfoMax: 50, plockMode: 'audioParam' },
      ...envDefs('op3', 'a', 'A', 0.001), ...envDefs('op3', 'd', 'D', 0.2),
      ...envDefs('op3', 's', 'S', 0.0),   ...envDefs('op3', 'r', 'R', 0.1),
      // OP4 — modulator → op3
      { path: 'op4.ratio',    label: 'Ratio',  type: 'number', min: 0.25, max: 16, default: 3.0, modulatable: true, lfoMin: 0.25, lfoMax: 16, plockMode: 'js'        },
      { path: 'op4.level',    label: 'Index',  type: 'number', min: 0,    max: 1,  default: 0.2, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
      { path: 'op4.detune',   label: 'Detune', type: 'number', min: -50,  max: 50, default: 0,   modulatable: true, lfoMin: -50,  lfoMax: 50, plockMode: 'audioParam' },
      ...envDefs('op4', 'a', 'A', 0.001), ...envDefs('op4', 'd', 'D', 0.15),
      ...envDefs('op4', 's', 'S', 0.0),   ...envDefs('op4', 'r', 'R', 0.05),
      // Output
      { path: 'output.level', label: 'Level',  type: 'number', min: 0,    max: 1,  default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,  plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'op1.detune':   return this._op1Osc.detune;
      case 'op1.level':    return this._op1Gain.gain;
      case 'op2.detune':   return this._op2Osc.detune;
      case 'op2.level':    return this._op2LevelGain.gain;  // 0-1 space; scale handled by _op2ScaleGain
      case 'op2.feedback': return this._op2FbLevelGain.gain; // 0-1 space
      case 'op3.detune':   return this._op3Osc.detune;
      case 'op3.level':    return this._op3LevelGain.gain;  // 0-1 space
      case 'op4.detune':   return this._op4Osc.detune;
      case 'op4.level':    return this._op4LevelGain.gain;  // 0-1 space
      case 'output.level': return this.outputGain.gain;
      // ratio params are JS-only (need to multiply by baseFreq), not direct AudioParams
      default: return null;
    }
  }

  toJSON() { return { type: this.type, params: { ...this._params } }; }
  fromJSON(obj) { Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v)); }
}
