/**
 * Track.js
 * --------
 * The central owner of one complete voice: machine + sequencer + signal chain.
 * Project.js creates 8 Track instances.
 *
 * Owns and wires the full per-track audio graph:
 *   machine → filter → envelope (ampGain) → outputGain → AudioEngine.fxBus
 *
 * Also owns:
 *   - Sequencer (step data, runs against Clock)
 *   - Array of LFOs
 *   - Mod wheel destination assignments (as param paths)
 *   - Follow source (index of another track whose notes this track mirrors)
 *
 * Machine registry: to add a new machine type, import it here and add to MACHINES map.
 *
 * Depends: SynthMachine, FMMachine, KickSilkMachine, KickHardMachine, SnareMachine, HiHatMachine, NoiseMachine, TransientMachine, Filter, Envelope, LFO, Sequencer
 * Used by: Project.js
 *
 * Public:
 *   .index             — track number (0-based)
 *   .machine           — current Machine instance
 *   .sequencer         — Sequencer instance
 *   .filter            — Filter instance
 *   .envelope          — Envelope instance
 *   .lfos              — LFO[] array
 *   .muted             — boolean
 *   .followSource      — track index to follow, or null
 *   .outputGain        — GainNode (mute is implemented by zeroing this)
 *   setMachine(type)   — swap machine type, rewires audio graph
 *   mute() / unmute()
 *   setFollow(index)   — set follow source (null to clear)
 *   addLFO()           — add a new LFO instance
 *   removeLFO(index)
 *   setLFODestination(lfoIndex, paramPath) — resolve path → AudioParam and connect
 *   resolveParam(path) — returns { object, audioParam } for a given path string
 *   toJSON() / fromJSON()
 */

import { SynthMachine }     from '../machines/SynthMachine.js';
import { FMMachine }        from '../machines/FMMachine.js';
import { KickMachine }      from '../machines/KickMachine.js';
import { KickHardMachine }  from '../machines/KickHardMachine.js';
import { KickSilkMachine }  from '../machines/KickSilkMachine.js';
import { SnareMachine }     from '../machines/SnareMachine.js';
import { HiHatMachine }     from '../machines/HiHatMachine.js';
import { NoiseMachine }     from '../machines/NoiseMachine.js';
import { TransientMachine } from '../machines/TransientMachine.js';
import { SwarmMachine }     from '../machines/SwarmMachine.js';
import { SamplerMachine }   from '../machines/SamplerMachine.js';
import { CymbalMachine }    from '../machines/CymbalMachine.js';
import { WoodMachine }      from '../machines/WoodMachine.js';
import { ClappMachine }     from '../machines/ClappMachine.js';
import { WavetableMachine } from '../machines/WavetableMachine.js';
import { KarplusMachine }   from '../machines/KarplusMachine.js';
import { BassMachine }      from '../machines/BassMachine.js';
import { CombMachine }      from '../machines/CombMachine.js';
import { ChordMachine }     from '../machines/ChordMachine.js';
import { WavetableSamplerMachine } from '../machines/WavetableSamplerMachine.js';
import { SampleSwarmMachine }     from '../machines/SampleSwarmMachine.js';
import { MarimbaMachine }         from '../machines/MarimbaMachine.js';
import { MidiMachine }           from '../machines/MidiMachine.js';
import { Filter }        from '../signal/Filter.js';
import { Envelope }      from '../signal/Envelope.js';
import { VoicePool }     from '../signal/VoicePool.js';
import { LFO }           from '../signal/LFO.js';
import { Sequencer }     from '../sequencer/Sequencer.js';
import { DelayFX }       from '../signal/DelayFX.js';
import { BitcrushFX }    from '../signal/BitcrushFX.js';
import { ReverbFX }      from '../signal/ReverbFX.js';

const MACHINES = {
  synth:      SynthMachine,
  fm:         FMMachine,
  kick:       KickMachine,      // backward compat alias → KickSilkMachine
  'kick.silk': KickSilkMachine,
  'kick.hard': KickHardMachine,
  snare:      SnareMachine,
  hihat:      HiHatMachine,
  noise:      NoiseMachine,
  transient:  TransientMachine,
  swarm:      SwarmMachine,
  sampler:    SamplerMachine,
  cymbal:     CymbalMachine,
  wood:       WoodMachine,
  clapp:      ClappMachine,
  wavetable:  WavetableMachine,
  karplus:    KarplusMachine,
  marimba:    MarimbaMachine,
  bass:       BassMachine,
  comb:       CombMachine,
  chord:      ChordMachine,
  'wt-sampler':     WavetableSamplerMachine,
  'sample-swarm':   SampleSwarmMachine,
  midi:             MidiMachine,
};

