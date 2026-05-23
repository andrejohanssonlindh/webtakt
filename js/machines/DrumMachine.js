/**
 * DrumMachine.js
 * --------------
 * Synthesis-based drum machine. STUB — v0.2 target.
 * Extends Machine.js. All methods are no-ops until implemented.
 *
 * Owns:    (future) per-drum synthesis nodes (kick, snare, hat etc.)
 * Depends: Machine.js
 * Used by: Track.js (registered in machine registry)
 */

import { Machine } from './Machine.js';

export class DrumMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'drum';
    this.label = 'Drum';

    this.outputGain = context.createGain();
    this.outputGain.gain.value = 0; // silent until implemented
  }

  noteOn(midiNote, velocity, time)     { /* TODO v0.2 */ }
  noteOff(time)                        { /* TODO v0.2 */ }
  setParam(path, value, time)          { /* TODO v0.2 */ }
  getParam(path)                       { return null; }
  getParamList()                       { return []; }
  connect(destinationNode)             { this.outputGain.connect(destinationNode); }
  disconnect()                         { this.outputGain.disconnect(); }
  toJSON()                             { return { type: this.type }; }
  fromJSON(obj)                        { }
}
