/**
 * SoundLibrary.js
 * ---------------
 * Manages a persistent library of saved sounds (machine + signal chain snapshots).
 * Each sound captures: name, tags, machine, filter, envelope, FX chain, LFOs, pan, trigTone.
 * Stored in localStorage under 'webtakt_sounds'.
 *
 * Does NOT capture sequencer data (steps, step count, page offset).
 */

const STORAGE_KEY = 'webtakt_sounds';

const _defFilter = () => ({ params: { 'filter.type': 'lowpass', 'filter.cutoff': 8000, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0.3, 'base.lpf': 20000, 'base.hpf': 20 } });
const _defEnv    = () => ({ params: { 'env.attack': 0.01, 'env.decay': 0.1, 'env.sustain': 0.7, 'env.release': 0.3, 'fenv.attack': 0.01, 'fenv.decay': 0.2, 'fenv.sustain': 0.0, 'fenv.release': 0.3 } });
const _defDelay  = () => ({ params: { 'delay.time': 0.25, 'delay.feedback': 0.3, 'delay.wet': 0 }, enabled: false });
const _defCrush  = () => ({ params: { 'crush.bits': 16, 'crush.rate': 1.0, 'crush.wet': 0 }, enabled: false });
const _defReverb = () => ({ params: { 'reverb.decay': 1.5, 'reverb.predelay': 0.02, 'reverb.damp': 8000, 'reverb.wet': 0 }, enabled: false });
const _defChorus = () => ({ params: { 'chorus.mix': 0, 'chorus.rate': 0.55, 'chorus.depth': 0.5 }, enabled: false });
const _noFX      = () => ({ delayFX: _defDelay(), bitcrushFX: _defCrush(), reverbFX: _defReverb() });

export class SoundLibrary {
  constructor() {
    this._sounds = this._load();
    this._seed();
  }

  /** @returns {Sound[]} */
  get sounds() { return this._sounds; }

  /** All unique tags across all saved sounds. */
  allTags() {
    const set = new Set();
    this._sounds.forEach(s => s.tags.forEach(t => set.add(t)));
    return [...set].sort();
  }

  /**
   * Save current track state as a named sound.
   * @param {string} name
   * @param {string[]} tags
   * @param {import('./Track.js').Track} track
   * @returns {Sound} the saved sound
   */
  save(name, tags, track) {
    const json = track.toJSON();
    const sound = {
      id:          Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name:        name.trim() || 'Untitled',
      tags:        tags.map(t => t.trim()).filter(Boolean),
      createdAt:   Date.now(),
      // Capture voice + signal chain — NOT sequencer
      machine:     json.machine,
      filter:      json.filter,
      envelope:    json.envelope,
      delayFX:     json.delayFX,
      bitcrushFX:  json.bitcrushFX,
      chorusFX:    json.chorusFX,
      reverbFX:    json.reverbFX,
      analogue:    json.analogue,
      lfos:        json.lfos,
      pan:         json.pan,
      trigTone:    json.trigTone,
    };
    this._sounds.unshift(sound);
    this._persist();
    return sound;
  }

