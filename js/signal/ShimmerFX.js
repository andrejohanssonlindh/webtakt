/**
 * ShimmerFX.js
 * ------------
 * Per-track shimmer reverb: a convolution reverb with an octave-up layer, giving
 * the glassy, angelic ambient wash. FREEZE holds the tail for a sustained pad.
 *
 * IMPORTANT — feedforward, NOT recursive. An earlier version fed the reverb tail
 * back through the pitch shifter into the convolver; with the convolver's long IR
 * that loop built up and never decayed (runaway howl, unaffected by bypass). This
 * version pitches the INPUT and sends both the dry and the octave-up copy into the
 * reverb ONCE — no loop, so it always decays and bypass is instant. `shimmer` is
 * just how much octave-up layer is sent in.
 *
 * Freeze is a SEPARATE, bounded hold: a feedback gain capped well below unity
 * (0.85) loops the wet output so the tail sustains a long time without ever
 * diverging, and it is forced to 0 whenever the block is disabled.
 *
 * Signal chain (internal):
 *   input → dryGain ──────────────────────────────────────────────→ output
 *   input → preHP ─┬─→ revIn ─→ convolver → damp ─┬─→ wetGain ─────→ output
 *                  └─→ pitch(oct↑) → shimGain ─────┘        │
 *                          freezeGain (≤0.85, off unless frozen) ←──┘
 *
 * Parameters:
 *   'shim.decay'    — s, 0.3..10, default 3   (IR length, rebuilds IR)
 *   'shim.shimmer'  — 0..1, default 0.5       (octave-up layer amount)
 *   'shim.damp'     — Hz, 500..16000, default 6000 (tail lowpass)
 *   'shim.preHP'    — Hz, 20..1000, default 120 (wet pre-highpass, de-mud)
 *   'shim.freeze'   — 'off' | 'on', default 'off'
 *   'shim.wet'      — 0..1, default 0
 *
 * Public: the standard FX block interface.
 */

const GRAIN_S    = 0.10;   // grain window length (s)
// Freeze feedback cap. The loop is freezeGain × convolver, and with
// `normalize:true` a LONGER IR (higher decay) has more peak energy per pass, so a
// fixed 0.85 pushed total loop gain over unity and ran away (worse at high decay —
// exactly the reported behaviour). 0.6 base, scaled DOWN as decay grows, keeps the
// round-trip safely below 1 for the whole decay range while still holding a long
// sustained pad.
const FREEZE_MAX = 0.6;

