/**
 * LFO.js
 * ------
 * Low-frequency oscillator for parameter modulation.
 *
 * Modes
 * ─────
 * Simple  — Elektron-style: waveform, trig mode (FRE/TRG), BPM sync, start
 *           phase, depth, fade in/out.
 * Advanced — adds ADSR depth/speed/mult envelope (amp-synced or own).
 *
 * Trig modes implemented
 * ──────────────────────
 * FRE — free-running, never resets
 * TRG — phase resets to startPhase on every noteOn
 * (HLD / ONE / HLF require JS phase tracking and are not implemented)
 *
 * BPM sync
 * ────────
 * When lfo.syncMode === 'bpm', the rate is expressed as an INTEGER COUNT of
 * 1/32 notes (lfo.bpmCount32 / lfo.adsr.<sec>.bpmCount32), matching the unified
 * sync-knob model (see js/util/BpmSync.js, design/sync-knob-rollout.md). The
 * 1/32 count is the LFO *period*, so Hz = 1 / count32ToSeconds(count, bpm).
 * In free Hz mode the speed knob sets Hz directly.
 *
 * Audio graph
 * ───────────
 * OscillatorNode (_lfoOsc)
 *   → GainNode (_depthGain, gain shaped by depth / ADSR envelope)
 *     → destination AudioParam(s)
 *
 * Multiple destinations are supported (one per voice-pool slot).
 * addDestination / removeDestination manage the set.
 * setDestination / clearDestination are kept for single-destination callers.
 *
 * Owns:    OscillatorNode, GainNode (_depthGain)
 * Depends: Web Audio API only
 * Used by: Track.js, Sequencer.js (noteOn / noteOff calls)
 */

import { count32ToSeconds, divToCount32 } from '../util/BpmSync.js';

/** LFO rate from a 1/32 count: the count is the LFO period. */
function count32ToHz(count32, bpm) {
  return 1 / Math.max(count32ToSeconds(count32, bpm), 1e-6);
}

export class LFO {
  /**
   * @param {AudioContext} context
   * @param {number} index
   * @param {{ bpm: number }} clock — Clock reference for BPM reads
   */
  constructor(context, index, clock) {
    this.context = context;
    this.index   = index;
    this._clock  = clock;   // may be null for legacy construction

    // ── Simple mode params ─────────────────────────────────────────────────
    this._params = {
      'lfo.mode':       'simple',     // 'simple' | 'advanced'
      'lfo.waveform':   'sine',       // sine | square | sawtooth | triangle
      'lfo.trigMode':   'free',       // 'free' | 'trig'
      'lfo.syncMode':   'hz',         // 'hz' | 'bpm'
      'lfo.speed':      0.1,          // Hz (syncMode=hz) or ignored (syncMode=bpm)
      'lfo.speedMult':  1,            // integer multiplier (hz mode only)
      'lfo.bpmCount32': 8,            // 1/32 count = LFO period (syncMode=bpm); 8 = 1/4
      'lfo.depth':      30,           // 0–100 % (simple mode global depth)
      'lfo.startPhase': 0,            // 0–127; mapped to 0–2π on reset (trig mode)
      'lfo.fade':       0,            // -100…+100; neg=fade in, pos=fade out, 0=none

      // ── Advanced mode params ───────────────────────────────────────────
      'lfo.adsrSource': 'own',        // 'own' | 'amp'

      'lfo.adsr.a.time':  0.01,       // seconds (own source only)
      'lfo.adsr.d.time':  0.1,
      'lfo.adsr.s.time':  0,          // ignored — gate-length driven
      'lfo.adsr.r.time':  0.3,

      'lfo.adsr.a.depth': 100,        // 0–100 %
      'lfo.adsr.d.depth': 60,
      'lfo.adsr.s.depth': 40,
      'lfo.adsr.r.depth': 0,

      'lfo.adsr.a.speed': 0.1,        // Hz (syncMode=hz)
      'lfo.adsr.d.speed': 0.1,
      'lfo.adsr.s.speed': 0.1,
      'lfo.adsr.r.speed': 0.1,

      'lfo.adsr.a.bpmCount32': 8,     // 1/32 count = period (syncMode=bpm); 8 = 1/4
      'lfo.adsr.d.bpmCount32': 8,
      'lfo.adsr.s.bpmCount32': 8,
      'lfo.adsr.r.bpmCount32': 8,

      'lfo.adsr.a.mult':  1,
      'lfo.adsr.d.mult':  1,
      'lfo.adsr.s.mult':  1,
      'lfo.adsr.r.mult':  1,
    };

    // ── Audio nodes ────────────────────────────────────────────────────────
    this._lfoOsc     = null;
    this._depthGain  = context.createGain();  // shaped by depth/ADSR
    this._depthGain.gain.value = 0;

    // Set of connected AudioParams — supports multiple voice-pool slots.
    this._destinations = new Set();
    this._depthScale   = 1;
    this._running      = false;

    // Phase offset applied when the oscillator is restarted (TRG mode)
    // OscillatorNode has no phase setter, so we stop/start at an offset time
    // that places the waveform at the correct point. Approximation only.
    this._phaseOffsetSec = 0;
  }

