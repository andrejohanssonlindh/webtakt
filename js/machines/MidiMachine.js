/**
 * MidiMachine.js
 * --------------
 * A machine that routes sequencer note events to MIDI out instead of audio.
 * No audio nodes are created — connect()/disconnect() are no-ops so the
 * normal Track signal chain is unaffected (silent output).
 *
 * The MidiEngine instance is set after construction via setMidiEngine().
 * MidiMachine holds its own output port selection and channel so each track
 * can target a different port/channel independently.
 *
 * Parameters:
 *   'midi.channel'     — MIDI channel 1–16 (integer)
 *   'midi.noteOffset'  — semitone offset applied to every outgoing note (-24 to +24)
 *
 * Audio graph: none — outputGain is a silent placeholder so Track's pool wiring
 * doesn't break. It stays at gain=0 and is never connected to anything audible.
 */

import { Machine } from './Machine.js';

export class MidiMachine extends Machine {
  /** @param {AudioContext} context */
  constructor(context) {
    super(context);
    this.type  = 'midi';
    this.label = 'MIDI';

    this._params = {
      'midi.channel':    1,
      'midi.noteOffset': 0,
    };

    // Silent placeholder gain — VoicePool expects an outputGain node
    this.outputGain = context.createGain();
    this.outputGain.gain.value = 0;

    // Set by Track after construction via setMidiEngine()
    this._midiEngine  = null;
    this._outputPortId = null;   // which MIDI output port to use
    this._lastNote    = null;    // track active note for noteOff
  }

  /**
   * @param {import('../core/MidiEngine.js').MidiEngine} engine
   */
  setMidiEngine(engine) {
    this._midiEngine = engine;
  }

  /** @param {string|null} portId */
  setOutputPort(portId) {
    this._outputPortId = portId;
  }

  getOutputPort() {
    return this._outputPortId;
  }

  noteOn(midiNote, velocity, time) {
    if (!this._midiEngine?.available || !this._outputPortId) return;
    const ch   = Math.round(this._params['midi.channel']);
    const note = Math.max(0, Math.min(127, midiNote + Math.round(this._params['midi.noteOffset'])));
    this._midiEngine.sendNoteOn(this._outputPortId, ch, note, velocity, time, this.context);
    this._lastNote = note;
  }

  noteOff(time) {
    if (!this._midiEngine?.available || !this._outputPortId || this._lastNote === null) return;
    const ch = Math.round(this._params['midi.channel']);
    this._midiEngine.sendNoteOff(this._outputPortId, ch, this._lastNote, time, this.context);
    this._lastNote = null;
  }

  setParam(path, value) {
    if (path in this._params) this._params[path] = value;
  }

  getParam(path) {
    return this._params[path] ?? null;
  }

  getParamList() {
    return [
      { path: 'midi.channel',    label: 'Channel',     type: 'number', min: 1,   max: 16,  default: 1,  step: 1,   fmt: v => Math.round(v).toString() },
      { path: 'midi.noteOffset', label: 'Note Offset', type: 'number', min: -24, max: 24,  default: 0,  step: 1,   fmt: v => { const n = Math.round(v); return n === 0 ? '0' : (n > 0 ? '+' : '') + n; } },
    ];
  }

  // No audio output — no-ops
  connect()    {}
  disconnect() {}

  toJSON() {
    return {
      type:       this.type,
      outputPort: this._outputPortId,
      ...this._params,
    };
  }

  fromJSON(obj) {
    if (obj['midi.channel']    !== undefined) this._params['midi.channel']    = obj['midi.channel'];
    if (obj['midi.noteOffset'] !== undefined) this._params['midi.noteOffset'] = obj['midi.noteOffset'];
    if (obj.outputPort         !== undefined) this._outputPortId = obj.outputPort;
  }
}
