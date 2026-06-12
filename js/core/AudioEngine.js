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

const LADDER_WORKLET_PATH = 'js/worklets/patina-ladder-processor.js';

export class AudioEngine {
  constructor() {
    this.context = new AudioContext();

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
}
