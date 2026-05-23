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