export class Track {
  /**
   * @param {number} index
   * @param {import('../core/AudioEngine.js').AudioEngine} audio
   * @param {import('../core/Clock.js').Clock} clock
   */
  constructor(index, audio, clock) {
    this.index   = index;
    this.audio   = audio;
    this.clock   = clock;
    this.muted   = false;
    this.followSource = null;

    // Output gain — mute implemented here
    this.outputGain = audio.context.createGain();
    this.outputGain.gain.value = 1.0;

    // Stereo panner
    this.pannerNode = audio.context.createStereoPanner();
    this.pannerNode.pan.value = 0;

    // Per-track FX chain: panner → delay → bitcrush → reverb → fxBus
    this.delayFX   = new DelayFX(audio.context);
    this.bitcrushFX = new BitcrushFX(audio.context);
    this.reverbFX  = new ReverbFX(audio.context);

    this.outputGain.connect(this.pannerNode);
    this.pannerNode.connect(this.delayFX.inputNode);
    this.delayFX.connect(this.bitcrushFX.inputNode);
    this.bitcrushFX.connect(this.reverbFX.inputNode);
    this.reverbFX.connect(audio.fxBus);

    // Signal chain nodes
    this.filter = new Filter(audio.context);
    // filter.node → outputGain (wired once here; slots gate before the filter input)
    this.filter.connect(this.outputGain);

    // Voice pool — owns machines + envelopes; all slots connect to shared filter + outputGain
    this._pool = null;
    this.setMachine('synth');

    // Sequencer
    this.sequencer = new Sequencer(this, clock);

    // LFO destination paths (parallel to this.lfos) — must be before addLFO()
    this._lfoDestPaths = [];

    // LFOs — start with one
    this.lfos = [];
    this.addLFO();

    // Mod wheel destination paths (resolved on assignment)
    this.modWheelTargets = [null, null];  // 2 wheels

    // Name of the last sound loaded from the library, or null if base/modified
    this.loadedSoundName = null;

    // SampleStore reference — set by Project after construction
    this.sampleStore = null;

    // Semitone transpose applied to every note on this track (+/-24)
    this.trigTone = 0;

    // Nudge quantize: 0 = keep recorded nudge, 1 = full quantize (nudge → 0)
    this.nudgeQuantize = 0;

    // Scale constraint: index into SCALE_DEFS (0 = chromatic / no filter)
    this.scaleIndex = 0;
    // Lead note (root) for scale, 0–11 (pitch class, C=0)
    this.leadNote   = 0;

    // DJ filter: -1 = full LPF, 0 = flat, +1 = full HPF
    this.djFilter = 0;

    // Note Follow delay in milliseconds (applied to follower track playback)
    this.followDelay = 0;

    // MidiEngine reference — set by Project after init
    this._midiEngine = null;

    // MIDI In configuration for this track
    this.midiIn = {
      inputId:  null,   // MIDIInput port id, or null = off
      channel:  0,      // 0 = all channels, 1-16 = specific
      ccMappings: [],   // [{ cc: number, param: string }]
    };
  }

  /** Canonical machine (slot 0) — used by UI panels for param reads/writes. */
  get machine()  { return this._pool?.machine;  }

  /** Canonical envelope (slot 0) — used by UI panels for param reads/writes. */
  get envelope() { return this._pool?.envelope; }

  /**
   * Swap machine type across all voice slots.
   * Params from slot 0 are preserved and copied to new slots.
   * @param {string} type
   */
  /**
   * @param {import('../core/MidiEngine.js').MidiEngine} engine
   */
  setMidiEngine(engine) {
    this._midiEngine = engine;
    if (this.machine?.type === 'midi') this.machine.setMidiEngine(engine);
  }

