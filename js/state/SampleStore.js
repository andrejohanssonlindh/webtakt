/**
 * SampleStore.js
 * --------------
 * Stores audio sample data in localStorage as base64-encoded blobs.
 * Keyed under 'webtakt_samples'.
 *
 * Each entry: { id, name, mimeType, data (base64), createdAt }
 *
 * Provides: save, load (→ AudioBuffer), delete, list.
 * The decoded AudioBuffer is also cached in memory so reload is instant.
 *
 * Size note: localStorage typically allows ~5MB. Large samples will exceed
 * this; the store silently falls back to memory-only (no persistence warning
 * is shown — see save() return value).
 */

const STORAGE_KEY = 'webtakt_samples';

export class SampleStore {
  constructor() {
    this._meta  = this._loadMeta();
    // id → AudioBuffer (decoded, in-memory cache)
    this._cache = new Map();
  }

  /** @returns {{ id, name, createdAt }[]} */
  list() {
    return this._meta.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  /**
   * Save an AudioBuffer to the store.
   * Encodes as WAV (PCM16), then base64.
   * @param {string} name
   * @param {AudioBuffer} buffer
   * @returns {{ id: string, persisted: boolean }}
   */
  save(name, buffer) {
    const id       = 'smp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const wavBytes = _bufferToWav(buffer);
    const b64      = _uint8ToBase64(wavBytes);

    this._cache.set(id, buffer);

    const entry = { id, name, mimeType: 'audio/wav', data: b64, createdAt: Date.now() };
    this._meta.push({ id, name, createdAt: entry.createdAt });

    let persisted = true;
    try {
      const all = this._loadAll();
      all.push(entry);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      this._persistMeta();
    } catch (_) {
      persisted = false;
    }

    return { id, persisted };
  }

  /**
   * Decode a saved sample into an AudioBuffer.
   * @param {string} id
   * @param {AudioContext} context
   * @returns {Promise<AudioBuffer|null>}
   */
  async load(id, context) {
    if (this._cache.has(id)) return this._cache.get(id);

    const all   = this._loadAll();
    const entry = all.find(e => e.id === id);
    if (!entry) return null;

    const bytes = _base64ToUint8(entry.data);
    try {
      const buf = await context.decodeAudioData(bytes.buffer.slice(0));
      this._cache.set(id, buf);
      return buf;
    } catch (_) {
      return null;
    }
  }

  /** Remove a sample by id. */
  delete(id) {
    this._cache.delete(id);
    this._meta = this._meta.filter(m => m.id !== id);
    try {
      const all = this._loadAll().filter(e => e.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      this._persistMeta();
    } catch (_) {}
  }

  _loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
  }

  _loadMeta() {
    return this._loadAll().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  _persistMeta() {
    // Meta is embedded in the main key — nothing separate to persist
  }
}

// ── WAV encoder ────────────────────────────────────────────────────────────

/** Encode an AudioBuffer to a PCM16 WAV Uint8Array. */
function _bufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate  = buffer.sampleRate;
  const numFrames   = buffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign  = numChannels * bytesPerSample;
  const byteRate    = sampleRate * blockAlign;
  const dataSize    = numFrames * blockAlign;
  const headerSize  = 44;
  const totalSize   = headerSize + dataSize;

  const view = new DataView(new ArrayBuffer(totalSize));

  // RIFF header
  _writeStr(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  _writeStr(view, 8, 'WAVE');
  _writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  _writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channel data
  let offset = headerSize;
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Uint8Array(view.buffer);
}

function _writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function _uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function _base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
