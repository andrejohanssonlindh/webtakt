/**
 * NormalizerFX.js
 * ---------------
 * A live auto-gain (loudness leveller) block for the FX pipeline. Some effects
 * (distortion, reverb wash, resonant filters) push the level up a lot; this block
 * watches the signal reaching it and continuously scales it so the LOUD parts sit
 * at a chosen target level — turning a too-hot point in the chain DOWN (and, if
 * you let it, lifting a too-quiet one up). Because it measures whatever actually
 * arrives, it re-adjusts on its own whenever the upstream chain changes (a
 * re-order, a louder reverb, a hotter crush) with no manual re-dialling.
 *
 * How it works: an AnalyserNode taps the (post-input) signal. A frame loop reads
 * its level and feeds a **decaying peak follower** — it rises instantly to new
 * peaks and decays slowly between hits, so the silence between drum hits doesn't
 * drag the measurement to zero (the classic "it always wants full boost" trap of
 * a plain windowed RMS). The desired gain is `target / followedLevel`, so a
 * SINGLE **Target** knob sets the direction and amount:
 *   • Target below the signal's level → gain < 1 → turned DOWN,
 *   • Target above it                 → gain > 1 → lifted UP.
 * The gain is smoothed toward that value (Speed) so it levels rather than pumps.
 * `MAX_GAIN` hard-clamps the boost as a safety net and the follower's noise floor
 * keeps the first transient from spiking to that clamp (which clipped the attack).
 *
 * Signal chain (internal):
 *   input ─┬─→ analyser (measure only, not summed)
 *          └─→ autoGain ─→ ceiling ─→ output
 *
 * The rAF loop is the SLOW, musical leveller, but it runs on the UI thread at
 * ~16–33 ms cadence + a smoothing time-constant, so a sudden loud transient
 * sails through for a few ms before the auto-gain catches it (the classic
 * "blast on the first hit / on a level jump"). The audio-thread `ceiling`
 * stage — a fast brickwall `DynamicsCompressorNode`, the same node the limiter
 * uses — sits AFTER the auto-gain and catches that transient sample-accurately:
 * its threshold tracks **Target** (in dB), so anything the slow loop hasn't
 * pulled down yet is clamped instantly to the target level. When the slow loop
 * is already on target the ceiling is transparent (nothing exceeds threshold).
 *
 * Parameters:
 *   'norm.target' — target peak level 0.05–1.5, default 0.5. One knob: LOWER than
 *                   the signal's level turns it DOWN, HIGHER pushes it UP. (Around
 *                   the natural peak level it's roughly unity.)
 *   'norm.range'  — how far it may push, 0–1, default 1. 0 = no change (unity);
 *                   1 = drive fully to target. Scales both cut and boost.
 *   'norm.speed'  — adaptation speed 0.02–1, default 0.3. Low = slow, gentle
 *                   levelling; high = reacts fast (more pumping).
 *
 * `setEnabled(false)` freezes the gain at unity (transparent passthrough) and
 * stops the analysis loop, so a bypassed normaliser costs nothing.
 *
 * Public: the standard FX block interface (inputNode/outputNode/connect/
 * connectInput/disconnect/setEnabled/setParam/getParam/getParamList/
 * resolveAudioParam/toJSON/fromJSON).
 */

// Hard safety clamp on the auto-gain — caps boost so a quiet/near-silent point
// (or a high Target) can't blow up into runaway gain or distortion.
const MAX_GAIN = 6;

// Noise gate: below this peak the input counts as silent, so the gain glides back
// toward unity rather than winding up to "lift" the silence (which then blasted
// the next note in at the wound-up gain).
const GATE = 0.02;