  // ── Destination ──────────────────────────────────────────────────────────

  /** Add one AudioParam to the destination set. */
  addDestination(audioParam, depthScale = 1) {
    this._depthScale = depthScale;
    if (!this._destinations.has(audioParam)) {
      this._destinations.add(audioParam);
      this._depthGain.connect(audioParam);
    }
    this._applyDepth();
  }

  /** Remove one AudioParam from the destination set. */
  removeDestination(audioParam) {
    if (this._destinations.has(audioParam)) {
      try { this._depthGain.disconnect(audioParam); } catch (_) {}
      this._destinations.delete(audioParam);
    }
  }

  /** Convenience: replace all destinations with a single one (legacy callers). */
  setDestination(audioParam, depthScale = 1) {
    this.clearDestination();
    this.addDestination(audioParam, depthScale);
  }

  /** Disconnect from all destinations. */
  clearDestination() {
    for (const ap of this._destinations) {
      try { this._depthGain.disconnect(ap); } catch (_) {}
    }
    this._destinations.clear();
  }

  setJSDepthScale(depthScale) {
    this._depthScale = depthScale;
    this._applyDepth();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _bpm() {
    return this._clock?.bpm ?? 120;
  }

  _effectiveHz() {
    if (this._params['lfo.syncMode'] === 'bpm') {
      return count32ToHz(this._params['lfo.bpmCount32'], this._bpm());
    }
    return Math.max(0.001, this._params['lfo.speed'] * this._params['lfo.speedMult']);
  }

  _sectionHz(section) {
    // Advanced per-section rate. Uses syncMode setting for unit interpretation.
    if (this._params['lfo.syncMode'] === 'bpm') {
      return count32ToHz(this._params[`lfo.adsr.${section}.bpmCount32`], this._bpm());
    }
    const speed = this._params[`lfo.adsr.${section}.speed`];
    const mult  = this._params[`lfo.adsr.${section}.mult`];
    return Math.max(0.001, speed * mult);
  }

  _sectionDepthGain(section) {
    return ((this._params[`lfo.adsr.${section}.depth`] ?? 0) / 100) * this._depthScale;
  }

  _applyDepth() {
    if (this._params['lfo.mode'] === 'advanced') return; // ADSR controls gain
    const scaled = (this._params['lfo.depth'] / 100) * this._depthScale;
    this._depthGain.gain.setTargetAtTime(scaled, this.context.currentTime, 0.01);
  }

  _applySpeed() {
    if (this._lfoOsc) {
      this._lfoOsc.frequency.setTargetAtTime(this._effectiveHz(), this.context.currentTime, 0.01);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(time = this.context.currentTime) {
    if (this._running) this.stop(time);
    this._startOsc(time, 0);
    this._running = true;
    if (this._params['lfo.mode'] === 'simple') this._applyDepth();
  }

  _startOsc(time, phaseOffsetSec) {
    this._lfoOsc = this.context.createOscillator();
    this._lfoOsc.type            = this._params['lfo.waveform'];
    this._lfoOsc.frequency.value = this._effectiveHz();
    this._lfoOsc.connect(this._depthGain);
    // Starting the oscillator slightly in the past shifts its phase.
    // For phase = p (0–1), we start it at: time - (p / hz) seconds.
    this._lfoOsc.start(time - phaseOffsetSec);
  }

  stop(time = this.context.currentTime) {
    if (this._lfoOsc) {
      try { this._lfoOsc.stop(time); } catch (_) {}
      this._lfoOsc = null;
    }
    this._running = false;
  }

  // ── noteOn / noteOff (called by Sequencer._fireStep) ──────────────────────

  /**
   * Called at each note trigger (scheduled time).
   * - TRG mode: restarts oscillator at startPhase
   * - Advanced mode: schedules ADSR depth/speed envelope
   * @param {number} time — AudioContext scheduled time
   * @param {number} offTime — AudioContext time of note-off
   * @param {object} [ampParams] — amp ADSR params for 'amp' source mode
   */
  noteOn(time, offTime, ampParams = null) {
    if (!this._running) return;

    const isAdv = this._params['lfo.mode'] === 'advanced';

    // ── TRG: phase reset ──────────────────────────────────────────────────
    if (this._params['lfo.trigMode'] === 'trig') {
      const phase    = (this._params['lfo.startPhase'] / 127);   // 0–1
      const hz       = this._effectiveHz();
      const phaseOff = phase / Math.max(hz, 0.0001);             // seconds to shift phase

      // Stop current osc at `time`, immediately start new one phase-shifted
      if (this._lfoOsc) {
        try { this._lfoOsc.stop(time); } catch (_) {}
        this._lfoOsc = null;
      }
      this._startOsc(time, phaseOff);
    }

    if (!isAdv) {
      // Simple mode: apply fade envelope if set
      this._scheduleFade(time);
      return;
    }

    // ── Advanced mode: schedule ADSR depth + speed envelope ──────────────
    const src = this._params['lfo.adsrSource'];
    const a = src === 'amp' ? (ampParams?.['env.attack']  ?? 0.01) : this._params['lfo.adsr.a.time'];
    const d = src === 'amp' ? (ampParams?.['env.decay']   ?? 0.1)  : this._params['lfo.adsr.d.time'];
    const r = src === 'amp' ? (ampParams?.['env.release'] ?? 0.3)  : this._params['lfo.adsr.r.time'];

    const gDA = this._depthGain.gain;
    const tA  = time;
    const tD  = time + a;
    const tS  = time + a + d;

    // Cancel any prior scheduled depth ramps from this note or previous note
    if (typeof gDA.cancelAndHoldAtTime === 'function') {
      gDA.cancelAndHoldAtTime(tA);
    } else {
      gDA.cancelScheduledValues(tA);
      gDA.setValueAtTime(gDA.value, tA);
    }

    // Attack ramp
    gDA.linearRampToValueAtTime(this._sectionDepthGain('a'), tD);
    // Decay ramp
    gDA.linearRampToValueAtTime(this._sectionDepthGain('d'), tS);
    // Sustain hold (implicit — no further ramp until noteOff)
    gDA.setValueAtTime(this._sectionDepthGain('s'), tS);

    // Per-section speed changes (snap at section boundary — see LFO.md)
    if (this._lfoOsc) {
      this._lfoOsc.frequency.setValueAtTime(this._sectionHz('a'), tA);
      this._lfoOsc.frequency.setValueAtTime(this._sectionHz('d'), tD);
      this._lfoOsc.frequency.setValueAtTime(this._sectionHz('s'), tS);
    }

    // Release will be scheduled in noteOff; store r so noteOff can use it
    this._pendingRelease = { offTime, r, src, ampParams };
  }

  /**
   * Called at note-off (scheduled time).
   * Advanced mode: schedule release ramp on depth gain.
   * @param {number} offTime
   */
  noteOff(offTime) {
    if (!this._running) return;
    if (this._params['lfo.mode'] !== 'advanced') return;

    const pr = this._pendingRelease;
    const r  = pr ? pr.r : this._params['lfo.adsr.r.time'];

    const gDA = this._depthGain.gain;
    gDA.setValueAtTime(this._sectionDepthGain('s'), offTime);
    gDA.linearRampToValueAtTime(this._sectionDepthGain('r'), offTime + r * 0.5);
    gDA.linearRampToValueAtTime(0, offTime + r);

    if (this._lfoOsc) {
      this._lfoOsc.frequency.setValueAtTime(this._sectionHz('r'), offTime);
    }

    this._pendingRelease = null;
  }

  // ── Fade (simple mode) ────────────────────────────────────────────────────

  _scheduleFade(time) {
    const fade      = this._params['lfo.fade'];
    const baseDepth = (this._params['lfo.depth'] / 100) * this._depthScale;
    if (fade === 0) {
      this._depthGain.gain.setValueAtTime(baseDepth, time);
      return;
    }
    // Use a 4-second default fade duration; could become a parameter later.
    const fadeDur = 4.0;
    if (fade > 0) {
      // Fade out: start at full, ramp toward 0
      const scale = fade / 100;
      this._depthGain.gain.setValueAtTime(baseDepth, time);
      this._depthGain.gain.linearRampToValueAtTime(baseDepth * (1 - scale), time + fadeDur);
    } else {
      // Fade in: start at 0, ramp to full
      const scale = (-fade) / 100;
      this._depthGain.gain.setValueAtTime(0, time);
      this._depthGain.gain.linearRampToValueAtTime(baseDepth * scale, time + fadeDur);
    }
  }

  // ── JS getCurrentValue (for trig.tone JS-only destination) ──────────────

  getCurrentValue() {
    if (!this._running) return 0;
    const hz    = this._effectiveHz();
    const depth = (this._params['lfo.depth'] / 100) * this._depthScale;
    const phase = (this.context.currentTime * hz) % 1;
    const wave  = this._params['lfo.waveform'];
    let raw;
    if      (wave === 'sine')     raw = Math.sin(phase * 2 * Math.PI);
    else if (wave === 'square')   raw = phase < 0.5 ? 1 : -1;
    else if (wave === 'sawtooth') raw = 2 * phase - 1;
    else                          raw = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    return raw * depth;
  }

  // ── setParam / getParam ───────────────────────────────────────────────────

  setParam(path, value) {
    this._params[path] = value;
    switch (path) {
      case 'lfo.waveform':
        if (this._lfoOsc) this._lfoOsc.type = value;
        break;
      case 'lfo.speed':
      case 'lfo.speedMult':
      case 'lfo.bpmCount32':
      case 'lfo.syncMode':
        if (path === 'lfo.speedMult') this._params['lfo.speedMult'] = Math.max(1, Math.round(value));
        this._applySpeed();
        break;
      case 'lfo.depth':
        this._applyDepth();
        break;
    }
  }

  getParam(path) { return this._params[path]; }

  getParamList() {
    const simple = [
      { path: 'lfo.mode',       label: 'Mode',        type: 'enum',   options: ['simple','advanced'] },
      { path: 'lfo.waveform',   label: 'Waveform',    type: 'enum',   options: ['sine','square','sawtooth','triangle'] },
      { path: 'lfo.trigMode',   label: 'Trig',        type: 'enum',   options: ['free','trig'] },
      { path: 'lfo.syncMode',   label: 'Sync',        type: 'enum',   options: ['hz','bpm'] },
      { path: 'lfo.speed',      label: 'Rate',        type: 'number', min: 0.001, max: 20,  default: 0.1 },
      { path: 'lfo.bpmCount32', label: 'Division',    type: 'number', min: 1,     max: 128, default: 8   },
      { path: 'lfo.depth',      label: 'Depth',       type: 'number', min: 0,     max: 100, default: 30  },
      { path: 'lfo.startPhase', label: 'Phase',       type: 'number', min: 0,     max: 127, default: 0   },
      { path: 'lfo.fade',       label: 'Fade',        type: 'number', min: -100,  max: 100, default: 0   },
    ];
    const advanced = [
      { path: 'lfo.adsrSource',    label: 'Source',  type: 'enum',   options: ['own','amp'] },
      ...['a','d','s','r'].flatMap(sec => [
        { path: `lfo.adsr.${sec}.depth`, label: `${sec.toUpperCase()} Depth`, type: 'number', min: 0,     max: 100, default: sec === 'r' ? 0 : 40 },
        { path: `lfo.adsr.${sec}.speed`, label: `${sec.toUpperCase()} Rate`,  type: 'number', min: 0.001, max: 20,  default: 0.1 },
        { path: `lfo.adsr.${sec}.bpmCount32`, label: `${sec.toUpperCase()} Div`, type: 'number', min: 1, max: 128, default: 8 },
        ...(sec !== 's' && this._params['lfo.adsrSource'] === 'own'
          ? [{ path: `lfo.adsr.${sec}.time`, label: `${sec.toUpperCase()} Time`, type: 'number', min: 0.001, max: 8, default: 0.1 }]
          : []),
      ]),
    ];
    return this._params['lfo.mode'] === 'advanced' ? [...simple, ...advanced] : simple;
  }

  toJSON() {
    return { index: this.index, params: { ...this._params } };
  }

  fromJSON(obj) {
    const params = { ...(obj.params ?? {}) };
    // Back-compat: legacy projects stored a 'lfo.bpmDiv' division string and
    // reused per-section 'lfo.adsr.<sec>.speed' as a division string in BPM
    // mode. Map both to the new integer 1/32-count fields on load.
    if (params['lfo.bpmDiv'] !== undefined && params['lfo.bpmCount32'] === undefined) {
      params['lfo.bpmCount32'] = divToCount32(params['lfo.bpmDiv']);
    }
    delete params['lfo.bpmDiv'];
    for (const sec of ['a', 'd', 's', 'r']) {
      const sp = params[`lfo.adsr.${sec}.speed`];
      if (typeof sp === 'string') {
        if (params[`lfo.adsr.${sec}.bpmCount32`] === undefined) {
          params[`lfo.adsr.${sec}.bpmCount32`] = divToCount32(sp);
        }
        delete params[`lfo.adsr.${sec}.speed`];   // drop the overloaded string
      }
    }
    Object.entries(params).forEach(([k, v]) => this.setParam(k, v));
  }
}
