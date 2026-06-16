/**
 * GateFX.js
 * ---------
 * Per-track BPM-synced rhythmic gate ("trance gate"): a repeating 16-slot on/off
 * pattern chops the signal in time with the tempo. Each slot is a 1/16 note by
 * default (the step size is itself a sync knob, so you can make it 1/8, 1/32, …).
 *
 * The gate is rendered by scheduling AudioParam ramps on a gain node ahead of the
 * audio clock — sample-accurate and tempo-locked. A lookahead loop (rAF, with a
 * timer fallback for headless tests, mirroring NormalizerFX) tops up the schedule.
 *
 * On slots are at full level; off slots drop to (1 − depth). `smooth` sets the
 * edge ramp so you can go from hard chops to soft pulsing.
 *
 * Signal chain (internal):  input → gateGain → output
 *
 * Parameters:
 *   'gate.pattern' — 16-char on/off mask string of '1'/'0', default '1010101010101010'
 *   'gate.depth'   — 0..1, default 1   (how far off slots duck; 1 = full silence)
 *   'gate.smooth'  — 0..1, default 0.15 (edge ramp as a fraction of slot length)
 *   'gate.syncMode'   — 'bpm' (only) — slot size is always tempo-locked
 *   'gate.bpmCount32' — 1/32 count per slot, default 2 (= 1/16)
 *
 * Public: the standard FX block interface.
 */

import { count32ToSeconds, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

const SLOTS = 16;
const DEFAULT_PATTERN = '1010101010101010';

export class GateFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'gate.pattern':     DEFAULT_PATTERN,
      'gate.depth':       1,
      'gate.smooth':      0.15,
      'gate.syncMode':    'bpm',
      'gate.bpmCount32':  2,        // 1/16
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._gateGain = context.createGain();
    this._gateGain.gain.value = 1;

    this.inputNode.connect(this._gateGain).connect(this.outputNode);

    // Scheduling state: which slot we have scheduled up to, and at what time.
    this._slotIndex   = 0;
    this._nextSlotAt  = 0;
    this._raf  = null;
    this._tick = this._tick.bind(this);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  _slotSeconds() {
    return Math.max(0.01, count32ToSeconds(this._params['gate.bpmCount32'], this._bpm));
  }

  _patternMask() {
    const p = String(this._params['gate.pattern'] ?? DEFAULT_PATTERN);
    // Normalise to exactly SLOTS chars (pad with the pattern repeated / trim).
    const out = [];
    for (let i = 0; i < SLOTS; i++) out.push(p[i % (p.length || 1)] === '1' ? 1 : 0);
    return out;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    if (enabled) {
      this._gateGain.gain.cancelScheduledValues(t);
      this._slotIndex  = 0;
      this._nextSlotAt = t + 0.02;
      this._gateGain.gain.setValueAtTime(this._gateGain.gain.value, t);
      this._startLoop();
    } else {
      this._stopLoop();
      this._gateGain.gain.cancelScheduledValues(t);
      this._gateGain.gain.setTargetAtTime(1, t, 0.02);
    }
  }

  setBpm(bpm) { this._bpm = bpm; }

  setParam(path, value, time) {
    this._params[path] = value;
    // No immediate node write — the schedule loop reads params each slot, so a
    // pattern/depth/smooth/division change takes effect at the next scheduled slot.
  }

  getParam(path) { return this._params[path]; }

  // ── Lookahead scheduler ────────────────────────────────────

  _startLoop() {
    if (this._raf != null) return;
    if (typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._tick);
    } else {
      this._raf = setInterval(this._tick, 25);
    }
  }

  _stopLoop() {
    if (this._raf == null) return;
    if (typeof cancelAnimationFrame === 'function' && typeof requestAnimationFrame === 'function') {
      cancelAnimationFrame(this._raf);
    } else {
      clearInterval(this._raf);
    }
    this._raf = null;
  }

  /** Schedule every slot whose start falls within the lookahead window. */
  _tick() {
    if (!this.enabled) { this._raf = null; return; }
    const now       = this.context.currentTime;
    const horizon   = now + 0.1;          // 100 ms lookahead
    const slotLen   = this._slotSeconds();
    const mask      = this._patternMask();
    const depth     = this._params['gate.depth'];
    const smoothFr  = Math.min(0.49, Math.max(0, this._params['gate.smooth']));
    const ramp      = Math.max(0.002, slotLen * smoothFr);
    const g         = this._gateGain.gain;

    while (this._nextSlotAt < horizon) {
      const on    = mask[this._slotIndex % SLOTS] === 1;
      const level = on ? 1 : (1 - depth);
      const at    = Math.max(now, this._nextSlotAt);
      // Ramp to the slot level at the slot boundary (an exponential-ish edge via
      // setTargetAtTime; the ramp length scales with the smooth fraction).
      g.setTargetAtTime(level, at, ramp / 3);

      this._slotIndex  = (this._slotIndex + 1) % SLOTS;
      this._nextSlotAt += slotLen;
    }

    if (typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  getParamList() {
    return [
      { path: 'gate.depth',  label: 'Depth',  type: 'number', min: 0, max: 1, default: 1,    modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
      { path: 'gate.smooth', label: 'Smooth', type: 'number', min: 0, max: 1, default: 0.15, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
      // Slot size as a BPM sync knob. There is no MS mode (a gate only makes
      // sense tempo-locked); msPath points at a phantom seconds value that the
      // knob never writes in practice because the toggle stays on BPM.
      {
        path: 'gate.sync', label: 'Slot', type: 'sync', noToggle: true,
        modePath: 'gate.syncMode',
        msPath:   'gate.bpmCount32',
        bpmPath:  'gate.bpmCount32',
        bpmMin: 1, bpmMax: 32, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'gate.syncMode',   label: 'Sync',     type: 'enum',   options: ['bpm'], default: 'bpm', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'gate.bpmCount32', label: 'Division', type: 'number', min: 1, max: 32, default: 2, modulatable: false, plockMode: 'js', hidden: true },
      { path: 'gate.pattern',    label: 'Pattern',  type: 'pattern', slots: SLOTS, default: DEFAULT_PATTERN, modulatable: false, plockMode: 'js' },
    ];
  }

  resolveAudioParam(path) { return null; }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
