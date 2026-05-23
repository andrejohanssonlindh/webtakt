/**
 * Machine.js
 * ----------
 * Abstract base class for all sound engines (machines).
 * All machine types extend this class and implement its interface.
 * Adding a new machine type = add one file, extend Machine, register in Track.js.
 *
 * Each machine owns its audio nodes and connects them to the provided outputNode.
 * The machine is responsible for responding to noteOn / noteOff events with
 * sample-accurate AudioContext timing.
 *
 * Owns:    audio nodes for this machine's synthesis
 * Depends: AudioEngine (AudioContext passed in via constructor)
 * Used by: Track.js (owns the machine), Sequencer.js (calls noteOn/noteOff)
 *
 * Public (must be implemented by subclasses):
 *   noteOn(midiNote, velocity, time)  — trigger a note at scheduled time
 *   noteOff(time)                     — release note at scheduled time
 *   setParam(path, value, time)       — set a parameter (for p-locks and UI)
 *   getParam(path)                    — get current parameter value
 *   getParamList()                    — returns array of { path, label, min, max, default }
 *   connect(destinationNode)          — connect machine output to next node in chain
 *   disconnect()                      — disconnect all outputs
 *   toJSON()                          — serialize machine state
 *   fromJSON(obj)                     — restore machine state
 *   .type                             — string identifier e.g. 'synth', 'fm', 'drum'
 *   .label                            — human-readable name
 */

export class Machine {
  /**
   * @param {AudioContext} context — from AudioEngine.context
   */
  constructor(context) {
    this.context = context;
    this.type    = 'base';
    this.label   = 'Machine';
  }

  /** @param {number} midiNote @param {number} velocity @param {number} time */
  noteOn(midiNote, velocity, time) {
    throw new Error(`${this.constructor.name} must implement noteOn()`);
  }

  /** @param {number} time */
  noteOff(time) {
    throw new Error(`${this.constructor.name} must implement noteOff()`);
  }

  /**
   * @param {string} path   — parameter path e.g. 'osc.detune', 'sub.level'
   * @param {number} value
   * @param {number} [time] — optional AudioContext time for scheduled change
   */
  setParam(path, value, time) {
    throw new Error(`${this.constructor.name} must implement setParam()`);
  }

  /** @param {string} path */
  getParam(path) {
    throw new Error(`${this.constructor.name} must implement getParam()`);
  }

  /**
   * Returns list of all controllable parameters for this machine.
   * Used by LFO destination selector, mod wheel assignment, and p-lock editor.
   * @returns {{ path: string, label: string, min: number, max: number, default: number }[]}
   */
  getParamList() {
    return [];
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    throw new Error(`${this.constructor.name} must implement connect()`);
  }

  disconnect() {
    throw new Error(`${this.constructor.name} must implement disconnect()`);
  }

  toJSON() {
    return { type: this.type };
  }

  /** @param {object} obj */
  fromJSON(obj) {
    // subclasses implement
  }

  /** Convert MIDI note number to frequency in Hz. */
  static midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
}
