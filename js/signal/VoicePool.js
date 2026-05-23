/**
 * VoicePool.js
 * ------------
 * Manages a small pool of independent voice slots per track.
 * Each slot owns a machine instance + envelope instance.
 * All slots share the track's filter, FX chain, and outputGain.
 *
 * Why: monophonic playback stacks amplitude envelopes when notes overlap
 * (fast sequences, long release tails), causing clipping. Giving each
 * concurrent note its own envelope eliminates the summing problem.
 *
 * Signal chain per slot:
 *   machine → envelope.ampGain (per-slot gate) → filter._baseHPF (shared) → filter.node → outputGain (shared)
 *
 * Voice selection: round-robin, advancing only when the chosen slot is still
 * in its release tail. If all slots are busy the oldest one is stolen.
 *
 * Public:
 *   .machine         — getter: canonical machine (slot 0) for UI reads/writes
 *   .envelope        — getter: canonical envelope (slot 0) for UI reads/writes
 *   .voiceCount      — number of active slots (default 4)
 *   nextVoice()      — returns the next available VoiceSlot
 *   setMachine(type) — replace machine type on all slots, copy params from slot 0
 *   connectLFO(lfo, path, depthScale, jsOnly) — wire LFO to all slot machines
 *   disconnectLFO(lfo, path) — remove LFO connection from all slot machines
 *   toJSON() / fromJSON()
 *
 * Owned by: Track.js
 * Depends:  Envelope.js, Machine subclasses (passed in via MACHINES map)
 */

import { Envelope } from './Envelope.js';

export class VoiceSlot {
  /**
   * @param {Machine} machine
   * @param {Envelope} envelope
   * @param {Filter}   filter       — shared filter
   * @param {GainNode} outputGain   — shared track output gain
   *
   * Signal chain per slot:
   *   machine → envelope.ampGain → filter._baseHPF (shared) → … → filter.node → outputGain
   *
   * The ampGain gates the machine BEFORE the shared filter so each slot is
   * fully isolated — a silent slot contributes no audio even though all slots
   * feed into the same filter input. The filter envelope still modulates
   * filter.node.frequency directly (shared, last-writer-wins, which is fine).
   */
  constructor(machine, envelope, filter, outputGain) {
    this.machine  = machine;
    this.envelope = envelope;
    this._filter  = filter;

    // machine → envelope.ampGain (per-slot isolation gate)
    this.machine.connect(envelope.ampGain);

    // envelope.ampGain → filter._baseHPF (shared filter input)
    this.envelope.connect(filter._baseHPF);

    // filter chain is already wired: _baseHPF → _baseLPF → filter.node → outputGain
    // That final connection (filter.node → outputGain) is made once by Track after pool creation.

    // Busy tracking: AudioContext time at which this slot becomes free.
    this._freeAt = 0;
  }

  /**
   * Mark this slot as busy until `freeAt` (AudioContext time).
   * Called by VoicePool just before firing a note.
   */
  claim(freeAt) {
    this._freeAt = freeAt;
  }

  isBusy(now) {
    return this._freeAt > now;
  }

  /** Disconnect this slot from the audio graph cleanly. */
  dispose() {
    this.machine.disconnect();
    // envelope.ampGain → filter._baseHPF: disconnect the slot's gate from filter input
    try { this.envelope.ampGain.disconnect(this._filter._baseHPF); } catch (_) {}
    this.envelope.disconnect();
  }
}

export class VoicePool {
  /**
   * @param {AudioContext}  context
   * @param {Filter}        filter      — shared track filter
   * @param {GainNode}      outputGain  — shared track output gain
   * @param {function}      makeMachine — (context) => Machine instance
   * @param {number}        [count=4]
   */
  constructor(context, filter, outputGain, makeMachine, count = 4) {
    this._context    = context;
    this._filter     = filter;
    this._outputGain = outputGain;
    this._makeMachine = makeMachine;
    this._slots      = [];
    this._robin      = 0;   // round-robin cursor

    for (let i = 0; i < count; i++) {
      this._slots.push(this._makeSlot());
    }
  }

  _makeSlot() {
    const machine  = this._makeMachine(this._context);
    const envelope = new Envelope(this._context);
    envelope.connectToFilter(this._filter);
    return new VoiceSlot(machine, envelope, this._filter);
  }

  get voiceCount() { return this._slots.length; }

