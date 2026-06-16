/**
 * machines/param_spec.js — declarative param-spec regression tests
 *
 * Guards the Machine `static SPEC` refactor: the spec-derived getParamList(),
 * resolveAudioParam(), and toJSON/fromJSON of each converted machine must match
 * the original hand-written descriptors EXACTLY. The EXPECTED tables below are
 * copied verbatim from the pre-refactor source — if a future spec edit drifts
 * from these, this test fails.
 *
 * Comparison is order-independent (both array order and object key order) so it
 * checks the real contract (consumers read by key), not incidental formatting.
 */

import { suite, test, assert, makeOfflineTrack } from '../../runner.js';

// Deep value-equality, ignoring object key order. Arrays are compared by the
// SET of their (normalised) elements keyed on `path`, so descriptor order is
// irrelevant — every consumer looks descriptors up by path, never by index.
function normObj(o) {
  if (Array.isArray(o)) return o.map(normObj);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = normObj(o[k]);
    return out;
  }
  return o;
}
function paramListEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  const byPath = list => Object.fromEntries(list.map(d => [d.path, JSON.stringify(normObj(d))]));
  const a = byPath(actual), e = byPath(expected);
  const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
  for (const k of keys) if (a[k] !== e[k]) return false;
  return true;
}

const EXPECTED = {
  synth: [
    { path: 'osc.waveform',  label: 'Waveform',     type: 'enum',   options: ['sine','sawtooth','square','triangle'], plockMode: 'js' },
    { path: 'osc.detune',    label: 'Detune',       type: 'number', min: -100, max: 100, default: 0,   modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'sub.level',     label: 'Sub Level',    type: 'number', min: 0,    max: 1,   default: 0.3, modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
    { path: 'sub.waveform',  label: 'Sub Waveform', type: 'enum',   options: ['sine','sawtooth','square','triangle'], plockMode: 'js' },
    { path: 'output.level',  label: 'Level',        type: 'number', min: 0,    max: 1,   default: 0.8, modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
  ],
  snare: [
    { path: 'tune',         label: 'Tune',      type: 'number', min: 100,  max: 400,  default: 200,  modulatable: true, lfoMin: 100,  lfoMax: 400,  plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',     type: 'number', min: 0.05, max: 1.0,  default: 0.18, plockMode: 'js' },
    { path: 'tone',         label: 'Tone',      type: 'number', min: 0,    max: 1,    default: 0.4,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    { path: 'snap',         label: 'Snap',      type: 'number', min: 0,    max: 1,    default: 0.8,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    { path: 'noise.cutoff', label: 'Noise Cut', type: 'number', min: 200,  max: 8000, default: 2000, modulatable: true, lfoMin: 200,  lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'output.level', label: 'Level',     type: 'number', min: 0,    max: 1,    default: 0.85, modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
  ],
  'snare.analogue': [
    { path: 'tune',         label: 'Tune',      type: 'number', min: 100,  max: 400,  default: 185,  modulatable: true, lfoMin: 100,  lfoMax: 400,  plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',     type: 'number', min: 0.05, max: 1.0,  default: 0.18, plockMode: 'js' },
    { path: 'tone',         label: 'Tone',      type: 'number', min: 0,    max: 1,    default: 0.4,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    { path: 'snap',         label: 'Snap',      type: 'number', min: 0,    max: 1,    default: 0.8,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    { path: 'noise.cutoff', label: 'Noise Cut', type: 'number', min: 200,  max: 8000, default: 1800, modulatable: true, lfoMin: 200,  lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'drift',        label: 'Drift',     type: 'number', min: 0,    max: 1,    default: 0.4,  plockMode: 'js' },
    { path: 'output.level', label: 'Level',     type: 'number', min: 0,    max: 1,    default: 0.85, modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
  ],
  chord: [
    { path: 'osc.detune',   label: 'Detune',    type: 'number', min: -100, max: 100, default: 0,   modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'chord',        label: 'Chord',     type: 'enum',   options: ['major','minor','dom7','maj7','min7','sus2','sus4','dim','aug','power','octave'], plockMode: 'js' },
    { path: 'inversion',    label: 'Inversion', type: 'number', min: 0, max: 3,  default: 0,   plockMode: 'js' },
    { path: 'spread',       label: 'Spread',    type: 'number', min: 0, max: 50, default: 8,   modulatable: true, lfoMin: 0, lfoMax: 50, plockMode: 'js' },
    { path: 'waveform',     label: 'Waveform',  type: 'enum',   options: ['sawtooth','square','triangle','sine'], plockMode: 'js' },
    { path: 'output.level', label: 'Level',     type: 'number', min: 0, max: 1,  default: 0.7, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'kick.silk': [
    { path: 'tune',         label: 'Tune',        type: 'number', min: 20, max: 200, default: 60, modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',       type: 'number', min: 0.05, max: 2.0, default: 0.45, plockMode: 'js' },
    { path: 'sweep',        label: 'Sweep',       type: 'number', min: 1, max: 8, default: 4.0, plockMode: 'js' },
    { path: 'punch',        label: 'Punch',       type: 'number', min: 0, max: 1, default: 0.7, plockMode: 'js' },
    { path: 'punch.decay',  label: 'Punch Decay', type: 'number', min: 0.005, max: 0.08, default: 0.025, plockMode: 'js' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.9, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'kick.hard': [
    { path: 'tune',         label: 'Tune',        type: 'number', min: 20, max: 200, default: 60, modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',       type: 'number', min: 0.05, max: 2.0, default: 0.45, plockMode: 'js' },
    { path: 'sweep',        label: 'Sweep',       type: 'number', min: 1, max: 8, default: 4.0, plockMode: 'js' },
    { path: 'sub.level',    label: 'Sub',         type: 'number', min: 0, max: 1, default: 0.8, plockMode: 'js' },
    { path: 'drive',        label: 'Drive',       type: 'number', min: 1, max: 6, default: 3.0, plockMode: 'js' },
    { path: 'punch',        label: 'Punch',       type: 'number', min: 0, max: 1, default: 0.7, plockMode: 'js' },
    { path: 'punch.decay',  label: 'Punch Decay', type: 'number', min: 0.005, max: 0.08, default: 0.025, plockMode: 'js' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.9, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'kick.analogue': [
    { path: 'tune',         label: 'Tune',        type: 'number', min: 20, max: 200, default: 55, modulatable: true, lfoMin: 20, lfoMax: 200, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',       type: 'number', min: 0.05, max: 2.0, default: 0.50, plockMode: 'js' },
    { path: 'sweep',        label: 'Sweep',       type: 'number', min: 1, max: 8, default: 4.0, plockMode: 'js' },
    { path: 'sub.level',    label: 'Sub',         type: 'number', min: 0, max: 1, default: 0.8, plockMode: 'js' },
    { path: 'drive',        label: 'Drive',       type: 'number', min: 1, max: 6, default: 2.5, plockMode: 'js' },
    { path: 'drift',        label: 'Drift',       type: 'number', min: 0, max: 1, default: 0.4, plockMode: 'js' },
    { path: 'punch',        label: 'Punch',       type: 'number', min: 0, max: 1, default: 0.6, plockMode: 'js' },
    { path: 'punch.decay',  label: 'Punch Decay', type: 'number', min: 0.005, max: 0.08, default: 0.025, plockMode: 'js' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.9, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  hihat: [
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.01, max: 0.25, default: 0.06, plockMode: 'js' },
    { path: 'open.decay',   label: 'Open Decay', type: 'number', min: 0.1, max: 2.0, default: 0.5, plockMode: 'js' },
    { path: 'open',         label: 'Open',       type: 'boolean', default: false, plockMode: 'js' },
    { path: 'cutoff',       label: 'Cutoff',     type: 'number', min: 500, max: 12000, default: 3000, modulatable: true, lfoMin: 500, lfoMax: 12000, plockMode: 'audioParam' },
    { path: 'tone',         label: 'Tone',       type: 'number', min: 0, max: 8, default: 2.0, modulatable: true, lfoMin: 0, lfoMax: 8, plockMode: 'audioParam' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 0.75, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'hihat.analogue': [
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.01, max: 0.25, default: 0.06, plockMode: 'js' },
    { path: 'open.decay',   label: 'Open Decay', type: 'number', min: 0.1, max: 2.0, default: 0.5, plockMode: 'js' },
    { path: 'open',         label: 'Open',       type: 'boolean', default: false, plockMode: 'js' },
    { path: 'cutoff',       label: 'Cutoff',     type: 'number', min: 500, max: 12000, default: 3000, modulatable: true, lfoMin: 500, lfoMax: 12000, plockMode: 'audioParam' },
    { path: 'tone',         label: 'Tone',       type: 'number', min: 0, max: 8, default: 2.0, modulatable: true, lfoMin: 0, lfoMax: 8, plockMode: 'audioParam' },
    { path: 'drift',        label: 'Drift',      type: 'number', min: 0, max: 1, default: 0.4, plockMode: 'js' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 0.75, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  clapp: [
    { path: 'tone',         label: 'Tone',   type: 'number', min: 800, max: 6000, default: 3000, modulatable: true, lfoMin: 800, lfoMax: 6000, plockMode: 'audioParam' },
    { path: 'snap',         label: 'Snap',   type: 'number', min: 0.3, max: 4, default: 1.2, modulatable: true, lfoMin: 0.3, lfoMax: 4, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',  type: 'number', min: 0.05, max: 1.0, default: 0.3, plockMode: 'js' },
    { path: 'spread',       label: 'Spread', type: 'number', min: 0, max: 30, default: 8, plockMode: 'js' },
    { path: 'output.level', label: 'Level',  type: 'number', min: 0, max: 1, default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'clapp.analogue': [
    { path: 'tone',         label: 'Tone',   type: 'number', min: 800, max: 6000, default: 2400, modulatable: true, lfoMin: 800, lfoMax: 6000, plockMode: 'audioParam' },
    { path: 'snap',         label: 'Snap',   type: 'number', min: 0.3, max: 4, default: 1.2, modulatable: true, lfoMin: 0.3, lfoMax: 4, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',  type: 'number', min: 0.05, max: 1.0, default: 0.3, plockMode: 'js' },
    { path: 'spread',       label: 'Spread', type: 'number', min: 0, max: 30, default: 8, plockMode: 'js' },
    { path: 'output.level', label: 'Level',  type: 'number', min: 0, max: 1, default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  cymbal: [
    { path: 'tune',         label: 'Tune',       type: 'number', min: 100, max: 800, default: 300, modulatable: true, lfoMin: 100, lfoMax: 800, plockMode: 'audioParam' },
    { path: 'tone',         label: 'Tone',       type: 'number', min: 200, max: 8000, default: 1500, modulatable: true, lfoMin: 200, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'body',         label: 'Body',       type: 'number', min: 500, max: 16000, default: 3500, modulatable: true, lfoMin: 500, lfoMax: 16000, plockMode: 'audioParam' },
    { path: 'resonance',    label: 'Resonance',  type: 'number', min: 0.5, max: 12, default: 3.0, modulatable: true, lfoMin: 0.5, lfoMax: 12, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.05, max: 0.5, default: 0.15, plockMode: 'js' },
    { path: 'mid.decay',    label: 'Mid Decay',  type: 'number', min: 0.1, max: 2.0, default: 0.6, plockMode: 'js' },
    { path: 'open.decay',   label: 'Open Decay', type: 'number', min: 0.5, max: 8.0, default: 2.5, plockMode: 'js' },
    { path: 'mode',         label: 'Mode',       type: 'enum',   options: ['closed','mid','open'], plockMode: 'js' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 0.5, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'cymbal.analogue': [
    { path: 'tune',         label: 'Tune',       type: 'number', min: 100, max: 800, default: 300, modulatable: true, lfoMin: 100, lfoMax: 800, plockMode: 'audioParam' },
    { path: 'tone',         label: 'Tone',       type: 'number', min: 200, max: 8000, default: 1500, modulatable: true, lfoMin: 200, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'body',         label: 'Body',       type: 'number', min: 500, max: 16000, default: 3500, modulatable: true, lfoMin: 500, lfoMax: 16000, plockMode: 'audioParam' },
    { path: 'resonance',    label: 'Resonance',  type: 'number', min: 0.5, max: 12, default: 3.0, modulatable: true, lfoMin: 0.5, lfoMax: 12, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.05, max: 0.5, default: 0.15, plockMode: 'js' },
    { path: 'mid.decay',    label: 'Mid Decay',  type: 'number', min: 0.1, max: 2.0, default: 0.6, plockMode: 'js' },
    { path: 'open.decay',   label: 'Open Decay', type: 'number', min: 0.5, max: 8.0, default: 2.5, plockMode: 'js' },
    { path: 'mode',         label: 'Mode',       type: 'enum',   options: ['closed','mid','open'], plockMode: 'js' },
    { path: 'drift',        label: 'Drift',      type: 'number', min: 0, max: 1, default: 0.4, plockMode: 'js' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 0.5, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  'tom.analogue': [
    { path: 'tune',         label: 'Tune',      type: 'number', min: 60, max: 400, default: 120, modulatable: true, lfoMin: 60, lfoMax: 400, plockMode: 'audioParam' },
    { path: 'decay',        label: 'Decay',     type: 'number', min: 0.1, max: 1.5, default: 0.4, plockMode: 'js' },
    { path: 'sweep',        label: 'Sweep',     type: 'number', min: 1, max: 4, default: 1.8, plockMode: 'js' },
    { path: 'drive',        label: 'Drive',     type: 'number', min: 1, max: 4, default: 1.8, plockMode: 'js' },
    { path: 'drift',        label: 'Drift',     type: 'number', min: 0, max: 1, default: 0.4, plockMode: 'js' },
    { path: 'attack',       label: 'Attack',    type: 'number', min: 0, max: 1, default: 0.35, plockMode: 'js' },
    { path: 'attack.decay', label: 'Atk Decay', type: 'number', min: 0.005, max: 0.05, default: 0.015, plockMode: 'js' },
    { path: 'output.level', label: 'Level',     type: 'number', min: 0, max: 1, default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  noise: [
    { path: 'color',        label: 'Color',      type: 'number', min: 0, max: 1, default: 0.3, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
    { path: 'color.freq',   label: 'Color Freq', type: 'number', min: 200, max: 8000, default: 2000, modulatable: true, lfoMin: 200, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'body.freq',    label: 'Body Freq',  type: 'number', min: 80, max: 2000, default: 400, modulatable: true, lfoMin: 80, lfoMax: 2000, plockMode: 'audioParam' },
    { path: 'body.level',   label: 'Body',       type: 'number', min: 0, max: 1, default: 0.5, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    { path: 'crush',        label: 'Crush',      type: 'number', min: 0, max: 1, default: 0.0, plockMode: 'js' },
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.01, max: 4.0, default: 0.25, plockMode: 'js' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 0.8, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  karplus: [
    { path: 'damping',      label: 'Damping',     type: 'number', min: 0, max: 1, default: 0.5, plockMode: 'js' },
    { path: 'feedback',     label: 'Feedback',    type: 'number', min: 0.8, max: 0.999, default: 0.985, plockMode: 'js' },
    { path: 'excite',       label: 'Excite',      type: 'number', min: 1, max: 50, default: 8, plockMode: 'js' },
    { path: 'excite.tone',  label: 'Excite Tone', type: 'number', min: 200, max: 20000, default: 8000, plockMode: 'js' },
    { path: 'stretch',      label: 'Stretch',     type: 'number', min: -12, max: 12, default: 0, plockMode: 'js' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.8, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  comb: [
    { path: 'ratio',        label: 'Ratio',   type: 'number', min: 0.5, max: 8, default: 2.756, modulatable: false, plockMode: 'js' },
    { path: 'decay',        label: 'Decay',   type: 'number', min: 0.1, max: 8, default: 1.8, modulatable: true, lfoMin: 0.1, lfoMax: 8, plockMode: 'js' },
    { path: 'decay2',       label: 'Decay 2', type: 'number', min: 0.1, max: 2, default: 0.35, modulatable: false, plockMode: 'js' },
    { path: 'mix',          label: 'Mix',     type: 'number', min: 0, max: 1, default: 0.4, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'js' },
    { path: 'strike',       label: 'Strike',  type: 'number', min: 0, max: 1, default: 0.6, modulatable: false, plockMode: 'js' },
    { path: 'output.level', label: 'Level',   type: 'number', min: 0, max: 1, default: 0.8, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  marimba: [
    { path: 'decay1',       label: 'Decay 1',     type: 'number', min: 0.2, max: 8.0, default: 1.8, plockMode: 'js' },
    { path: 'decay2',       label: 'Decay 2',     type: 'number', min: 0.05, max: 2.0, default: 0.18, plockMode: 'js' },
    { path: 'decay3',       label: 'Decay 3',     type: 'number', min: 0.01, max: 0.5, default: 0.05, plockMode: 'js' },
    { path: 'p2ratio',      label: 'P2 Ratio',    type: 'number', min: 2.0, max: 6.0, default: 3.9, modulatable: true, lfoMin: 2.0, lfoMax: 6.0, plockMode: 'audioParam' },
    { path: 'p3ratio',      label: 'P3 Ratio',    type: 'number', min: 5.0, max: 15.0, default: 9.9, modulatable: true, lfoMin: 5.0, lfoMax: 15.0, plockMode: 'audioParam' },
    { path: 'p2level',      label: 'P2 Level',    type: 'number', min: 0, max: 1, default: 0.45, plockMode: 'js' },
    { path: 'p3level',      label: 'P3 Level',    type: 'number', min: 0, max: 1, default: 0.15, plockMode: 'js' },
    { path: 'mallet',       label: 'Mallet',      type: 'number', min: 0, max: 1, default: 0.5, plockMode: 'js' },
    { path: 'mallet.tone',  label: 'Mallet Tone', type: 'number', min: 500, max: 8000, default: 2500, modulatable: true, lfoMin: 500, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.9, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  transient: [
    { path: 'pitch',        label: 'Pitch',       type: 'number', min: 0, max: 2000, default: 0, modulatable: true, lfoMin: 0, lfoMax: 2000, plockMode: 'js' },
    { path: 'pitch.end',    label: 'Pitch End',   type: 'number', min: 0.05, max: 1.0, default: 0.4, plockMode: 'js' },
    { path: 'body.decay',   label: 'Body Decay',  type: 'number', min: 0.01, max: 2.0, default: 0.12, plockMode: 'js' },
    { path: 'body.wave',    label: 'Body Wave',   type: 'enum',   options: ['sine','triangle'], plockMode: 'js' },
    { path: 'click.freq',   label: 'Click Freq',  type: 'number', min: 100, max: 8000, default: 1200, modulatable: true, lfoMin: 100, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'click.decay',  label: 'Click Decay', type: 'number', min: 0.001, max: 0.05, default: 0.008, plockMode: 'js' },
    { path: 'noise.click',  label: 'Crack',       type: 'number', min: 0, max: 1, default: 0.3, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    { path: 'output.level', label: 'Level',       type: 'number', min: 0, max: 1, default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  wood: [
    { path: 'freq1',        label: 'Freq 1',     type: 'number', min: 200, max: 4000, default: 600, modulatable: true, lfoMin: 200, lfoMax: 4000, plockMode: 'audioParam' },
    { path: 'freq2',        label: 'Freq 2',     type: 'number', min: 400, max: 8000, default: 1400, modulatable: true, lfoMin: 400, lfoMax: 8000, plockMode: 'audioParam' },
    { path: 'ring',         label: 'Ring',       type: 'number', min: 1, max: 30, default: 12, modulatable: true, lfoMin: 1, lfoMax: 30, plockMode: 'audioParam' },
    { path: 'mix',          label: 'Mix',        type: 'number', min: 0, max: 1, default: 0.35, plockMode: 'js' },
    { path: 'decay',        label: 'Decay',      type: 'number', min: 0.001, max: 0.4, default: 0.08, plockMode: 'js' },
    { path: 'click',        label: 'Click',      type: 'number', min: 0, max: 1, default: 0.6, plockMode: 'js' },
    { path: 'click.freq',   label: 'Click Freq', type: 'number', min: 500, max: 12000, default: 3000, modulatable: true, lfoMin: 500, lfoMax: 12000, plockMode: 'audioParam' },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0, max: 1, default: 1.0, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
  bass: [
    { path: 'osc.detune',   label: 'Detune',    type: 'number', min: -100, max: 100,  default: 0,    modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'waveform',     label: 'Waveform',  type: 'enum',   options: ['sawtooth','square'],                                                    plockMode: 'js'        },
    { path: 'sub.level',    label: 'Sub',       type: 'number', min: 0,    max: 1,    default: 0.4,  modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
    { path: 'drive',        label: 'Drive',     type: 'number', min: 0,    max: 1,    default: 0.0,                                                plockMode: 'js'        },
    { path: 'glide',        label: 'Glide',     type: 'number', min: 0,    max: 500,  default: 0,                                                  plockMode: 'js'        },
    { path: 'accent',       label: 'Accent',    type: 'number', min: 0,    max: 127,  default: 100,                                                plockMode: 'js'        },
    { path: 'output.level', label: 'Level',     type: 'number', min: 0,    max: 1,    default: 0.85, modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
  ],
  swarm: [
    { path: 'osc.wave',     label: 'Wave',       type: 'enum',   options: ['sawtooth','square','triangle','sine'], plockMode: 'js' },
    { path: 'osc.detune',   label: 'Detune',     type: 'number', min: -100, max: 100, default: 0,    modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'spread',       label: 'Spread',     type: 'number', min: 0,    max: 100, default: 15,                                                  plockMode: 'js'        },
    { path: 'height',       label: 'Height',     type: 'number', min: 0,    max: 1,   default: 0.7,  modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
    { path: 'slope',        label: 'Slope',      type: 'number', min: -1,   max: 1,   default: 0,                                                   plockMode: 'js'        },
    { path: 'noise.amount', label: 'Noise Amt',  type: 'number', min: 0,    max: 50,  default: 8,    modulatable: true, lfoMin: 0,    lfoMax: 50,  plockMode: 'js'        },
    { path: 'noise.color',  label: 'Noise Rate', type: 'number', min: 0,    max: 1,   default: 0.15, modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'js'        },
    { path: 'output.level', label: 'Level',      type: 'number', min: 0,    max: 1,   default: 0.8,  modulatable: true, lfoMin: 0,    lfoMax: 1,   plockMode: 'audioParam' },
  ],
  strings: [
    { path: 'mode',         label: 'Mode',     type: 'enum',   options: ['violin','viola','cello','ensemble'], plockMode: 'js' },
    { path: 'osc.detune',   label: 'Detune',   type: 'number', min: -100, max: 100, default: 0,    modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'ensemble',     label: 'Ensemble', type: 'number', min: 0,    max: 60,  default: 14,   modulatable: true, lfoMin: 0,    lfoMax: 60,   plockMode: 'js'        },
    { path: 'tone',         label: 'Tone',     type: 'number', min: 300,  max: 12000, default: 4000, modulatable: true, lfoMin: 300,  lfoMax: 12000, plockMode: 'audioParam' },
    { path: 'body',         label: 'Body',     type: 'number', min: 150,  max: 3000, default: 800,  modulatable: true, lfoMin: 150,  lfoMax: 3000, plockMode: 'audioParam' },
    { path: 'resonance',    label: 'Resonance',type: 'number', min: 0.3,  max: 10,   default: 1.2,  modulatable: true, lfoMin: 0.3,  lfoMax: 10,   plockMode: 'audioParam' },
    { path: 'bow',          label: 'Bow',      type: 'number', min: 0,    max: 1,    default: 0.15, modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
    { path: 'vibrato',      label: 'Vibrato',  type: 'number', min: 0,    max: 50,   default: 6,    modulatable: true, lfoMin: 0,    lfoMax: 50,   plockMode: 'audioParam' },
    { path: 'vibrato.rate', label: 'Vib Rate', type: 'number', min: 0.5,  max: 12,   default: 5.0,  modulatable: true, lfoMin: 0.5,  lfoMax: 12,   plockMode: 'audioParam' },
    { path: 'vibrato.syncMode',   label: 'Vib Sync', type: 'enum',   options: ['hz','bpm'],                                            hidden: true, plockMode: 'js' },
    { path: 'vibrato.bpmCount32', label: 'Vib Div',  type: 'number', min: 1, max: 128, default: 8,                                     hidden: true, plockMode: 'js' },
    { path: 'output.level', label: 'Level',    type: 'number', min: 0,    max: 1,    default: 0.7,  modulatable: true, lfoMin: 0,    lfoMax: 1,    plockMode: 'audioParam' },
  ],
  moogish: [
    { path: 'osc1.waveform', label: 'O1 Wave',   type: 'enum',   options: ['saw','square','triangle','pulse','sine'], plockMode: 'js' },
    { path: 'osc1.octave',   label: 'O1 Oct',    type: 'number', min: -2,  max: 2,   default: 0,    plockMode: 'js' },
    { path: 'osc1.detune',   label: 'O1 Detune', type: 'number', min: -50, max: 50,  default: -6,   modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam' },
    { path: 'osc1.level',    label: 'O1 Level',  type: 'number', min: 0,   max: 1,   default: 0.45, modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
    { path: 'osc2.waveform', label: 'O2 Wave',   type: 'enum',   options: ['saw','square','triangle','pulse','sine'], plockMode: 'js' },
    { path: 'osc2.octave',   label: 'O2 Oct',    type: 'number', min: -2,  max: 2,   default: 0,    plockMode: 'js' },
    { path: 'osc2.detune',   label: 'O2 Detune', type: 'number', min: -50, max: 50,  default: 7,    modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam' },
    { path: 'osc2.level',    label: 'O2 Level',  type: 'number', min: 0,   max: 1,   default: 0.45, modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
    { path: 'osc3.waveform', label: 'O3 Wave',   type: 'enum',   options: ['saw','square','triangle','pulse','sine'], plockMode: 'js' },
    { path: 'osc3.octave',   label: 'O3 Oct',    type: 'number', min: -2,  max: 2,   default: -1,   plockMode: 'js' },
    { path: 'osc3.detune',   label: 'O3 Detune', type: 'number', min: -50, max: 50,  default: 2,    modulatable: true, lfoMin: -50, lfoMax: 50, plockMode: 'audioParam' },
    { path: 'osc3.level',    label: 'O3 Level',  type: 'number', min: 0,   max: 1,   default: 0.0,  modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
    { path: 'sub.level',     label: 'Sub',       type: 'number', min: 0,   max: 1,   default: 0.0,  modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
    { path: 'noise.level',   label: 'Noise',     type: 'number', min: 0,   max: 1,   default: 0.0,  modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
    { path: 'drift',         label: 'Drift',     type: 'number', min: 0,   max: 1,   default: 0.5,  plockMode: 'js' },
    { path: 'hum',           label: 'Hum',       type: 'number', min: 0,   max: 1,   default: 0.0,  modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'js' },
    { path: 'humFreq',       label: 'Hum Hz',    type: 'enum',   options: [50, 60], plockMode: 'js' },
    { path: 'osc.detune',    label: 'Detune',    type: 'number', min: -100, max: 100, default: 0,   modulatable: true, lfoMin: -100, lfoMax: 100, plockMode: 'audioParam', hidden: true },
    { path: 'output.level',  label: 'Level',     type: 'number', min: 0,   max: 1,   default: 0.8,  modulatable: true, lfoMin: 0,   lfoMax: 1,  plockMode: 'audioParam' },
  ],
  sampler: [
    { path: 'sample.start',     label: 'Start',    type: 'number',  min: 0,   max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
    { path: 'sample.end',       label: 'End',      type: 'number',  min: 0,   max: 1,   default: 1,    modulatable: false, plockMode: 'js' },
    { path: 'sample.loopStart', label: 'Loop Strt',type: 'number',  min: 0,   max: 1,   default: 0,    modulatable: false, plockMode: 'js' },
    { path: 'sample.speed',   label: 'Speed',   type: 'number',  min: 0.125, max: 4, default: 1,    modulatable: false, plockMode: 'js' },
    { path: 'sample.gain',    label: 'Gain',    type: 'number',  min: 0,   max: 20,  default: 1,    modulatable: false, plockMode: 'js' },
    { path: 'sample.root',    label: 'Root',    type: 'number',  min: 0,   max: 127, default: 60,   modulatable: false, plockMode: 'js' },
    { path: 'sample.reverse', label: 'Reverse', type: 'boolean', default: false,                    plockMode: 'js' },
    { path: 'sample.loop',    label: 'Loop',    type: 'boolean', default: false,                    plockMode: 'js' },
    { path: 'sample.pitch',   label: 'Pitch',   type: 'boolean', default: true,                     plockMode: 'js' },
    { path: 'output.level',   label: 'Level',   type: 'number',  min: 0,   max: 1,   default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
  ],
};

// Paths that must resolve to a real AudioParam (incl. manualTarget ones).
const RESOLVES = {
  synth: ['osc.detune', 'sub.level', 'output.level'],
  snare: ['tune', 'tone', 'snap', 'noise.cutoff', 'output.level'],
  'snare.analogue': ['tune', 'tone', 'snap', 'noise.cutoff', 'output.level'],
  chord: ['osc.detune', 'output.level'],
  'kick.silk': ['tune', 'output.level'],
  'kick.hard': ['tune', 'output.level'],
  'kick.analogue': ['tune', 'output.level'],
  hihat: ['cutoff', 'tone', 'output.level'],
  'hihat.analogue': ['cutoff', 'tone', 'output.level'],
  clapp: ['tone', 'snap', 'output.level'],
  'clapp.analogue': ['tone', 'snap', 'output.level'],
  cymbal: ['tune', 'tone', 'body', 'resonance', 'output.level'],
  'cymbal.analogue': ['tune', 'tone', 'body', 'resonance', 'output.level'],
  'tom.analogue': ['tune', 'output.level'],
  noise: ['color.freq', 'body.freq', 'body.level', 'output.level'],
  karplus: ['output.level'],
  comb: ['output.level'],
  marimba: ['p2ratio', 'p3ratio', 'mallet.tone', 'output.level'],
  transient: ['click.freq', 'noise.click', 'output.level'],
  wood: ['freq1', 'freq2', 'ring', 'click.freq', 'output.level'],
  bass: ['osc.detune', 'sub.level', 'output.level'],
  swarm: ['osc.detune', 'height', 'output.level'],
  strings: ['osc.detune', 'tone', 'body', 'resonance', 'bow', 'vibrato', 'vibrato.rate', 'output.level'],
  moogish: ['osc1.detune', 'osc1.level', 'osc2.detune', 'osc2.level', 'osc3.detune', 'osc3.level',
            'sub.level', 'noise.level', 'osc.detune', 'output.level'],
  sampler: ['output.level'],
};

suite('Param spec (declarative machines)', () => {

  for (const type of [
    'synth', 'snare', 'snare.analogue', 'chord',
    'kick.silk', 'kick.hard', 'kick.analogue', 'hihat', 'hihat.analogue',
    'clapp', 'clapp.analogue', 'cymbal', 'cymbal.analogue', 'tom.analogue',
    'noise', 'karplus', 'comb', 'marimba', 'transient', 'wood',
    'bass', 'swarm', 'strings', 'moogish', 'sampler',
  ]) {

    test(`${type}: getParamList matches original descriptors`, async () => {
      const { track } = await makeOfflineTrack(type, 0.1);
      const actual = track.machine.getParamList();
      assert.ok(paramListEqual(actual, EXPECTED[type]),
        `${type} getParamList drifted from original:\n` +
        `actual=${JSON.stringify(actual)}`);
    });

    test(`${type}: resolveAudioParam returns AudioParams for the right paths`, async () => {
      const { track } = await makeOfflineTrack(type, 0.1);
      const m = track.machine;
      const all = m.getParamList().map(d => d.path);
      for (const p of all) {
        const ap = m.resolveAudioParam(p);
        const shouldResolve = RESOLVES[type].includes(p);
        if (shouldResolve) {
          assert.ok(ap && typeof ap.setValueAtTime === 'function',
            `${type}.${p} should resolve to an AudioParam`);
        } else {
          assert.ok(ap == null, `${type}.${p} should resolve to null, got ${ap}`);
        }
      }
    });

    test(`${type}: toJSON/fromJSON round-trips all params`, async () => {
      const { track } = await makeOfflineTrack(type, 0.1);
      const m = track.machine;

      // Mutate EVERY param to a non-default value (per type) so the round-trip
      // exercises all of them, not just the first — otherwise a param that
      // silently fails to serialise/restore would still pass.
      for (const d of m.getParamList()) {
        if (d.type === 'number')  m.setParam(d.path, (d.min + d.max) / 2);
        else if (d.type === 'boolean') m.setParam(d.path, !m.getParam(d.path));
        else if (d.type === 'enum')    m.setParam(d.path, d.options[d.options.length - 1]);
      }

      const json = m.toJSON();
      assert.ok(json.type === type, `toJSON type should be '${type}'`);
      assert.ok(json.params && typeof json.params === 'object', 'toJSON must carry params');

      const { track: t2 } = await makeOfflineTrack(type, 0.1);
      t2.machine.fromJSON(json);
      for (const d of m.getParamList()) {
        assert.ok(t2.machine.getParam(d.path) === m.getParam(d.path),
          `${type}.${d.path} did not round-trip (${t2.machine.getParam(d.path)} !== ${m.getParam(d.path)})`);
      }
    });
  }

  // Sampler keeps an overridden toJSON/fromJSON (it carries sampleId/sampleName
  // alongside params, rather than the base's {type, params}). The generic loop
  // above only checks params; this guards the custom fields the override exists
  // for — the exact thing that makes Sampler non-generic.
  test('sampler: toJSON/fromJSON round-trips sampleId/sampleName', async () => {
    const { track } = await makeOfflineTrack('sampler', 0.1);
    const m = track.machine;
    m.sampleId   = 'sample-abc-123';
    m.sampleName = 'kick.wav';

    const json = m.toJSON();
    assert.ok(json.sampleId === 'sample-abc-123', 'toJSON must carry sampleId');
    assert.ok(json.sampleName === 'kick.wav',     'toJSON must carry sampleName');

    const { track: t2 } = await makeOfflineTrack('sampler', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.sampleId === 'sample-abc-123',
      `sampleId did not round-trip (${t2.machine.sampleId})`);
    assert.ok(t2.machine.sampleName === 'kick.wav',
      `sampleName did not round-trip (${t2.machine.sampleName})`);
  });
});
