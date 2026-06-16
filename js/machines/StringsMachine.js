/**
 * StringsMachine.js
 * -----------------
 * Bowed / plucked string-section synthesizer. A small ensemble of detuned
 * sawtooth oscillators (the "section") is summed, run through a body
 * resonance (bandpass) and a tone lowpass, with a touch of bow noise and an
 * internal vibrato LFO. The result is a sustained, lush strings pad that
 * tracks the played note.
 *
 * Persistent-oscillator architecture (like SynthMachine / ChordMachine): all
 * nodes run continuously and amplitude is gated entirely by the track
 * Envelope. noteOn just retunes the section; noteOff is a no-op. This lets
 * LFOs / mod-wheel bind permanently to any AudioParam.
 *
 * Modes (instrument character) — each shifts the section octave and sets how
 * many semitones of spread feel natural for that register:
 *   violin   — +12 st, bright, tight ensemble
 *   viola    —   0 st, warm mid
 *   cello    — −12 st, dark, fuller body
 *   ensemble — +0 st, wide section (extra octave-up voice for shimmer)
 *
 * Audio graph:
 *   Osc×N (saw, persistent, vibrato-modulated) ─┐
 *   bow-noise → _bowGain ───────────────────────┴→ _mixGain
 *     → _body (bandpass, resonance)
 *     → _tone (lowpass)
 *     → outputGain → _trimGain → [Filter]
 *
 *   _vibratoOsc → _vibratoGain → every osc.detune  (shared vibrato)
 *
 * Parameters:
 *   'mode'          — 'violin' | 'viola' | 'cello' | 'ensemble'
 *   'osc.detune'    — master detune cents (-100–+100), hidden (trig tab)
 *   'ensemble'      — section spread in cents (0–60), width of the unison stack
 *   'tone'          — lowpass cutoff Hz (300–12000), brightness
 *   'body'          — body bandpass center Hz (150–3000), wooden resonance
 *   'resonance'     — body bandpass Q (0.3–10)
 *   'bow'           — bow-noise level (0–1), breathy attack texture
 *   'vibrato'       — vibrato depth cents (0–50)
 *   'vibrato.rate'  — vibrato LFO speed Hz (0.5–12)
 *   'output.level'  — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';
import { count32ToHz } from '../util/BpmSync.js';

// Per-mode character: octave shift (semitones) + a relative ensemble scaler.
// Voice offsets (semitones) define the unison stack for each mode — the
// 'ensemble' param then detunes them in cents around these centres.
const MODE_DEFS = {
  violin:   { octave:  12, voices: [0, 0, 0],        spreadScale: 0.7 },
  viola:    { octave:   0, voices: [0, 0, 0],        spreadScale: 0.85 },
  cello:    { octave: -12, voices: [0, 0, 0, -12],   spreadScale: 1.0 },
  ensemble: { octave:   0, voices: [0, 0, 0, 12, -12], spreadScale: 1.3 },
};
const MODE_NAMES = Object.keys(MODE_DEFS);
// Max voices across all modes — we allocate this many oscillators up front and
// silence the unused ones per mode (persistent-oscillator architecture).
const MAX_VOICES = Math.max(...Object.values(MODE_DEFS).map(d => d.voices.length));

export class StringsMachine extends Machine {
  // 'osc.detune' is manualTarget: its AudioParam (osc[0].detune) is exposed to
  // LFO/resolveAudioParam, but setParam writes it through _applyTuning (so per-
  // voice ensemble spread is preserved), NOT a direct auto-schedule. 'mode' and
  // 'ensemble' are JS side-effects that recompute the section via _applyTuning.
  static SPEC = {
    'mode':         { label: 'Mode', type: 'enum', options: MODE_NAMES, default: 'viola', group: 'VOICE',
                      plockMode: 'js', apply: (v, t, m) => m._applyTuning(m._rootFreq, t) },
    'osc.detune':   { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                      modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                      target: m => m._oscs[0].detune, manualTarget: true,
                      apply: (v, t, m) => m._applyTuning(m._rootFreq, t) },
    'ensemble':     { label: 'Ensemble', type: 'number', min: 0, max: 60, default: 14, group: 'VOICE',
                      modulatable: true, lfoMin: 0, lfoMax: 60, plockMode: 'js',
                      apply: (v, t, m) => m._applyTuning(m._rootFreq, t) },
    'tone':         { label: 'Tone', type: 'number', min: 300, max: 12000, default: 4000, group: 'TONE',
                      modulatable: true, lfoMin: 300, lfoMax: 12000,
                      target: m => m._tone.frequency, schedule: 'setTarget', tc: 0.01 },
    'body':         { label: 'Body', type: 'number', min: 150, max: 3000, default: 800, group: 'TONE',
                      modulatable: true, lfoMin: 150, lfoMax: 3000,
                      target: m => m._body.frequency, schedule: 'setTarget', tc: 0.01 },
    'resonance':    { label: 'Resonance', type: 'number', min: 0.3, max: 10, default: 1.2, group: 'TONE',
                      modulatable: true, lfoMin: 0.3, lfoMax: 10,
                      target: m => m._body.Q, schedule: 'setTarget', tc: 0.01 },
    'bow':          { label: 'Bow', type: 'number', min: 0, max: 1, default: 0.15, group: 'TONE',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m._bowGain.gain, schedule: 'setTarget', tc: 0.01 },
    'vibrato':      { label: 'Vibrato', type: 'number', min: 0, max: 50, default: 6, group: 'VIBRATO',
                      modulatable: true, lfoMin: 0, lfoMax: 50,
                      target: m => m._vibratoGain.gain, schedule: 'setTarget', tc: 0.02 },
    // Vibrato rate is a unified MS↔BPM (here Hz↔BPM) sync knob: in 'hz' mode the
    // knob drives this Hz value (LFO/p-lock modulatable via the osc.frequency
    // AudioParam); in 'bpm' mode the rate is derived from `vibrato.bpmCount32`
    // (1/32 period count) + the track tempo. manualTarget keeps the AudioParam
    // exposed to the LFO/resolveAudioParam while `_applyVibratoRate` owns the
    // actual write (so BPM mode wins when active). See design/audio-signal-chain.md (Unified Sync-Knob Model).
    'vibrato.rate': { label: 'Vib Rate', type: 'number', min: 0.5, max: 12, default: 5.0, group: 'VIBRATO',
                      modulatable: true, lfoMin: 0.5, lfoMax: 12, plockMode: 'audioParam',
                      target: m => m._vibratoOsc.frequency, manualTarget: true,
                      apply: (v, t, m) => m._applyVibratoRate(t) },
    // syncMode + bpmCount32 are the BPM half of the vibrato.rate sync knob — the
    // panel renders them together as one knob, so they are hidden from the flat
    // param list (still p-lockable/serialised via their paths).
    'vibrato.syncMode':   { label: 'Vib Sync', type: 'enum', options: ['hz', 'bpm'], default: 'hz',
                            hidden: true, plockMode: 'js', apply: (v, t, m) => m._applyVibratoRate(t) },
    'vibrato.bpmCount32': { label: 'Vib Div', type: 'number', min: 1, max: 128, default: 8,
                            hidden: true, plockMode: 'js', apply: (v, t, m) => m._applyVibratoRate(t) },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.7, group: 'OUTPUT',
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'strings';
    this.label = 'Strings';

    this._initSpec();
    this._rootFreq = 440;   // needed before any _applyTuning (setParam during fromJSON)
    this._bpm = 120;        // current tempo, for resolving BPM-synced vibrato rate

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Tone lowpass — overall brightness
    this._tone = context.createBiquadFilter();
    this._tone.type            = 'lowpass';
    this._tone.frequency.value = this._params['tone'];
    this._tone.Q.value         = 0.7071;
    this._tone.connect(this.outputGain);

    // Body bandpass — wooden resonance of the instrument
    this._body = context.createBiquadFilter();
    this._body.type            = 'bandpass';
    this._body.frequency.value = this._params['body'];
    this._body.Q.value         = this._params['resonance'];
    this._body.connect(this._tone);

    // Mix gain — sums the section + bow noise, normalised by max voice count so
    // changing mode/voices does not jump the level.
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1 / (MAX_VOICES + 1);
    this._mixGain.connect(this._body);

    // Shared vibrato LFO → each osc.detune (depth in cents via _vibratoGain)
    this._vibratoOsc = context.createOscillator();
    this._vibratoOsc.type            = 'sine';
    this._vibratoOsc.frequency.value = this._effectiveVibratoHz();
    this._vibratoGain = context.createGain();
    this._vibratoGain.gain.value = this._params['vibrato'];
    this._vibratoOsc.connect(this._vibratoGain);
    this._vibratoOsc.start();

    // Persistent section oscillators (sawtooth). Per-mode unused voices are
    // silenced via _voiceGains; vibrato detune is shared across all of them.
    this._oscs       = [];
    this._voiceGains = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      const osc = context.createOscillator();
      osc.type            = 'sawtooth';
      osc.frequency.value = 440;
      this._vibratoGain.connect(osc.detune);   // shared vibrato

      const vg = context.createGain();
      vg.gain.value = 1;
      osc.connect(vg);
      vg.connect(this._mixGain);
      osc.start();

      this._oscs.push(osc);
      this._voiceGains.push(vg);
    }

    // Bow noise — band-limited white noise looped, gated by _bowGain
    this._bowGain = context.createGain();
    this._bowGain.gain.value = this._params['bow'];
    this._bowGain.connect(this._mixGain);

    const noiseLen = Math.max(1, Math.floor(context.sampleRate * 0.5));
    const noiseBuf = context.createBuffer(1, noiseLen, context.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;
    this._bowSrc        = context.createBufferSource();
    this._bowSrc.buffer = noiseBuf;
    this._bowSrc.loop   = true;
    // Tame the noise so it reads as bow texture, not hiss
    this._bowFilter = context.createBiquadFilter();
    this._bowFilter.type            = 'bandpass';
    this._bowFilter.frequency.value = 2500;
    this._bowFilter.Q.value         = 0.5;
    this._bowSrc.connect(this._bowFilter);
    this._bowFilter.connect(this._bowGain);
    this._bowSrc.start();

    this._applyTuning(this._rootFreq, context.currentTime);
  }

  /**
   * Resolve the vibrato LFO rate in Hz from the current sync mode: the raw Hz
   * value ('hz' mode) or the 1/32 period count + tempo ('bpm' mode).
   */
  _effectiveVibratoHz() {
    if (this._params['vibrato.syncMode'] === 'bpm') {
      return count32ToHz(this._params['vibrato.bpmCount32'], this._bpm);
    }
    return this._params['vibrato.rate'];
  }

  /** Write the resolved vibrato rate to the LFO oscillator. */
  _applyVibratoRate(time) {
    if (!this._vibratoOsc) return;
    const t = time ?? this.context.currentTime;
    this._vibratoOsc.frequency.setTargetAtTime(this._effectiveVibratoHz(), t, 0.02);
  }

  /** Track tempo changed — re-resolve the vibrato rate if BPM-synced. */
  setBpm(bpm) {
    this._bpm = bpm;
    if (this._params['vibrato.syncMode'] === 'bpm') this._applyVibratoRate();
  }

  /**
   * Retune the section for the current root frequency, mode, ensemble spread
   * and master detune. Silences voices not used by the active mode.
   */
  _applyTuning(rootFreq, time) {
    const def     = MODE_DEFS[this._params['mode']] ?? MODE_DEFS.viola;
    const spread  = this._params['ensemble'] * def.spreadScale;
    const detune  = this._params['osc.detune'];
    const baseFreq = rootFreq * Math.pow(2, def.octave / 12);
    const t       = time ?? this.context.currentTime;

    this._oscs.forEach((osc, i) => {
      const active = i < def.voices.length;
      this._voiceGains[i].gain.setValueAtTime(active ? 1 : 0, t);
      if (!active) return;
      const semis = def.voices[i];
      const freq  = baseFreq * Math.pow(2, semis / 12);
      // Alternating per-voice detune for a wide unison stack
      const spreadCents = (i % 2 === 0 ? 1 : -1) * Math.ceil((i + 1) / 2) * spread * 0.5;
      // Drop stale future frequency events from a previous held chord before
      // retuning — see SynthMachine.noteOn for the LiveArp octave-bleed rationale.
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(detune + spreadCents, t);
    });
  }

  /**
   * Retune section to the played note. Amplitude gating is handled by the
   * track Envelope — no gain changes here.
   */
  noteOn(midiNote, velocity, time) {
    this._rootFreq = Machine.midiToFreq(midiNote);
    this._applyTuning(this._rootFreq, time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    try { this._vibratoOsc.stop(); } catch (_) {}
    try { this._bowSrc.stop();     } catch (_) {}
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). The section
  // retune side-effects live in _applyTuning, referenced by the spec apply hooks.
}