  setMachine(type) {
    const MachineClass = MACHINES[type] ?? SynthMachine;
    const midiEngine   = this._midiEngine;
    const makeMachine  = (ctx) => {
      const m = new MachineClass(ctx);
      if (m.type === 'midi' && midiEngine) m.setMidiEngine(midiEngine);
      return m;
    };

    if (this._pool) {
      // Rewire LFOs: disconnect all existing machine AudioParam connections
      this.lfos?.forEach((lfo, i) => {
        const path = this._lfoDestPaths?.[i];
        if (path) this._pool.disconnectLFOFromAll(lfo, path);
      });
      this._pool.setMachine(makeMachine);
      // Reconnect LFOs to new machines
      this.lfos?.forEach((lfo, i) => {
        const path = this._lfoDestPaths?.[i];
        if (path) this._rewireLFOToPool(lfo, i, path);
      });
    } else {
      this._pool = new VoicePool(
        this.audio.context,
        this.filter,
        this.outputGain,
        makeMachine,
        8
      );
    }

    this.loadedSoundName = null;
  }

  mute() {
    this.muted = true;
    this.outputGain.gain.setTargetAtTime(0, this.audio.context.currentTime, 0.01);
  }

  unmute() {
    this.muted = false;
    this.outputGain.gain.setTargetAtTime(1.0, this.audio.context.currentTime, 0.01);
  }

  /**
   * Apply the DJ filter value to the base HPF and LPF nodes.
   * value: -1 = full LPF (80 Hz cutoff), 0 = flat, +1 = full HPF (8000 Hz cutoff)
   * Left half drives LPF down (20000 → 80 Hz), right half drives HPF up (20 → 8000 Hz).
   * @param {number} value — clamped to [-1, 1]
   */
  applyDJFilter(value) {
    this.djFilter = Math.max(-1, Math.min(1, value));
    const now = this.audio.context.currentTime;
    if (this.djFilter <= 0) {
      // Left side: sweep LPF down, HPF stays neutral
      const t = -this.djFilter;  // 0 = flat, 1 = full LPF
      // exponential interpolation 20000 → 80 Hz
      const lpf = 20000 * Math.pow(80 / 20000, t);
      this.filter._baseLPF.frequency.setTargetAtTime(lpf, now, 0.01);
      this.filter._baseHPF.frequency.setTargetAtTime(20, now, 0.01);
    } else {
      // Right side: sweep HPF up, LPF stays neutral
      const t = this.djFilter;   // 0 = flat, 1 = full HPF
      // exponential interpolation 20 → 8000 Hz
      const hpf = 20 * Math.pow(8000 / 20, t);
      this.filter._baseHPF.frequency.setTargetAtTime(hpf, now, 0.01);
      this.filter._baseLPF.frequency.setTargetAtTime(20000, now, 0.01);
    }
  }

  /** @param {number|null} trackIndex */
  setFollow(trackIndex) {
    this.followSource = trackIndex;
  }

  /**
   * Fire a note on this track immediately (for note-follow triggering).
   * @param {number} note     — MIDI note 0-127
   * @param {number} velocity
   * @param {number} audioTime — AudioContext scheduled time
   * @param {number} offTime   — AudioContext scheduled note-off time
   */
  fireFollowNote(note, velocity, audioTime, offTime) {
    if (this.muted) return;
    const delayMs  = this.followDelay ?? 0;
    const delaySec = delayMs / 1000;
    const startTime = audioTime + delaySec;
    const stopTime  = offTime  + delaySec;
    const oscOffTime = stopTime + (this.envelope?.getParam('env.release') ?? 0.3);

    const voice    = this._pool?.nextVoice() ?? null;
    const machine  = voice?.machine  ?? this.machine;
    const envelope = voice?.envelope ?? this.envelope;
    if (voice) voice.claim(oscOffTime);

    machine?.noteOn(note, velocity, startTime, stopTime);
    machine?.noteOff(oscOffTime);
    envelope?.scheduleNote(startTime, stopTime, {});
    this.lfos?.forEach(lfo => {
      lfo.noteOn(startTime, stopTime, envelope?._params ?? {});
      lfo.noteOff(stopTime);
    });
  }

  addLFO() {
    const lfo = new LFO(this.audio.context, this.lfos.length, this.clock);
    lfo.start();
    this.lfos.push(lfo);
    this._lfoDestPaths.push('');
    return lfo;
  }

  /** @param {number} lfoIndex */
  removeLFO(lfoIndex) {
    const lfo = this.lfos[lfoIndex];
    if (!lfo) return;
    lfo.stop();
    lfo.clearDestination();
    this.lfos.splice(lfoIndex, 1);
    this._lfoDestPaths.splice(lfoIndex, 1);
  }

