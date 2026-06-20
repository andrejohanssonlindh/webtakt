/**
 * Filter.js
 * ---------
 * Per-track filter wrapping up to 4 cascaded BiquadFilterNodes for the main filter,
 * plus base HPF + base LPF nodes before them.
 *
 * `filter.slope` (0–1) controls how many extra poles are active:
 *   0   → 1 pole  (12 dB/oct)  — only the primary node
 *   0.33 → 2 poles (24 dB/oct)
 *   0.66 → 3 poles (36 dB/oct)
 *   1   → 4 poles  (48 dB/oct)
 * Intermediate values blend continuously via per-stage dry/wet GainNodes.
 *
 * All extra stages track the same type/cutoff/Q/gain as node.
 * The envelope writes node.frequency (+ every stage's .frequency, see
 * scheduleFrequency). LFO modulation of cutoff rides on .detune (cents →
 * exponential/octave-based, see resolveLFOTargets) and also fans to every stage.
 *
 * Signal chain:
 *   [input] → _baseHPF → _baseLPF → node → _extra[0..2] (wet-blended) → [output]
 *
 * Public:
 *   .node             — primary BiquadFilterNode (for LFO/env connections)
 *   connect(dest)     — connect filter output to next node
 *   disconnect()
 *   setParam(path, value, time)
 *   getParam(path)
 *   getParamList()
 *
 * Parameters:
 *   'filter.type'       — 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'allpass'
 *   'filter.cutoff'     — Hz, 20–20000
 *   'filter.resonance'  — Q, 0.1–20
 *   'filter.gain'       — dB, -30–+30 (peaking only)
 *   'filter.envAmount'  — -1.0 to 1.0
 *   'filter.slope'      — 0–1 (continuous pole count, default 0 = 1 pole / 12dB/oct)
 *   'base.lpf'          — Hz, 200–20000 (base lowpass, no resonance, default 20000)
 *   'base.hpf'          — Hz, 20–8000  (base highpass, no resonance, default 20)
 */

const EXTRA_STAGES = 7; // 7 extra → 8 poles max (96 dB/oct)

// Page-relative path to the analogue ladder worklet module. AudioEngine preloads
// this at boot (fire-and-forget), but a filter can be switched to 'analogue'
// BEFORE that load resolves (e.g. setMachine applies an analogue-machine default
// during synchronous Project construction). addModule() is idempotent and resolves
// once the module is registered regardless of who kicked it off, so _setEngine
// re-issues it and self-heals the switch on resolve rather than failing to digital.
const LADDER_WORKLET_PATH = 'js/worklets/patina-ladder-processor.js';

// Map the UI resonance knob (biquad Q, 0.1–20) onto the analogue ladder's
// resonance range (0–1.15, where > ~1.0 self-oscillates). Linear so the top of
// the knob reaches self-oscillation; clamped to the ladder's worklet range.
function _resToLadder(q) {
  const t = (q - 0.1) / (20 - 0.1);           // 0..1 across the Q knob
  return Math.max(0, Math.min(1.15, t * 1.15));
}

// Map the UI `filter.type` (shared with the digital biquad) onto the analogue
// ladder worklet's `shape` param (pole-mix index). The ladder has no peaking
// response, so 'peaking' falls back to lowpass (the ladder's native shape).
const _LADDER_SHAPE = {
  lowpass:  0,
  highpass: 1,
  bandpass: 2,
  notch:    3,
  allpass:  4,
  peaking:  0,
};

// Short glide used to reach the note-on cutoff without a coefficient-step click
// (see scheduleFrequency baseCut anchor).
const ANCHOR_GLIDE = 0.0015;

/**
 * One RC (exponential-approach) cutoff segment toward `target`, started at
 * `start` and pinned to exactly `target` at `start + dur`. Mirrors
 * Envelope._rcSegment so the analogue filter envelope curves identically to the
 * analogue amp envelope. A near-zero duration degrades to an instant step.
 */
