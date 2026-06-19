/**
 * PhaserFX.js
 * -----------
 * Per-track phaser — a cascade of allpass filters whose centre frequencies are
 * swept by an LFO and summed (equal-level) with the dry signal so the moving
 * notches sweep. Re-activated after the original was too subtle; the fixes that
 * make it actually audible:
 *
 *   · The sweep stays in a POSITIVE, audible window (centre ± swing, both > 0) so
 *     the allpasses keep shifting phase across the whole LFO cycle. The earlier
 *     version let the modulated frequency go to 0/negative for half the cycle,
 *     where a biquad allpass barely moves — which is why it "did nothing".
 *   · Lower Q (≈0.7) so each stage shifts phase over a WIDE band; high-Q allpass
 *     stages only twist phase in a sliver, giving a near-inaudible notch.
 *   · Dry and wet are summed at EQUAL level (true 50/50 at wet=1) — that
 *     cancellation IS the phaser. Stereo comes from a second cascade whose LFO is
 *     phase-inverted, panned opposite the first, so the notches counter-sweep.
 *
 * Signal chain (internal), per side:
 *   input → dryGain ───────────────────────────────────────────→ output
 *   input → ap0..apN → fb → (loop) → panSide → wetGain ────────→ output
 *   lfo → +bias/−bias depth → ap.frequency   (left +, right −)
 *
 * Rate is a unified Hz↔BPM sync knob (same model as AutoPanFX / ChorusFX), so
 * the sweep can lock to tempo when you want it to.
 *
 * Parameters:
 *   'phaser.rate'        — Hz (syncMode='hz'), 0.05–8, default 0.4
 *   'phaser.syncMode'    — 'hz' | 'bpm', default 'hz'
 *   'phaser.bpmCount32'  — 1/32 period count (syncMode='bpm'), default 32 (= 1 bar)
 *   'phaser.depth'       — 0–1,       default 0.8
 *   'phaser.feedback'    — 0–0.85,    default 0.5
 *   'phaser.wet'         — 0–1,       default 0
 *
 * Public: the standard FX block interface.
 */

import { count32ToHz, MUSICAL_SNAP_32 } from '../util/BpmSync.js';

const STAGES    = 6;       // 6 stages = 3 notches → an obvious, classic phaser
const CENTER_HZ = 1000;    // sweep centre
const SWING_HZ  = 850;     // ± swing at depth 1 → 150..1850 Hz (always positive)

export class PhaserFX {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this._bpm = 120;

    this._params = {
      'phaser.rate':       0.4,
      'phaser.syncMode':   'hz',
      'phaser.bpmCount32':  32,    // 32 × 1/32 = 1 bar — a slow, classic phaser sweep
      'phaser.depth':      0.8,
      'phaser.feedback':   0.5,
      'phaser.wet':        0,
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

    // LFO → depth taps. Left tap positive, right tap negated (counter-sweep). Each
    // allpass also carries a static CENTER_HZ bias as its frequency.value, so the
    // modulation swings AROUND that centre and stays positive.
    this._lfo = context.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = this._effectiveRateHz();
    this._depthL = context.createGain();
    this._depthR = context.createGain();
    this._depthL.gain.value =  SWING_HZ * this._params['phaser.depth'];
    this._depthR.gain.value = -SWING_HZ * this._params['phaser.depth'];
    this._lfo.connect(this._depthL);
    this._lfo.connect(this._depthR);
    this._lfo.start();

    this._stagesL = this._buildCascade(this._depthL);
    this._stagesR = this._buildCascade(this._depthR);

    // Gentle stereo only (±0.3): the two counter-swept cascades still both reach
    // both channels, so each sums with the centred dry to cut DEEP notches. Hard
    // panning (±0.6+) isolated each wet to one side and shallowed the cancellation.
    this._panL = context.createStereoPanner(); this._panL.pan.value = -0.3;
    this._panR = context.createStereoPanner(); this._panR.pan.value =  0.3;

    this._fbL = context.createGain(); this._fbL.gain.value = this._params['phaser.feedback'];
    this._fbR = context.createGain(); this._fbR.gain.value = this._params['phaser.feedback'];

    // CRITICAL: Web Audio MUTES any feedback cycle that contains no DelayNode —
    // and because the allpass cascade itself sits inside that cycle, the whole
    // wet branch went silent (wet==dry exactly, "does nothing"). A one-block
    // (~2.7 ms) delay in each feedback path makes the cycle legal so audio flows,
    // and a hair of delay is musically harmless to a phaser's resonance.
    this._fbDelayL = context.createDelay(0.05); this._fbDelayL.delayTime.value = 0.003;
    this._fbDelayR = context.createDelay(0.05); this._fbDelayR.delayTime.value = 0.003;

    this.inputNode.connect(this._dryGain).connect(this.outputNode);

    this.inputNode.connect(this._stagesL[0]);
    this._chain(this._stagesL);
    const lastL = this._stagesL[this._stagesL.length - 1];
    lastL.connect(this._panL).connect(this._wetGain);
    lastL.connect(this._fbL).connect(this._fbDelayL).connect(this._stagesL[0]);

    this.inputNode.connect(this._stagesR[0]);
    this._chain(this._stagesR);
    const lastR = this._stagesR[this._stagesR.length - 1];
    lastR.connect(this._panR).connect(this._wetGain);
    lastR.connect(this._fbR).connect(this._fbDelayR).connect(this._stagesR[0]);

    this._wetGain.connect(this.outputNode);
  }

