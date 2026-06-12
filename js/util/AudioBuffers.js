/**
 * AudioBuffers.js
 * ---------------
 * Shared buffer factory for machines that need white noise.
 *
 * Each machine keeps its own module-scoped reference so buffers are
 * isolated per machine type (different durations). Pass the desired
 * duration in seconds; the buffer is lazily created and cached until
 * the sample rate changes.
 */

// ── Noise random source ──────────────────────────────────────────────────────
// The random source used to FILL noise buffers (white here, pink in
// AnalogueParts). Defaults to Math.random so the app keeps full per-load and
// per-voice variation — analogue voices must not be carbon copies, and the
// moogish/patina hiss must differ across the 8-voice pool. The test harness calls
// seedNoiseRandom() ONCE before rendering so noise-buffer content is deterministic
// (peak/RMS reproducible → no flaky audio tests); restoreNoiseRandom() reverts.
// Determinism is therefore a test-only concern; production audio is unchanged.
let _noiseRandom = Math.random;

/** Current noise random value in [0, 1). Used by getNoiseBuffer + makePinkBuffer. */
export function noiseRandomValue() { return _noiseRandom(); }

/** Install a seeded PRNG for noise buffers (test harness only). */
export function seedNoiseRandom(seed = 0x1234abcd) {
  let a = seed >>> 0;
  _noiseRandom = function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Restore Math.random as the noise source. */
export function restoreNoiseRandom() {
  _noiseRandom = Math.random;
}

/**
 * Return a mono white-noise AudioBuffer of the requested duration.
 * The returned buffer is cached by the calling module (pass the cache
 * slot as `cache` — an object with a single `buf` property).
 *
 * @param {AudioContext} context
 * @param {{ buf: AudioBuffer|null }} cache  — module-level { buf: null } object
 * @param {number} durationSeconds
 * @returns {AudioBuffer}
 */
export function getNoiseBuffer(context, cache, durationSeconds) {
  if (cache.buf && cache.buf.sampleRate === context.sampleRate) return cache.buf;
  const length = Math.ceil(context.sampleRate * durationSeconds);
  const buf    = context.createBuffer(1, length, context.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = noiseRandomValue() * 2 - 1;
  cache.buf = buf;
  return buf;
}

// Shared 1-sample silent buffer used by scheduleCallback (one per context is enough,
// but we cache per context via a WeakMap to stay GC-friendly).
const _silentBufCache = new WeakMap();
function _getSilentBuf(context) {
  let buf = _silentBufCache.get(context);
  if (!buf) {
    buf = context.createBuffer(1, 1, context.sampleRate);
    _silentBufCache.set(context, buf);
  }
  return buf;
}

/**
 * Fire `fn` at AudioContext time `atTime` using a 1-sample silent
 * AudioBufferSourceNode whose `onended` fires precisely on the audio thread.
 * This avoids wall-clock setTimeout drift for post-note node cleanup.
 *
 * @param {AudioContext} context
 * @param {number} atTime   — AudioContext.currentTime value
 * @param {Function} fn
 */
export function scheduleCallback(context, atTime, fn) {
  const src = context.createBufferSource();
  src.buffer = _getSilentBuf(context);
  // No destination needed — onended fires regardless of graph connection
  src.onended = fn;
  src.start(atTime);
  src.stop(atTime);
}
