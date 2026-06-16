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
import { AnalogueKickMachine } from '../machines/AnalogueKickMachine.js';
import { AnalogueSnareMachine } from '../machines/AnalogueSnareMachine.js';
import { AnalogueHiHatMachine } from '../machines/AnalogueHiHatMachine.js';
import { AnalogueTomMachine }   from '../machines/AnalogueTomMachine.js';
import { AnalogueClappMachine } from '../machines/AnalogueClappMachine.js';
import { AnalogueCymbalMachine } from '../machines/AnalogueCymbalMachine.js';
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
import { InputMachine }          from '../machines/InputMachine.js';
import { Filter }        from '../signal/Filter.js';
import { Envelope }      from '../signal/Envelope.js';
import { VoicePool }     from '../signal/VoicePool.js';
import { LFO }           from '../signal/LFO.js';
import { Sequencer }     from '../sequencer/Sequencer.js';
import { DelayFX }       from '../signal/DelayFX.js';
import { BitcrushFX }    from '../signal/BitcrushFX.js';
import { ChorusFX }      from '../signal/ChorusFX.js';
import { ReverbFX }      from '../signal/ReverbFX.js';
import { DistortionFX }  from '../signal/DistortionFX.js';
import { CompressorFX }  from '../signal/CompressorFX.js';
import { PhaserFX }      from '../signal/PhaserFX.js';
import { FXFilter }      from '../signal/FXFilter.js';
import { NormalizerFX }  from '../signal/NormalizerFX.js';
import { EQ3FX }         from '../signal/EQ3FX.js';
import { AutoPanFX }     from '../signal/AutoPanFX.js';
import { GateFX }        from '../signal/GateFX.js';
import { WidthFX }       from '../signal/WidthFX.js';
import { LimiterFX }     from '../signal/LimiterFX.js';
import { RingModFX }     from '../signal/RingModFX.js';
import { TapeFX }        from '../signal/TapeFX.js';
import { CombFX }        from '../signal/CombFX.js';
import { ShimmerFX }     from '../signal/ShimmerFX.js';
import { Crush2FX }      from '../signal/Crush2FX.js';
import { StutterFX }     from '../signal/StutterFX.js';
import { FXInstance }    from '../signal/FXInstance.js';
import { Arpeggiator }   from '../signal/Arpeggiator.js';
import { LiveArp }       from '../signal/LiveArp.js';
import { Condition }     from '../sequencer/Condition.js';

const MACHINES = {
  synth:      SynthMachine,
  fm:         FMMachine,
  kick:       KickMachine,      // backward compat alias → KickSilkMachine
  'kick.silk': KickSilkMachine,
  'kick.hard': KickHardMachine,
  'kick.analogue': AnalogueKickMachine,
  snare:      SnareMachine,
  'snare.analogue': AnalogueSnareMachine,
  hihat:      HiHatMachine,
  'hihat.analogue': AnalogueHiHatMachine,
  noise:      NoiseMachine,
  transient:  TransientMachine,
  swarm:      SwarmMachine,
  sampler:    SamplerMachine,
  cymbal:     CymbalMachine,
  'cymbal.analogue': AnalogueCymbalMachine,
  wood:       WoodMachine,
  clapp:      ClappMachine,
  'clapp.analogue': AnalogueClappMachine,
  'tom.analogue': AnalogueTomMachine,
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
  input:            InputMachine,
};

/**
 * FX block type → factory. Used by Track.addFX(type) to build ADDED instances
 * (extra copies of the base effects + the new types). The base four blocks are
 * created directly in the constructor and keep bare (un-prefixed) param paths.
 */
const FX_TYPES = {
  delay:    DelayFX,
  crush:    BitcrushFX,
  chorus:   ChorusFX,
  reverb:   ReverbFX,
  distortion: DistortionFX,
  compressor: CompressorFX,
  phaser:   PhaserFX,        // un-parked: now stereo (counter-sweep) + wider range.
  filter:   FXFilter,
  normalizer: NormalizerFX,
  eq3:      EQ3FX,
  autopan:  AutoPanFX,
  gate:     GateFX,
  width:    WidthFX,
  limiter:  LimiterFX,
  ringmod:  RingModFX,
  tape:     TapeFX,
  comb:     CombFX,
  shimmer:  ShimmerFX,
  crush2:   Crush2FX,
  stutter:  StutterFX,
};

