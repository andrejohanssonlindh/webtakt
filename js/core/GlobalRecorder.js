/**
 * GlobalRecorder.js
 * -----------------
 * Records the master audio output to a downloadable file.
 *
 * Taps a MediaStreamDestinationNode inserted just before AudioContext.destination.
 * Uses MediaRecorder to capture the stream as audio/webm (Opus) or audio/ogg,
 * whichever the browser supports. Falls back to the first supported type.
 *
 * Usage:
 *   const rec = new GlobalRecorder(audioEngine);
 *   rec.start();
 *   // ... audio plays ...
 *   rec.stop();  // resolves the blob
 *   rec.save('my-song');  // triggers browser download
 *
 * Public:
 *   .recording        — boolean, true while capturing
 *   .start()          — begin capture
 *   .stop()           — end capture, returns Promise<Blob>
 *   .save(filename)   — download last recording (call after stop resolves)
 *   .blob             — the last recorded Blob (null until first stop)
 */
export class GlobalRecorder {
  /** @param {import('./AudioEngine.js').AudioEngine} audioEngine */
  constructor(audioEngine) {
    this._ctx         = audioEngine.context;
    this._masterGain  = audioEngine.masterGain;

    // Insert a MediaStreamDestinationNode in parallel (does not interrupt playback)
    this._dest = this._ctx.createMediaStreamDestination();
    this._masterGain.connect(this._dest);

    this._recorder   = null;
    this._chunks     = [];
    this.recording   = false;
    this.blob        = null;
    this._stopResolve = null;
  }

  /** Start recording. Throws if already recording. */
  start() {
    if (this.recording) throw new Error('GlobalRecorder: already recording');

    const mimeType = _pickMime();
    const options  = mimeType ? { mimeType } : {};
    this._recorder = new MediaRecorder(this._dest.stream, options);
    this._chunks   = [];
    this.blob      = null;

    this._recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };

    this._recorder.onstop = () => {
      const type = this._recorder.mimeType || 'audio/webm';
      this.blob  = new Blob(this._chunks, { type });
      this.recording = false;
      if (this._stopResolve) { this._stopResolve(this.blob); this._stopResolve = null; }
    };

    this._recorder.start(100); // collect chunks every 100 ms
    this.recording = true;
  }

  /**
   * Stop recording.
   * @returns {Promise<Blob>} resolves with the recorded audio blob
   */
  stop() {
    if (!this.recording) return Promise.resolve(this.blob);
    return new Promise(resolve => {
      this._stopResolve = resolve;
      this._recorder.stop();
    });
  }

  /**
   * Trigger a browser download of the last recording.
   * @param {string} [filename='webtakt-recording']
   */
  save(filename = 'webtakt-recording') {
    if (!this.blob) return;
    const ext = _extForMime(this.blob.type);
    const url = URL.createObjectURL(this.blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename.endsWith(ext) ? filename : filename + ext;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function _pickMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function _extForMime(mime) {
  if (mime.includes('ogg'))  return '.ogg';
  if (mime.includes('webm')) return '.webm';
  return '.webm';
}
