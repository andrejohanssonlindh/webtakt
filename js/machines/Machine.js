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

  // ──────────────────────────────────────────────────────────────────────
  // Declarative param spec (opt-in)
  // ──────────────────────────────────────────────────────────────────────
  // A machine opts in by defining `static SPEC` and calling `this._initSpec()`
  // at the END of its constructor (after its audio nodes exist). The base then
  // derives setParam / getParam / getParamList / resolveAudioParam / toJSON /
  // fromJSON from the spec, so the machine deletes those six members.
  //
  // Machines that do NOT call _initSpec() keep their own hand-rolled overrides
  // untouched — both styles coexist, so migration is incremental.
  //
  // Spec entry per path:
  //   label, type ('number'|'enum'|'boolean'), min, max, default, options,
  //   hidden, modulatable, lfoMin, lfoMax, plockMode   — descriptor fields,
  //     copied verbatim into getParamList() (these NAMES are a contract read by
  //     the sequencer, LFO routing, UI panels, formatParam, serialization).
  //   target       (m) => AudioParam   — lazy; drives auto-schedule + resolveAudioParam
  //   schedule     'setTarget' (default) | 'setValue'
  //   tc           setTargetAtTime time-constant (default 0.005)
  //   apply        (value, time, m) => void  — JS side-effect, runs after store
  //   manualTarget true → `target` is exposed to resolveAudioParam/LFO only;
  //                setParam does NOT auto-schedule it (the `apply` hook owns the
  //                write). Used by ChordMachine 'osc.detune' and samplers'
  //                'output.level' (resolved for LFO, applied per-noteOn).
  //
  // `default` doubles as the _params init value. SPEC is static (one allocation
  // per class); getParamList() is cached on the class (descriptors are read-only).

  /** Initialise _params from the class SPEC defaults. Call at end of constructor. */
  _initSpec() {
    this._spec = this.constructor.SPEC;
    if (!this._params) this._params = {};
    for (const [path, s] of Object.entries(this._spec)) {
      if (!(path in this._params)) this._params[path] = s.default;
    }
  }

  /** True when this instance opted into the declarative spec. */
  _hasSpec() { return this._spec != null; }

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
    if (!this._hasSpec()) {
      throw new Error(`${this.constructor.name} must implement setParam()`);
    }
    this._params[path] = value;
    const s = this._spec[path];
    if (!s) return;                       // unknown path → store-only (matches old switch default)
    const t = time ?? this.context.currentTime;
    if (s.target && !s.manualTarget) {
      const ap = s.target(this);
      if (s.schedule === 'setValue') ap.setValueAtTime(value, t);
      else ap.setTargetAtTime(value, t, s.tc ?? 0.005);
    }
    if (s.apply) s.apply(value, t, this);
  }

  /** @param {string} path */
  getParam(path) {
    if (!this._hasSpec()) {
      throw new Error(`${this.constructor.name} must implement getParam()`);
    }
    return this._params[path];
  }

  /**
   * Returns list of all controllable parameters for this machine.
   * Used by LFO destination selector, mod wheel assignment, and p-lock editor.
   * Spec-driven machines derive (and cache) this from `static SPEC`; the cache
   * lives on the class because the spec is static and the result is read-only.
   * @returns {{ path: string, label: string, min: number, max: number, default: number }[]}
   */
  getParamList() {
    if (!this._hasSpec()) return [];
    const cls = this.constructor;
    if (!cls._paramListCache) cls._paramListCache = Machine._buildParamList(cls.SPEC);
    return cls._paramListCache;
  }

  /**
   * Build descriptor array from a SPEC, emitting fields with the SAME branching
   * the hand-written getParamList()s used, so truthiness matches exactly (a
   * stray `undefined` field would change `p.hidden`/`p.modulatable` checks).
   */
  static _buildParamList(spec) {
    return Object.entries(spec).map(([path, s]) => {
      const d = { path, label: s.label, type: s.type };
      if (s.type === 'number')  { d.min = s.min; d.max = s.max; d.default = s.default; }
      if (s.type === 'enum')    { d.options = s.options; }
      if (s.type === 'boolean') { d.default = s.default; }
      if (s.modulatable)        { d.modulatable = true; d.lfoMin = s.lfoMin; d.lfoMax = s.lfoMax; }
      else if ('modulatable' in s) d.modulatable = false;   // samplers emit this explicitly
      if (s.hidden) d.hidden = true;
      // Optional layout hint: panels (DefaultMachinePanel) cluster params sharing
      // a `group` into a labelled row. No group → flows in the default run, so
      // machines that don't declare it render exactly as before.
      if (s.group) d.group = s.group;
      d.plockMode = s.plockMode ?? (s.target ? 'audioParam' : 'js');
      return d;
    });
  }

  /**
   * @param {string} path @returns {AudioParam|null}
   * Spec-driven: returns the param's `target()` (incl. manualTarget params, so
   * LFO/mod-wheel can still bind them). Un-converted machines override this.
   */
  resolveAudioParam(path) {
    const s = this._spec?.[path];
    return s?.target ? s.target(this) : null;
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    throw new Error(`${this.constructor.name} must implement connect()`);
  }

  /**
   * Disconnect all of this machine's outputs AND release any background timers
   * (setInterval drift timers, etc.) it owns. Callers (e.g. VoicePool.setMachine)
   * drop the machine reference right after, so anything not released here leaks
   * for the lifetime of the page. Machines with no timers just disconnect nodes.
   */
  disconnect() {
    throw new Error(`${this.constructor.name} must implement disconnect()`);
  }

  toJSON() {
    if (this._hasSpec()) return { type: this.type, params: { ...this._params } };
    return { type: this.type };
  }

  /** @param {object} obj */
  fromJSON(obj) {
    if (this._hasSpec()) {
      Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    }
    // non-spec subclasses implement
  }

  /**
   * Restore only JS-state params from JSON — skips AudioParam-backed params
   * (plockMode: 'audioParam') so in-flight scheduled gain ramps are not interrupted.
   * Called by VoicePool.nextVoice() when syncing a non-canonical slot.
   */
  fromJSONSafe(obj) {
    const audioParamPaths = new Set(
      this.getParamList()
        .filter(p => p.plockMode === 'audioParam')
        .map(p => p.path)
    );
    const params = obj.params ?? {};
    Object.entries(params).forEach(([k, v]) => {
      if (!audioParamPaths.has(k)) this.setParam(k, v);
    });
  }

  /**
   * Copy AudioParam-backed param VALUES (plockMode: 'audioParam') from another
   * machine into this one's JS state ONLY — without scheduling any AudioParam.
   * Called by VoicePool.nextVoice() so a reused slot carries the canonical
   * slot-0 values in its _params; syncParamsAt(time) then schedules them at the
   * note start (not now), avoiding interruption of any in-flight release tail.
   * @param {Machine} src — canonical (slot-0) machine to copy values from
   */
  copyAudioParamState(src) {
    if (!this._params || !src) return;
    this.getParamList()
      .filter(p => p.plockMode === 'audioParam')
      .forEach(p => {
        const v = src.getParam(p.path);
        if (v !== undefined) this._params[p.path] = v;
      });
  }

  /**
   * Apply AudioParam-backed params at a scheduled audio time.
   * Called by the sequencer just before noteOn so level/etc snap at note start.
   * @param {number} time — AudioContext scheduled time
   */
  syncParamsAt(time) {
    const params = this.getParamList().filter(p => p.plockMode === 'audioParam');
    params.forEach(p => {
      const v = this.getParam(p.path);
      if (v !== undefined) this.setParam(p.path, v, time);
    });
  }

  /** Convert MIDI note number to frequency in Hz. */
  static midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
}
