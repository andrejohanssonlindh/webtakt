/**
 * MoogishMachine.js
 * -----------------
 * Analogue-modelling oscillator machine — the tone-generator section of the
 * PATINA engine (js/patina/patina.js) adapted to the Webtakt machine contract.
 *
 * The analogue character comes from shared building blocks in AnalogueParts.js
 * (extracted from here / PATINA so the analogue drums reuse them too):
 *   - Custom oscillator spectra (`makeImperfectWave`): real analogue waveforms
 *     are never textbook-perfect. Component tolerance skews harmonic amplitudes,
 *     comparator asymmetry leaks even harmonics into "square" waves, and op-amp
 *     slew limiting rounds off the very top. Each oscillator gets a fresh,
 *     slightly different PeriodicWave so no two are identical.
 *   - Slow thermal pitch DRIFT (`DriftClock`): a bounded random walk nudges every
 *     oscillator's detune ~12×/s (own setInterval, like SwarmMachine). `drift` scales it.
 *   - Per-instance component TOLERANCE: fixed random tuning/level offsets baked
 *     in at construction, so two MoogishMachine instances differ subtly.
 *   - Pink-noise hiss layer (circuit noise) blended in pre-filter.
 *
 * This machine is the OSCILLATOR section only. It deliberately does NOT include
 * Patina's ladder filter, envelopes, LFO, or FX — those are owned by the
 * Webtakt Track (Filter / Envelope / LFO / FX), so the existing GUI tabs,
 * p-locks and LFO routing drive this machine's tone for free. The analogue
 * ladder filter is a separate, later phase (see project_patina_analogue memory
 * / DESIGN.md). For now Moogish feeds the standard biquad Filter chain.
 *
 * Persistent-oscillator architecture (like SynthMachine / StringsMachine): all
 * nodes run continuously and amplitude is gated entirely by the track Envelope.
 * noteOn just retunes; noteOff is a no-op. LFOs / mod-wheel bind permanently.
 *
 * Audio graph:
 *   Osc1 → g1 ─┐
 *   Osc2 → g2 ─┤
 *   Osc3 → g3 ─┤
 *   Sub  → gS ─┼→ _mixGain → outputGain → _trimGain → [Filter]
 *   Noise→ gN ─┤
 *   Hum  → gH ─┤
 *   Hum2 → gH2─┘
 *
 * Parameters (all p-lockable + LFO-assignable where they back an AudioParam):
 *   'osc1.waveform' 'osc1.octave' 'osc1.detune' 'osc1.level'
 *   'osc2.waveform' 'osc2.octave' 'osc2.detune' 'osc2.level'
 *   'osc3.waveform' 'osc3.octave' 'osc3.detune' 'osc3.level'
 *   'sub.level'     — sub sine, one octave below osc1 (0–1)
 *   'noise.level'   — circuit hiss (0–1)
 *   'drift'         — thermal pitch wander amount (0–1)
 *   'hum'           — mains hum level (0–1): sine at humFreq + 2nd harmonic
 *   'humFreq'       — 50 (Europe) | 60 (Americas) Hz
 *   'osc.detune'    — master detune cents (hidden, trig tab), -100..+100
 *   'output.level'  — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { makeImperfectWave, makePinkBuffer, DriftClock, rand } from './AnalogueParts.js';

const WAVEFORMS = ['saw', 'square', 'triangle', 'pulse', 'sine'];

export class MoogishMachine extends Machine {
  // Per-osc waveform/octave are JS side-effects (PeriodicWave swap / retune);
  // detune/level back AudioParams so they p-lock + LFO natively. 'osc.detune' is
  // the hidden trig-tab master detune; like other persistent-osc machines it is
  // manualTarget so the per-osc offsets are preserved (written via _retune).
  static SPEC = {
    'osc1.waveform': { label: 'O1 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       group: 'OSC 1', plockMode: 'js', apply: (v, t, m) => m._setWave(0, v) },
    'osc1.octave':   { label: 'O1 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 1',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc1.detune':   { label: 'O1 Detune', type: 'number', min: -50, max: 50, default: -6, group: 'OSC 1',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc1.level':    { label: 'O1 Level', type: 'number', min: 0, max: 1, default: 0.45, group: 'OSC 1',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[0].gain, schedule: 'setTarget', tc: 0.005 },

    // Hard sync (osc2 → osc1). When on, osc2's native oscillator is detached and
    // a `sync-osc` worklet drives osc2's mix gain, its slave frequency = osc2's
    // pitch and master = osc1's, for the classic metallic sync sweep. `osc2.sync.amt`
    // sweeps the slave detune (the timbre) up to +4 octaves over osc2's base pitch.
    'osc2.sync':     { label: 'O2 Sync', type: 'boolean', default: false, group: 'OSC 2',
                       plockMode: 'js', apply: (v, t, m) => m._setSync(!!v, t) },
    'osc2.sync.amt': { label: 'O2 SyncAmt', type: 'number', min: 0, max: 1, default: 0.0, group: 'OSC 2',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applySyncAmt(t) },

    'osc2.waveform': { label: 'O2 Wave', type: 'enum', options: WAVEFORMS, default: 'saw',
                       group: 'OSC 2', plockMode: 'js', apply: (v, t, m) => m._setWave(1, v) },
    'osc2.octave':   { label: 'O2 Oct', type: 'number', min: -2, max: 2, default: 0, group: 'OSC 2',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc2.detune':   { label: 'O2 Detune', type: 'number', min: -50, max: 50, default: 7, group: 'OSC 2',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[1].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc2.level':    { label: 'O2 Level', type: 'number', min: 0, max: 1, default: 0.45, group: 'OSC 2',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[1].gain, schedule: 'setTarget', tc: 0.005 },

    'osc3.waveform': { label: 'O3 Wave', type: 'enum', options: WAVEFORMS, default: 'triangle',
                       group: 'OSC 3', plockMode: 'js', apply: (v, t, m) => m._setWave(2, v) },
    'osc3.octave':   { label: 'O3 Oct', type: 'number', min: -2, max: 2, default: -1, group: 'OSC 3',
                       plockMode: 'js', apply: (v, t, m) => m._retune(t) },
    'osc3.detune':   { label: 'O3 Detune', type: 'number', min: -50, max: 50, default: 2, group: 'OSC 3',
                       modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam',
                       target: m => m._oscs[2].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },
    'osc3.level':    { label: 'O3 Level', type: 'number', min: 0, max: 1, default: 0.0, group: 'OSC 3',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._gains[2].gain, schedule: 'setTarget', tc: 0.005 },

    'sub.level':     { label: 'Sub', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._subGain.gain, schedule: 'setTarget', tc: 0.005 },
    'noise.level':   { label: 'Noise', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._noiseGain.gain, schedule: 'setTarget', tc: 0.01 },

    // PWM layer (osc1 pitch): a variable-width pulse made by subtracting a
    // delayed copy of a saw from itself (saw − saw_delayed(pw/freq) = pulse of
    // duty `pw`), so the width is continuously modulatable (unlike the static
    // imperfect-pulse PeriodicWave). `pwm` mixes it in; `pwm.width` is the duty.
    'pwm':           { label: 'PWM', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._pwmGain.gain, schedule: 'setTarget', tc: 0.01 },
    'pwm.width':     { label: 'PW', type: 'number', min: 0.05, max: 0.95, default: 0.5, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0.05, lfoMax: 0.95, plockMode: 'js',
                       apply: (v, t, m) => m._applyPwmWidth(t) },

    // Ring / cross-mod: osc1 × osc2 (a GainNode whose gain AudioParam is driven by
    // osc1, multiplying osc2's signal), summed in via `ring`. Clangorous, inharmonic.
    'ring':          { label: 'Ring', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m._ringMix.gain, schedule: 'setTarget', tc: 0.01 },

    // Wavefolder on the osc mix bus: a WaveShaper sine-fold curve scaled by `fold`
    // (West-coast timbre — harmonics bloom as the signal folds back on itself).
    'fold':          { label: 'Fold', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applyFold(t) },

    'drift':         { label: 'Drift', type: 'number', min: 0, max: 1, default: 0.5, group: 'TEXTURE',
                       plockMode: 'js' },
    // Mains hum (ported from Patina): a sine at humFreq + its 2nd harmonic, the
    // "circuit is never entirely quiet" floor. hum scales both levels; humFreq is
    // 50 Hz (Europe) or 60 Hz (Americas). _hum (a fixed scalar) drives the gains.
    'hum':           { label: 'Hum', type: 'number', min: 0, max: 1, default: 0.0, group: 'TEXTURE',
                       modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js',
                       apply: (v, t, m) => m._applyHum(t) },
    'humFreq':       { label: 'Hum Hz', type: 'enum', options: [50, 60], default: 50, group: 'TEXTURE',
                       plockMode: 'js', apply: (v, t, m) => m._applyHum(t) },

    'osc.detune':    { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                       modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                       target: m => m._oscs[0].detune, manualTarget: true,
                       apply: (v, t, m) => m._retune(t) },

    'output.level':  { label: 'Level', type: 'number', min: 0, max: 1, default: 0.8, group: 'OUTPUT',
                       modulatable: true, lfoMin: 0, lfoMax: 1,
                       target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'moogish';
    this.label = 'Moogish';

    this._initSpec();
    this._rootMidi = 60;   // needed before any _retune (setParam during fromJSON)

    // Fixed per-instance "component tolerance" — like one slot in a vintage poly.
    this._tolTune  = rand() * 4;            // cents
    this._tolSub   = rand() * 2;            // cents

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix bus — sums the three oscillators + sub + noise + pwm + ring. Passes
    // through the wavefolder shaper on its way to outputGain (fold=0 ⇒ identity).
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1;
    // Wavefolder: a WaveShaper whose curve is rebuilt by _applyFold from the
    // `fold` amount (fold 0 = linear passthrough). Sits mix → fold → output.
    this._foldShaper = context.createWaveShaper();
    this._foldShaper.oversample = '4x';
    this._mixGain.connect(this._foldShaper);
    this._foldShaper.connect(this.outputGain);

    // Three persistent main oscillators, each with its own imperfect spectrum.
    // _waveType[i] tracks the current waveform string so _setWave only rebuilds
    // the (randomised) PeriodicWave when the type actually changes — see _setWave.
    this._oscs       = [];
    this._gains      = [];
    this._waveType   = [];
    for (let i = 0; i < 3; i++) {
      const osc = context.createOscillator();
      const wf  = this._params[`osc${i + 1}.waveform`];
      osc.setPeriodicWave(makeImperfectWave(context, wf, { tolerance: 0.04 }));
      this._waveType[i] = wf;
      osc.frequency.value = 261.63;
      osc.detune.value    = this._params[`osc${i + 1}.detune`] + this._tolTune;

      const g = context.createGain();
      g.gain.value = this._params[`osc${i + 1}.level`];
      osc.connect(g);
      g.connect(this._mixGain);
      osc.start();

      this._oscs.push(osc);
      this._gains.push(g);
    }

    // Sub oscillator — sine, one octave below osc1.
    this._subGain = context.createGain();
    this._subGain.gain.value = this._params['sub.level'];
    this._subGain.connect(this._mixGain);
    this._oscSub = context.createOscillator();
    this._oscSub.setPeriodicWave(makeImperfectWave(context, 'sine', { tolerance: 0.02 }));
    this._oscSub.frequency.value = 130.81;
    this._oscSub.detune.value    = this._tolSub;
    this._oscSub.connect(this._subGain);
    this._oscSub.start();

    // Circuit hiss — looped pink noise, gated by _noiseGain.
    this._noiseGain = context.createGain();
    this._noiseGain.gain.value = this._params['noise.level'];
    this._noiseGain.connect(this._mixGain);
    this._noiseSrc        = context.createBufferSource();
    this._noiseSrc.buffer = makePinkBuffer(context, 2);
    this._noiseSrc.loop   = true;
    this._noiseSrc.playbackRate.value = 1 + rand() * 0.1; // decorrelate
    this._noiseSrc.connect(this._noiseGain);
    this._noiseSrc.start();

    // ── PWM layer (osc1 pitch) ──────────────────────────────────────────────
    // A continuously-variable pulse: saw − saw_delayed(width/freq). ONE saw, split
    // into a direct path and a delayed+inverted copy of ITSELF, summed. (Two
    // separate oscillators would drift in phase and never form a stable pulse.)
    // Their difference is a pulse of duty `width`; the delay re-sets per retune /
    // width change so the duty tracks pitch. Mixed in via _pwmGain.
    this._pwmOsc = context.createOscillator();
    this._pwmOsc.setPeriodicWave(makeImperfectWave(context, 'saw', { tolerance: 0.04 }));
    this._pwmOsc.frequency.value = 261.63;
    this._pwmOsc.detune.value    = this._tolTune;
    this._pwmDelay = context.createDelay(0.05);          // max 50 ms (≥ one period of 20 Hz)
    this._pwmInvert = context.createGain();
    this._pwmInvert.gain.value = -1;                     // subtract the delayed copy
    this._pwmGain = context.createGain();
    this._pwmGain.gain.value = this._params['pwm'];
    this._pwmOsc.connect(this._pwmGain);                 // direct path
    this._pwmOsc.connect(this._pwmDelay);                // delayed copy of the SAME saw
    this._pwmDelay.connect(this._pwmInvert);
    this._pwmInvert.connect(this._pwmGain);
    this._pwmGain.connect(this._mixGain);
    this._pwmOsc.start();

    // ── Ring / cross-mod (osc1 × osc2) ──────────────────────────────────────
    // _ringGain multiplies osc2's signal by osc1 (osc1 drives _ringGain.gain),
    // so the output is osc1·osc2 — the sum/difference sidebands of a ring mod.
    // Mixed in via the `ring` amount (the gain's resting value when osc1 is 0).
    this._ringGain = context.createGain();
    this._ringGain.gain.value = 0;                       // baseline 0; osc1 swings it ±
    this._oscs[1].connect(this._ringGain);               // signal path = osc2
    this._oscs[0].connect(this._ringGain.gain);          // modulator = osc1
    // `ring` amount scales the product into the mix via a follow-up gain.
    this._ringMix = context.createGain();
    this._ringMix.gain.value = this._params['ring'];
    this._ringGain.connect(this._ringMix);
    this._ringMix.connect(this._mixGain);

    // ── Hard-sync slave (lazy worklet) ──────────────────────────────────────
    // Created on first switch to osc2.sync=on (worklet preloaded at boot). When
    // active it replaces osc2's native oscillator into _gains[1]. Self-heals if
    // the worklet isn't registered yet (mirrors Filter's analogue ladder).
    this._syncNode    = null;
    this._syncWired   = false;
    this._syncRetrying = false;

    // Mains hum — a sine at humFreq plus its 2nd harmonic (real hum is never a
    // pure tone), summed into the mix bus. Levels driven by _applyHum from the
    // `hum` param; ported from Patina (0.0011 / 0.0004 × hum). Off by default.
    this._humOsc  = context.createOscillator();
    this._humOsc2 = context.createOscillator();
    this._humOsc.type  = 'sine';
    this._humOsc2.type = 'sine';
    this._humGain  = context.createGain();
    this._humGain2 = context.createGain();
    this._humGain.gain.value  = 0;
    this._humGain2.gain.value = 0;
    this._humOsc.connect(this._humGain).connect(this._mixGain);
    this._humOsc2.connect(this._humGain2).connect(this._mixGain);
    this._humOsc.start();
    this._humOsc2.start();
    this._applyHum(context.currentTime);

    // Thermal drift clock — bounded random walk on every osc detune (3 main +
    // sub), ~12×/s. Each tick DriftClock adds a small wander on top of the
    // per-osc base detune supplied by _driftBase(). Released in disconnect()
    // (Machine base warns: un-released timers leak).
    this._drift = new DriftClock(
      context,
      [...this._oscs, this._oscSub].map(o => o.detune),
      { baseFor: i => this._driftBase(i), amountFor: () => this._params['drift'] * 3.5 },
    );

    this._retune(context.currentTime);
  }

  /** Base detune (excluding wander) for drift index i: 0–2 = main oscs, 3 = sub. */
  _driftBase(i) {
    if (i < 3) {
      return this._params[`osc${i + 1}.detune`] + this._params['osc.detune'] + this._tolTune;
    }
    return this._tolSub;
  }

  /**
   * Swap one oscillator's waveform (regenerates its imperfect spectrum).
   * No-op if the type is unchanged: makeImperfectWave bakes a *fresh random*
   * tolerance each call, so rebuilding on an identical type would re-randomise the
   * voice's character. VoicePool.nextVoice() re-applies every JS param (incl.
   * waveform) to non-canonical slots on every note via fromJSONSafe — without this
   * guard slots 1..N got a new spectrum per hit while the canonical slot 0 kept its
   * construction-time wave, so every Nth note (slot 0) audibly stood out.
   */
  _setWave(idx, type) {
    if (this._waveType[idx] === type) return;
    this._waveType[idx] = type;
    this._oscs[idx].setPeriodicWave(makeImperfectWave(this.context, type, { tolerance: 0.04 }));
  }

  /**
   * Retune all oscillators to the current root note, applying per-osc octave +
   * detune (+ master detune + component tolerance). Sub tracks osc1 one octave
   * below. Mirrors StringsMachine._applyTuning.
   */
  _retune(time) {
    const t = time ?? this.context.currentTime;
    const master = this._params['osc.detune'];
    for (let i = 0; i < 3; i++) {
      const oct  = this._params[`osc${i + 1}.octave`];
      const det  = this._params[`osc${i + 1}.detune`];
      const freq = Machine.midiToFreq(this._rootMidi + oct * 12);
      // Drop stale future frequency events from a previous held chord before
      // retuning — see SynthMachine.noteOn for the LiveArp octave-bleed rationale.
      this._oscs[i].frequency.cancelScheduledValues(t);
      this._oscs[i].frequency.setValueAtTime(freq, t);
      this._oscs[i].detune.setValueAtTime(det + master + this._tolTune, t);
    }
    const subOct = this._params['osc1.octave'];
    const subFreq = Machine.midiToFreq(this._rootMidi + subOct * 12 - 12);
    this._oscSub.frequency.cancelScheduledValues(t);
    this._oscSub.frequency.setValueAtTime(subFreq, t);

    // PWM layer tracks osc1's pitch (both saws), and its delay (= pulse width)
    // tracks that frequency so the duty cycle stays constant across the keyboard.
    const o1Oct  = this._params['osc1.octave'];
    const o1Freq = Machine.midiToFreq(this._rootMidi + o1Oct * 12);
    this._pwmOsc.frequency.cancelScheduledValues(t);
    this._pwmOsc.frequency.setValueAtTime(o1Freq, t);
    this._applyPwmWidth(t);

    // Hard-sync node (when active): master = osc1 pitch, slave = osc2 pitch ×
    // (1 + amt·4 octaves) so the sync sweep rides osc2's tuning + the sync amount.
    if (this._syncNode) this._applySyncAmt(t);
  }

  /**
   * Apply the mains-hum level + frequency. hum scales both the fundamental and
   * its (quieter) 2nd harmonic; humFreq selects 50/60 Hz. Levels ported from
   * Patina. setTargetAtTime so live `hum` knob moves don't click.
   */
  _applyHum(time) {
    const t    = time ?? this.context.currentTime;
    const hum  = this._params['hum'];
    const freq = Number(this._params['humFreq']);
    this._humOsc.frequency.setTargetAtTime(freq,     t, 0.05);
    this._humOsc2.frequency.setTargetAtTime(freq * 2, t, 0.05);
    this._humGain.gain.setTargetAtTime(0.0011 * hum, t, 0.1);
    this._humGain2.gain.setTargetAtTime(0.0004 * hum, t, 0.1);
  }

  /**
   * Set the PWM delay so duty = `pwm.width` of one osc1 period. delay = width/freq;
   * clamped to the delay node's max (50 ms). A short setTargetAtTime keeps live
   * width-knob / LFO moves click-free.
   */
  _applyPwmWidth(time) {
    const t     = time ?? this.context.currentTime;
    const width = this._params['pwm.width'];
    const o1Oct = this._params['osc1.octave'];
    const freq  = Machine.midiToFreq(this._rootMidi + o1Oct * 12);
    const delay = Math.min(0.05, Math.max(0, width / Math.max(freq, 1e-6)));
    this._pwmDelay.delayTime.setTargetAtTime(delay, t, 0.005);
  }

  /**
   * Wavefolder curve from the `fold` amount (0 = linear passthrough). The curve
   * pre-gains the input then takes sin(), so as fold rises the signal folds back
   * on itself, blooming odd+even harmonics (West-coast timbre). Rebuilt on change.
   */
  _applyFold(time) {
    const fold = this._params['fold'];
    if (fold <= 0.0001) { this._foldShaper.curve = null; return; }   // identity
    const drive = 1 + fold * 6;                 // up to ~7× pre-gain into the fold
    const N = 1024;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;          // −1..+1
      // sin fold normalised so the curve stays within ±1 at any drive.
      curve[i] = Math.sin(x * drive * Math.PI * 0.5) / Math.max(1, drive * 0.6);
    }
    this._foldShaper.curve = curve;
  }

  /**
   * Drive the hard-sync slave/master frequencies (only meaningful while the sync
   * worklet is active). master = osc1 pitch; slave = osc2 pitch swept up to +4
   * octaves by `osc2.sync.amt` — the slave's reset rate is the sync timbre.
   */
  _applySyncAmt(time) {
    if (!this._syncNode) return;
    const t     = time ?? this.context.currentTime;
    const amt   = this._params['osc2.sync.amt'];
    const o1Oct = this._params['osc1.octave'];
    const o2Oct = this._params['osc2.octave'];
    const o2Det = this._params['osc2.detune'];
    const masterF = Machine.midiToFreq(this._rootMidi + o1Oct * 12);
    const o2Base  = Machine.midiToFreq(this._rootMidi + o2Oct * 12) *
                    Math.pow(2, o2Det / 1200);
    const slaveF  = o2Base * Math.pow(2, amt * 4);   // up to +4 octaves
    this._syncNode.parameters.get('masterFreq').setTargetAtTime(masterF, t, 0.005);
    this._syncNode.parameters.get('slaveFreq').setTargetAtTime(slaveF, t, 0.005);
  }

  /**
   * Switch osc2 between its native oscillator and the hard-sync worklet. On: the
   * native osc2 is detached from its mix gain and the sync node drives it. Off:
   * the native osc2 returns. The worklet is created lazily on first 'on'; if it
   * isn't registered yet (switched before the boot preload resolved) we self-heal
   * by re-issuing addModule() and retrying — mirrors Filter._setEngine.
   */
  _setSync(on, time) {
    if (on === this._syncWired) return;            // idempotent
    const t = time ?? this.context.currentTime;

    if (on) {
      if (!this._syncNode) {
        try {
          this._syncNode = new AudioWorkletNode(this.context, 'sync-osc', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
          });
        } catch (err) {
          if (this.context.audioWorklet && !this._syncRetrying) {
            this._syncRetrying = true;
            this.context.audioWorklet.addModule('js/worklets/sync-osc-processor.js')
              .then(() => {
                this._syncRetrying = false;
                if (this._params['osc2.sync'] && !this._syncWired) this._setSync(true);
              })
              .catch((e) => {
                // Worklet genuinely unavailable (e.g. OfflineAudioContext in
                // tests). Keep the sync INTENT in _params (a project saved with
                // sync on should restore it if the worklet later loads); just
                // stay on the native osc2. Benign offline → allow-listed warning.
                this._syncRetrying = false;
                console.warn('Moogish: sync-osc worklet unavailable, staying native.', e);
              });
          }
          return;                                  // stay native until retry wires it
        }
      }
      // Detach native osc2 → its gain; route the sync node there instead.
      try { this._oscs[1].disconnect(this._gains[1]); } catch (_) {}
      this._syncNode.connect(this._gains[1]);
      this._applySyncAmt(t);
    } else {
      // Detach sync node; restore native osc2 → its gain.
      if (this._syncNode) { try { this._syncNode.disconnect(this._gains[1]); } catch (_) {} }
      this._oscs[1].connect(this._gains[1]);
    }
    this._syncWired = on;
  }

  /** Retune to the played note. Amplitude gating handled by the track Envelope. */
  noteOn(midiNote, velocity, time) {
    this._rootMidi = midiNote;
    this._retune(time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._drift.stop();
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    try { this._oscSub.stop();   } catch (_) {}
    try { this._noiseSrc.stop(); } catch (_) {}
    try { this._humOsc.stop();   } catch (_) {}
    try { this._humOsc2.stop();  } catch (_) {}
    try { this._pwmOsc.stop();   } catch (_) {}
    if (this._syncNode) {
      try { this._syncNode.port.postMessage('kill'); } catch (_) {}
      try { this._syncNode.disconnect(); } catch (_) {}
    }
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). Per-osc
  // retune side-effects live in _retune, referenced by the spec apply hooks.
}