  _buildCascade(depthTap) {
    const stages = [];
    for (let i = 0; i < STAGES; i++) {
      const ap = this.context.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = CENTER_HZ;
      // Moderate Q: enough phase twist per stage for deep notches, not so narrow
      // that the sweep becomes inaudible (the old Q=3 mistake) nor so wide it
      // smears (Q=0.7 was too gentle). ~1.2 is the classic phaser sweet spot.
      ap.Q.value = 1.2;
      depthTap.connect(ap.frequency);
      stages.push(ap);
    }
    return stages;
  }

  _chain(stages) {
    for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);
  }

  connect(destinationNode) { this.outputNode.connect(destinationNode); }
  connectInput(sourceNode) { sourceNode.connect(this.inputNode); }
  disconnect() { this.outputNode.disconnect(); }

  /** LFO frequency in Hz, honouring the Hz↔BPM sync mode. */
  _effectiveRateHz() {
    if (this._params['phaser.syncMode'] === 'bpm') {
      return count32ToHz(this._params['phaser.bpmCount32'], this._bpm);
    }
    return this._params['phaser.rate'];
  }

  _applyRate(time) {
    const t = time ?? this.context.currentTime;
    this._lfo.frequency.setTargetAtTime(this._effectiveRateHz(), t, 0.05);
  }

  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['phaser.syncMode'] === 'bpm') this._applyRate();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this._applyMix(enabled ? this._params['phaser.wet'] : 0, this.context.currentTime);
  }

  _applyMix(wet, t) {
    this._wetGain.gain.setTargetAtTime(wet, t, 0.005);
    this._dryGain.gain.setTargetAtTime(1, t, 0.005);
  }

  setParam(path, value, time) {
    this._params[path] = value;
    const t = time ?? this.context.currentTime;
    switch (path) {
      case 'phaser.rate':
      case 'phaser.bpmCount32':
      case 'phaser.syncMode':
        this._applyRate(t);
        break;
      case 'phaser.depth':
        this._depthL.gain.setTargetAtTime( SWING_HZ * value, t, 0.01);
        this._depthR.gain.setTargetAtTime(-SWING_HZ * value, t, 0.01);
        break;
      case 'phaser.feedback':
        // Cap below self-oscillation.
        this._fbL.gain.setTargetAtTime(Math.min(0.85, value), t, 0.01);
        this._fbR.gain.setTargetAtTime(Math.min(0.85, value), t, 0.01);
        break;
      case 'phaser.wet':
        if (this.enabled) this._applyMix(value, t);
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    return [
      // Unified Hz↔BPM rate knob (same model as AutoPanFX / ChorusFX). offLabel:'HZ'.
      {
        path: 'phaser.sync', label: 'Rate', type: 'sync',
        modePath: 'phaser.syncMode',
        msPath:   'phaser.rate',
        bpmPath:  'phaser.bpmCount32',
        offLabel: 'HZ',
        bpmMin: 0.25, bpmMax: 64, bpmSnap: MUSICAL_SNAP_32,
      },
      { path: 'phaser.depth',    label: 'Depth',    type: 'number', min: 0,    max: 1,    default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
      { path: 'phaser.feedback', label: 'Feedback', type: 'number', min: 0,    max: 0.85, default: 0.5, modulatable: true, lfoMin: 0,    lfoMax: 0.85, plockMode: 'audioParam' },
      { path: 'phaser.wet',      label: 'Wet',      type: 'number', min: 0,    max: 1,    default: 0,   modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
      // Backing params for the sync knob (hidden — the knob drives them).
      { path: 'phaser.syncMode',   label: 'Sync',     type: 'enum',   options: ['hz','bpm'], default: 'hz', modulatable: false, plockMode: 'js', hidden: true },
      { path: 'phaser.rate',       label: 'Rate',     type: 'number', min: 0.05, max: 8,  default: 0.4, modulatable: true, lfoMin: 0.05, lfoMax: 8,  plockMode: 'audioParam', hidden: true },
      { path: 'phaser.bpmCount32', label: 'Division', type: 'number', min: 1,    max: 64, default: 32,  modulatable: true, plockMode: 'js', hidden: true },
    ];
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'phaser.rate':     return this._lfo.frequency;
      case 'phaser.depth':    return this._depthL.gain;   // R tracks (negated) via setParam
      case 'phaser.feedback': return this._fbL.gain;       // R tracks via setParam
      case 'phaser.wet':      return this._wetGain.gain;
      default: return null;
    }
  }

  toJSON() { return { params: { ...this._params }, enabled: this.enabled }; }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
    this.setEnabled(obj.enabled ?? false);
  }
}