  /**
   * Load a sound onto a track. Restores machine + signal chain, leaves sequencer intact.
   * @param {string} id
   * @param {import('./Track.js').Track} track
   */
  load(id, track) {
    const sound = this._sounds.find(s => s.id === id);
    if (!sound) return;

    if (sound.machine?.type) track.setMachine(sound.machine.type);
    track.loadedSoundName = sound.name;
    track.machine.fromJSON(sound.machine ?? {});
    track.filter.fromJSON(sound.filter ?? {});
    track.envelope.fromJSON(sound.envelope ?? {});
    track.delayFX.fromJSON(sound.delayFX ?? {});
    track.bitcrushFX.fromJSON(sound.bitcrushFX ?? {});
    track.chorusFX.fromJSON(sound.chorusFX ?? {});
    track.reverbFX.fromJSON(sound.reverbFX ?? {});
    // Analogue flow: derive from the saved flag, or fall back to the restored
    // filter engine for sounds saved before the flag existed. setAnalogue keeps
    // the chorus enable + filter engine consistent.
    track.setAnalogue(sound.analogue ?? (track.filter.getParam('filter.engine') === 'analogue'));
    // Restore sampler buffer via SampleStore if present on the track
    if (track.machine.type === 'sampler' && track.machine.sampleId && track.sampleStore) {
      track.sampleStore.load(track.machine.sampleId, track.audio.context).then(buf => {
        if (buf) track.machine.setBuffer(buf, track.machine.sampleId, track.machine.sampleName);
      });
    }
    if (track.machine.type === 'wt-sampler' && track.sampleStore) {
      if (track.machine.sampleIdA) {
        track.sampleStore.load(track.machine.sampleIdA, track.audio.context).then(buf => {
          if (buf) track.machine.setBufferA(buf, track.machine.sampleIdA, track.machine.sampleNameA);
        });
      }
      if (track.machine.sampleIdB) {
        track.sampleStore.load(track.machine.sampleIdB, track.audio.context).then(buf => {
          if (buf) track.machine.setBufferB(buf, track.machine.sampleIdB, track.machine.sampleNameB);
        });
      }
    }

    // Restore pan
    track.pannerNode.pan.setTargetAtTime(sound.pan ?? 0, track.audio.context.currentTime, 0.005);
    track.trigTone = sound.trigTone ?? 0;

    // Restore LFOs
    track.lfos.forEach(l => l.stop());
    track.lfos = [];
    track._lfoDestPaths = [];
    (sound.lfos ?? []).forEach(lfoObj => {
      const lfo = track.addLFO();
      lfo.fromJSON(lfoObj);
      if (lfoObj.destPath) track.setLFODestination(track.lfos.length - 1, lfoObj.destPath);
    });
  }

  /** @param {string} id */
  delete(id) {
    this._sounds = this._sounds.filter(s => s.id !== id);
    this._persist();
  }

  /** Rename a sound in place. */
  rename(id, newName) {
    const s = this._sounds.find(s => s.id === id);
    if (s) { s.name = newName.trim() || s.name; this._persist(); }
  }

  /** Update tags for a sound. */
  setTags(id, tags) {
    const s = this._sounds.find(s => s.id === id);
    if (s) { s.tags = tags.map(t => t.trim()).filter(Boolean); this._persist(); }
  }

