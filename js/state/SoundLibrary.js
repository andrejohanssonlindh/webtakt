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
    const mk = (name, tags, machine, filter, envelope, fx) => ({
      id:         'seed_' + name.replace(/\s+/g, '_').toLowerCase(),
      name,
      tags:       ['AI', ...tags],
      createdAt:  Date.now(),
      machine,
      filter:     filter  ?? _defFilter(),
      envelope:   envelope ?? _defEnv(),
      ...fx,
      lfos:       [{ params: { 'lfo.waveform': 'sine', 'lfo.speed': 0.1, 'lfo.speedMult': 1, 'lfo.depth': 30 }, destPath: '' }],
      pan:        0,
      trigTone:   0,
    });

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

    ];

    // Merge: add any seed whose ID is not already in the library
    const existingIds = new Set(this._sounds.map(s => s.id));
    seeds.forEach(s => { if (!existingIds.has(s.id)) this._sounds.unshift(s); });
    this._persist();
  }
}
