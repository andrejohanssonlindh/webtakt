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
 */

export class AudioEngine {
  constructor() {
    this.context = new AudioContext();

    // FX bus placeholder — passthrough for now
    this.fxBus = this.context.createGain();
    this.fxBus.gain.value = 1.0;

    // Master gain
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 0.8;

    // Signal flow: fxBus → masterGain → destination
    this.fxBus.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
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
