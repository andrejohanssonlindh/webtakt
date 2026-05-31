/**
 * formatParam.js
 * --------------
 * Shared parameter value formatter used by SynthPanel and every tab/machine
 * panel. Given a param descriptor `p` (from getParamList()) and a numeric
 * value `v`, returns a human-readable display string (units, %, note names…).
 *
 * Path-keyed: each machine/filter/FX param path has its own formatting rule.
 * Falls back to a generic %/decimal format for unknown paths.
 *
 * Extracted verbatim from SynthPanel._fmtParam so panels can format values
 * without depending on SynthPanel. Pass it around via the panel context as
 * `ctx.fmtParam`.
 *
 * @param {{ path: string, max?: number }} p — param descriptor
 * @param {number} v — current value
 * @returns {string}
 */
export function formatParam(p, v) {
  if (p.path === 'filter.cutoff')    return Math.round(v) + 'Hz';
  if (p.path === 'filter.resonance') return v.toFixed(1);
  if (p.path === 'filter.gain')      return (v >= 0 ? '+' : '') + v.toFixed(1) + 'dB';
  if (p.path === 'filter.envAmount') return (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
  if (p.path === 'delay.time')       return v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
  if (p.path === 'delay.feedback')   return Math.round(v * 100) + '%';
  if (p.path === 'delay.wet')        return Math.round(v * 100) + '%';
  if (p.path === 'crush.bits')       return Math.round(v) + ' bit';
  if (p.path === 'crush.rate')       return Math.round(v * 100) + '%';
  if (p.path === 'crush.wet')        return Math.round(v * 100) + '%';
  if (p.path === 'reverb.decay')     return v.toFixed(2) + 's';
  if (p.path === 'reverb.predelay')  return v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
  if (p.path === 'reverb.damp')      return Math.round(v) + 'Hz';
  if (p.path === 'reverb.wet')       return Math.round(v * 100) + '%';
  if (p.path === 'base.lpf')         return Math.round(v) + 'Hz';
  if (p.path === 'base.hpf')         return Math.round(v) + 'Hz';
  if (p.path === 'osc.detune')       return (v >= 0 ? '+' : '') + Math.round(v) + '¢';
  if (p.path === 'amp.pan')          return Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
  if (p.path === 'sub.level')        return Math.round(v * 100) + '%';
  if (p.path === 'output.level')     return Math.round(v * 100) + '%';
  if (p.path === 'lfo.speed' || p.path.endsWith('.speed')) return v < 0.1 ? v.toFixed(3) + 'Hz' : v.toFixed(2) + 'Hz';
  if (p.path === 'lfo.speedMult' || p.path.endsWith('.mult')) return Math.round(v) + 'x';
  if (p.path === 'lfo.depth' || p.path.endsWith('.depth')) return Math.round(v) + '%';
  if (p.path === 'lfo.startPhase')   return Math.round(v);
  if (p.path === 'lfo.fade')         return v === 0 ? 'off' : (v > 0 ? '+' : '') + Math.round(v) + '%';
  if (p.path.endsWith('.time'))      return (v * 1000).toFixed(0) + 'ms';
  // Drum machine params
  if (p.path === 'tune')             return Math.round(v) + 'Hz';
  if (p.path === 'decay')            return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'open.decay')       return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'sweep')            return 'x' + v.toFixed(1);
  if (p.path === 'punch')            return Math.round(v * 100) + '%';
  if (p.path === 'punch.decay')      return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'snap')             return Math.round(v * 100) + '%';
  if (p.path === 'tone')             return p.max > 1 ? Math.round(v) + 'Hz' : Math.round(v * 100) + '%';
  if (p.path === 'noise.cutoff')     return Math.round(v) + 'Hz';
  if (p.path === 'cutoff')           return Math.round(v) + 'Hz';
  // NoiseMachine
  if (p.path === 'color')            return Math.round(v * 100) + '%';
  if (p.path === 'color.freq')       return Math.round(v) + 'Hz';
  if (p.path === 'body.freq')        return Math.round(v) + 'Hz';
  if (p.path === 'body.level')       return Math.round(v * 100) + '%';
  if (p.path === 'crush')            return Math.round(v * 100) + '%';
  // TransientMachine
  if (p.path === 'pitch')            return v === 0 ? 'NOTE' : Math.round(v) + 'Hz';
  if (p.path === 'pitch.end')        return Math.round(v * 100) + '%';
  if (p.path === 'body.decay')       return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'click.freq')       return Math.round(v) + 'Hz';
  if (p.path === 'click.decay')      return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'noise.click')      return Math.round(v * 100) + '%';
  // SwarmMachine / SampleSwarmMachine
  if (p.path === 'spread')           return Math.round(v) + '¢';
  if (p.path === 'swarm.detune')     return Math.round(v) + '¢';
  if (p.path === 'slope')            return (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
  if (p.path === 'noise.amount')     return Math.round(v) + '¢';
  if (p.path === 'noise.color')      return Math.round(v * 100) + '%';
  // CymbalMachine
  if (p.path === 'mid.decay')        return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'resonance')        return v.toFixed(1);
  // WoodMachine
  if (p.path === 'freq1')            return Math.round(v) + 'Hz';
  if (p.path === 'freq2')            return Math.round(v) + 'Hz';
  if (p.path === 'ring')             return v.toFixed(1);
  if (p.path === 'click')            return Math.round(v * 100) + '%';
  // WavetableMachine
  if (p.path === 'pos') {
    const names = ['Sine','Tri','Saw','Sqr','Pls25','BrtSaw','Hollow','Vocal'];
    const i = Math.floor(Math.min(v, names.length - 1));
    const f = v - Math.floor(v);
    if (f < 0.01) return names[i] ?? v.toFixed(2);
    const next = names[Math.min(i + 1, names.length - 1)];
    return names[i] + '→' + next;
  }
  // KarplusMachine
  if (p.path === 'damping')          return Math.round(v) + 'Hz';
  if (p.path === 'feedback' && p.max <= 1) return Math.round(v * 100) + '%';
  if (p.path === 'excite')           return Math.round(v) + 'ms';
  if (p.path === 'excite.tone')      return Math.round(v) + 'Hz';
  if (p.path === 'stretch')          return (v >= 0 ? '+' : '') + Math.round(v) + '¢';
  // MarimbaMachine
  if (p.path === 'decay1' || p.path === 'decay2' || p.path === 'decay3') return (v * 1000).toFixed(0) + 'ms';
  if (p.path === 'p2ratio' || p.path === 'p3ratio') return 'x' + v.toFixed(2);
  if (p.path === 'mallet.tone')      return Math.round(v) + 'Hz';
  // BassMachine
  if (p.path === 'glide')            return Math.round(v) + 'ms';
  if (p.path === 'accent')           return Math.round(v);
  if (p.path === 'drive')            return Math.round(v * 100) + '%';
  // CombMachine
  if (p.path === 'excite.level')     return Math.round(v * 100) + '%';
  // ChordMachine
  if (p.path === 'inversion')        return Math.round(v);
  // StringsMachine
  if (p.path === 'ensemble')         return Math.round(v) + '¢';
  if (p.path === 'bow')              return Math.round(v * 100) + '%';
  if (p.path === 'vibrato')          return Math.round(v) + '¢';
  if (p.path === 'vibrato.rate')     return v.toFixed(2) + 'Hz';
  // FMMachine
  if (p.path.endsWith('.ratio'))     return 'x' + v.toFixed(2);
  if (p.path.endsWith('.feedback'))  return Math.round(v * 100) + '%';
  if (p.path.endsWith('.detune') && p.path.startsWith('op')) return (v >= 0 ? '+' : '') + Math.round(v) + '¢';
  if (p.max !== undefined && p.max <= 1) return Math.round(v * 100) + '%';
  return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v);
}
