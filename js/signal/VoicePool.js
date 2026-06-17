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
 *   machine → filter (per-slot) → envelope.ampGain (per-slot gate) → outputGain (shared)
 *
 * Each slot owns its OWN filter so the amp gate sits AFTER the filter, exactly
 * as in the pre-polyphony topology. This keeps every idle voice fully silent —
 * including the filter's resonant ringing tail — instead of letting one shared
 * filter bleed its ring across steps (the "pre-sound / ghost note" bug). The
 * slot-0 filter is canonical (UI/sequencer read & write it) and mirrors every
 * param change to the sibling slot filters so all voices stay identical.
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
   * @param {Machine}  machine
   * @param {Envelope} envelope
   * @param {Filter}   filter       — this slot's own filter
   * @param {GainNode} outputGain   — shared track output gain
   *
   * Signal chain per slot:
   *   machine → filter._baseHPF → … → filter._outputGain → envelope.ampGain → outputGain
   *
   * The filter sits BEFORE the amp gate so the gate silences the filter's own
   * resonant ring between notes — each slot is fully isolated, contributing no
   * audio (and no filter ring) while idle. The slot envelope drives this slot's
   * own filter frequency, so the filter envelope is identical per voice.
   */
  constructor(machine, envelope, filter, outputGain) {
    this.machine  = machine;
    this.envelope = envelope;
    this._filter  = filter;

    // machine → filter input (per-slot filter)
    this.machine.connect(filter._baseHPF);

    // filter output → envelope.ampGain (per-slot gate)
    filter.connect(envelope.ampGain);

    // envelope.ampGain → shared track outputGain
    this.envelope.connect(outputGain);

    // This slot's envelope drives this slot's own filter frequency envelope.
    this.envelope.connectToFilter(filter);

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

  /**
   * Hard kill this slot: release the machine (stops oscillators / sample sources
   * where the machine supports it) and slam the amp gate to silence, cancelling
   * any pending automation. Frees the slot for immediate reuse. Used by the
   * global STOP/panic button.
   */
  silence(time) {
    try { this.machine.noteOff?.(time); } catch (_) {}
    this.envelope.silence(time);
    this._freeAt = 0;
  }

  /** Disconnect this slot from the audio graph cleanly. */
  dispose() {
    this.machine.disconnect();
    try { this._filter.disconnect(); } catch (_) {}
    this.envelope.disconnect();
  }
}

export class VoicePool {
  /**
   * @param {AudioContext}  context
   * @param {Filter}        filter      — canonical (slot-0) track filter
   * @param {GainNode}      outputGain  — shared track output gain
   * @param {function}      makeMachine — (context) => Machine instance
   * @param {function}      makeFilter  — (context) => Filter instance (for slots 1..n)
   * @param {number}        [count=4]
   */
  constructor(context, filter, outputGain, makeMachine, makeFilter, count = 4) {
    this._context     = context;
    this._filter      = filter;       // canonical slot-0 filter
    this._outputGain  = outputGain;
    this._makeMachine = makeMachine;
    this._makeFilter  = makeFilter;
    this._slots       = [];
    this._robin       = 0;   // round-robin cursor
    this._bpm         = 120; // current tempo, propagated to new slot envelopes

    for (let i = 0; i < count; i++) {
      this._slots.push(this._makeSlot(i === 0));
    }
  }

  _makeSlot(isCanonical = false) {
    const machine  = this._makeMachine(this._context);
    machine.setBpm?.(this._bpm);   // machines with tempo-synced env stages (FM)
    const envelope = new Envelope(this._context);
    envelope.setBpm(this._bpm);
    // Slot 0 uses the canonical track filter; other slots get their own filter
    // that mirrors the canonical one's params (set in mirrorTo below).
    const filter = isCanonical ? this._filter : this._makeFilter(this._context);
    if (!isCanonical) this._filter.mirrorTo(filter);
    return new VoiceSlot(machine, envelope, filter, this._outputGain);
  }

  get voiceCount() { return this._slots.length; }

  /** Canonical machine — slot 0. UI reads/writes params here. */
  get machine()  { return this._slots[0].machine;  }

  /** Canonical envelope — slot 0. UI reads/writes params here. */
  get envelope() { return this._slots[0].envelope; }

  /** Canonical filter — slot 0. UI/sequencer read/write params here. */
  get filter()   { return this._slots[0]._filter; }

  /** All per-slot filters — used for direct AudioParam writes (e.g. DJ filter). */
  get filters()  { return this._slots.map(s => s._filter); }

  /** All per-slot envelopes — used for direct ampGain writes (e.g. Input continuous gate). */
  get envelopes() { return this._slots.map(s => s.envelope); }

  /** All per-slot machines — used to fan a shared op across voices (e.g. Input enable). */
  get machines() { return this._slots.map(s => s.machine); }

  /** Propagate the current BPM to every slot's envelope + machine (tempo-synced stages). */
  setBpm(bpm) {
    this._bpm = bpm;
    for (const slot of this._slots) {
      slot.envelope.setBpm(bpm);
      slot.machine.setBpm?.(bpm);   // machines with tempo-synced env stages (FM)
    }
  }

  /** Hard kill every voice slot (global STOP/panic). */
  silence(time) {
    for (const slot of this._slots) slot.silence(time);
    this._robin = 0;
  }

