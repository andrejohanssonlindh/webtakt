/**
 * DuckFX.js
 * ---------
 * Trigger-driven sidechain ducker (Syntakt-style kick pump). Unlike the other FX
 * blocks this one has no rhythmic source of its own — it ducks on an external
 * TRIGGER. The trigger comes from the track-FOLLOW mechanism: put DuckFX on the
 * global FX track, point that track's follow source at the kick, and every kick
 * step pulses trigger() (see Sequencer follower loop → Track.triggerDuck).
 *
 * On each trigger the output gain drops to (1 − depth), holds, then recovers —
 * an inverted amplitude envelope, exactly what a "negative-ADH amp" does on the
 * Syntakt, but as a reusable FX block instead of new envelope plumbing.
 *
 * Signal chain (internal):  input → _duckGain → output   (gain rests at 1)
 *
 * Parameters:
 *   'duck.depth'   — 0..1, default 0.8   (how far it ducks; 1 = full silence)
 *   'duck.attack'  / 'duck.hold' / 'duck.release' — each a unified MS↔BPM SYNC knob:
 *     'duck.<stage>'          — ms value (used when its syncMode = 'ms')
 *     'duck.<stage>SyncMode'  — 'ms' | 'bpm'
 *     'duck.<stage>Count32'   — integer count of 1/32 notes (used when syncMode = 'bpm')
 *   Click the knob centre to toggle MS↔BPM (FXPanel sync-knob model). BPM mode locks
 *   the stage to a tempo division (e.g. Release = 1/8 → the pump tail is an 1/8 note).
 *
 * Depth is continuous (p-lockable / LFO-able via the JS tick); the stage times are
 * read at trigger time (envelope-shape params, like note-read machine params).
 *
 * Public: the standard FX block interface (inputNode/outputNode/connect/disconnect/
 * setEnabled/setParam/getParam/getParamList/resolveAudioParam/toJSON/fromJSON) plus
 * trigger(time) and setBpm(bpm).
 */

import { count32ToSeconds, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

const STAGES = ['attack', 'hold', 'release'];

export class DuckFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'duck.depth':   0.8,
      'duck.attack':  5,    'duck.attackSyncMode':  'ms', 'duck.attackCount32':  1,  // 1/32
      'duck.hold':    40,   'duck.holdSyncMode':    'ms', 'duck.holdCount32':    2,  // 1/16
      'duck.release': 220,  'duck.releaseSyncMode': 'ms', 'duck.releaseCount32': 8,  // 1/4
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._duckGain = context.createGain();
    this._duckGain.gain.value = 1;

    this.inputNode.connect(this._duckGain).connect(this.outputNode);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      // Release any in-flight duck back to unity.
      const t = this.context.currentTime;
      this._duckGain.gain.cancelScheduledValues(t);
      this._duckGain.gain.setTargetAtTime(1, t, 0.02);
    }
  }

  setBpm(bpm) { this._bpm = bpm; }

  /** Resolve a stage's duration in seconds, honouring its MS↔BPM mode. */
  _stageSeconds(stage) {
    if (this._params[`duck.${stage}SyncMode`] === 'bpm') {
      return count32ToSeconds(this._params[`duck.${stage}Count32`], this._bpm);
    }
    return (this._params[`duck.${stage}`] ?? 0) / 1000;   // ms → s
  }

  /**
   * Pulse the duck envelope: dip to (1 − depth) over attack, hold, recover over
   * release. Anchored with an explicit setValueAtTime before each ramp so Chrome
   * ramps from `time`, not the previous (past) event — see DESIGN.md pre-note note.
   * No-op when disabled.
   * @param {number} time — AudioContext time
   */
  trigger(time) {
    if (!this.enabled) return;
    const g       = this._duckGain.gain;
    const t       = Math.max(time, this.context.currentTime);
    const depth   = Math.min(1, Math.max(0, this._params['duck.depth']));
    const attack  = Math.max(0.001, this._stageSeconds('attack'));
    const hold    = Math.max(0,     this._stageSeconds('hold'));
    const release = Math.max(0.001, this._stageSeconds('release'));
    const bottom  = 1 - depth;

    // Drop the previous schedule and ramp from the current held value.
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(bottom, t + attack);
    g.setValueAtTime(bottom, t + attack + hold);
    g.linearRampToValueAtTime(1, t + attack + hold + release);
  }

  setParam(path, value) { this._params[path] = value; }

  getParam(path) { return this._params[path]; }

  getParamList() {
    const list = [
      { path: 'duck.depth', label: 'Depth', type: 'number', min: 0, max: 1, default: 0.8, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
    ];
    // Three MS↔BPM sync knobs (attack / hold / release). Each renders as one knob
    // + an MS/BPM centre toggle (FXPanel sync-knob model); the underlying ms +
    // 1/32-count params stay listed (hidden) so p-lock/serialisation keep working.
    const SYNC = {
      attack:  { label: 'Attack',  msMax: 200,  bpmMax: 16, ms: 5 },
      hold:    { label: 'Hold',    msMax: 500,  bpmMax: 16, ms: 40 },
      release: { label: 'Release', msMax: 2000, bpmMax: 32, ms: 220 },
    };
    for (const stage of STAGES) {
      const s = SYNC[stage];
      list.push(
        {
          path: `duck.${stage}.sync`, label: s.label, type: 'sync',
          modePath: `duck.${stage}SyncMode`,
          msPath:   `duck.${stage}`,
          bpmPath:  `duck.${stage}Count32`,
          bpmMin: 1, bpmMax: s.bpmMax, bpmSnap: MUSICAL_SNAP_32,
        },
        { path: `duck.${stage}`,         label: s.label,     type: 'number', min: 1, max: s.msMax, default: s.ms, modulatable: false, plockMode: 'js', hidden: true },
        { path: `duck.${stage}SyncMode`, label: `${s.label} Sync`, type: 'enum', options: ['ms', 'bpm'], default: 'ms', modulatable: false, plockMode: 'js', hidden: true },
        { path: `duck.${stage}Count32`,  label: `${s.label} Div`, type: 'number', min: 1, max: s.bpmMax, default: this._params[`duck.${stage}Count32`], modulatable: false, plockMode: 'js', hidden: true },
      );
    }
    return list;
  }

  // depth is whitelisted as a continuous JS-LFO target in Track.TRACK_JS_LFO_PARAMS;
  // there is no single AudioParam to ride (the duck gain is schedule-driven), so an
  // LFO drives depth via setParam on the rAF tick. No AudioParam target here.
  resolveAudioParam() { return null; }

  /** Hard-reset the duck gain to unity (panic / flush). */
  flush() {
    const t = this.context.currentTime;
    this._duckGain.gain.cancelScheduledValues(t);
    this._duckGain.gain.setValueAtTime(1, t);
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