function _rcFreq(freq, start, dur, target) {
  if (dur <= 0.0005) {
    freq.setValueAtTime(target, start);
    return;
  }
  freq.setTargetAtTime(target, start, dur / 3);
  freq.setValueAtTime(target, start + dur);
}

export class Filter {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;

    this._params = {
      'filter.engine':    'digital',  // 'digital' (biquad) | 'analogue' (ladder worklet)
      'filter.type':      'lowpass',
      'filter.cutoff':    8000,
      'filter.resonance': 1.0,
      'filter.gain':      0,
      'filter.envAmount': 0.3,
      'filter.slope':     0,
      'filter.drive':     2.0,        // analogue ladder only: input gain into tanh stage
      'filter.drift':     0.01,       // analogue ladder only: thermal cutoff wander
      'filter.keytrack':  0.0,        // analogue flow: cutoff follows pitch (0–1). 1.0 = the
                                      // self-oscillating ladder plays in tune across the keyboard.
      'base.lpf':         20000,
      'base.hpf':         20,
    };

    // Lazily-created analogue ladder worklet node (Moog transistor ladder).
    // Stays null until the user switches this filter to engine='analogue'.
    this._ladder = null;
    // Which engine is currently WIRED into the audio path. The constructor wires
    // the digital biquad cascade below, so this starts 'digital'. _setEngine only
    // re-routes on an actual transition (re-connecting an already-connected node
    // pair would double the signal).
    this._wiredEngine = 'digital';

    // Primary filter node — LFO + env connect here
    this.node = context.createBiquadFilter();
    this.node.type            = this._params['filter.type'];
    this.node.frequency.value = this._params['filter.cutoff'];
    this.node.Q.value         = this._params['filter.resonance'];
    this.node.gain.value      = this._params['filter.gain'];

    // Base filter nodes — fixed Q, no resonance
    this._baseLPF = context.createBiquadFilter();
    this._baseLPF.type            = 'lowpass';
    this._baseLPF.frequency.value = this._params['base.lpf'];
    this._baseLPF.Q.value         = 0.7071;

    this._baseHPF = context.createBiquadFilter();
    this._baseHPF.type            = 'highpass';
    this._baseHPF.frequency.value = this._params['base.hpf'];
    this._baseHPF.Q.value         = 0.7071;

    // Extra slope stages — each is a dry/wet blend
    // dry path: passthrough GainNode (gain = 1 - wetGain)
    // wet path: BiquadFilterNode → wetGainNode
    // both sum into next stage's input
    this._stages = [];
    for (let i = 0; i < EXTRA_STAGES; i++) {
      const biquad  = context.createBiquadFilter();
      biquad.type            = this._params['filter.type'];
      biquad.frequency.value = this._params['filter.cutoff'];
      biquad.Q.value         = 0.7071; // slope stages: flat Butterworth, no resonance stacking
      biquad.gain.value      = this._params['filter.gain'];

      const dryGain = context.createGain();
      dryGain.gain.value = 1;

      const wetGain = context.createGain();
      wetGain.gain.value = 0;

      // sumNode receives dry + wet, feeds into next stage or output
      const sumNode = context.createGain();
      sumNode.gain.value = 1;

      this._stages.push({ biquad, dryGain, wetGain, sumNode });
    }

    // Output node — final connection point
    this._outputGain = context.createGain();
    this._outputGain.gain.value = 1;

    // Sibling filters (other voice slots) that mirror this one's params.
    // The canonical slot-0 filter is the only one the UI/sequencer writes to;
    // it fans every setParam out to its mirrors so all voices stay identical.
    this._mirrors = [];

    // Wire signal chain
    // base: _baseHPF → _baseLPF → node
    this._baseHPF.connect(this._baseLPF);
    this._baseLPF.connect(this.node);