  /** Canonical machine — slot 0. UI reads/writes params here. */
  get machine()  { return this._slots[0].machine;  }

  /** Canonical envelope — slot 0. UI reads/writes params here. */
  get envelope() { return this._slots[0].envelope; }

  /**
   * Return the next voice slot to use.
   * Prefers an idle slot in round-robin order.
   * If all slots are busy, returns the one whose release ends soonest (steal oldest).
   * Syncs the chosen slot's machine+envelope params from slot 0 before returning,
   * so UI knob changes always take effect on the next note regardless of which slot fires.
   */
  nextVoice() {
    const now = this._context.currentTime;

    let chosen = -1;

    // Try round-robin slots starting from cursor
    for (let i = 0; i < this._slots.length; i++) {
      const idx = (this._robin + i) % this._slots.length;
      if (!this._slots[idx].isBusy(now)) {
        chosen = idx;
        this._robin = (idx + 1) % this._slots.length;
        break;
      }
    }

    if (chosen === -1) {
      // All busy — steal the one that will be free soonest
      let minFree = Infinity;
      for (let i = 0; i < this._slots.length; i++) {
        if (this._slots[i]._freeAt < minFree) {
          minFree = this._slots[i]._freeAt;
          chosen  = i;
        }
      }
      this._robin = (chosen + 1) % this._slots.length;
    }

    const slot = this._slots[chosen];

    // Sync params from canonical slot 0 to the chosen slot (skip slot 0 itself)
    if (chosen !== 0) {
      const machineJSON = this._slots[0].machine.toJSON();
      slot.machine.fromJSON(machineJSON);
      const envJSON = this._slots[0].envelope.toJSON();
      slot.envelope.fromJSON(envJSON);
    }

    return slot;
  }

  /**
   * Sync all slot params to match slot 0 (canonical), then swap machine type.
   * Called by Track.setMachine().
   * @param {function} makeMachine — (context) => new Machine of desired type
   */
  setMachine(makeMachine) {
    this._makeMachine = makeMachine;

    // Capture canonical JSON before destroying anything
    const canonicalJSON = this._slots[0].machine.toJSON();

    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      // Disconnect old machine from the slot's envelope ampGain
      slot.machine.disconnect();
      // Build new machine, restore params, and reconnect to slot's envelope gate
      const newMachine = makeMachine(this._context);
      newMachine.fromJSON(canonicalJSON);
      newMachine.connect(slot.envelope.ampGain);
      slot.machine = newMachine;
    }
  }

  /**
   * Sync params from slot 0 to all other slots.
   * Called after any UI param change so all voices are consistent.
   */
  syncParams() {
    if (this._slots.length <= 1) return;
    const json = this._slots[0].machine.toJSON();
    for (let i = 1; i < this._slots.length; i++) {
      this._slots[i].machine.fromJSON(json);
    }
    const envJson = this._slots[0].envelope.toJSON();
    for (let i = 1; i < this._slots.length; i++) {
      this._slots[i].envelope.fromJSON(envJson);
    }
  }

  /**
   * Connect an LFO to the given AudioParam path on every slot's machine.
   * @param {LFO}    lfo
   * @param {string} path        — param path e.g. 'osc.detune'
   * @param {number} depthScale
   */
  connectLFOToAll(lfo, path, depthScale) {
    for (const slot of this._slots) {
      const ap = slot.machine.resolveAudioParam?.(path);
      if (ap) lfo.addDestination(ap, depthScale);
    }
  }

  /**
   * Disconnect an LFO from the given path on every slot's machine.
   */
  disconnectLFOFromAll(lfo, path) {
    for (const slot of this._slots) {
      const ap = slot.machine.resolveAudioParam?.(path);
      if (ap) lfo.removeDestination(ap);
    }
  }

  /**
   * Tear down all slots (called when track is destroyed or machine type changes).
   */
  dispose() {
    for (const slot of this._slots) {
      slot.dispose();
    }
    this._slots = [];
  }

  toJSON() {
    return {
      voiceCount: this._slots.length,
      machine:    this._slots[0].machine.toJSON(),
      envelope:   this._slots[0].envelope.toJSON(),
    };
  }

  fromJSON(obj, makeMachine) {
    if (makeMachine) this._makeMachine = makeMachine;
    this._slots[0].machine.fromJSON(obj.machine ?? {});
    this._slots[0].envelope.fromJSON(obj.envelope ?? {});
    this.syncParams();
  }
}