  /**
   * Return the next voice slot to use for a note scheduled at `noteTime`.
   *
   * The scheduler runs 100ms ahead of audio time, so we compare _freeAt against
   * `noteTime` (the scheduled note start), not context.currentTime. Using currentTime
   * caused future-scheduled notes to fill the pool, forcing premature slot stealing
   * and fromJSON calls that produced audible pre-note glitches on every track.
   *
   * @param {number} [noteTime] — AudioContext scheduled start time. Defaults to
   *   context.currentTime when called from live keyboard (no lookahead).
   */
  nextVoice(noteTime) {
    const now = noteTime ?? this._context.currentTime;

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

    // Sync params from canonical slot 0 to the chosen slot (skip slot 0 itself).
    // fromJSONSafe applies JS-state params (waveforms, enums) immediately.
    // AudioParam-backed params (output.level, detune, …) must NOT fire
    // setValueAtTime(now) — that would interrupt any still-ringing release tail
    // on this slot's outputGain. Instead copyAudioParamState copies their VALUES
    // into the slot's JS _params, and the sequencer's machine.syncParamsAt(time)
    // schedules them at the note start. This ensures a reused voice plays the
    // canonical level/detune even though fromJSONSafe skips those params.
    if (chosen !== 0) {
      const canonical = this._slots[0].machine;
      slot.machine.fromJSONSafe(canonical.toJSON());
      slot.machine.copyAudioParamState(canonical);
      slot.machine.syncFrom?.(canonical);
      slot.envelope.fromJSON(this._slots[0].envelope.toJSON());
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

    // Capture canonical JSON before destroying anything — only reapply if the
    // new machine is the same type (same-type rebuild). Cross-type swaps must
    // not bleed params like output.level from the old machine onto the new one.
    const oldCanonical = this._slots[0].machine;
    const canonicalJSON = oldCanonical.toJSON();
    const oldType = canonicalJSON.type;

    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      // Disconnect old machine from the slot's signal chain.
      slot.machine.disconnect();
      // Cancel any in-flight envelope automation so the new machine isn't
      // silenced by a long release tail from the previous machine type.
      const g = slot.envelope.ampGain.gain;
      g.cancelScheduledValues(this._context.currentTime);
      g.setValueAtTime(0, this._context.currentTime);
      slot._freeAt = 0;
      // Build new machine and reconnect to the slot's FILTER input — the slot
      // chain is machine → filter → envelope.ampGain (as set up in the VoiceSlot
      // constructor). Connecting to ampGain directly would bypass the filter,
      // so the machine must feed the filter's base-HPF entry node.
      const newMachine = makeMachine(this._context);
      newMachine.setBpm?.(this._bpm);   // tempo-synced env stages (FM)
      if (newMachine.type === oldType) {
        newMachine.fromJSON(canonicalJSON);
        // fromJSON restores sampleId/name but NOT the live AudioBuffer (it is
        // "handled externally" via SampleStore). On a same-type sampler rebuild
        // the buffer is already in memory on the old machine — carry it over so
        // the loaded/recorded sample survives the swap without a re-decode.
        newMachine.syncFrom?.(oldCanonical);
      } else if (typeof newMachine.setBuffer === 'function' &&
                 typeof oldCanonical.getBuffer === 'function') {
        // Cross-type swap between SINGLE-buffer samplers (sampler ↔ sample-swarm):
        // carry the loaded/recorded buffer AND the comparable settings across so
        // they aren't lost. Detected by the shared single-buffer protocol
        // (getBuffer/setBuffer) — the A/B wt-sampler lacks these, so it is
        // correctly excluded.
        const buf = oldCanonical.getBuffer();
        if (buf) newMachine.setBuffer(buf, oldCanonical.sampleId, oldCanonical.sampleName);
        // Carry every param the two machines have in COMMON (start/end/loopStart,
        // speed, reverse, loop, level, …). Keys unique to either side are left at
        // the new machine's defaults. setParam (not raw assign) so side effects
        // like swarm spread recompute fire.
        const newParams = newMachine.getParamList?.().map(p => p.path) ?? [];
        for (const path of newParams) {
          const v = oldCanonical.getParam?.(path);
          if (v !== undefined) newMachine.setParam(path, v);
        }
      }
      newMachine.connect(slot._filter._baseHPF);
      slot.machine = newMachine;
    }
  }

  /**
   * Drop the loaded sample on every slot machine that supports it (panel RESET).
   * Param reset is handled by the caller (canonical setParam + syncParams).
   */
  clearSampleBuffers() {
    for (const slot of this._slots) slot.machine.clearBuffer?.();
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
      this._slots[i].machine.syncFrom?.(this._slots[0].machine);
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
   * Connect an LFO to a filter AudioParam path on every slot's filter, so all
   * voices modulate identically (each slot owns its own filter).
   * @param {LFO}    lfo
   * @param {string} path        — filter param path e.g. 'filter.cutoff'
   * @param {number} depthScale
   */
  connectLFOToAllFilters(lfo, path, depthScale) {
    for (const slot of this._slots) {
      // A single filter path may resolve to several AudioParams (e.g. cutoff
      // fans to every slope stage's .detune) — connect to all of them.
      const targets = slot._filter.resolveLFOTargets?.(path) ?? [];
      for (const ap of targets) lfo.addDestination(ap, depthScale);
    }
  }

  /** Disconnect an LFO from a filter AudioParam path on every slot's filter. */
  disconnectLFOFromAllFilters(lfo, path) {
    for (const slot of this._slots) {
      const targets = slot._filter.resolveLFOTargets?.(path) ?? [];
      for (const ap of targets) lfo.removeDestination(ap);
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
