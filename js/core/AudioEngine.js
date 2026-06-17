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

import { settings, SAMPLE_RATE_OPTIONS, resolveLatencyHint } from '../state/Settings.js';

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

    // Sample rate + latency hint come from user settings (Settings.js), applied
    // here because both are fixed at context creation and can't change on a live
    // context. Background: pinning a HIGH rate + a buffer-minimising latency hint
    // on weak phone CPUs (OnePlus 9 Pro, Galaxy S22) causes buffer UNDERRUNS —
    // crackle / a "2-bit" gritty sound across every browser (they share the OS
    // audio stack). So the defaults are conservative: native rate, and a latency
    // hint that resolves to 'playback' (bigger buffer) on mobile-like devices and
    // 'interactive' (low latency) on desktop. Users can step the rate down or the
    // latency up from the Settings pane to chase crackle on a specific device.
    const opts = {};
    const rate = SAMPLE_RATE_OPTIONS.find(o => o.id === settings.get('audioSampleRate'))?.rate;
    if (rate) opts.sampleRate = rate;          // omit → platform-native rate
    opts.latencyHint = resolveLatencyHint(settings.get('audioLatency'));

    // A device may reject a requested sampleRate; fall back to native (no rate)
    // rather than failing to construct. Throws only if there's no AudioContext at
    // all (unrecoverable) — we let that propagate.
    const tryCtx = (o) => { try { return new Ctor(o); } catch (_) { return null; } };
    this.context = tryCtx(opts)
                ?? tryCtx({ latencyHint: opts.latencyHint })  // drop the rate, keep latency
                ?? new Ctor();

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
