/**
 * AudioEngine.js
 * --------------
 * Creates and owns the Web Audio API AudioContext.
 * Provides the master gain node and FX bus placeholder.
 * All audio nodes in the app connect (directly or indirectly) to AudioEngine.masterGain.
 *
 * Owns:    AudioContext, masterGain (GainNode), fxBus (GainNode placeholder)
 * Depends: nothing
 * Used by: Clock.js, Track.js (each track connects its output here)
 *
 * Public:
 *   .context          — the AudioContext instance
 *   .masterGain       — final gain node before destination
 *   .fxBus            — placeholder gain node (future: real FX graph lives here)
 *   .resume()         — resumes AudioContext after user gesture (browser requirement)
 *   .setMasterVolume(0–1)
 *   .ladderReady      — Promise resolving once the analogue ladder worklet module is loaded
 *   .ladderLoaded     — bool, true once the ladder worklet is registered
 */

const LADDER_WORKLET_PATH   = 'js/worklets/patina-ladder-processor.js';
// FX worklets registered at boot so `new AudioWorkletNode(ctx, 'bitcrush'|'stutter')`
// is synchronous by the time a user adds Crush+ / Stutter to a chain (always long
// after boot). Each FX block falls back to a dry passthrough if its node can't be
// constructed (see Crush2FX / StutterFX), so a slow/failed load never breaks audio.
const FX_WORKLET_PATHS = [
  'js/worklets/bitcrush-processor.js',
  'js/worklets/stutter-processor.js',
];

export class AudioEngine {
  constructor() {
    // iOS/older Safari only exposes the prefixed constructor. Resolve once so a
    // missing unprefixed AudioContext doesn't throw a ReferenceError at boot
    // (which would kill ALL audio AND freeze the oscilloscope — the analyser
    // never gets a context). patina.js already uses this same fallback.
    const Ctor = window.AudioContext || window.webkitAudioContext;

    // We deliberately do NOT request a buffer-minimising latency hint or pin a
    // high sample rate here. Earlier we pinned 48 kHz to dodge an Android Chrome
    // bug where the smallest-buffer chase opened the device at "telephony" rate
    // (grainy/distorted). But on weaker phone CPUs (OnePlus 9 Pro, Galaxy S22)
    // forcing 48 kHz + a tiny buffer just trades distortion for buffer UNDERRUNS
    // — the render thread can't keep up and you get crackle / a "2-bit" gritty
    // sound across every browser (Chrome/FF/Brave all share the platform audio
    // stack, so it reproduced everywhere). Letting the platform choose its own
    // native rate and buffer size is the stable default: no resample, no
    // telephony fallback, and a buffer the device can actually fill in time.
    // No options object → platform-native rate + default buffer (most stable on
    // mobile). Throws only if the browser has no AudioContext at all, which is
    // unrecoverable, so we let it propagate rather than swallow it silently.
    this.context = new Ctor();

    // Preload the analogue ladder filter worklet (Filter.js engine='analogue').
    // Fire-and-forget at boot: nothing awaits it, but by the time a user switches
    // a track's filter to analogue (always long after boot) the module is
    // registered, so `new AudioWorkletNode(ctx, 'patina-ladder')` is synchronous.
    this.ladderLoaded = false;
    this.ladderReady  = this.context.audioWorklet
      ? this.context.audioWorklet.addModule(LADDER_WORKLET_PATH)
          .then(() => { this.ladderLoaded = true; })
          .catch(err => { console.warn('AudioEngine: analogue ladder worklet load failed', err); })
      : Promise.resolve();

    // FX worklets (Crush+ / Stutter). Fire-and-forget like the ladder.
    this.fxWorkletsReady = this.context.audioWorklet
      ? Promise.all(FX_WORKLET_PATHS.map(path =>
          this.context.audioWorklet.addModule(path)
            .catch(err => console.warn('AudioEngine: FX worklet load failed', path, err))))
      : Promise.resolve();

    // FX bus placeholder — passthrough for now
    this.fxBus = this.context.createGain();
    this.fxBus.gain.value = 1.0;

    // Master gain
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 0.8;

    // Analyser — tapped in parallel from masterGain (does not affect audio path)
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;

    // Signal flow: fxBus → masterGain → destination
    //                                 ↘ analyser (parallel, silent branch)
    this.fxBus.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
    this.masterGain.connect(this.analyser);
  }

  /** Call once on first user gesture to unblock AudioContext. */
  resume() {
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
  }

  /** @param {number} value — 0.0 to 1.0 */
  setMasterVolume(value) {
    this.masterGain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  /**
   * Estimated input→output round-trip latency in seconds, or null if the
   * browser doesn't expose the figures. Used by InputPanel to show the user
   * the real monitoring latency rather than a guess. baseLatency is the
   * AudioContext's own processing buffer; outputLatency includes the OS/device
   * path. We sum what's available (both are read-only browser estimates).
   * @returns {number|null}
   */
  getLatencySeconds() {
    const base = typeof this.context.baseLatency === 'number' ? this.context.baseLatency : null;
    const out  = typeof this.context.outputLatency === 'number' ? this.context.outputLatency : null;
    if (base == null && out == null) return null;
    return (base ?? 0) + (out ?? 0);
  }
}