  _persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._sounds)); } catch {}
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
  }

  _seed() {
    const mk = (name, tags, machine, filter, envelope, fx, opts = {}) => ({
      id:         'seed_' + name.replace(/\s+/g, '_').toLowerCase(),
      name,
      tags:       ['AI', ...tags],
      createdAt:  Date.now(),
      machine,
      filter:     filter  ?? _defFilter(),
      envelope:   envelope ?? _defEnv(),
      ...fx,
      analogue:   opts.analogue ?? false,
      lfos:       [{ params: { 'lfo.waveform': 'sine', 'lfo.speed': 0.1, 'lfo.speedMult': 1, 'lfo.depth': 30 }, destPath: '' }],
      pan:        0,
      trigTone:   0,
    });

    // ── Patina preset → Webtakt mapping helpers (analogue Moogish seeds) ──
    // Patina's resonance is the ladder value 0–1.15; Webtakt stores the biquad Q
    // knob (0.1–20) and maps it to the ladder linearly (_resToLadder). Invert it
    // here so a ported preset hits the same ladder resonance.
    const ladderResToQ = r => 0.1 + (Math.min(Math.max(r, 0), 1.15) / 1.15) * (20 - 0.1);
    // Patina filter-env `amount` is Hz added on top of cutoff (peak = cutoff +
    // amount). Webtakt's envAmount is a 0–1 fraction of the remaining headroom up
    // to 20 kHz. Convert so the peak cutoff matches.
    const envAmtFromHz = (amountHz, cutoff) =>
      amountHz <= 0 ? 0 : Math.min(1, amountHz / Math.max(1, 20000 - cutoff));
    // Build the four FX blocks from a Patina `fx` object. Chorus/reverb are the
    // analogue-flow effects; delay/crush stay off (Patina has neither).
    const patinaFX = (fx = {}) => {
      const ch = fx.chorus ?? {};
      const rv = fx.reverb ?? {};
      const chMix = ch.mix ?? 0;
      const rvMix = rv.mix ?? 0;
      return {
        delayFX:    _defDelay(),
        bitcrushFX: _defCrush(),
        chorusFX: {
          params: { 'chorus.mix': chMix, 'chorus.rate': ch.rate ?? 0.55, 'chorus.depth': ch.depth ?? 0.5 },
          enabled: chMix > 0,
        },
        reverbFX: {
          // Patina `size` (s of tail) ≈ decay; `tone` 0–1 (darker→brighter) → damp Hz.
          params: {
            'reverb.decay':    rv.size ?? 1.5,
            'reverb.predelay': 0.02,
            'reverb.damp':     2000 + (rv.tone ?? 0.4) * 14000,
            'reverb.wet':      rvMix,
          },
          enabled: rvMix > 0,
        },
      };
    };
    // Map up to three Patina oscillators (+ sub/noise) onto a Moogish machine.
    // Patina osc types are already Moogish waveform names (saw/square/triangle/
    // sine/pulse). Missing oscs are silenced (level 0).
    const moogMachine = (oscs, sub = {}, noiseLevel = 0, character = {}) => {
      const o = i => oscs[i] ?? { type: 'saw', octave: 0, detune: 0, level: 0 };
      const p = {};
      for (let i = 0; i < 3; i++) {
        const osc = o(i);
        p[`osc${i + 1}.waveform`] = osc.type ?? 'saw';
        p[`osc${i + 1}.octave`]   = osc.octave ?? 0;
        p[`osc${i + 1}.detune`]   = osc.detune ?? 0;
        p[`osc${i + 1}.level`]    = i < oscs.length ? (osc.level ?? 0.45) : 0;
      }
      p['sub.level']   = sub.level ?? 0;
      p['noise.level'] = noiseLevel;
      p['drift']       = character.drift ?? 0.5;
      p['hum']         = character.hum ?? 0.15;
      p['humFreq']     = character.humFreq ?? 50;
      p['output.level'] = 0.8;
      return { type: 'moogish', params: p };
    };
    // Build a full analogue Moogish seed straight from a Patina preset object.
    const patina = (name, tags, P) => {
      const f  = P.filter ?? {};
      const e  = P.envelope ?? {};
      const fe = P.filterEnvelope ?? {};
      const cutoff = f.cutoff ?? 1400;
      const machine = moogMachine(P.oscillators ?? [], P.sub, (P.character ?? {}).noiseFloor ?? 0, P.character ?? {});
      const filter = { params: {
        'filter.engine':    'analogue',
        'filter.type':      'lowpass',
        'filter.cutoff':    cutoff,
        'filter.resonance': ladderResToQ(f.resonance ?? 0.25),
        'filter.gain':      0,
        'filter.envAmount': envAmtFromHz(fe.amount ?? 0, cutoff),
        'filter.drive':     f.drive ?? 1.6,
        'filter.drift':     0.01,
        'filter.keytrack':  f.keytrack ?? 0.4,
        'base.lpf':         20000,
        'base.hpf':         20,
      } };
      const envelope = { params: {
        'env.attack':   e.attack  ?? 0.01,
        'env.decay':    e.decay   ?? 0.25,
        'env.sustain':  e.sustain ?? 0.7,
        'env.release':  e.release ?? 0.35,
        'fenv.attack':  fe.attack  ?? 0.01,
        'fenv.decay':   fe.decay   ?? 0.3,
        'fenv.sustain': fe.sustain ?? 0.25,
        'fenv.release': fe.release ?? 0.3,
        'env.velSens':  P.velocitySensitivity ?? 0.6,
      } };
      return mk(name, ['patina', 'analogue', ...tags], machine, filter, envelope,
                patinaFX(P.fx), { analogue: true });
    };

    const seeds = [

      // ── 1. Dark Sub Bass (Synth) ───────────────────────────
      mk('Dark Sub Bass', ['bass', 'dark', 'mono'],
        { type: 'synth', params: { 'osc.waveform': 'sawtooth', 'osc.detune': 0, 'sub.level': 0.85, 'sub.waveform': 'sine', 'output.level': 0.9 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 420, 'filter.resonance': 2.2, 'filter.gain': 0, 'filter.envAmount': 0.18, 'base.lpf': 20000, 'base.hpf': 28 } },
        { params: { 'env.attack': 0.02, 'env.decay': 0.25, 'env.sustain': 0.85, 'env.release': 0.4, 'fenv.attack': 0.01, 'fenv.decay': 0.18, 'fenv.sustain': 0.0, 'fenv.release': 0.2 } },
        _noFX()),

      // ── 2. Acid Lead (Synth) ──────────────────────────────
      mk('Acid Lead', ['lead', 'acid', 'bright'],
        { type: 'synth', params: { 'osc.waveform': 'sawtooth', 'osc.detune': 0, 'sub.level': 0.1, 'sub.waveform': 'square', 'output.level': 0.8 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 700, 'filter.resonance': 14, 'filter.gain': 0, 'filter.envAmount': 0.7, 'base.lpf': 20000, 'base.hpf': 40 } },
        { params: { 'env.attack': 0.005, 'env.decay': 0.15, 'env.sustain': 0.5, 'env.release': 0.18, 'fenv.attack': 0.001, 'fenv.decay': 0.12, 'fenv.sustain': 0.0, 'fenv.release': 0.1 } },
        _noFX()),

      // ── 3. Pad Wide (Synth) ───────────────────────────────
      mk('Pad Wide', ['pad', 'ambient', 'lush'],
        { type: 'synth', params: { 'osc.waveform': 'sawtooth', 'osc.detune': 14, 'sub.level': 0.4, 'sub.waveform': 'sine', 'output.level': 0.75 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 2800, 'filter.resonance': 1.2, 'filter.gain': 0, 'filter.envAmount': 0.08, 'base.lpf': 20000, 'base.hpf': 60 } },
        { params: { 'env.attack': 0.55, 'env.decay': 0.3, 'env.sustain': 0.9, 'env.release': 1.6, 'fenv.attack': 0.4, 'fenv.decay': 0.5, 'fenv.sustain': 0.0, 'fenv.release': 0.8 } },
        { delayFX: { params: { 'delay.time': 0.375, 'delay.feedback': 0.45, 'delay.wet': 0.35 }, enabled: true }, bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 3.5, 'reverb.predelay': 0.02, 'reverb.damp': 8000, 'reverb.wet': 0.4 }, enabled: true } }),

      // ── 4. Pluck (Synth) ─────────────────────────────────
      mk('Pluck', ['pluck', 'bright', 'percussive'],
        { type: 'synth', params: { 'osc.waveform': 'triangle', 'osc.detune': 0, 'sub.level': 0.15, 'sub.waveform': 'sine', 'output.level': 0.85 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 3500, 'filter.resonance': 1.8, 'filter.gain': 0, 'filter.envAmount': 0.6, 'base.lpf': 18000, 'base.hpf': 30 } },
        { params: { 'env.attack': 0.001, 'env.decay': 0.28, 'env.sustain': 0.0, 'env.release': 0.35, 'fenv.attack': 0.001, 'fenv.decay': 0.2, 'fenv.sustain': 0.0, 'fenv.release': 0.15 } },
        { delayFX: { params: { 'delay.time': 0.25, 'delay.feedback': 0.3, 'delay.wet': 0.22 }, enabled: true }, bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 1.2, 'reverb.predelay': 0.01, 'reverb.damp': 12000, 'reverb.wet': 0.18 }, enabled: true } }),

      // ── 5. Warm Keys (Synth) ──────────────────────────────
      mk('Warm Keys', ['keys', 'warm', 'melodic'],
        { type: 'synth', params: { 'osc.waveform': 'square', 'osc.detune': 0, 'sub.level': 0.3, 'sub.waveform': 'sine', 'output.level': 0.78 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 1800, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0.3, 'base.lpf': 20000, 'base.hpf': 20 } },
        { params: { 'env.attack': 0.008, 'env.decay': 0.35, 'env.sustain': 0.55, 'env.release': 0.6, 'fenv.attack': 0.005, 'fenv.decay': 0.3, 'fenv.sustain': 0.0, 'fenv.release': 0.4 } },
        _noFX()),

      // ── 6. Bell FM (FM) ───────────────────────────────────
      mk('Bell FM', ['fm', 'bell', 'melodic', 'bright'],
        { type: 'fm', params: {
            'op1.ratio': 1.0,   'op1.level': 0.9,  'op1.detune': 0,   'op1.env.a': 0.001, 'op1.env.d': 0.8,  'op1.env.s': 0.0,  'op1.env.r': 1.2,
            'op2.ratio': 3.5,   'op2.level': 0.55, 'op2.feedback': 0.0, 'op2.detune': 0, 'op2.env.a': 0.001, 'op2.env.d': 0.3,  'op2.env.s': 0.0,  'op2.env.r': 0.4,
            'op3.ratio': 7.0,   'op3.level': 0.22, 'op3.detune': 0,   'op3.env.a': 0.001, 'op3.env.d': 0.12, 'op3.env.s': 0.0,  'op3.env.r': 0.1,
            'op4.ratio': 14.0,  'op4.level': 0.08, 'op4.detune': 0,   'op4.env.a': 0.001, 'op4.env.d': 0.06, 'op4.env.s': 0.0,  'op4.env.r': 0.05,
            'output.level': 0.8 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 12000, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0, 'base.lpf': 20000, 'base.hpf': 20 } },
        { params: { 'env.attack': 0.001, 'env.decay': 1.2, 'env.sustain': 0.0, 'env.release': 1.5, 'fenv.attack': 0.001, 'fenv.decay': 0.2, 'fenv.sustain': 0.0, 'fenv.release': 0.3 } },
        { delayFX: _defDelay(), bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 2.0, 'reverb.predelay': 0.01, 'reverb.damp': 14000, 'reverb.wet': 0.3 }, enabled: true } }),

      // ── 7. FM Bass (FM) ───────────────────────────────────
      mk('FM Bass', ['fm', 'bass', 'punchy'],
        { type: 'fm', params: {
            'op1.ratio': 1.0,  'op1.level': 1.0,  'op1.detune': 0,   'op1.env.a': 0.001, 'op1.env.d': 0.4, 'op1.env.s': 0.6, 'op1.env.r': 0.2,
            'op2.ratio': 1.0,  'op2.level': 0.8,  'op2.feedback': 0.25, 'op2.detune': 0, 'op2.env.a': 0.001, 'op2.env.d': 0.08, 'op2.env.s': 0.0, 'op2.env.r': 0.05,
            'op3.ratio': 2.0,  'op3.level': 0.3,  'op3.detune': 0,   'op3.env.a': 0.001, 'op3.env.d': 0.05, 'op3.env.s': 0.0, 'op3.env.r': 0.05,
            'op4.ratio': 3.0,  'op4.level': 0.12, 'op4.detune': 0,   'op4.env.a': 0.001, 'op4.env.d': 0.04, 'op4.env.s': 0.0, 'op4.env.r': 0.04,
            'output.level': 0.85 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 900, 'filter.resonance': 2.0, 'filter.gain': 0, 'filter.envAmount': 0.35, 'base.lpf': 20000, 'base.hpf': 35 } },
        { params: { 'env.attack': 0.002, 'env.decay': 0.35, 'env.sustain': 0.65, 'env.release': 0.25, 'fenv.attack': 0.001, 'fenv.decay': 0.18, 'fenv.sustain': 0.0, 'fenv.release': 0.1 } },
        _noFX()),

      // ── 8. Kalimba FM (FM) ────────────────────────────────
      mk('Kalimba FM', ['fm', 'melodic', 'percussive', 'world'],
        { type: 'fm', params: {
            'op1.ratio': 1.0,  'op1.level': 0.85, 'op1.detune': 0,    'op1.env.a': 0.001, 'op1.env.d': 0.7,  'op1.env.s': 0.0,  'op1.env.r': 0.9,
            'op2.ratio': 2.756,'op2.level': 0.4,  'op2.feedback': 0.0,'op2.detune': 8,    'op2.env.a': 0.001, 'op2.env.d': 0.25, 'op2.env.s': 0.0,  'op2.env.r': 0.2,
            'op3.ratio': 5.0,  'op3.level': 0.12, 'op3.detune': -5,   'op3.env.a': 0.001, 'op3.env.d': 0.1,  'op3.env.s': 0.0,  'op3.env.r': 0.1,
            'op4.ratio': 8.0,  'op4.level': 0.05, 'op4.detune': 0,    'op4.env.a': 0.001, 'op4.env.d': 0.06, 'op4.env.s': 0.0,  'op4.env.r': 0.05,
            'output.level': 0.8 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 10000, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0, 'base.lpf': 20000, 'base.hpf': 20 } },
        { params: { 'env.attack': 0.001, 'env.decay': 0.9, 'env.sustain': 0.0, 'env.release': 1.0, 'fenv.attack': 0.001, 'fenv.decay': 0.2, 'fenv.sustain': 0.0, 'fenv.release': 0.3 } },
        { delayFX: _defDelay(), bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 1.8, 'reverb.predelay': 0.01, 'reverb.damp': 16000, 'reverb.wet': 0.25 }, enabled: true } }),

      // ── 9. Marble Machine (FM) ───────────────────────────
      mk('Marble Machine', ['fm', 'melodic', 'percussive', 'metallic'],
        { type: 'fm', params: {
            'op1.ratio': 1.0,   'op1.level': 0.9,  'op1.detune': 0,    'op1.env.a': 0.001, 'op1.env.d': 0.55, 'op1.env.s': 0.0, 'op1.env.r': 0.8,
            'op2.ratio': 3.502, 'op2.level': 0.62, 'op2.feedback': 0.05, 'op2.detune': 12, 'op2.env.a': 0.001, 'op2.env.d': 0.18, 'op2.env.s': 0.0, 'op2.env.r': 0.12,
            'op3.ratio': 8.1,   'op3.level': 0.22, 'op3.detune': -7,   'op3.env.a': 0.001, 'op3.env.d': 0.09, 'op3.env.s': 0.0, 'op3.env.r': 0.06,
            'op4.ratio': 14.3,  'op4.level': 0.08, 'op4.detune': 5,    'op4.env.a': 0.001, 'op4.env.d': 0.04, 'op4.env.s': 0.0, 'op4.env.r': 0.03,
            'output.level': 0.82 } },
        { params: { 'filter.type': 'lowpass', 'filter.cutoff': 14000, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0, 'base.lpf': 20000, 'base.hpf': 30 } },
        { params: { 'env.attack': 0.001, 'env.decay': 0.6, 'env.sustain': 0.0, 'env.release': 0.9, 'fenv.attack': 0.001, 'fenv.decay': 0.15, 'fenv.sustain': 0.0, 'fenv.release': 0.2 } },
        { delayFX: _defDelay(), bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 1.4, 'reverb.predelay': 0.01, 'reverb.damp': 15000, 'reverb.wet': 0.22 }, enabled: true } }),

      // ── 10. Silk Kick (KickSilk) ──────────────────────────
      mk('Silk Kick', ['kick', 'drum', 'round'],
        { type: 'kick.silk', params: { 'tune': 55, 'decay': 0.5, 'sweep': 5.5, 'punch': 0.8, 'punch.decay': 0.022, 'output.level': 0.95 } },
        _defFilter(),
        _defEnv(),
        _noFX()),

      // ── 11. Room Snare (Snare) ────────────────────────────
      mk('Room Snare', ['snare', 'drum', 'punchy'],
        { type: 'snare', params: { 'tune': 220, 'decay': 0.22, 'snap': 0.9, 'tone': 0.45, 'noise.cutoff': 2400, 'output.level': 0.88 } },
        { params: { 'filter.type': 'highpass', 'filter.cutoff': 120, 'filter.resonance': 1.0, 'filter.gain': 0, 'filter.envAmount': 0, 'base.lpf': 20000, 'base.hpf': 80 } },
        _defEnv(),
        { delayFX: _defDelay(), bitcrushFX: _defCrush(), reverbFX: { params: { 'reverb.decay': 0.8, 'reverb.predelay': 0.005, 'reverb.damp': 6000, 'reverb.wet': 0.28 }, enabled: true } }),

      // ── PATINA presets — analogue Moogish ports (A/B vs the originals) ──
      // Faithful transcriptions of js/patina/patina.js PRESETS, mapped onto the
      // MoogishMachine + analogue Filter/Envelope/Chorus flow via patina().

      patina('Patina Init', ['init'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -6, level: 0.5 },
          { type: 'saw', octave: 0, detune: +7, level: 0.5 },
        ],
        filter: { cutoff: 1400, resonance: 0.25, drive: 1.6, keytrack: 0.4 },
        envelope:       { attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.35 },
        filterEnvelope: { attack: 0.01, decay: 0.30, sustain: 0.25, release: 0.30, amount: 2200 },
        character: { drift: 0.5, noiseFloor: 0.35, hum: 0.15, humFreq: 50 },
      }),

      patina('Patina Warm Pad', ['pad', 'lush'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -9, level: 0.42 },
          { type: 'saw', octave: 0, detune: +8, level: 0.42 },
          { type: 'triangle', octave: -1, detune: 2, level: 0.35 },
        ],
        filter: { cutoff: 900, resonance: 0.18, drive: 1.8, keytrack: 0.3 },
        envelope: { attack: 0.9, decay: 1.2, sustain: 0.8, release: 1.8 },
        filterEnvelope: { attack: 1.4, decay: 1.6, sustain: 0.5, release: 1.6, amount: 1100 },
        character: { drift: 0.7, noiseFloor: 0.45, hum: 0.2 },
        fx: { chorus: { mix: 0.55, rate: 0.5, depth: 0.6 }, reverb: { mix: 0.3, size: 3.2, tone: 0.35 } },
      }),

      patina('Patina Fat Bass', ['bass', 'mono'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -4, level: 0.55 },
          { type: 'square', octave: 0, detune: 5, level: 0.4 },
        ],
        sub: { level: 0.55 },
        filter: { cutoff: 420, resonance: 0.35, drive: 3.2, keytrack: 0.5 },
        envelope: { attack: 0.004, decay: 0.3, sustain: 0.55, release: 0.12 },
        filterEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.15, release: 0.1, amount: 2600 },
        character: { drift: 0.4, noiseFloor: 0.25, hum: 0.1 },
        fx: { chorus: { mix: 0 }, reverb: { mix: 0 } },
      }),

      patina('Patina Screaming Lead', ['lead', 'mono'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -3, level: 0.55 },
          { type: 'saw', octave: 1, detune: 4, level: 0.35 },
        ],
        filter: { cutoff: 2400, resonance: 0.55, drive: 4.0, keytrack: 0.6 },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.85, release: 0.2 },
        filterEnvelope: { attack: 0.01, decay: 0.35, sustain: 0.4, release: 0.2, amount: 3200 },
        character: { drift: 0.6, noiseFloor: 0.3, hum: 0.15 },
        fx: { chorus: { mix: 0.2, rate: 0.7, depth: 0.4 }, reverb: { mix: 0.18, size: 1.8, tone: 0.5 } },
      }),

      patina('Patina String Machine', ['strings', 'lush'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -11, level: 0.4 },
          { type: 'saw', octave: 0, detune: 10, level: 0.4 },
          { type: 'saw', octave: 1, detune: -5, level: 0.22 },
        ],
        filter: { cutoff: 2600, resonance: 0.08, drive: 1.3, keytrack: 0.4 },
        envelope: { attack: 0.35, decay: 0.5, sustain: 0.85, release: 0.9 },
        filterEnvelope: { attack: 0.4, decay: 0.5, sustain: 0.6, release: 0.8, amount: 500 },
        character: { drift: 0.8, noiseFloor: 0.5, hum: 0.25 },
        fx: { chorus: { mix: 0.85, rate: 0.65, depth: 0.8 }, reverb: { mix: 0.25, size: 2.6, tone: 0.4 } },
      }),

      patina('Patina EP Keys', ['keys', 'ep'], {
        oscillators: [
          { type: 'sine', octave: 0, detune: -2, level: 0.6 },
          { type: 'triangle', octave: 1, detune: 3, level: 0.18 },
        ],
        sub: { level: 0.2 },
        filter: { cutoff: 1900, resonance: 0.12, drive: 2.2, keytrack: 0.7 },
        envelope: { attack: 0.003, decay: 1.6, sustain: 0.25, release: 0.5 },
        filterEnvelope: { attack: 0.002, decay: 0.7, sustain: 0.1, release: 0.4, amount: 1500 },
        velocitySensitivity: 0.85,
        character: { drift: 0.35, noiseFloor: 0.3, hum: 0.2 },
        fx: { chorus: { mix: 0.4, rate: 0.8, depth: 0.5 }, reverb: { mix: 0.22, size: 2.0, tone: 0.45 } },
      }),

      patina('Patina Acid 303', ['acid', 'mono'], {
        oscillators: [{ type: 'square', octave: 0, detune: 0, level: 0.7 }],
        filter: { cutoff: 320, resonance: 0.92, drive: 2.6, keytrack: 0.4 },
        envelope: { attack: 0.003, decay: 0.18, sustain: 0.0, release: 0.08 },
        filterEnvelope: { attack: 0.003, decay: 0.22, sustain: 0.0, release: 0.1, amount: 3400 },
        character: { drift: 0.45, noiseFloor: 0.2, hum: 0.1 },
        fx: { chorus: { mix: 0 }, reverb: { mix: 0.1, size: 1.2, tone: 0.5 } },
      }),

      patina('Patina Poly Brass', ['brass'], {
        oscillators: [
          { type: 'saw', octave: 0, detune: -7, level: 0.5 },
          { type: 'saw', octave: 0, detune: 6, level: 0.5 },
        ],
        filter: { cutoff: 700, resonance: 0.3, drive: 2.4, keytrack: 0.5 },
        envelope: { attack: 0.06, decay: 0.25, sustain: 0.85, release: 0.25 },
        filterEnvelope: { attack: 0.09, decay: 0.4, sustain: 0.45, release: 0.25, amount: 2800 },
        character: { drift: 0.6, noiseFloor: 0.35, hum: 0.2 },
        fx: { chorus: { mix: 0.25, rate: 0.6, depth: 0.4 }, reverb: { mix: 0.15, size: 1.8, tone: 0.5 } },
      }),

      patina('Patina Haunted Organ', ['organ', 'dark'], {
        oscillators: [
          { type: 'pulse', octave: 0, detune: -5, level: 0.4 },
          { type: 'pulse', octave: 0, detune: 6, level: 0.4 },
          { type: 'sine', octave: 1, detune: 0, level: 0.2 },
        ],
        sub: { level: 0.3 },
        filter: { cutoff: 1500, resonance: 0.2, drive: 1.8, keytrack: 0.3 },
        envelope: { attack: 0.05, decay: 0.1, sustain: 1.0, release: 0.4 },
        filterEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.4, amount: 300 },
        character: { drift: 0.9, noiseFloor: 0.6, hum: 0.4 },
        fx: { chorus: { mix: 0.5, rate: 0.4, depth: 0.7 }, reverb: { mix: 0.45, size: 3.6, tone: 0.3 } },
      }),

      patina('Patina Whistle', ['whistle', 'mono', 'self-osc'], {
        oscillators: [{ type: 'saw', octave: 0, detune: 0, level: 0.0 }],
        filter: { cutoff: 800, resonance: 1.08, drive: 1.2, keytrack: 1.0 },
        envelope: { attack: 0.05, decay: 0.3, sustain: 0.8, release: 0.6 },
        filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 1.0, release: 0.6, amount: 0 },
        character: { drift: 0.8, noiseFloor: 0.4, hum: 0.1 },
        fx: { chorus: { mix: 0.3, rate: 0.5, depth: 0.5 }, reverb: { mix: 0.4, size: 3.0, tone: 0.35 } },
      }),

    ];

    // Merge: add any seed whose ID is not already in the library
    const existingIds = new Set(this._sounds.map(s => s.id));
    seeds.forEach(s => { if (!existingIds.has(s.id)) this._sounds.unshift(s); });
    this._persist();
  }
}