export class NormalizerFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'norm.target': 0.5,
      'norm.range':  1,
      'norm.speed':  0.3,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    // The auto-adjusted makeup gain — input passes through it (slow leveller).
    this._autoGain = context.createGain();
    this._autoGain.gain.value = 1;

    // Fast audio-thread brickwall: catches the transient that slips past the slow
    // rAF loop before it can pull the gain down. Threshold tracks Target (dB).
    this._ceiling = context.createDynamicsCompressor();
    this._ceiling.ratio.value     = 20;     // brickwall-ish
    this._ceiling.attack.value    = 0.001;  // fast — catch the transient
    this._ceiling.release.value   = 0.05;
    this._ceiling.knee.value      = 0;       // hard knee
    this._ceiling.threshold.value = this._targetDb();

    // Tap for measurement only (NOT summed into the output path).
    this._analyser = context.createAnalyser();
    this._analyser.fftSize = 1024;
    this._buf = new Float32Array(this._analyser.fftSize);

    // Wiring: signal passes input → autoGain → ceiling → output; the analyser
    // taps the input for measurement only (dead-end, never feeding the output).
    this.inputNode.connect(this._autoGain).connect(this._ceiling).connect(this.outputNode);
    this.inputNode.connect(this._analyser);

    // Decaying peak envelope of the input level, and the smoothed gain estimate.
    this._env  = 0;
    this._gain = 1;
    this._raf  = null;
    this._tick = this._tick.bind(this);
  }

  /** Target (linear amplitude) → dB threshold for the brickwall ceiling. */
  _targetDb() {
    return 20 * Math.log10(Math.max(this._params['norm.target'], 1e-4));
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() {
    this.outputNode.disconnect();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    // Bypassed → threshold 0 dB so the brickwall never engages (transparent).
    this._ceiling.threshold.setTargetAtTime(enabled ? this._targetDb() : 0, t, 0.01);
    if (enabled) {
      // Seed the follower at the Target (not 0) so the very first frame computes a
      // gain near unity and ramps in from there, instead of spiking to MAX_GAIN
      // on the opening transient (which distorted the attack).
      this._env  = this._params['norm.target'];
      this._gain = 1;
      this._startLoop();
    } else {
      this._stopLoop();
      // Snap back to transparent unity gain when bypassed.
      this._gain = 1;
      this._autoGain.gain.setTargetAtTime(1, this.context.currentTime, 0.02);
    }
  }

  _startLoop() {
    if (this._raf != null) return;
    // Drive the analysis off rAF when available (UI thread); fall back to a timer
    // so headless/test environments still advance it.
    if (typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._tick);
    } else {
      this._raf = setInterval(this._tick, 33);
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

  /**
   * One analysis step: update the decaying peak follower, compute the desired
   * gain (target / followed level), and smooth toward it.
   */
  _tick() {
    if (!this.enabled) { this._raf = null; return; }

    this._analyser.getFloatTimeDomainData(this._buf);
    // Peak magnitude of this frame (responds to transients, not averaged-with-
    // silence RMS).
    let peak = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const a = Math.abs(this._buf[i]);
      if (a > peak) peak = a;
    }
    // Peak follower: jump up to a new peak instantly, decay slowly otherwise. This
    // holds the measured level across the gaps between hits so the gain reflects
    // the LOUD parts, not the silence.
    if (peak > this._env) this._env = peak;
    else this._env += (peak - this._env) * 0.05;   // ~slow release per frame

    const target = this._params['norm.target'];
    const range  = this._params['norm.range'];
    const speed  = this._params['norm.speed'];

    // Noise gate: when the input is essentially silent, DON'T wind the gain up to
    // lift the "quiet" signal — glide it back toward unity instead. Without this
    // the gain crept above 1 during the silence before the first note, then that
    // first transient hit at the wound-up gain → a loud distorted blast on the
    // opening note (fine on every note after, once the follower had seen real
    // signal). Gating to unity keeps the first note clean.
    let desired;
    if (peak < GATE) {
      desired = 1;
    } else {
      // Full-normalisation gain drives the followed level to the target — a single
      // knob: a low Target turns a hot signal DOWN, a high Target pushes a quiet
      // one UP. MAX_GAIN is a hard safety clamp on the boost.
      let full = target / Math.max(this._env, 0.02);
      if (full > MAX_GAIN) full = MAX_GAIN;
      // Range scales how far from unity we go (0 = unity/transparent, 1 = full).
      desired = 1 + (full - 1) * range;
    }

    // One-pole smoothing toward `desired`; `speed` sets the lerp coefficient.
    this._gain += (desired - this._gain) * Math.min(1, Math.max(0.01, speed));
    // A slower ramp (longer time-constant) avoids zipper/distortion when the gain
    // jumps — the analysis already smooths, this just de-clicks the AudioParam.
    this._autoGain.gain.setTargetAtTime(this._gain, this.context.currentTime, 0.05);

    // Re-arm.
    if (typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._tick);
    }
    // (setInterval path re-fires itself.)
  }

  setParam(path, value /*, time */) {
    this._params[path] = value;
    // Range/Speed are read live inside _tick. Target also drives the audio-thread
    // brickwall threshold, so push it through immediately when enabled.
    if (path === 'norm.target' && this.enabled) {
      this._ceiling.threshold.setTargetAtTime(this._targetDb(), this.context.currentTime, 0.01);
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'norm.target', label: 'Target', type: 'number', min: 0.05, max: 1.5, default: 0.5, modulatable: false, plockMode: 'js' },
      { path: 'norm.range',  label: 'Range',  type: 'number', min: 0,    max: 1,   default: 1,   modulatable: false, plockMode: 'js' },
      { path: 'norm.speed',  label: 'Speed',  type: 'number', min: 0.02, max: 1,   default: 0.3, modulatable: false, plockMode: 'js' },
    ];
  }

  /** No directly-modulatable AudioParams — the gain is driven by the analysis loop. */
  resolveAudioParam() { return null; }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