  /**
   * Resolve a parameter path for mod wheel use.
   * Returns { audioParam, min, max } using lfoMin/lfoMax from the descriptor.
   * @param {string} path
   * @returns {{ audioParam: AudioParam, min: number, max: number }|null}
   */
  resolveModWheelParam(path) {
    if (!path) return null;
    if (path === 'amp.pan') {
      return { obj: null, audioParam: this.pannerNode.pan, min: -1, max: 1 };
    }
    const sources = [
      { obj: this.machine,     params: this.machine.getParamList()      },
      { obj: this.filter,      params: this.filter.getParamList()       },
      { obj: this.delayFX,     params: this.delayFX.getParamList()      },
      { obj: this.bitcrushFX,  params: this.bitcrushFX.getParamList()   },
      { obj: this.reverbFX,    params: this.reverbFX.getParamList()     },
    ];
    for (const { obj, params } of sources) {
      const descriptor = params.find(p => p.path === path && p.modulatable);
      if (!descriptor) continue;
      const audioParam = obj.resolveAudioParam?.(path) ?? null;
      // JS-only params (no AudioParam) are still controllable via setParam directly
      return { obj, audioParam, min: descriptor.lfoMin, max: descriptor.lfoMax };
    }
    return null;
  }

  /**
   * Assign an LFO to a parameter path.
   * For machine params: connects to the AudioParam on every voice slot.
   * For filter/FX/pan params: connects to the single shared AudioParam.
   * @param {number} lfoIndex
   * @param {string} paramPath
   */
  setLFODestination(lfoIndex, paramPath) {
    const lfo = this.lfos[lfoIndex];
    if (!lfo) return;

    // Disconnect from previous destination(s) before reassigning
    lfo.clearDestination();
    this._lfoDestPaths[lfoIndex] = '';

    if (!paramPath) return;

    this._rewireLFOToPool(lfo, lfoIndex, paramPath);
  }

  /**
   * Internal: wire one LFO to its resolved destination(s).
   * Machine params → all voice slots. Shared params → single AudioParam.
   */
  _rewireLFOToPool(lfo, lfoIndex, paramPath) {
    const resolved = this._resolveAudioParam(paramPath);
    if (!resolved) return;

    if (resolved.jsOnly) {
      lfo.clearDestination();
      lfo.setJSDepthScale(resolved.depthScale);
      this._lfoDestPaths[lfoIndex] = paramPath;
      return;
    }

    // Check if this path belongs to the machine (multi-slot) or shared signal chain
    const isMachineParam = this.machine.resolveAudioParam?.(paramPath) != null;

    if (isMachineParam) {
      // Connect to every slot's machine AudioParam
      this._pool.connectLFOToAll(lfo, paramPath, resolved.depthScale);
    } else {
      // Single shared AudioParam (filter, FX, pan)
      lfo.addDestination(resolved.audioParam, resolved.depthScale);
    }

    this._lfoDestPaths[lfoIndex] = paramPath;
  }

  /**
   * Resolve a parameter path string to a Web Audio AudioParam + depthScale.
   * For machine params, returns the slot-0 AudioParam (caller handles multi-slot).
   * depthScale = (lfoMax - lfoMin) / 2 so that 100% depth = full half-range swing.
   * @param {string} path
   * @returns {{ audioParam: AudioParam, depthScale: number, jsOnly?: boolean }|null}
   */
  _resolveAudioParam(path) {
    if (path === 'amp.pan') {
      return { audioParam: this.pannerNode.pan, depthScale: 1.0 };
    }
    if (path === 'trig.tone') {
      return { audioParam: null, depthScale: 24, jsOnly: true };
    }

    const allParams = [
      ...this.machine.getParamList(),
      ...this.filter.getParamList(),
      ...this.delayFX.getParamList(),
      ...this.bitcrushFX.getParamList(),
      ...this.reverbFX.getParamList(),
      ...this._envelopeModulatableParams(),
    ];
    const descriptor = allParams.find(p => p.path === path && p.modulatable);
    if (!descriptor) return null;

    // Try slot-0 machine first, then shared signal chain objects
    let audioParam = this.machine.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.filter.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.delayFX.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.bitcrushFX.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.reverbFX.resolveAudioParam?.(path) ?? null;
    if (!audioParam) return null;

    const depthScale = (descriptor.lfoMax - descriptor.lfoMin) / 2;
    return { audioParam, depthScale };
  }

