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
    // latencyHint 'interactive' asks the platform for the smallest stable
    // output buffer — matters for live monitoring through the Input machine
    // (InputMachine.js). Browsers still impose ~20-60ms+ round-trip; see
    // baseLatency/outputLatency getters and design/input-machine.md.
    //
    // BUT on Android (e.g. OnePlus 9 Pro) 'interactive' makes Chrome open the
    // audio device at a low "telephony" sample rate (~8–24 kHz) to chase the
    // smallest buffer — everything then sounds like a really low-bitrate file
    // (grainy/distorted). Desktop honours interactive at full 44.1/48 kHz, so
    // it never showed there. Fix: PIN a full-quality sample rate. The latency
    // hint stays at its spec default (still 'interactive', so live monitoring
    // latency is unchanged) — pinning the rate just stops the platform from
    // dropping to telephony quality in pursuit of that low latency. We try
    // 48000 first (the common Android-native rate, avoids a resample), then fall
    // back progressively if a device rejects the requested rate.
    const tryContext = (opts) => { try { return new AudioContext(opts); } catch (_) { return null; } };
    this.context =
         tryContext({ sampleRate: 48000 })
      ?? tryContext({ sampleRate: 44100 })
      ?? tryContext({})            // let the platform choose its native rate
      ?? new AudioContext();       // last resort (older browsers w/o options arg)

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