export class ShimmerFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'shim.decay':   3,
      'shim.shimmer': 0.5,
      'shim.damp':    6000,
      'shim.preHP':   120,
      'shim.freeze':  'off',
      'shim.wet':     0,
    };

    this.enabled = false;

    this.inputNode  = context.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 1;

    this._dryGain = context.createGain();
    this._dryGain.gain.value = 1;
    this._wetGain = context.createGain();
    this._wetGain.gain.value = 0;

    this._preHP = context.createBiquadFilter();
    this._preHP.type = 'highpass';
    this._preHP.frequency.value = this._params['shim.preHP'];

    // Reverb input sum (dry copy + octave-up copy + freeze feedback all meet here).
    this._revIn = context.createGain();
    this._revIn.gain.value = 1;

    this._convolver = context.createConvolver();
    this._convolver.normalize = true;

    this._damp = context.createBiquadFilter();
    this._damp.type = 'lowpass';
    this._damp.frequency.value = this._params['shim.damp'];

    // Octave-up layer amount (feedFORWARD: input → pitch → revIn).
    this._shimGain = context.createGain();
    this._shimGain.gain.value = this._params['shim.shimmer'];

    // Freeze hold: damped tail → freezeGain (≤ FREEZE_MAX) → freezeDelay → revIn.
    // Off (0) unless frozen AND enabled, so it can never run away or survive a
    // disable.
    //
    // CRITICAL: this freeze path forms a feedback cycle revIn → convolver → damp →
    // freezeGain → revIn. Web Audio MUTES any feedback cycle that contains no
    // DelayNode — a ConvolverNode does NOT count — and the mute is TOPOLOGICAL
    // (the edge exists even at gain 0), so it silenced the convolver and the whole
    // wet tap. (Chrome's OFFLINE renderer tolerates it, which is why the test
    // passed while the live app produced no shimmer at all.) The DelayNode below
    // makes the cycle legal in the real-time renderer; ~20 ms reads as a natural
    // reverb pre-delay on the frozen tail.
    this._freezeGain = context.createGain();
    this._freezeGain.gain.value = 0;
    this._freezeDelay = context.createDelay(0.1);
    this._freezeDelay.delayTime.value = 0.02;

    this._pitch = this._buildPitchShifter();   // octave up

    // Wiring (no recursive shimmer loop).
    this.inputNode.connect(this._dryGain).connect(this.outputNode);
    this.inputNode.connect(this._preHP);
    // Dry copy of the (pre-HP'd) input into the reverb.
    this._preHP.connect(this._revIn);
    // Octave-up copy into the reverb.
    this._preHP.connect(this._pitch.input);
    this._pitch.output.connect(this._shimGain).connect(this._revIn);
    // Reverb proper. A normalised noise IR spreads its energy over the whole tail,
    // so the convolved output is tens of dB below the input — without makeup the
    // "wet" was inaudible and you only heard the ducked dry ("slightly quieter, no
    // effect"). _wetMakeup brings the tail back up to a usable level.
    this._wetMakeup = context.createGain();
    this._wetMakeup.gain.value = 8;
    this._revIn.connect(this._convolver).connect(this._damp);
    this._damp.connect(this._wetMakeup).connect(this._wetGain).connect(this.outputNode);
    // Bounded freeze feedback (separate from the shimmer layer). The DelayNode in
    // this path is REQUIRED — see the freeze-hold note above (delay-less cycle
    // through the convolver gets muted, killing the whole wet output).
    this._damp.connect(this._freezeGain).connect(this._freezeDelay).connect(this._revIn);

    this._buildIR();
  }

  /**
   * Dual-delay granular pitch shifter, octave up (ratio ~2.0). Two delay lines
   * each ramped down (constant slope = constant pitch ratio), crossfaded by
   * triangle windows 180° apart. Native nodes; runs continuously.
   */
  _buildPitchShifter() {
    const ctx = this.context;
    const input  = ctx.createGain();
    const output = ctx.createGain();

    const d0 = ctx.createDelay(1); const d1 = ctx.createDelay(1);
    const g0 = ctx.createGain();   const g1 = ctx.createGain();
    g0.gain.value = 0; g1.gain.value = 0;

    input.connect(d0).connect(g0).connect(output);
    input.connect(d1).connect(g1).connect(output);

    const win0 = ctx.createOscillator(); win0.type = 'triangle';
    const win1 = ctx.createOscillator(); win1.type = 'triangle';
    const winFreq = 1 / GRAIN_S;
    win0.frequency.value = winFreq;
    win1.frequency.value = winFreq;
    const wg0 = ctx.createGain(); wg0.gain.value = 0.5;
    const wg1 = ctx.createGain(); wg1.gain.value = 0.5;
    const wb0 = ctx.createConstantSource(); wb0.offset.value = 0.5;
    const wb1 = ctx.createConstantSource(); wb1.offset.value = 0.5;
    win0.connect(wg0).connect(g0.gain); wb0.connect(g0.gain);
    win1.connect(wg1).connect(g1.gain); wb1.connect(g1.gain);

    win0.start(); win1.start(ctx.currentTime + GRAIN_S / 2);
    wb0.start();  wb1.start();
    this._d0 = d0; this._d1 = d1;
    this._scheduleGrains();

    return { input, output };
  }

  /** Repeating downward delayTime ramps (octave up). Timer-driven re-arm. */
  _scheduleGrains() {
    const ctx = this.context;
    const arm = () => {
      const now = ctx.currentTime;
      for (const [d, off] of [[this._d0, 0], [this._d1, GRAIN_S / 2]]) {
        const start = now + off;
        d.delayTime.cancelScheduledValues(start);
        d.delayTime.setValueAtTime(GRAIN_S, start);
        d.delayTime.linearRampToValueAtTime(0.0001, start + GRAIN_S);
      }
    };
    arm();
    if (this._grainTimer) clearInterval(this._grainTimer);
    this._grainTimer = setInterval(arm, GRAIN_S * 1000);
  }

  _buildIR() {
    const ctx = this.context;
    const sr  = ctx.sampleRate;
    const decay = this._params['shim.decay'];
    const length = Math.ceil(decay * 3 * sr);
    const ir = ctx.createBuffer(2, length, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t / decay);
      }
    }
    this._convolver.buffer = ir;
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() {
    if (this._grainTimer) { clearInterval(this._grainTimer); this._grainTimer = null; }
    this.outputNode.disconnect();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const t = this.context.currentTime;
    const wet = enabled ? this._params['shim.wet'] : 0;
    this._wetGain.gain.setTargetAtTime(wet, t, 0.01);
    this._dryGain.gain.setTargetAtTime(enabled ? 1 - wet * 0.5 : 1, t, 0.01);
    // Disabling always kills the freeze feedback so nothing sustains after off.
    this._applyFreeze();
  }

  _applyFreeze() {
    const on = this.enabled && this._params['shim.freeze'] === 'on';
    const t  = this.context.currentTime;
    this._freezeGain.gain.setTargetAtTime(on ? this._freezeCap() : 0, t, 0.05);
  }

  /** Freeze feedback gain, scaled DOWN as decay rises so the loop (freezeGain ×
   *  normalized convolver) never crosses unity at long IR lengths. At decay 0.3 it
   *  stays near FREEZE_MAX; by decay 10 it's roughly halved. */
  _freezeCap() {
    const decay = this._params['shim.decay'];
    return FREEZE_MAX * (3 / (3 + decay));
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'shim.decay':   this._buildIR(); this._applyFreeze(); break;  // re-scale freeze: longer IR ⇒ lower cap
      case 'shim.shimmer': this._shimGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'shim.damp':    this._damp.frequency.setTargetAtTime(value, t, 0.02);   break;
      case 'shim.preHP':   this._preHP.frequency.setTargetAtTime(value, t, 0.02);  break;
      case 'shim.freeze':  this._applyFreeze(); break;
      case 'shim.wet':
        if (this.enabled) {
          this._wetGain.gain.setTargetAtTime(value, t, 0.01);
          this._dryGain.gain.setTargetAtTime(1 - value * 0.5, t, 0.01);
        }
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      { path: 'shim.decay',   label: 'Decay',   type: 'number', min: 0.3, max: 10,    default: 3,    modulatable: false,                          plockMode: 'js' },
      { path: 'shim.shimmer', label: 'Shimmer', type: 'number', min: 0,   max: 1,     default: 0.5,  modulatable: true, lfoMin: 0,   lfoMax: 1,   plockMode: 'audioParam' },
      { path: 'shim.damp',    label: 'Damp',    type: 'number', min: 500, max: 16000, default: 6000, modulatable: true, lfoMin: 500, lfoMax: 16000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'shim.preHP',   label: 'Pre-HP',  type: 'number', min: 20,  max: 1000,  default: 120,  modulatable: true, lfoMin: 20,  lfoMax: 1000, lfoUnit: 'cents', plockMode: 'audioParam' },
      { path: 'shim.freeze',  label: 'Freeze',  type: 'enum',   options: ['off','on'], default: 'off', modulatable: false, plockMode: 'js' },
      { path: 'shim.wet',     label: 'Wet',     type: 'number', min: 0,   max: 1,     default: 0,    modulatable: true, lfoMin: 0,   lfoMax: 1,   plockMode: 'audioParam' },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'shim.shimmer': return this._shimGain.gain;
      case 'shim.damp':    return this._damp.frequency;
      case 'shim.preHP':   return this._preHP.frequency;
      case 'shim.wet':     return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