    // node → stage[0] → stage[1] → stage[2] → _outputGain
    let prev = this.node;
    for (const { biquad, dryGain, wetGain, sumNode } of this._stages) {
      // dry path: prev → dryGain → sumNode
      prev.connect(dryGain);
      dryGain.connect(sumNode);
      // wet path: prev → biquad → wetGain → sumNode
      prev.connect(biquad);
      biquad.connect(wetGain);
      wetGain.connect(sumNode);
      prev = sumNode;
    }
    prev.connect(this._outputGain);
    // Tail of the digital biquad cascade — disconnected from _outputGain when the
    // analogue ladder takes over the path (see _setEngine).
    this._biquadTail = prev;
  }

  /** @param {AudioNode} destinationNode */
  connect(destinationNode) {
    this._outputGain.connect(destinationNode);
  }

  /**
   * Switch the filter engine between the digital biquad cascade and the analogue
   * Moog ladder worklet. Both subgraphs stay alive; we only move two cut points:
   *
   *   digital:  _baseLPF → node → stages… → _biquadTail → _outputGain
   *   analogue: _baseLPF →               _ladder        → _outputGain
   *
   * The ladder node is created lazily on first switch (its worklet module is
   * preloaded at boot by AudioEngine, so construction here is synchronous). If
   * the worklet is unavailable (load failed / OfflineAudioContext w/o worklet)
   * we fall back to staying digital rather than silencing the track.
   *
   * @param {string} engine 'digital' | 'analogue'
   * @param {number} [time]
   */
  _setEngine(engine, time) {
    const target = engine === 'analogue' ? 'analogue' : 'digital';
    if (target === this._wiredEngine) return;   // idempotent: only act on transitions

    const analogue = target === 'analogue';
    if (analogue && !this._ladder) {
      try {
        this._ladder = new AudioWorkletNode(this.context, 'patina-ladder', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        });
      } catch (err) {
        // The worklet module isn't registered yet (a filter switched to analogue
        // before AudioEngine's boot-time preload resolved — e.g. an analogue
        // machine default applied during Project construction). Keep the analogue
        // INTENT in _params (so a UI re-render shows analogue), stay wired digital
        // for now, and retry once the module loads. addModule() is idempotent, so
        // re-issuing it just resolves when the shared preload finishes. Guard the
        // retry against the user/project flipping the engine back meanwhile.
        if (this.context.audioWorklet && !this._ladderRetrying) {
          this._ladderRetrying = true;
          this.context.audioWorklet.addModule(LADDER_WORKLET_PATH)
            .then(() => {
              this._ladderRetrying = false;
              if (this._params['filter.engine'] === 'analogue' && this._wiredEngine !== 'analogue') {
                this._setEngine('analogue');
              }
            })
            .catch((e) => {
              this._ladderRetrying = false;
              console.warn('Filter: analogue ladder unavailable, staying digital.', e);
              this._params['filter.engine'] = 'digital';
            });
        }
        return;   // stay digital until the retry re-wires (or gives up)
      }
    }

    const t = time ?? this.context.currentTime;
    if (analogue) {
      // base → ladder → output ; detach biquad cascade from base + output.
      try { this._baseLPF.disconnect(this.node); } catch (_) {}
      try { this._biquadTail.disconnect(this._outputGain); } catch (_) {}
      this._baseLPF.connect(this._ladder);
      this._ladder.connect(this._outputGain);
      // Push current params into the ladder so it matches the knobs.
      this._ladder.parameters.get('cutoff').setValueAtTime(this._params['filter.cutoff'], t);
      this._ladder.parameters.get('resonance').setValueAtTime(_resToLadder(this._params['filter.resonance']), t);
      this._ladder.parameters.get('drive').setValueAtTime(this._params['filter.drive'], t);
      this._ladder.parameters.get('drift').setValueAtTime(this._params['filter.drift'], t);
      this._ladder.parameters.get('shape').setValueAtTime(_LADDER_SHAPE[this._params['filter.type']] ?? 0, t);
    } else {
      // base → node → … → output ; detach ladder.
      if (this._ladder) {
        try { this._baseLPF.disconnect(this._ladder); } catch (_) {}
        try { this._ladder.disconnect(this._outputGain); } catch (_) {}
      }
      this._baseLPF.connect(this.node);
      this._biquadTail.connect(this._outputGain);
    }
    this._wiredEngine = target;
  }

  /**
   * The cutoff AudioParam of the ACTIVE engine — ladder `cutoff` in analogue mode,
   * else the primary biquad's `frequency`. The Envelope (live keyboard path) writes
   * cutoff through this so it targets whichever engine is running.
   * @returns {AudioParam}
   */
  cutoffParam() {
    return (this._params['filter.engine'] === 'analogue' && this._ladder)
      ? this._ladder.parameters.get('cutoff')
      : this.node.frequency;
  }

  /** Connect an incoming node to the filter input (base HPF entry point) */
  connectInput(sourceNode) {
    sourceNode.connect(this._baseHPF);
  }

  disconnect() {
    if (this._ladder) {
      try { this._ladder.port.postMessage('kill'); } catch (_) {}
      try { this._ladder.disconnect(); } catch (_) {}
    }
    this._outputGain.disconnect();
  }

  /**
   * Register a sibling filter that should mirror every param change made here.
   * Used by VoicePool so all voice-slot filters track the canonical slot-0 filter.
   *
   * Replays the canonical's CURRENT param state onto the new mirror immediately —
   * mirroring only fans out FUTURE setParam calls, so without this replay a mirror
   * registered after the canonical was already configured (e.g. engine switched to
   * 'analogue', or any non-default param) would silently stay on the defaults. That
   * left voice slot 0 (the canonical) on a different filter than the others — heard
   * as "every Nth note (slot 0) sounds different", and only on analogue voices
   * because the digital biquad defaults happen to match.
   * @param {Filter} filter
   */
  mirrorTo(filter) {
    if (!filter || filter === this) return;
    this._mirrors.push(filter);
    // Bring the new mirror up to the canonical's current state.
    for (const [path, value] of Object.entries(this._params)) {
      filter.setParam(path, value);
    }
  }

  /** @param {string} path @param {number|string} value @param {number} [time] */
  setParam(path, value, time) {
    // Fan out to mirror filters (other voice slots) so all voices stay identical.
    for (const m of this._mirrors) m.setParam(path, value, time);

    this._params[path] = value;
    const t = time ?? this.context.currentTime;

    switch (path) {
      case 'filter.engine':
        this._setEngine(value, t);
        break;
      case 'filter.type':
        this.node.type = value;
        for (const { biquad } of this._stages) biquad.type = value;
        // The analogue ladder mirrors the same type via its pole-mix `shape`.
        if (this._ladder) {
          const shape = _LADDER_SHAPE[value] ?? 0;
          this._ladder.parameters.get('shape').setValueAtTime(shape, t);
        }
        break;
      case 'filter.cutoff':
        // Write both engines so the inactive one stays in sync for a later switch.
        this.node.frequency.setTargetAtTime(value, t, 0.005);
        for (const { biquad } of this._stages) biquad.frequency.setTargetAtTime(value, t, 0.005);
        if (this._ladder) this._ladder.parameters.get('cutoff').setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.resonance':
        this.node.Q.setTargetAtTime(value, t, 0.005);
        // Slope stages stay at Butterworth Q (0.7071) — applying user Q to every
        // pole causes resonance to compound-multiply across stages, blowing up at
        // high slope + high Q. Only the primary node carries the resonance peak.
        if (this._ladder) this._ladder.parameters.get('resonance').setTargetAtTime(_resToLadder(value), t, 0.005);
        break;
      case 'filter.gain':
        this.node.gain.setTargetAtTime(value, t, 0.005);
        for (const { biquad } of this._stages) biquad.gain.setTargetAtTime(value, t, 0.005);
        break;
      case 'filter.drive':
        if (this._ladder) this._ladder.parameters.get('drive').setTargetAtTime(value, t, 0.01);
        break;
      case 'filter.drift':
        if (this._ladder) this._ladder.parameters.get('drift').setTargetAtTime(value, t, 0.01);
        break;
      case 'filter.envAmount':
      case 'filter.keytrack':
        // Read at note-fire time by Envelope.scheduleNote (plockMode 'envelope');
        // no live AudioParam to update here.
        break;
      case 'filter.slope':
        this._applySlope(value, t);
        break;
      case 'base.lpf':
        this._baseLPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
      case 'base.hpf':
        this._baseHPF.frequency.setTargetAtTime(value, t, 0.005);
        break;
    }
  }

  /**
   * Slope 0–1 maps to 1–4 active poles continuously.
   * Stage i (0-indexed) becomes fully wet when slope >= (i+1)/EXTRA_STAGES.
   * It ramps in over the preceding 1/EXTRA_STAGES range.
   */
  _applySlope(slope, t) {
    const tc = 0.008;
    for (let i = 0; i < EXTRA_STAGES; i++) {
      const { dryGain, wetGain } = this._stages[i];
      // Stage i activates in the range [i/N, (i+1)/N] where N = EXTRA_STAGES
      const lo = i / EXTRA_STAGES;
      const hi = (i + 1) / EXTRA_STAGES;
      const wet = Math.max(0, Math.min(1, (slope - lo) / (hi - lo)));
      wetGain.gain.setTargetAtTime(wet, t, tc);
      dryGain.gain.setTargetAtTime(1 - wet, t, tc);
    }
  }

  /** @param {string} path */
  getParam(path) {
    return this._params[path];
  }

  getParamList() {
    return [
      { path: 'filter.engine',    label: 'Engine',    type: 'enum',   options: ['digital','analogue'], plockMode: 'js' },
      { path: 'filter.type',      label: 'Type',      type: 'enum',   options: ['lowpass','highpass','bandpass','notch','peaking','allpass'], plockMode: 'js'        },
      { path: 'filter.cutoff',    label: 'Cutoff',    type: 'number', min: 20,  max: 20000, default: 8000,  modulatable: true, lfoMin: 20,   lfoMax: 20000, lfoUnit: 'cents', plockMode: 'envelope' },
      { path: 'filter.resonance', label: 'Resonance', type: 'number', min: 0.1, max: 20,    default: 1.0,   modulatable: true, lfoMin: 0.1,  lfoMax: 20,    plockMode: 'filter'   },
      { path: 'filter.gain',      label: 'Gain',      type: 'number', min: -30, max: 30,    default: 0,     modulatable: true, lfoMin: -30,  lfoMax: 30,    plockMode: 'filter'   },
      { path: 'filter.envAmount', label: 'Env Amt',   type: 'number', min: -1,  max: 1,     default: 0.3,                                                   plockMode: 'envelope' },
      { path: 'filter.slope',     label: 'Slope',     type: 'number', min: 0,   max: 1,     default: 0,     modulatable: true, lfoMin: 0,    lfoMax: 1,     plockMode: 'filter'   },
      { path: 'filter.drive',     label: 'Drive',     type: 'number', min: 0.1, max: 12,    default: 2.0,   modulatable: true, lfoMin: 0.1,  lfoMax: 12,    plockMode: 'filter'   },
      { path: 'filter.drift',     label: 'Drift',     type: 'number', min: 0,   max: 0.08,  default: 0.01,  modulatable: true, lfoMin: 0,    lfoMax: 0.08,  plockMode: 'filter'   },
      { path: 'filter.keytrack',  label: 'Keytrack',  type: 'number', min: 0,   max: 1,     default: 0.0,                                                   plockMode: 'envelope' },
      { path: 'base.lpf',         label: 'Base LPF',  type: 'number', min: 200, max: 20000, default: 20000, modulatable: true, lfoMin: 200,  lfoMax: 20000, lfoUnit: 'cents', plockMode: 'filter'   },
      { path: 'base.hpf',         label: 'Base HPF',  type: 'number', min: 20,  max: 8000,  default: 20,    modulatable: true, lfoMin: 20,   lfoMax: 8000,  lfoUnit: 'cents', plockMode: 'filter'   },
    ];
  }

  /**
   * Schedule a complete filter-envelope sweep across all filter nodes (primary + slope stages).
   * Called by Envelope.scheduleNote so that slope stages track the envelope identically.
   *
   * @param {number} time       — note-on time
   * @param {number} a          — fenv attack
   * @param {number} d          — fenv decay
   * @param {number} peakCut    — Hz at peak of envelope
   * @param {number} sustainCut — Hz at sustain
   * @param {number} offTime    — note-off time (start of release)
   * @param {number} fr         — fenv release
   * @param {number} trueCut    — Hz to restore to after release
   * @param {number} [baseCut]  — Hz the sweep starts from at note-on. A fresh voice
   *   slot's filter rests at its constructed default (8 kHz) until its first note.
   *   Without anchoring, the attack of a note p-locked to a low cutoff is played
   *   while the filter is still open/settling, so a low-frequency chunk of the
   *   onset leaks through — a short muffled "thump" on the first 8 notes (once per
   *   pool slot), then gone once every slot has rested at the locked cutoff.
   *
   *   We can't fix that with a ramp at `time`: an instant jump steps the biquad
   *   coefficients (click), and a short glide *sweeps the cutoff through the whole
   *   midrange* during the audible attack (a descending chirp/thump — worse). The
   *   filter sits BEFORE the amp gate, which is shut while the slot is idle, so we
   *   instead pre-position it: `anchorFrequency(baseCut, settleTime)` is called at
   *   scheduling time (ahead of `time`), letting the filter settle to baseCut
   *   silently before the gate opens. `scheduleFrequency` then just runs the
   *   envelope from baseCut with no discontinuity. baseCut here is informational /
   *   back-compat for the sweep start; the actual pre-position is anchorFrequency.
   */
  /**
   * Cutoff AudioParam(s) of the active engine. Digital: the primary biquad +
   * every slope stage (all must track the envelope identically). Analogue: the
   * single ladder `cutoff` param. Envelope sweeps + LFO + anchor all fan to these.
   * @returns {AudioParam[]}
   */
  _cutoffParams() {
    if (this._params['filter.engine'] === 'analogue' && this._ladder) {
      return [this._ladder.parameters.get('cutoff')];
    }
    return [this.node.frequency, ...this._stages.map(s => s.biquad.frequency)];
  }

  scheduleFrequency(time, a, d, peakCut, sustainCut, offTime, fr, trueCut, baseCut = null, analogue = false) {
    for (const freq of this._cutoffParams()) {
      if (typeof freq.cancelAndHoldAtTime === 'function') {
        freq.cancelAndHoldAtTime(time);
      } else {
        freq.cancelScheduledValues(time);
      }
      // Always anchor the curve start at `time`. Without an explicit event here
      // Chrome ramps the sweep from the previous automation event (in the past),
      // so the cutoff begins moving a lookahead early — the filter-side twin of
      // the amp "pre-note". baseCut, when given, IS that anchor; otherwise pin the
      // held value. See Envelope._scheduleADS for the full rationale.
      freq.setValueAtTime(baseCut !== null ? baseCut : freq.value, time);
      // Release must win over any A/D/S event that lands after `offTime`. When the
      // decay is long (attack+decay > gateLen+release) its trailing pin/ramp to
      // sustainCut falls AFTER the release in the timeline and would override the
      // release sweep, leaving the cutoff stuck at sustain. Cancel-and-hold at
      // offTime drops those late decay events and freezes the held value so the
      // release sweeps cleanly from there. (Amp-gate twin of this is the drone bug
      // fixed in Envelope._scheduleR — see that for the full rationale.)
      const holdRelease = () => {
        if (typeof freq.cancelAndHoldAtTime === 'function') freq.cancelAndHoldAtTime(offTime);
        else                                                freq.cancelScheduledValues(offTime);
        freq.setValueAtTime(sustainCut, offTime);
      };
      if (analogue) {
        // RC (exponential) filter sweep, matching the analogue amp envelope's
        // curve. Each segment approaches asymptotically (tc = dur/3) and is
        // pinned to its exact endpoint so the A→D→S→R chain stays accurate.
        _rcFreq(freq, time,       a,  peakCut);
        _rcFreq(freq, time + a,   d,  sustainCut);
        holdRelease();
        _rcFreq(freq, offTime,    fr, trueCut);
      } else {
        freq.linearRampToValueAtTime(peakCut,    time + a);
        freq.linearRampToValueAtTime(sustainCut, time + a + d);
        holdRelease();
        freq.linearRampToValueAtTime(trueCut, offTime + fr);
      }
    }
  }

  /**
   * Pre-position every filter node's cutoff to `freqHz`, settling by `settleTime`.
   * Called at scheduling time (ahead of the note) while the slot's amp gate is
   * still shut, so the move is inaudible. This lets a note whose cutoff is p-locked
   * far from where the slot's filter currently rests start from the right cutoff
   * with no onset thump/click — see scheduleFrequency's baseCut note.
   *
   * The settle uses a short setTargetAtTime so the biquad coefficients move
   * continuously (no coefficient-step click) and reach the target well before the
   * gate opens. No-op-cheap when the filter is already there.
   *
   * @param {number} freqHz     — target cutoff Hz
   * @param {number} settleTime — AudioContext time the move should start
   */
  anchorFrequency(freqHz, settleTime) {
    for (const freq of this._cutoffParams()) {
      freq.setTargetAtTime(freqHz, settleTime, ANCHOR_GLIDE);
    }
  }

  resolveAudioParam(path) {
    switch (path) {
      case 'filter.cutoff':    return this.cutoffParam();
      case 'filter.resonance': return this.node.Q;
      case 'base.lpf':         return this._baseLPF.frequency;
      case 'base.hpf':         return this._baseHPF.frequency;
      default: return null;
    }
  }

  /**
   * Resolve a param path to the AudioParam(s) an LFO should modulate.
   *
   * This is intentionally distinct from `resolveAudioParam` (used by the
   * envelope and UI, which write the *intrinsic* value). Two reasons it differs:
   *
   *  1. **Frequency params modulate `detune`, not `frequency`.** `detune` is in
   *     cents and combines exponentially (`computedFreq = frequency·2^(detune/1200)`),
   *     so a constant cents swing = a constant octave swing — symmetric to the ear
   *     and pitch-independent. Adding linear Hz to `frequency` instead darkens far
   *     harder than it brightens and can slam a lowpass to 0 Hz (silence). The
   *     intrinsic value (knob + envelope) keeps living on `frequency`; the LFO
   *     rides on top via `detune`, so the two compose cleanly. Params flagged
   *     `lfoUnit: 'cents'` in getParamList() (cutoff, base LPF/HPF) route this way;
   *     `depthScale` is then a cents value spanning the param's full log range
   *     (see Track.lfoDepthScale), so full depth reaches both rails from any base.
   *     Q/gain stay linear, since they are not octave quantities.
   *  2. **Cutoff fans out to every slope stage.** All poles must track the same
   *     modulation (cf. `scheduleFrequency`), so we return each stage's `detune`
   *     as well as the primary node's.
   *
   * @param {string} path
   * @returns {AudioParam[]} zero or more params to drive (empty = not modulatable)
   */
  resolveLFOTargets(path) {
    switch (path) {
      case 'filter.cutoff':
        // Analogue ladder has no .detune — the LFO rides the worklet's `cutoff`
        // param directly (Hz, linear). Depth is then interpreted in Hz rather than
        // cents; see Track.lfoDepthScale / design doc note.
        if (this._params['filter.engine'] === 'analogue' && this._ladder) {
          return [this._ladder.parameters.get('cutoff')];
        }
        // Digital: primary node + every slope stage, so all active poles track the LFO.
        return [this.node.detune, ...this._stages.map(s => s.biquad.detune)];
      case 'base.lpf': return [this._baseLPF.detune];
      case 'base.hpf': return [this._baseHPF.detune];
      default: {
        const ap = this.resolveAudioParam(path);  // linear params (Q, gain)
        return ap ? [ap] : [];
      }
    }
  }

  toJSON() {
    return { params: { ...this._params } };
  }

  fromJSON(obj) {
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }
}