  /** No envelope params are safely LFO-modulatable: ADSR times are JS-only,
   *  and ampGain.gain is controlled by scheduled automation that fights LFO addition. */
  _envelopeModulatableParams() {
    return [];
  }

  /**
   * Get all modulatable parameter paths for LFO destination dropdown.
   * Returns grouped structure: [{ group, items: [{ path, label }] }]
   * @returns {Array}
   */
  /**
   * Clear only step notes — active flag and note data — leaving all params untouched.
   */
  clearNotes() {
    this.sequencer.steps.forEach(s => {
      s.active    = false;
      s.note      = 60;
      s.velocity  = 100;
      s.length    = 1;
      s.nudge     = 0;
      s.retrigger = null;
      s.chance    = 100;
      s.plocks.clear();
      s.condition = { type: 'always', options: {}, label: '—', evaluate() { return true; } };
    });
    this.sequencer.stepCount  = 16;
    this.sequencer.pageOffset = 0;
    // Trim steps array back to 16 so inactive pages are truly gone
    this.sequencer.steps.length = 16;
  }

  /**
   * Full reset: clear notes + restore all params to defaults + reset LFOs to one empty LFO.
   */
  resetTrack() {
    this.clearNotes();

    // Reset machine to synth with defaults (rebuilds pool)
    this.setMachine('synth');

    // Reset filter
    this.filter.fromJSON({});

    // Reset envelope on all slots
    this.envelope.fromJSON({});
    this._pool.syncParams();

    // Reset FX
    this.delayFX.fromJSON({});
    this.bitcrushFX.fromJSON({});
    this.reverbFX.fromJSON({});

    // Reset pan, tone, quantize, scale, sound name, and DJ filter
    this.pannerNode.pan.setTargetAtTime(0, this.audio.context.currentTime, 0.005);
    this.loadedSoundName = null;
    this.trigTone      = 0;
    this.nudgeQuantize = 0;
    this.scaleIndex    = 0;
    this.leadNote      = 0;
    this.applyDJFilter(0);

    // Reset mute
    if (this.muted) this.unmute();
    this.followSource = null;
    this.followDelay  = 0;
    this.modWheelTargets = [null, null];

    // Reset MIDI In
    this.midiIn = { inputId: null, channel: 0, ccMappings: [] };

    // Tear down all LFOs and start fresh with one
    this.lfos.forEach(l => { l.clearDestination(); l.stop(); });
    this.lfos = [];
    this._lfoDestPaths = [];
    this.addLFO();
  }

  getAssignableParams() {
    // Detune lives in machine but belongs logically in Trig — pull it out separately
    const detuneParam = this.machine.getParamList().find(p => p.path === 'osc.detune' && p.modulatable);

    const machineParams = this.machine.getParamList()
      .filter(p => p.modulatable && p.path !== 'osc.detune')
      .map(p => {
        // For FM operator params (op1.*, op2.*, etc.), prefix label with operator number
        const opMatch = p.path.match(/^(op\d+)\./);
        const label = opMatch ? `${opMatch[1].toUpperCase()} ${p.label}` : p.label;
        return { path: p.path, label };
      });

    const filterParams = this.filter.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const ampParams = [{ path: 'amp.pan', label: 'Pan' }];

    const delayParams = this.delayFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const crushParams = this.bitcrushFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const reverbParams = this.reverbFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const trigItems = [{ path: 'trig.tone', label: 'Tone' }];
    if (detuneParam) trigItems.push({ path: 'osc.detune', label: 'Detune' });

    const groups = [];
    groups.push({ group: 'Trig', items: trigItems });
    if (machineParams.length) groups.push({ group: this.machine.label ?? 'Machine', items: machineParams });
    if (filterParams.length)  groups.push({ group: 'Filter', items: filterParams });
    groups.push({ group: 'Amp', items: ampParams });
    if (delayParams.length)  groups.push({ group: 'Delay', items: delayParams });
    if (crushParams.length)  groups.push({ group: 'Crush', items: crushParams });
    if (reverbParams.length) groups.push({ group: 'Reverb', items: reverbParams });
    return groups;
  }

