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
import { StringsMachine }         from '../machines/StringsMachine.js';
import { MoogishMachine }         from '../machines/MoogishMachine.js';
import { MidiMachine }           from '../machines/MidiMachine.js';
import { Filter }        from '../signal/Filter.js';
import { Envelope }      from '../signal/Envelope.js';
import { VoicePool }     from '../signal/VoicePool.js';
import { LFO }           from '../signal/LFO.js';
import { Sequencer }     from '../sequencer/Sequencer.js';
import { DelayFX }       from '../signal/DelayFX.js';
import { BitcrushFX }    from '../signal/BitcrushFX.js';
import { ChorusFX }      from '../signal/ChorusFX.js';
import { ReverbFX }      from '../signal/ReverbFX.js';
import { Arpeggiator }   from '../signal/Arpeggiator.js';
import { LiveArp }       from '../signal/LiveArp.js';
import { Condition }     from '../sequencer/Condition.js';

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
  strings:    StringsMachine,
  moogish:    MoogishMachine,
  'wt-sampler':     WavetableSamplerMachine,
  'sample-swarm':   SampleSwarmMachine,
  midi:             MidiMachine,
};

/**
 * LFO depth scale for a param descriptor: the amount added at 100% depth.
 *
 * Two unit models, both defined so that 100% depth (bias 0) spans the param's
 * full range peak-to-peak around the base value:
 *
 *  • Linear (default): half the linear range, (lfoMax − lfoMin) / 2.
 *  • Octave/`cents` (`lfoUnit: 'cents'`): half the *log* range in cents,
 *    1200·log2(lfoMax / lfoMin) / 2. The LFO drives an exponential AudioParam
 *    (e.g. a filter's .detune, see Filter.resolveLFOTargets), so a constant cents
 *    swing is a constant octave swing — symmetric to the ear and base-independent.
 *
 * Anchoring to the full log range (rather than a fixed octave count) is what
 * makes the sweep reach the rails from anywhere: from a low cutoff, 100% depth
 * still opens all the way to lfoMax (the detune drives the computed frequency
 * past Nyquist, which the BiquadFilterNode clamps), and from a high cutoff it
 * closes all the way down. A fixed ±N octaves could not reach the ceiling from a
 * low base (base·2^N stays low) — that was the "darker at the bottom" bug.
 *
 * @param {object} descriptor — a getParamList() entry with modulatable: true
 * @returns {number}
 */
function lfoDepthScale(descriptor) {
  if (descriptor.lfoUnit === 'cents') {
    return 1200 * Math.log2(descriptor.lfoMax / descriptor.lfoMin) / 2;
  }
  return (descriptor.lfoMax - descriptor.lfoMin) / 2;
}

