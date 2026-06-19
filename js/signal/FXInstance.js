/**
 * FXInstance.js
 * -------------
 * A thin namespacing proxy around a real FX block (DelayFX / BitcrushFX /
 * ChorusFX / ReverbFX / FXFilter / …) so that MULTIPLE instances of the same
 * effect type can coexist on one track without their param paths colliding.
 *
 * The wrapped FX speaks bare paths (`reverb.wet`). This proxy speaks PREFIXED
 * paths (`fx5.reverb.wet`) on its public surface — getParamList() returns
 * prefixed paths, and setParam/getParam/resolveAudioParam strip the prefix
 * before delegating. To the rest of the app (Sequencer p-lock dispatch, LFO
 * routing, mod wheel, UI param lists) a proxied instance is indistinguishable
 * from a base FX — it just owns a different, unique set of paths.
 *
 * The base four FX (delay/crush/chorus/reverb) are NOT proxied: they keep their
 * bare paths for back-compat (existing projects, p-locks, presets). Only blocks
 * ADDED via "Add FX" get an FXInstance wrapper with a `fxN.` prefix.
 *
 * Audio graph passthrough: inputNode / outputNode / connect / disconnect /
 * connectInput are forwarded to the wrapped FX so Track._rewireFXChain treats a
 * proxy exactly like a bare block.
 *
 * Path rewriting also covers nested path refs inside descriptors — `sync`-type
 * params carry modePath/msPath/bpmPath that must be prefixed too, else the FX
 * panel's sync knob would write the wrong (bare) path.
 */

const PREFIX_RE = /^fx\d+\./;

export class FXInstance {
  /**
   * @param {object} fx   — the wrapped FX block (bare-path interface)
   * @param {number} id   — unique instance id on the track
   * @param {string} type — block type key ('delay'|'crush'|'chorus'|'reverb'|'filter'|…)
   */
  constructor(fx, id, type) {
    this.fx     = fx;
    this.id     = id;
    this.type   = type;
    this.prefix = `fx${id}.`;
  }

  // ── Audio graph passthrough ────────────────────────────────
  get inputNode()  { return this.fx.inputNode;  }
  get outputNode() { return this.fx.outputNode; }
  get enabled()    { return this.fx.enabled;    }
  set enabled(v)   { this.fx.enabled = v;       }

  connect(dest)        { return this.fx.connect(dest); }
  connectInput(src)    { return this.fx.connectInput?.(src); }
  disconnect()         { return this.fx.disconnect(); }
  // Permanent teardown (kills worklet processors). Falls back to disconnect for
  // blocks that don't implement it.
  destroy()            { return (this.fx.destroy ?? this.fx.disconnect).call(this.fx); }
  setEnabled(on)       { return this.fx.setEnabled?.(on); }
  setBpm(bpm)          { return this.fx.setBpm?.(bpm); }
  flush()              { return this.fx.flush?.(); }

  // ── Path namespacing ───────────────────────────────────────

  /** Strip our `fxN.` prefix from a path (no-op if absent). */
  _strip(path) {
    return path?.startsWith(this.prefix) ? path.slice(this.prefix.length) : path;
  }

  /** Add our prefix to a bare path. */
  _add(path) {
    return this.prefix + path;
  }

  /** True if `path` belongs to this instance. */
  ownsPath(path) {
    return typeof path === 'string' && path.startsWith(this.prefix);
  }

  setParam(path, value, time) { return this.fx.setParam(this._strip(path), value, time); }
  getParam(path)              { return this.fx.getParam(this._strip(path)); }
  resolveAudioParam(path)     { return this.fx.resolveAudioParam?.(this._strip(path)) ?? null; }

  /**
   * Param descriptors with EVERY path field prefixed: `path`, and the nested
   * refs `modePath` / `msPath` / `bpmPath` carried by `type: 'sync'` params.
   */
  getParamList() {
    return this.fx.getParamList().map(p => {
      const out = { ...p, path: this._add(p.path) };
      if (p.modePath) out.modePath = this._add(p.modePath);
      if (p.msPath)   out.msPath   = this._add(p.msPath);
      if (p.bpmPath)  out.bpmPath  = this._add(p.bpmPath);
      return out;
    });
  }

  // ── Serialisation ──────────────────────────────────────────
  toJSON() {
    return { id: this.id, type: this.type, ...this.fx.toJSON() };
  }

  fromJSON(obj) {
    return this.fx.fromJSON(obj);
  }
}

/** Strip any `fxN.` instance prefix from a path → its bare form. */
export function stripFXPrefix(path) {
  return typeof path === 'string' ? path.replace(PREFIX_RE, '') : path;
}

/** Extract the `fxN` instance token from a path, or null if it has none. */
export function fxTokenOf(path) {
  const m = typeof path === 'string' ? path.match(/^(fx\d+)\./) : null;
  return m ? m[1] : null;
}