  toJSON() {
    return {
      index:        this.index,
      muted:        this.muted,
      followSource: this.followSource,
      followDelay:  this.followDelay,
      pan:          this.pannerNode.pan.value,
      trigTone:      this.trigTone,
      nudgeQuantize: this.nudgeQuantize,
      scaleIndex:    this.scaleIndex,
      leadNote:     this.leadNote,
      djFilter:     this.djFilter,
      machine:      this.machine.toJSON(),
      filter:       this.filter.toJSON(),
      envelope:     this.envelope.toJSON(),   // slot-0 envelope (canonical)
      delayFX:      this.delayFX.toJSON(),
      bitcrushFX:   this.bitcrushFX.toJSON(),
      reverbFX:     this.reverbFX.toJSON(),
      lfos:         this.lfos.map((lfo, i) => ({
        ...lfo.toJSON(),
        destPath: this._lfoDestPaths[i] ?? '',
      })),
      sequencer:    this.sequencer.toJSON(),
      modWheelTargets: [...this.modWheelTargets],
      midiIn:       { ...this.midiIn, ccMappings: [...this.midiIn.ccMappings] },
    };
  }

  /** @param {object} obj */
  fromJSON(obj) {
    this.muted        = obj.muted        ?? false;
    this.followSource = obj.followSource ?? null;
    this.followDelay  = obj.followDelay  ?? 0;
    this.pannerNode.pan.value = obj.pan ?? 0;
    this.trigTone      = obj.trigTone      ?? 0;
    this.nudgeQuantize = obj.nudgeQuantize ?? 0;
    this.scaleIndex    = obj.scaleIndex    ?? 0;
    this.leadNote   = obj.leadNote   ?? 0;
    this.applyDJFilter(obj.djFilter ?? 0);

    // Swap machine type (rebuilds pool slots), then restore params into slot 0
    if (obj.machine?.type) this.setMachine(obj.machine.type);
    this.machine.fromJSON(obj.machine ?? {});

    // Restore sampler buffer asynchronously if we have a store reference
    if ((this.machine.type === 'sampler' || this.machine.type === 'sample-swarm') && this.machine.sampleId && this.sampleStore) {
      this.sampleStore.load(this.machine.sampleId, this.audio.context).then(buf => {
        if (buf) this.machine.setBuffer(buf, this.machine.sampleId, this.machine.sampleName);
      });
    }
    // Restore wt-sampler buffers asynchronously
    if (this.machine.type === 'wt-sampler' && this.sampleStore) {
      if (this.machine.sampleIdA) {
        this.sampleStore.load(this.machine.sampleIdA, this.audio.context).then(buf => {
          if (buf) this.machine.setBufferA(buf, this.machine.sampleIdA, this.machine.sampleNameA);
        });
      }
      if (this.machine.sampleIdB) {
        this.sampleStore.load(this.machine.sampleIdB, this.audio.context).then(buf => {
          if (buf) this.machine.setBufferB(buf, this.machine.sampleIdB, this.machine.sampleNameB);
        });
      }
    }

    // Sync machine params to all slots, then restore shared signal chain
    this._pool.syncParams();

    this.filter.fromJSON(obj.filter ?? {});
    // Restore envelope into slot 0, then sync to all slots
    this.envelope.fromJSON(obj.envelope ?? {});
    this._pool.syncParams();

    this.delayFX.fromJSON(obj.delayFX ?? {});
    this.bitcrushFX.fromJSON(obj.bitcrushFX ?? {});
    this.reverbFX.fromJSON(obj.reverbFX ?? {});
    this.sequencer.fromJSON(obj.sequencer ?? {});
    this.modWheelTargets = obj.modWheelTargets ?? [null, null];

    if (obj.midiIn) {
      this.midiIn.inputId    = obj.midiIn.inputId    ?? null;
      this.midiIn.channel    = obj.midiIn.channel    ?? 0;
      this.midiIn.ccMappings = obj.midiIn.ccMappings ?? [];
    }

    // Restore LFOs
    this.lfos.forEach(l => l.stop());
    this.lfos = [];
    this._lfoDestPaths = [];
    (obj.lfos ?? []).forEach(lfoObj => {
      const lfo = this.addLFO();
      lfo.fromJSON(lfoObj);
      if (lfoObj.destPath) this.setLFODestination(this.lfos.length - 1, lfoObj.destPath);
    });

    if (this.muted) this.mute();
  }
}
