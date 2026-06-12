/**
 * ChordMachine.js
 * ---------------
 * Four-voice chord synthesizer. Four detuned oscillators are tuned to
 * a fixed interval set (chord type) above the played root note. Chord
 * type and inversion are p-lockable per step, enabling harmonic sequences
 * from a single track without polyphonic architecture.
 *
 * Persistent oscillator architecture — all four oscillators run
 * continuously, amplitude gated by the track Envelope.
 *
 * Chord types (intervals in semitones above root):
 *   major      [0, 4, 7, 12]
 *   minor      [0, 3, 7, 12]
 *   dom7       [0, 4, 7, 10]
 *   maj7       [0, 4, 7, 11]
 *   min7       [0, 3, 7, 10]
 *   sus2       [0, 2, 7, 12]
 *   sus4       [0, 5, 7, 12]
 *   dim        [0, 3, 6, 12]
 *   aug        [0, 4, 8, 12]
 *   power      [0, 0, 7, 12]  (root doubled + fifth)
 *   octave     [0, 12, 24, 36] (stacked octaves)
 *
 * Inversion 0: root position. Inversion 1–3: rotate bottom voice up one octave.
 *
 * Parameters:
 *   'osc.detune'   — master detune cents (-100–+100), hidden (trig tab)
 *   'chord'        — chord type (enum, see above)
 *   'inversion'    — 0–3
 *   'spread'       — additional detuning per voice in cents (0–50¢), adds width
 *   'waveform'     — 'sawtooth' | 'square' | 'triangle' | 'sine'
 *   'output.level' — 0–1
 */

import { Machine } from './Machine.js';
import { makeTrimGain } from './LoudnessTrim.js';

const CHORD_DEFS = {
  major:  [0,  4,  7,  12],
  minor:  [0,  3,  7,  12],
  dom7:   [0,  4,  7,  10],
  maj7:   [0,  4,  7,  11],
  min7:   [0,  3,  7,  10],
  sus2:   [0,  2,  7,  12],
  sus4:   [0,  5,  7,  12],
  dim:    [0,  3,  6,  12],
  aug:    [0,  4,  8,  12],
  power:  [0,  0,  7,  12],
  octave: [0, 12, 24,  36],
};
const CHORD_NAMES = Object.keys(CHORD_DEFS);
const NUM_VOICES  = 4;

function _getIntervals(chordName, inversion) {
  const base  = [...(CHORD_DEFS[chordName] ?? CHORD_DEFS.major)];
  const inv   = Math.max(0, Math.min(3, Math.round(inversion)));
  // Each inversion: raise the lowest voice by one octave
  const notes = [...base];
  for (let i = 0; i < inv; i++) {
    // Find the minimum and add 12
    let minIdx = 0;
    for (let j = 1; j < notes.length; j++) {
      if (notes[j] < notes[minIdx]) minIdx = j;
    }
    notes[minIdx] += 12;
  }
  notes.sort((a, b) => a - b);
  return notes;
}

export class ChordMachine extends Machine {
  // Most params are JS side-effects that recompute the 4 voice freqs/detunes via
  // _applyChord. 'osc.detune' is manualTarget: its AudioParam (osc[0].detune) is
  // exposed to LFO/resolveAudioParam, but setParam writes it through _applyChord
  // (so per-voice spread is preserved), NOT a direct auto-schedule.
  static SPEC = {
    'osc.detune':   { label: 'Detune', type: 'number', min: -100, max: 100, default: 0, hidden: true,
                      modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam',
                      target: m => m._oscs[0].detune, manualTarget: true,
                      apply: (v, t, m) => m._applyChord(m._rootFreq, t) },
    'chord':        { label: 'Chord', type: 'enum', options: CHORD_NAMES, default: 'major',
                      plockMode: 'js', apply: (v, t, m) => m._applyChord(m._rootFreq, t) },
    'inversion':    { label: 'Inversion', type: 'number', min: 0, max: 3, default: 0,
                      plockMode: 'js', apply: (v, t, m) => m._applyChord(m._rootFreq, t) },
    'spread':       { label: 'Spread', type: 'number', min: 0, max: 50, default: 8,
                      modulatable: true, lfoMin: 0, lfoMax: 50, plockMode: 'js',
                      apply: (v, t, m) => m._applyChord(m._rootFreq, t) },
    'waveform':     { label: 'Waveform', type: 'enum', options: ['sawtooth','square','triangle','sine'],
                      default: 'sawtooth', plockMode: 'js',
                      apply: (v, t, m) => m._oscs.forEach(osc => { osc.type = v; }) },
    'output.level': { label: 'Level', type: 'number', min: 0, max: 1, default: 0.7,
                      modulatable: true, lfoMin: 0, lfoMax: 1,
                      target: m => m.outputGain.gain, schedule: 'setValue' },
  };

  constructor(context) {
    super(context);
    this.type  = 'chord';
    this.label = 'Chord';

    this._initSpec();
    this._rootFreq = 440;   // needed before any _applyChord (setParam during fromJSON)

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];

    // Loudness normalisation trim (see LoudnessTrim.js) — fixed, post-output.
    this._trimGain = makeTrimGain(context, this.type);
    this.outputGain.connect(this._trimGain);

    // Mix gain — normalise 4 voices so volume is consistent
    this._mixGain = context.createGain();
    this._mixGain.gain.value = 1 / NUM_VOICES;
    this._mixGain.connect(this.outputGain);

    // Four persistent oscillators
    this._oscs = Array.from({ length: NUM_VOICES }, (_, i) => {
      const osc = context.createOscillator();
      osc.type            = this._params['waveform'];
      osc.frequency.value = 440 * Math.pow(2, _getIntervals('major', 0)[i] / 12);
      osc.connect(this._mixGain);
      osc.start();
      return osc;
    });
  }

  _applyChord(rootFreq, time) {
    const intervals = _getIntervals(this._params['chord'], this._params['inversion']);
    const spread    = this._params['spread'];
    const t         = time ?? this.context.currentTime;

    this._oscs.forEach((osc, i) => {
      const freq = rootFreq * Math.pow(2, intervals[i] / 12);
      // Alternating detune per voice for stereo spread character
      const spreadCents = (i % 2 === 0 ? 1 : -1) * Math.floor(i / 2 + 1) * spread * 0.5;
      // Drop stale future frequency events from a previous held chord before
      // retuning — see SynthMachine.noteOn for the LiveArp octave-bleed rationale.
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(this._params['osc.detune'] + spreadCents, t);
    });
  }

  noteOn(midiNote, velocity, time) {
    this._rootFreq = Machine.midiToFreq(midiNote);
    this._applyChord(this._rootFreq, time);
  }

  noteOff(time) {} // Envelope handles amplitude

  connect(destinationNode) { this._trimGain.connect(destinationNode); }

  disconnect() {
    this._oscs.forEach(osc => { try { osc.stop(); } catch (_) {} });
    this.outputGain.disconnect();
    this._trimGain.disconnect();
  }

  // Param interface derived from `static SPEC` (Machine base class). The chord
  // recompute side-effects live in _applyChord, referenced by the spec's apply hooks.
}