export class Track {
  /**
   * @param {number} index
   * @param {import('../core/AudioEngine.js').AudioEngine} audio
   * @param {import('../core/Clock.js').Clock} clock
   */
  constructor(index, audio, clock, outputBus = null) {
    this.index   = index;
    this.audio   = audio;
    this.clock   = clock;
    this.muted   = false;
    this.followSource = null;

    // The node this track's FX chain feeds into. Defaults to the shared master
    // FX bus, but a Project may pass its own per-deck bus (DeckManager) so the
    // whole deck can be crossfaded/silenced as a unit. See design/audio-signal-chain.md.
    this._outputBus = outputBus ?? audio.fxBus;

    // Output gain — mute implemented here
    this.outputGain = audio.context.createGain();
    this.outputGain.gain.value = 1.0;

    // Tremolo VCA — a dedicated post-envelope amplitude node, the only safe LFO
    // target for "amp level". The per-voice envelope owns ampGain via absolute
    // scheduled automation, which would stomp any LFO added there; mute owns
    // outputGain. This node is touched by nothing else, so the LFO (Amp → Level)
    // can ride its gain freely. Base gain 1.0 = unity; the LFO/bias dips it for
    // classic tremolo. See _resolveAudioParam('amp.level').
    this.tremGain = audio.context.createGain();
    this.tremGain.gain.value = 1.0;

    // Stereo panner
    this.pannerNode = audio.context.createStereoPanner();
    this.pannerNode.pan.value = 0;

    // Per-track FX chain: panner → delay → bitcrush → chorus → reverb → fxBus.
    // The BBD chorus is part of the analogue flow — it stays in the chain for
    // every track but is bypassed (dry) unless the track's analogue flag is on.
    this.delayFX    = new DelayFX(audio.context);
    this.bitcrushFX = new BitcrushFX(audio.context);
    this.chorusFX   = new ChorusFX(audio.context);
    this.reverbFX   = new ReverbFX(audio.context);

    // Arpeggiator — schedules note fans from Sequencer triggers
    this.arp = new Arpeggiator();

    // Live (keyboard-driven) arp runner for arp mode 'input'. Fed key on/off by
    // Keyboard.js; free-running so it works with the transport stopped.
    this.liveArp = new LiveArp(this);

    this.outputGain.connect(this.tremGain);
    this.tremGain.connect(this.pannerNode);
    this.pannerNode.connect(this.delayFX.inputNode);
    this.delayFX.connect(this.bitcrushFX.inputNode);
    this.bitcrushFX.connect(this.chorusFX.inputNode);
    this.chorusFX.connect(this.reverbFX.inputNode);
    this.reverbFX.connect(this._outputBus);

    // Canonical (slot-0) filter — UI/sequencer read & write params here. Each
    // voice slot owns its own filter (created by the pool); this one is slot 0's
    // and mirrors its params to the others. Wiring (filter → ampGain → outputGain)
    // is done per slot inside VoiceSlot, so no direct connect here.
    this.filter = new Filter(audio.context);

    // Voice pool — owns machines + envelopes + per-slot filters
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
    // Base velocity for sequencer-fired notes (1–127); MIDI input overrides this
    this.trigVelocity = 127;

    // Nudge quantize: 0 = keep recorded nudge, 1 = full quantize (nudge → 0)
    this.nudgeQuantize = 0;

    // Scale constraint: index into SCALE_DEFS (0 = chromatic / no filter)
    this.scaleIndex = 0;
    // Lead note (root) for scale, 0–11 (pitch class, C=0)
    this.leadNote   = 0;

    // DJ filter: -1 = full LPF, 0 = flat, +1 = full HPF
    this.djFilter = 0;

    // Analogue flow: one track-level switch that drives the whole analogue
    // signal path as a unit — the Moog ladder filter engine, RC (exponential)
    // envelope curves, filter keytrack, and velocity sensitivity. The per-slot
    // Envelope/Filter read this flag indirectly via filter.engine (set in
    // setAnalogue), so no extra per-slot plumbing is needed. false = the clean
    // digital path (default, unchanged behaviour for every existing machine).
    this.analogue = false;

    // Note Follow delay in milliseconds (applied to follower track playback)
    this.followDelay = 0;

    // MidiEngine reference — set by Project after init
    this._midiEngine = null;

    // MIDI In configuration for this track
    this.midiIn = {
      inputId:       null,  // MIDIInput port id, or null = off
      channel:       0,     // 0 = all channels, 1-16 = specific
      noteTranspose: 0,     // semitone offset applied to incoming notes (-48..+48)
      ccMappings:    [],    // [{ cc: number, param: string }]
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
        (ctx) => new Filter(ctx),
        8
      );
    }

