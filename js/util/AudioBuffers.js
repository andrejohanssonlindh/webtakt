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
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
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