/** Human labels for the Add-FX menu (order = menu order). */
export const FX_TYPE_LABELS = {
  filter:     'Filter',
  eq3:        'EQ',
  delay:      'Delay',
  tape:       'Tape',
  chorus:     'Chorus',
  phaser:     'Phaser',
  autopan:    'AutoPan',
  ringmod:    'RingMod',
  reverb:     'Reverb',
  shimmer:    'Shimmer',
  comb:       'Comb',
  crush:      'Crush',
  crush2:     'Crush+',
  distortion: 'Distortion',
  gate:       'Gate',
  stutter:    'Stutter',
  width:      'Width',
  compressor: 'Compressor',
  limiter:    'Limiter',
  normalizer: 'Normalizer',
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
    this.held    = false;   // true while keyboard/MIDI note-offs are suppressed for this track
    // HOLD-mode latch stash: midiNote → VoiceSlot for notes left ringing when the
    // user switched away from this (held) track. Filled by Keyboard on track
    // switch, drained by Keyboard._flushLatched when hold turns off. Lets a held
    // note be stopped after switching away without resorting to STOP-ALL.
    this._latchedVoices = new Map();
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

    // Per-track FX chain. The chain ORDER is user-customisable (FX pipeline
    // pane): the blocks are reorderable; the upstream nodes (outputGain →
    // tremGain → pannerNode) and the downstream output bus are fixed. The chain
    // is rebuilt declaratively from `_fxOrder` by `_rewireFXChain()`.
    // The BBD chorus is part of the analogue flow — it stays in the chain for
    // every track but is bypassed (dry) unless the track's analogue flag is on.
    this.delayFX    = new DelayFX(audio.context);
    this.bitcrushFX = new BitcrushFX(audio.context);
    this.chorusFX   = new ChorusFX(audio.context);
    this.reverbFX   = new ReverbFX(audio.context);

    // FX block registry: id → the FX block on this track. The pipeline order is
    // an array of these ids. The base four are PERMANENT (cannot be removed) and
    // keep bare param paths ('reverb.wet') for back-compat. ADDED instances
    // (Track.addFX) get ids 'fxN' and are wrapped in an FXInstance proxy so
    // their param paths are namespaced ('fxN.reverb.wet') and never collide.
    this._fxBlocks = {
      delay:  this.delayFX,
      crush:  this.bitcrushFX,
      chorus: this.chorusFX,
      reverb: this.reverbFX,
    };
    // Ids that may never be removed (the permanent base blocks).
    this._fxBaseIds = ['delay', 'crush', 'chorus', 'reverb'];
    // Monotonic counter for added-instance ids ('fx1', 'fx2', …). Also drives
    // the FXInstance prefix, so an id of 'fx3' ↔ prefix 'fx3.'.
    this._fxNextId  = 1;
    // Default chain order — the base four (matches the historical chain).
    this._fxOrder = [...this._fxBaseIds];

    // FX bind assignments: bind number (1–4) → block id (or null). The four
    // global FX keybinds (Settings fx1..fx4) toggle whichever block this track
    // maps them to, so the SAME key can hit a different effect per track. A block
    // may hold at most one bind, and a bind at most one block (assigning steals).
    this._fxBinds = { 1: null, 2: null, 3: null, 4: null };

    // Arpeggiator — schedules note fans from Sequencer triggers
    this.arp = new Arpeggiator();

    // Live (keyboard-driven) arp runner for the input arp modes ('input' /
    // 'input-manual'). Fed key on/off by Keyboard.js; free-running so it works
    // with the transport stopped.
    this.liveArp = new LiveArp(this);

    this.outputGain.connect(this.tremGain);
    this.tremGain.connect(this.pannerNode);
    // Wire pannerNode → [FX blocks in _fxOrder] → outputBus.
    this._rewireFXChain();

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

    // Input machine in continuous mode needs the per-voice amp gate held open
    // (it has no notes to open it). Leaving input → close the gate again. reset:
    // a machine swap is an explicit intent to establish a clean gate baseline.
    this._applyInputGate({ reset: true });
  }

  /**
   * Reconcile the per-voice amp gate with the Input machine's gate mode.
   *
   * The Input machine (InputMachine.js) produces continuous live audio with no
   * notes. The slot envelope's ampGain defaults to 0 and opens only on a note,
   * so for CONTINUOUS input we must pin every slot's ampGain open (gain = 1).
   * For GATED input (input.gate = true) we leave the envelope alone — the
   * sequencer/keyboard drive it normally, chopping the live signal. Any other
   * machine type, or no pool yet, restores the gate to closed (0) so a normal
   * voice is silent until its envelope fires.
   *
   * Called from setMachine (machine swap), mute/unmute, after silence() (STOP),
   * and from InputPanel when the gate toggle flips. Idempotent.
   *
   * Mute applies HERE for continuous input: unlike a normal machine (where mute
   * only stops sequencer notes and lets live voices ring), continuous input has
   * no notes — so mute must actually silence it. A muted continuous-input track
   * pins the gate to 0.
   */
  _applyInputGate({ reset = false } = {}) {
    if (!this._pool) return;
    const m = this.machine;
    const isInput    = m?.type === 'input';
    const continuous = isInput && !m.gated;
    const t = this.audio.context.currentTime;

    // CONTINUOUS input (or muted continuous): pin every slot's amp gate to a
    // static value — there are no notes, the envelope never runs, so we own
    // ampGain outright. open while unmuted, closed while muted.
    if (continuous) {
      const open = !this.muted;
      for (const env of this._pool.envelopes) {
        const g = env.ampGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(open ? 1 : 0, t);
      }
      return;
    }

    // GATED input (or any non-input machine): the per-note ADSR envelope owns
    // ampGain. On INCIDENTAL calls (mute toggle, re-render, fromJSON) we must
    // NOT cancel/pin it — that would wipe a still-ringing note's scheduled
    // release and freeze the gate OPEN. Only on an explicit `reset` (machine
    // swap, gate-mode toggle — including continuous→gated, which left the gate
    // pinned wide open at 1.0) do we force a clean closed baseline.
    if (!reset) return;
    for (const env of this._pool.envelopes) {
      const g = env.ampGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
    }
  }

  /**
   * Mute = silence the SEQUENCER for this track (pattern-fired notes), while
   * leaving live keyboard / MIDI-in / arp play audible. Enforced by
   * Sequencer._fireStep early-returning on `track.muted`; outputGain stays open
   * so live voices still pass. (Previously mute zeroed outputGain, killing live
   * play too.) A note already ringing when you hit mute finishes its tail —
   * mute only blocks the NEXT sequencer step, which matches Elektron behaviour.
   */
  /**
   * Enable live audio capture on EVERY voice slot's InputMachine, not just the
   * canonical slot 0. The pool round-robins voices, so in note-gated mode each
   * key press may land on any slot — every slot needs the stream or only the
   * first note (slot 0) sounds. All slots acquire the SAME shared source node
   * (ref-counted by the InputMachine stream manager), so this is one stream
   * fanned out, not N microphones. No-op on non-input machines.
   * @returns {Promise<boolean>} success of the canonical (slot-0) acquire
   */
  async enableInput() {
    if (this.machine?.type !== 'input') return false;
    const machines = this._pool?.machines ?? [this.machine];
    // Mirror the canonical device selection to every slot first.
    const dev = this.machine.getDevice();
    const results = await Promise.all(machines.map(async (m) => {
      if (m !== this.machine) await m.setDevice(dev);
      return m.enableInput();
    }));
    this._applyInputGate();
    return results[0] ?? false;
  }

  /** Disable live capture on every slot's InputMachine. No-op on other types. */
  disableInput() {
    if (this.machine?.type !== 'input') return;
    for (const m of (this._pool?.machines ?? [])) m.disableInput?.();
    this._applyInputGate();
  }

  mute() {
    this.muted = true;
    this._applyInputGate();   // continuous input has no notes — mute must silence it
  }

  unmute() {
    this.muted = false;
    this._applyInputGate();   // re-open a continuous-input gate that mute closed
  }

  setHold(on) {
    this.held = !!on;
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

  /**
   * The current FX pipeline order — an array of block ids (e.g.
   * ['delay','crush','chorus','reverb']). Returns a copy.
   * @returns {string[]}
   */
  getFXOrder() {
    return [...this._fxOrder];
  }

  /** Block ids known to this track (registry keys), in registry order. */
  getFXBlockIds() {
    return Object.keys(this._fxBlocks);
  }

  /** Resolve a block id → its FX block (bare FX or FXInstance proxy), or null. */
  getFXBlock(id) {
    return this._fxBlocks[id] ?? null;
  }

  /**
   * True if this block can be removed from the chain. Every block currently in
   * the chain is removable now — the base four can be dragged out too (they stay
   * registered with their bare paths for back-compat and can be re-added from the
   * Add menu). Added instances are removed permanently (full teardown).
   */
  isFXRemovable(id) {
    return !!this._fxBlocks[id] && this._fxOrder.includes(id);
  }

  /** True only for the four permanent base blocks (kept registered for back-compat). */
  isFXBase(id) {
    return this._fxBaseIds.includes(id);
  }

  /**
   * Block ids that exist (registered) but are NOT currently in the chain — i.e.
   * base blocks the user dragged out. These are offered in the Add menu so they
   * can rejoin the chain with their original id (and their existing params).
   * @returns {string[]}
   */
  getDetachedBaseIds() {
    return this._fxBaseIds.filter(id => !this._fxOrder.includes(id));
  }

  /** The block type for an id ('delay'|'crush'|…|'filter'). */
  getFXType(id) {
    const blk = this._fxBlocks[id];
    if (!blk) return null;
    if (blk.type) return blk.type;          // FXInstance carries its type
    return id;                              // base blocks: id === type
  }

  /**
   * Add a new FX instance of `type` to the end of the chain. Wrapped in an
   * FXInstance so its param paths are namespaced ('fxN.<type>.<param>') and can
   * never collide with the base blocks or sibling instances.
   * @param {string} type — key of FX_TYPES
   * @returns {string|null} the new block id ('fxN'), or null if type unknown
   */
  addFX(type) {
    const Cls = FX_TYPES[type];
    if (!Cls) return null;
    const id = `fx${this._fxNextId++}`;
    const fx = new Cls(this.audio.context);
    fx.setBpm?.(this.clock.bpm);
    const inst = new FXInstance(fx, Number(id.slice(2)), type);
    this._fxBlocks[id] = inst;
    this._fxOrder.push(id);
    this._rewireFXChain();
    this.sequencer?.invalidatePlockModeMap();
    return id;
  }

  /**
   * Rebuild the added FX instances from saved JSON (toJSON().fxInstances). Tears
   * down any current added instances first, then recreates each with its SAVED
   * id (so namespaced p-lock / LFO paths still resolve) and bumps the id counter
   * past the highest restored id. Does not touch fxOrder — the caller applies it.
   * @param {Array<{id:number,type:string,params:object,enabled:boolean}>} list
   */
  _restoreFXInstances(list) {
    // Drop existing added instances (added ids start with 'fx'; base blocks are
    // never torn down — they stay registered).
    for (const id of Object.keys(this._fxBlocks)) {
      if (!this._fxBaseIds.includes(id)) {
        // destroy() — these instances are being thrown away, so kill any worklet.
        try { this._fxBlocks[id]?.destroy?.(); } catch (_) {}
        delete this._fxBlocks[id];
      }
    }
    this._fxOrder = this._fxOrder.filter(id => !id.startsWith('fx'));
    let maxId = 0;
    for (const obj of list ?? []) {
      const Cls = FX_TYPES[obj.type];
      if (!Cls) continue;
      const numId = Number(obj.id) || (maxId + 1);
      const fx = new Cls(this.audio.context);
      fx.setBpm?.(this.clock.bpm);
      const inst = new FXInstance(fx, numId, obj.type);
      inst.fromJSON(obj);
      const blockId = `fx${numId}`;
      this._fxBlocks[blockId] = inst;
      this._fxOrder.push(blockId);
      if (numId > maxId) maxId = numId;
    }
    this._fxNextId = maxId + 1;
    this._rewireFXChain();
  }

  /**
   * Serialise just the FX subset of this track — the four base-block param sets,
   * the chain order, and the added instances. This is the shape an FX-pipeline
   * preset stores (a strict subset of toJSON()); see applyFXPreset() for the
   * inverse. Does NOT touch machine / filter / envelope / LFOs.
   * @returns {{delayFX:object,bitcrushFX:object,chorusFX:object,reverbFX:object,fxOrder:string[],fxInstances:object[]}}
   */
  exportFXPreset() {
    return {
      delayFX:     this.delayFX.toJSON(),
      bitcrushFX:  this.bitcrushFX.toJSON(),
      chorusFX:    this.chorusFX.toJSON(),
      reverbFX:    this.reverbFX.toJSON(),
      fxOrder:     [...this._fxOrder],
      fxInstances: this._fxOrder
        .filter(id => this.isFXRemovable(id) && !this.isFXBase(id))
        .map(id => this._fxBlocks[id].toJSON()),
    };
  }

  /**
   * Apply an FX preset (see exportFXPreset) to this track: restore the base-four
   * params, rebuild added instances, then apply the order. Order matters —
   * _restoreFXInstances MUST run before setFXOrder so the 'fxN' ids in the order
   * resolve. Clears any p-locks/LFOs that pointed at instances the preset drops
   * (handled by _restoreFXInstances tearing down the old instances).
   * @param {object} preset
   */
  applyFXPreset(preset) {
    if (!preset) return;
    this.delayFX.fromJSON(preset.delayFX ?? {});
    this.bitcrushFX.fromJSON(preset.bitcrushFX ?? {});
    this.chorusFX.fromJSON(preset.chorusFX ?? {});
    this.reverbFX.fromJSON(preset.reverbFX ?? {});
    this._restoreFXInstances(preset.fxInstances ?? []);
    this.setFXOrder(preset.fxOrder ?? [...this._fxBaseIds]);
    this.sequencer?.invalidatePlockModeMap();
  }

  /**
   * Audition an FX preset (or the dry signal) on the CURRENT machine: swap in the
   * preset's FX chain (or bypass all FX when `dry`), play a one-shot C4, then
   * restore the previous FX chain after the note's tail. Lets the user A/B a
   * pipeline against dry without committing. The machine/filter/envelope are
   * untouched — only the FX subset is swapped and restored.
   * @param {object|null} preset — an FXLibrary preset's `.fx`, or null for dry
   * @param {{dry?:boolean}} [opts]
   */
  auditionFXPreset(preset, { dry = false } = {}) {
    if (this.muted) return;
    const ctx  = this.audio.context;
    const prev = this.exportFXPreset();          // snapshot to restore after

    if (dry || !preset) {
      // Dry = every block bypassed (still wired; setEnabled(false) routes through).
      for (const id of this.getFXBlockIds()) this._fxBlocks[id]?.setEnabled?.(false);
    } else {
      this.applyFXPreset(preset);
    }

    // One-shot C4 blip, mirroring fireFollowNote's voice/envelope/LFO handling.
    const startTime  = ctx.currentTime + 0.015;
    const stopTime   = startTime + 0.5;
    const release    = this.envelope?.getParam('env.release') ?? 0.3;
    const oscOffTime = stopTime + release;

    const voice    = this._pool?.nextVoice(startTime) ?? null;
    const machine  = voice?.machine  ?? this.machine;
    const envelope = voice?.envelope ?? this.envelope;
    if (voice) voice.claim(oscOffTime);

    machine?.syncParamsAt?.(startTime);
    machine?.noteOn(60, 100, startTime, stopTime);
    machine?.noteOff(oscOffTime);
    envelope?.scheduleNote(startTime, stopTime, { note: 60, velocity: 100 });
    this.lfos?.forEach(lfo => {
      lfo.noteOn(startTime, stopTime, envelope?._params ?? {});
      lfo.noteOff(stopTime);
    });

    // Restore the prior FX chain once the tail (incl. any FX wash) has decayed.
    clearTimeout(this._auditionRestoreTimer);
    const restoreMs = (oscOffTime - ctx.currentTime + 1.2) * 1000;
    this._auditionRestoreTimer = setTimeout(() => this.applyFXPreset(prev), restoreMs);
  }

  /**
   * Remove an FX block from the chain.
   *  - Added instance ('fxN'): full teardown — detach from the graph, drop LFOs
   *    pointed at it, strip its p-locks, and delete it from the registry.
   *  - Base block (delay/crush/chorus/reverb): just pull it out of the chain
   *    order (it stays registered with its bare paths so existing projects /
   *    p-locks / presets keep resolving, and it can be re-added). The block is
   *    bypassed-by-removal: it's no longer wired into the signal path.
   * @param {string} id
   */
  removeFX(id) {
    if (!this.isFXRemovable(id)) return;

    // Drop any FX bind pointing at this block (it's leaving the chain).
    const bind = this.getFXBindFor(id);
    if (bind) this._fxBinds[bind] = null;

    if (this.isFXBase(id)) {
      // Base block: detach from the chain only, keep it registered.
      this._fxOrder = this._fxOrder.filter(x => x !== id);
      this._rewireFXChain();
      this.sequencer?.invalidatePlockModeMap();
      return;
    }

    const inst = this._fxBlocks[id];
    // Drop LFO connections whose dest path belongs to this instance.
    this.lfos?.forEach((lfo, i) => {
      const path = this._lfoDestPaths?.[i];
      if (path && path.startsWith(`${id}.`)) this.setLFODestination(i, '');
    });
    // Strip this instance's p-locks from every step.
    this.sequencer?.steps?.forEach(s => {
      for (const k of [...s.plocks.keys()]) {
        if (k.startsWith(`${id}.`)) s.plocks.delete(k);
      }
    });
    // destroy() (not just disconnect) so worklet-backed blocks kill their
    // processor on real removal. disconnect() is audio-detach only now — it must
    // NOT kill, because _rewireFXChain calls it on every chain change.
    try { inst?.destroy?.(); } catch (_) {}
    delete this._fxBlocks[id];
    this._fxOrder = this._fxOrder.filter(x => x !== id);
    this._rewireFXChain();
    this.sequencer?.invalidatePlockModeMap();
  }

  /**
   * Re-attach a previously-removed base block (delay/crush/chorus/reverb) to the
   * end of the chain. No-op if the id isn't a detached base block.
   * @param {string} id
   * @returns {string|null} the id if re-attached, else null
   */
  reattachBaseFX(id) {
    if (!this._fxBaseIds.includes(id)) return null;
    if (this._fxOrder.includes(id)) return null;
    if (!this._fxBlocks[id]) return null;
    this._fxOrder.push(id);
    this._rewireFXChain();
    this.sequencer?.invalidatePlockModeMap();
    return id;
  }

  // ── FX bind assignments (the four global FX keybinds) ──────

  /** The block id assigned to FX bind `n` (1–4), or null. */
  getFXBindBlock(n) {
    return this._fxBinds[n] ?? null;
  }

  /** The bind number (1–4) currently assigned to block `id`, or null. */
  getFXBindFor(id) {
    for (const n of [1, 2, 3, 4]) if (this._fxBinds[n] === id) return n;
    return null;
  }

  /**
   * Assign block `id` to FX bind `n` (1–4). Pass id=null to clear the bind.
   * Enforces the 1:1 rule: the block loses any other bind it held, and any block
   * previously on bind `n` is displaced.
   * @param {number} n
   * @param {string|null} id
   */
  setFXBind(n, id) {
    if (![1, 2, 3, 4].includes(n)) return;
    if (id) {
      // Clear this block from any other bind it currently holds.
      for (const k of [1, 2, 3, 4]) if (this._fxBinds[k] === id) this._fxBinds[k] = null;
    }
    this._fxBinds[n] = id ?? null;
  }

  /**
   * Toggle the block assigned to FX bind `n` (1–4) on this track. No-op if the
   * bind is unassigned or its block has gone. Returns the block toggled, or null.
   * @param {number} n
   */
  toggleFXBind(n) {
    const id = this._fxBinds[n];
    if (!id) return null;
    const fx = this._fxBlocks[id];
    if (!fx?.setEnabled) return null;
    fx.setEnabled(!fx.enabled);
    return fx;
  }

  /**
   * Resolve a param path → the FX block that owns it (base or instance), or
   * null. An instance path ('fx3.reverb.wet') matches by its 'fx3.' prefix; a
   * base path ('reverb.wet') matches the base block by its type prefix.
   */
  fxObjForPath(path) {
    if (typeof path !== 'string') return null;
    // Instance paths: 'fxN.<type>.<param>'.
    const m = path.match(/^(fx\d+)\./);
    if (m) return this._fxBlocks[m[1]] ?? null;
    // Base paths: dispatch by type prefix.
    if (path.startsWith('delay.'))  return this._fxBlocks.delay;
    if (path.startsWith('crush.'))  return this._fxBlocks.crush;
    if (path.startsWith('chorus.')) return this._fxBlocks.chorus;
    if (path.startsWith('reverb.')) return this._fxBlocks.reverb;
    return null;
  }

  /** All FX param descriptors across base + instance blocks (paths namespaced). */
  _allFXParams() {
    const out = [];
    for (const id of this._fxOrder) {
      const blk = this._fxBlocks[id];
      if (blk?.getParamList) out.push(...blk.getParamList());
    }
    return out;
  }

  /**
   * Set the FX pipeline order and rebuild the audio chain accordingly.
   * Accepts any permutation/subset of known block ids; unknown ids are dropped.
   *
   * Base blocks (delay/crush/chorus/reverb) absent from `order` stay absent — the
   * user can drag them out of the chain (they remain registered for back-compat
   * and re-add). Added instances ('fxN') absent from `order` are appended instead
   * of orphaned, since an instance in the registry but out of the graph would be
   * a dangling, unreachable node.
   * @param {string[]} order
   */
  setFXOrder(order) {
    const known = new Set(this.getFXBlockIds());
    const seen  = new Set();
    const next  = [];
    for (const id of order ?? []) {
      if (known.has(id) && !seen.has(id)) { next.push(id); seen.add(id); }
    }
    // Append any ADDED instances not named in `order` (never orphan an instance).
    // Base blocks are intentionally omittable, so they are NOT auto-appended.
    for (const id of this.getFXBlockIds()) {
      if (!seen.has(id) && !this._fxBaseIds.includes(id)) next.push(id);
    }
    this._fxOrder = next;
    this._rewireFXChain();
  }

  /**
   * (Re)build the per-track FX chain from `_fxOrder`:
   *   pannerNode → block[0] → block[1] → … → outputBus
   * Disconnects pannerNode and every block's output first, then reconnects in
   * order. Each FX block exposes the uniform inputNode/outputNode/connect()
   * interface, so reordering is pure rewiring — params, p-locks, LFO and mod-
   * wheel routing all target AudioParams by path and are unaffected by order.
   */
  _rewireFXChain() {
    // Tear down existing connections from the panner and all blocks.
    try { this.pannerNode.disconnect(); } catch (_) {}
    for (const id of this.getFXBlockIds()) {
      try { this._fxBlocks[id].disconnect(); } catch (_) {}
    }

    // Reconnect in order: panner → first block, block → next block, last → bus.
    let prev = this.pannerNode;
    for (const id of this._fxOrder) {
      const fx = this._fxBlocks[id];
      if (!fx) continue;
      prev.connect(fx.inputNode);
      prev = fx;            // FX expose .connect(dest) via their outputNode
    }
    prev.connect(this._outputBus);
  }

  /** Called by Project when BPM changes — propagates to synced FX and arpeggiator. */
  onBpmChanged(bpm) {
    this.delayFX.setBpm(bpm);
    this.reverbFX.setBpm(bpm);
    this.chorusFX.setBpm(bpm);   // BBD chorus rate has Hz↔BPM sync
    // Added delay/reverb instances are tempo-synced too (setBpm is a no-op on
    // FX that don't sync).
    for (const id of this._fxOrder) {
      if (!this.isFXBase(id)) this._fxBlocks[id]?.setBpm?.(bpm);
    }
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
    // Continuous live input is a monitor, not a ringing note — STOP/panic cuts
    // the instant of sound but the input keeps working, so re-arm its gate. The
    // stream itself is untouched (use the panel's toggle to actually stop it).
    this._applyInputGate();
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
    // bus can be GC'd and the nodes stop pulling on the graph. The last block in
    // _fxOrder feeds the bus; disconnect every block (order-independent) plus
    // the fixed upstream nodes.
    for (const id of this.getFXBlockIds()) {
      // dispose() is permanent (deck unload) → destroy() to kill worklets and free
      // CPU; base blocks have no destroy(), so fall back to disconnect().
      const blk = this._fxBlocks[id];
      try { (blk?.destroy ?? blk?.disconnect)?.call(blk); } catch (_) {}
    }
    try { this.pannerNode?.disconnect?.(); } catch (_) {}
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
      { obj: this.machine, params: this.machine.getParamList() },
      { obj: this.filter,  params: this.filter.getParamList()  },
    ];
    for (const { obj, params } of sources) {
      const descriptor = params.find(p => p.path === path && p.modulatable);
      if (!descriptor) continue;
      const audioParam = obj.resolveAudioParam?.(path) ?? null;
      // JS-only params (no AudioParam) are still controllable via setParam directly
      return { obj, audioParam, min: descriptor.lfoMin, max: descriptor.lfoMax };
    }
    // FX blocks (base + added instances) — owner resolved by path namespace.
    const fxObj = this.fxObjForPath(path);
    if (fxObj) {
      const descriptor = fxObj.getParamList().find(p => p.path === path && p.modulatable);
      if (descriptor) {
        const audioParam = fxObj.resolveAudioParam?.(path) ?? null;
        return { obj: fxObj, audioParam, min: descriptor.lfoMin, max: descriptor.lfoMax };
      }
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
      ...this._allFXParams(),                 // base + added FX (namespaced paths)
      ...this._envelopeModulatableParams(),
    ];
    const descriptor = allParams.find(p => p.path === path && p.modulatable);
    if (!descriptor) return null;

    // Try slot-0 machine, then filter, then the FX block owning this path.
    let audioParam = this.machine.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.filter.resolveAudioParam?.(path) ?? null;
    if (!audioParam) audioParam = this.fxObjForPath(path)?.resolveAudioParam?.(path) ?? null;
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
    this.chorusFX.fromJSON({});
    this.reverbFX.fromJSON({});

    // Remove all added FX instances and restore the default base-four order.
    this._restoreFXInstances([]);
    this.setFXOrder([...this._fxBaseIds]);
    this._fxBinds = { 1: null, 2: null, 3: null, 4: null };

    // Drop back to the clean digital flow: restores the biquad filter engine
    // and disables the BBD chorus, keeping engine + chorus enable consistent.
    this.setAnalogue(false);

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

    // Reset mute + hold
    if (this.muted) this.unmute();
    if (this.held)  this.setHold(false);
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

    // One LFO-destination group per FX block (base + added instances), in chain
    // order. Group label = the type label, suffixed with the instance number for
    // added instances so duplicates are distinguishable (e.g. "Reverb 2").
    const seenType = {};
    const fxGroups = [];
    for (const id of this._fxOrder) {
      const blk = this._fxBlocks[id];
      if (!blk?.getParamList) continue;
      const type  = this.getFXType(id);
      const items = blk.getParamList()
        .filter(p => p.modulatable)
        .map(p => ({ path: p.path, label: p.label }));
      if (!items.length) continue;
      seenType[type] = (seenType[type] ?? 0) + 1;
      const base  = FX_TYPE_LABELS[type] ?? type;
      const label = this._fxBaseIds.includes(id) ? base : `${base} ${seenType[type]}`;
      fxGroups.push({ group: label, items });
    }

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
    for (const g of fxGroups) groups.push(g);
    if (this.arp.enabled)    groups.push({ group: 'Arp', items: arpItems });
    return groups;
  }

  /**
   * Like getAssignableParams() but restricted to LFO-valid destinations. The LFO
   * connects to an AudioParam (or a recognised JS-only target like trig.tone/
   * arp.rate); a composite FX param with no AudioParam (e.g. comb.freq, pan.shape,
   * tape.wow) can't be LFO-driven, so it is dropped here — while staying available
   * to the mod-wheel / MIDI-CC dropdowns (those apply via setParam and DO support
   * such params). Empty groups are removed.
   */
  getLFOAssignableParams() {
    return this.getAssignableParams()
      .map(g => ({
        group: g.group,
        items: g.items.filter(it => this._resolveAudioParam(it.path) != null),
      }))
      .filter(g => g.items.length);
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
      fxOrder:      [...this._fxOrder],
      // Added FX instances (base four serialise via their own fields above). Each
      // carries { id, type, params, enabled }; restored before applying fxOrder.
      fxInstances:  this._fxOrder
        .filter(id => this.isFXRemovable(id) && !this.isFXBase(id))
        .map(id => this._fxBlocks[id].toJSON()),
      fxBinds:      { ...this._fxBinds },
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

    // Re-apply the Input continuous/gated amp gate now that the restored
    // input.gate value is in place (setMachine above ran before fromJSON, so it
    // saw the default gate). reset: load is an explicit clean-baseline intent.
    // No-op for non-input machines.
    this._applyInputGate({ reset: true });

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

    // Rebuild added FX instances (must precede setFXOrder so the order's ids
    // resolve). No-op for legacy projects without fxInstances.
    this._restoreFXInstances(obj.fxInstances ?? []);

    // FX pipeline order. Absent in legacy projects → keep the default chain.
    this.setFXOrder(obj.fxOrder ?? this._fxOrder);

    // FX bind assignments (1–4 → block id). Keep only binds whose block still
    // exists in the chain; absent in legacy projects → all unassigned.
    this._fxBinds = { 1: null, 2: null, 3: null, 4: null };
    const savedBinds = obj.fxBinds ?? {};
    for (const n of [1, 2, 3, 4]) {
      const id = savedBinds[n] ?? null;
      if (id && this._fxOrder.includes(id)) this._fxBinds[n] = id;
    }

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