    this.loadedSoundName = null;
    // New machine = new param set; drop the sequencer's cached plock-mode map.
    // (Guarded: sequencer is created after the constructor's first setMachine.)
    this.sequencer?.invalidatePlockModeMap();
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
    // Apply to every voice slot's filter (each slot owns its own filter).
    const filters = this._pool?.filters ?? [this.filter];
    if (this.djFilter <= 0) {
      // Left side: sweep LPF down, HPF stays neutral
      const t = -this.djFilter;  // 0 = flat, 1 = full LPF
      // exponential interpolation 20000 → 80 Hz
      const lpf = 20000 * Math.pow(80 / 20000, t);
      for (const f of filters) {
        f._baseLPF.frequency.setTargetAtTime(lpf, now, 0.01);
        f._baseHPF.frequency.setTargetAtTime(20, now, 0.01);
      }
    } else {
      // Right side: sweep HPF up, LPF stays neutral
      const t = this.djFilter;   // 0 = flat, 1 = full HPF
      // exponential interpolation 20 → 8000 Hz
      const hpf = 20 * Math.pow(8000 / 20, t);
      for (const f of filters) {
        f._baseHPF.frequency.setTargetAtTime(hpf, now, 0.01);
        f._baseLPF.frequency.setTargetAtTime(20000, now, 0.01);
      }
    }
  }

  /** @param {number|null} trackIndex */
  setFollow(trackIndex) {
    this.followSource = trackIndex;
  }

  /**
   * Toggle the analogue flow for this track. One switch drives the whole
   * analogue path:
   *   - filter engine → Moog ladder ('analogue') vs. biquad ('digital'),
   *   - RC envelope curves + keytrack + velocity (the per-slot Envelope reads
   *     `filter.engine` to decide, so flipping it here is enough),
   *   - the BBD chorus FX (enabled only in analogue mode).
   * The Filter mirrors `filter.engine` to every voice slot, so a single set on
   * the canonical filter covers the whole pool.
   * @param {boolean} on
   */
  setAnalogue(on) {
    this.analogue = !!on;
    const t = this.audio.context.currentTime;
    this.filter.setParam('filter.engine', this.analogue ? 'analogue' : 'digital', t);
    this.chorusFX?.setEnabled(this.analogue && this.chorusFX.getParam('chorus.mix') > 0);
  }

  /** Called by Project when BPM changes — propagates to synced FX and arpeggiator. */
  onBpmChanged(bpm) {
    this.delayFX.setBpm(bpm);
    this.reverbFX.setBpm(bpm);
    this.arp.setBpm(bpm);
    this._pool?.setBpm(bpm);   // tempo-synced envelope stages
  }

  /**
   * Hard kill all sound on this track: silence every voice slot (cancels pending
   * gain automation, stops machine sources) and stop the live-input arp. Used by
   * the global STOP/panic button to cut notes that ring out, loop, or get stuck.
   * @param {number} [time] — AudioContext time (defaults to now)
   */
  silence(time) {
    const t = time ?? this.audio.context.currentTime;
    this.liveArp?.releaseAll();
    if (this._pool) this._pool.silence(t);
    else this.envelope?.silence(t);
  }

  /**
   * Tear this track out of the audio graph and release its resources. Stops the
   * sequencer, hard-silences voices, stops LFOs, and disconnects the FX chain
   * from its output bus. Used when a deck is unloaded (DeckManager) to free CPU.
   * After dispose() the track must not be reused.
   */
  dispose() {
    try { this.sequencer?.stop(); } catch (_) {}
    this.silence(this.audio.context.currentTime);
    this.liveArp?.releaseAll?.();
    this.lfos?.forEach(lfo => { try { lfo.stop?.(); } catch (_) {} });
    // Disconnect the chain tail from the (per-deck) output bus so the deck's
    // bus can be GC'd and the nodes stop pulling on the graph.
    try { this.reverbFX?.disconnect?.(); } catch (_) {}
    try { this.outputGain?.disconnect?.(); } catch (_) {}
    try { this.tremGain?.disconnect?.(); } catch (_) {}
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

    const voice    = this._pool?.nextVoice(startTime) ?? null;
    const machine  = voice?.machine  ?? this.machine;
    const envelope = voice?.envelope ?? this.envelope;
    if (voice) voice.claim(oscOffTime);

    machine?.syncParamsAt?.(startTime);
    machine?.noteOn(note, velocity, startTime, stopTime);
    machine?.noteOff(oscOffTime);
    envelope?.scheduleNote(startTime, stopTime, { note, velocity });
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
    if (path === 'amp.level') {
      // Tremolo VCA as a direct level/expression target: wheel 0→1 maps to
      // silence→unity. (If an LFO is also on amp.level it sums additively, as with
      // any shared param.)
      return { obj: null, audioParam: this.tremGain.gain, min: 0, max: 1 };
    }
    if (path === 'trig.tone') {
      return { obj: this, audioParam: null, min: -24, max: 24,
               setParam: (v) => { this.trigTone = v; },
               getParam: () => this.trigTone };
    }
    if (path === 'trig.velocity') {
      return { obj: this, audioParam: null, min: 1, max: 127,
               setParam: (v) => { this.trigVelocity = Math.round(v); },
               getParam: () => this.trigVelocity };
    }
    const sources = [
      { obj: this.machine,     params: this.machine.getParamList()      },
      { obj: this.filter,      params: this.filter.getParamList()       },
      { obj: this.delayFX,     params: this.delayFX.getParamList()      },
      { obj: this.bitcrushFX,  params: this.bitcrushFX.getParamList()   },
      { obj: this.chorusFX,    params: this.chorusFX.getParamList()     },
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

    // Route by owner: machine and filter params are per-slot (multi-slot);
    // FX/pan params are single shared AudioParams.
    const isMachineParam = this.machine.resolveAudioParam?.(paramPath) != null;
    const isFilterParam  = this.filter.resolveAudioParam?.(paramPath) != null;

    if (isMachineParam) {
      // Connect to every slot's machine AudioParam
      this._pool.connectLFOToAll(lfo, paramPath, resolved.depthScale);
    } else if (isFilterParam) {
      // Connect to every slot's filter AudioParam
      this._pool.connectLFOToAllFilters(lfo, paramPath, resolved.depthScale);
    } else {
      // Single shared AudioParam (FX, pan)
      lfo.addDestination(resolved.audioParam, resolved.depthScale);
    }

    this._lfoDestPaths[lfoIndex] = paramPath;
  }

  /**
   * Resolve a parameter path string to a Web Audio AudioParam + depthScale.
   * For machine params, returns the slot-0 AudioParam (caller handles multi-slot).
   * depthScale comes from lfoDepthScale() — half the linear range, or a cents
   * value for octave-based params (see filter.cutoff).
   * @param {string} path
   * @returns {{ audioParam: AudioParam, depthScale: number, jsOnly?: boolean }|null}
   */
  _resolveAudioParam(path) {
    if (path === 'amp.pan') {
      return { audioParam: this.pannerNode.pan, depthScale: 1.0 };
    }
    if (path === 'amp.level') {
      // Tremolo VCA. depthScale 1.0 → LFO depth 100% swings gain by ±1.0 around
      // unity; pair with the LFO's Bias knob for one-sided (classic) tremolo.
      return { audioParam: this.tremGain.gain, depthScale: 1.0 };
    }
    if (path === 'trig.tone') {
      return { audioParam: null, depthScale: 24, jsOnly: true };
    }
    if (path === 'trig.velocity') {
      return { audioParam: null, depthScale: 63, jsOnly: true };
    }
    if (path === 'arp.rate' || path === 'arp.gate' || path === 'arp.variance') {
      // Arp timing is JS-only (read at build time, not an AudioParam) — sampled
      // by the Sequencer / LiveArp per fire. depthScale = half the param range.
      const d = this.arp.modParamDescriptors().find(p => p.path === path);
      const depthScale = d ? lfoDepthScale(d) : 1;
      return { audioParam: null, depthScale, jsOnly: true };
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

    return { audioParam, depthScale: lfoDepthScale(descriptor) };
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
      s.condition = Condition.always();
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

    // Reset pan + tremolo VCA, tone, quantize, scale, sound name, and DJ filter
    this.pannerNode.pan.setTargetAtTime(0, this.audio.context.currentTime, 0.005);
    this.tremGain.gain.setTargetAtTime(1.0, this.audio.context.currentTime, 0.005);
    this.loadedSoundName = null;
    this.trigTone      = 0;
    this.trigVelocity  = 100;
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
    this.midiIn = { inputId: null, channel: 0, noteTranspose: 0, ccMappings: [] };

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

    const ampParams = [
      { path: 'amp.level', label: 'Level' },
      { path: 'amp.pan',   label: 'Pan' },
    ];

    const delayParams = this.delayFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const crushParams = this.bitcrushFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const reverbParams = this.reverbFX.getParamList()
      .filter(p => p.modulatable)
      .map(p => ({ path: p.path, label: p.label }));

    const trigItems = [
      { path: 'trig.tone',     label: 'Tone' },
      { path: 'trig.velocity', label: 'Velocity' },
    ];
    if (detuneParam) trigItems.push({ path: 'osc.detune', label: 'Detune' });

    // Arp rate/gate/variance — JS-only sample-and-hold LFO targets (see LiveArp /
    // Sequencer). Only useful when the arp is enabled.
    const arpItems = this.arp.modParamDescriptors().map(p => ({ path: p.path, label: p.label }));

    const groups = [];
    groups.push({ group: 'Trig', items: trigItems });
    if (machineParams.length) groups.push({ group: this.machine.label ?? 'Machine', items: machineParams });
    if (filterParams.length)  groups.push({ group: 'Filter', items: filterParams });
    groups.push({ group: 'Amp', items: ampParams });
    if (delayParams.length)  groups.push({ group: 'Delay', items: delayParams });
    if (crushParams.length)  groups.push({ group: 'Crush', items: crushParams });
    if (reverbParams.length) groups.push({ group: 'Reverb', items: reverbParams });
    if (this.arp.enabled)    groups.push({ group: 'Arp', items: arpItems });
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
      trigVelocity:  this.trigVelocity,
      nudgeQuantize: this.nudgeQuantize,
      scaleIndex:    this.scaleIndex,
      leadNote:     this.leadNote,
      djFilter:     this.djFilter,
      analogue:     this.analogue,
      machine:      this.machine.toJSON(),
      filter:       this.filter.toJSON(),
      envelope:     this.envelope.toJSON(),   // slot-0 envelope (canonical)
      delayFX:      this.delayFX.toJSON(),
      bitcrushFX:   this.bitcrushFX.toJSON(),
      chorusFX:     this.chorusFX.toJSON(),
      reverbFX:     this.reverbFX.toJSON(),
      arp:          this.arp.toJSON(),
      lfos:         this.lfos.map((lfo, i) => ({
        ...lfo.toJSON(),
        destPath: this._lfoDestPaths[i] ?? '',
      })),
      sequencer:    this.sequencer.toJSON(),
      modWheelTargets: [...this.modWheelTargets],
      midiIn:       { ...this.midiIn, ccMappings: [...this.midiIn.ccMappings],
                       noteTranspose: this.midiIn.noteTranspose },
    };
  }

  /** @param {object} obj */
  fromJSON(obj) {
    this.muted        = obj.muted        ?? false;
    this.followSource = obj.followSource ?? null;
    this.followDelay  = obj.followDelay  ?? 0;
    this.pannerNode.pan.value = obj.pan ?? 0;
    this.trigTone      = obj.trigTone      ?? 0;
    this.trigVelocity  = obj.trigVelocity  ?? 127;
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
    this.chorusFX.fromJSON(obj.chorusFX ?? {});

    // Analogue flow flag. Back-compat: projects saved before the unified flag
    // carry only filter.engine, so derive the flag from it when absent. Then
    // re-assert via setAnalogue so the chorus enable + engine stay consistent.
    const analogue = obj.analogue ?? (this.filter.getParam('filter.engine') === 'analogue');
    this.setAnalogue(analogue);

    if (obj.arp) this.arp.fromJSON(obj.arp);
    this.onBpmChanged(this.clock.bpm);
    this.sequencer.fromJSON(obj.sequencer ?? {});
    this.modWheelTargets = obj.modWheelTargets ?? [null, null];

    if (obj.midiIn) {
      this.midiIn.inputId       = obj.midiIn.inputId       ?? null;
      this.midiIn.channel       = obj.midiIn.channel       ?? 0;
      this.midiIn.noteTranspose = obj.midiIn.noteTranspose ?? 0;
      this.midiIn.ccMappings    = obj.midiIn.ccMappings    ?? [];
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
