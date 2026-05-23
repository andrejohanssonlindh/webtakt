/**
 * SamplerPanel.js
 * ---------------
 * Custom SYNTH tab for SamplerMachine.
 *
 * Layout (top→bottom):
 *   [File picker button]  [Record button]  [sample name / status]
 *   [Waveform canvas — shows loaded buffer with start/end trim handles]
 *   [Params row: Start knob, End knob, Speed knob, Reverse toggle, Loop toggle, Level knob]
 *
 * Trim handles: two vertical lines on the waveform canvas that can be dragged left/right.
 * The canvas also shows the active region highlighted.
 *
 * Called by SynthPanel._renderSynth() when track.machine.type === 'sampler'.
 * Receives the standard panel context object.
 */

import { KnobWidget } from '../KnobWidget.js';

const WAVEFORM_H = 100; // canvas CSS height in px

export class SamplerPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} ctx  — panel context from SynthPanel._makePanelContext()
   * @param {import('../../state/SampleStore.js').SampleStore} sampleStore
   * @param {AudioContext} audioContext
   */
  constructor(container, ctx, sampleStore, audioContext) {
    this.container    = container;
    this.ctx          = ctx;
    this.sampleStore  = sampleStore;
    this.audioContext = audioContext;
    this.machine      = ctx.machine;

    this._recording   = false;
    this._mediaStream = null;
    this._mediaRec    = null;
    this._recChunks   = [];

    this._dragging    = null; // 'start' | 'end' | null
    this._canvasEl    = null;
    this._animFrame   = null;

    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'sampler-wrap';

    // ── Top bar: load / record / name ───────────────────────
    const topBar = document.createElement('div');
    topBar.className = 'sampler-topbar';

    // File picker
    const fileLabel = document.createElement('label');
    fileLabel.className = 'btn sampler-load-btn';
    fileLabel.textContent = 'LOAD FILE';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) this._loadFile(file);
    });
    fileLabel.appendChild(fileInput);
    topBar.appendChild(fileLabel);

    // Record button
    this._recBtn = document.createElement('button');
    this._recBtn.className = 'btn sampler-rec-btn';
    this._recBtn.textContent = '⏺ REC';
    this._recBtn.addEventListener('click', () => this._toggleRecord());
    topBar.appendChild(this._recBtn);

    // Sample name label
    this._nameEl = document.createElement('span');
    this._nameEl.className = 'sampler-name';
    this._nameEl.textContent = this.machine.sampleName || '(no sample)';
    topBar.appendChild(this._nameEl);

    wrap.appendChild(topBar);

    // ── Waveform canvas ─────────────────────────────────────
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'sampler-canvas-wrap';

    this._canvasEl = document.createElement('canvas');
    this._canvasEl.className = 'sampler-waveform';
    this._canvasEl.style.width   = '100%';
    this._canvasEl.style.height  = '100%';
    this._canvasEl.style.display = 'block';
    this._canvasEl.style.cursor  = 'ew-resize';

    canvasWrap.appendChild(this._canvasEl);
    wrap.appendChild(canvasWrap);

    // ── Params row ───────────────────────────────────────────
    const paramRow = document.createElement('div');
    paramRow.className = 'sampler-param-row';

    const m = this.machine;

    const addKnob = (path, label, min, max, fmt) => {
      const knob = new KnobWidget({
        label,
        min,
        max,
        value: m.getParam(path),
        size: 56,
        fmt,
        onChange: v => {
          this.ctx.writeValue(m, path, v, false);
          this._drawWaveform();
        },
        onRelease: () => {
          this.ctx.emitStep?.();
          this._drawWaveform();
        },
      });
      paramRow.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      return knob;
    };

    this._startKnob = addKnob('sample.start', 'START', 0, 1, v => Math.round(v * 100) + '%');
    this._endKnob   = addKnob('sample.end',   'END',   0, 1, v => Math.round(v * 100) + '%');
    addKnob('sample.speed', 'SPEED', 0.125, 4,  v => v.toFixed(2) + 'x');
    addKnob('sample.gain',  'GAIN',  0, 20,     v => v.toFixed(1) + 'x');
    addKnob('sample.root',  'ROOT',  0, 127,    v => this._midiName(Math.round(v)));
    addKnob('output.level', 'LEVEL', 0, 1,      v => Math.round(v * 100) + '%');

    // Toggles
    paramRow.appendChild(this._makeToggle('PITCH', 'sample.pitch'));
    paramRow.appendChild(this._makeToggle('REV',   'sample.reverse'));
    paramRow.appendChild(this._makeToggle('LOOP',  'sample.loop'));

    wrap.appendChild(paramRow);

    this.container.appendChild(wrap);

    // Initial draw — defer one frame so layout is settled
    requestAnimationFrame(() => {
      this._setupCanvas();
      this._drawWaveform();
    });

    // Re-draw on resize
    const ro = new ResizeObserver(() => {
      this._setupCanvas();
      this._drawWaveform();
    });
    ro.observe(canvasWrap);
    this.ctx.activeWidgets.push({ destroy: () => ro.disconnect() });

    // Drag on canvas for trim handles
    this._setupDrag();
  }

  _makeToggle(label, path) {
    const wrap = document.createElement('div');
    wrap.className = 'sampler-toggle';

    const btn = document.createElement('button');
    btn.className = 'btn sampler-toggle-btn' + (this.machine.getParam(path) ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const newVal = !this.machine.getParam(path);
      this.ctx.writeValue(this.machine, path, newVal, true);
      btn.classList.toggle('active', newVal);
    });

    const lbl = document.createElement('span');
    lbl.className = 'sampler-toggle-label';
    lbl.textContent = label;

    wrap.appendChild(btn);
    return wrap;
  }

  _setupCanvas() {
    const canvas = this._canvasEl;
    const wrap   = canvas.parentElement;
    const dpr    = window.devicePixelRatio || 1;
    const w      = wrap.clientWidth  || 400;
    const h      = wrap.clientHeight || WAVEFORM_H;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const gc = canvas.getContext('2d');
    gc.setTransform(1, 0, 0, 1, 0, 0); // reset before rescale
    gc.scale(dpr, dpr);
    this._canvasW = w;
    this._canvasH = h;
  }

  _drawWaveform() {
    const canvas = this._canvasEl;
    if (!canvas) return;

    const w   = this._canvasW || canvas.offsetWidth || 400;
    const h   = this._canvasH || WAVEFORM_H;
    const gc  = canvas.getContext('2d');

    gc.clearRect(0, 0, w, h);

    // Background
    gc.fillStyle = '#1a1a2e';
    gc.fillRect(0, 0, w, h);

    if (!this.machine.hasBuffer) {
      gc.fillStyle = '#555';
      gc.font = '13px monospace';
      gc.textAlign = 'center';
      gc.fillText('No sample loaded', w / 2, h / 2 + 5);
      return;
    }

    const buf = this.machine._buffer;
    const data = buf.getChannelData(0); // use channel 0 for display
    const numSamples = data.length;

    // Active region highlight
    const startX = this.machine.getParam('sample.start') * w;
    const endX   = this.machine.getParam('sample.end')   * w;
    gc.fillStyle = 'rgba(90, 180, 90, 0.12)';
    gc.fillRect(startX, 0, endX - startX, h);

    // Waveform
    const mid  = h / 2;
    const step = numSamples / w;

    gc.beginPath();
    gc.strokeStyle = '#4caf50';
    gc.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const from = Math.floor(x * step);
      const to   = Math.floor((x + 1) * step);
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      if (x === 0) gc.moveTo(x, y1);
      gc.lineTo(x, y1);
      gc.lineTo(x, y2);
    }
    gc.stroke();

    // Start handle — green line
    gc.strokeStyle = '#8bc34a';
    gc.lineWidth = 2;
    gc.beginPath();
    gc.moveTo(startX, 0);
    gc.lineTo(startX, h);
    gc.stroke();

    // End handle — amber line
    gc.strokeStyle = '#ffb300';
    gc.lineWidth = 2;
    gc.beginPath();
    gc.moveTo(endX, 0);
    gc.lineTo(endX, h);
    gc.stroke();

    // Labels
    gc.font = '10px monospace';
    gc.fillStyle = '#8bc34a';
    gc.textAlign = startX < 30 ? 'left' : 'right';
    gc.fillText('S', startX + (startX < 30 ? 3 : -3), 12);
    gc.fillStyle = '#ffb300';
    gc.textAlign = endX > w - 30 ? 'right' : 'left';
    gc.fillText('E', endX + (endX > w - 30 ? -3 : 3), 12);
  }

  _setupDrag() {
    const canvas = this._canvasEl;
    if (!canvas) return;

    const getPos = e => {
      const rect = canvas.getBoundingClientRect();
      return (e.clientX - rect.left) / rect.width;
    };

    const SNAP = 0.01; // snap zone near handles

    canvas.addEventListener('mousedown', e => {
      const pos   = getPos(e);
      const start = this.machine.getParam('sample.start');
      const end   = this.machine.getParam('sample.end');

      if (Math.abs(pos - start) < SNAP) {
        this._dragging = 'start';
      } else if (Math.abs(pos - end) < SNAP) {
        this._dragging = 'end';
      } else if (pos < start + (end - start) / 2) {
        this._dragging = 'start';
      } else {
        this._dragging = 'end';
      }
      e.preventDefault();
    });

    const onMove = e => {
      if (!this._dragging) return;
      const pos = Math.max(0, Math.min(1, getPos(e)));
      const path = this._dragging === 'start' ? 'sample.start' : 'sample.end';
      this.ctx.writeValue(this.machine, path, pos, false);
      this._drawWaveform();
    };

    const onUp = () => {
      if (this._dragging) {
        this._dragging = null;
        this.ctx.emitStep?.();
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);

    // Clean up listeners when panel is destroyed
    this.ctx.activeWidgets.push({
      destroy: () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
    });
  }

  // ── File loading ─────────────────────────────────────────────

  async _loadFile(file) {
    this._nameEl.textContent = 'Loading…';
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);

      const { id } = this.sampleStore.save(file.name, audioBuf);
      this.machine.setBuffer(audioBuf, id, file.name);
      this._autoTrim(audioBuf);

      this._nameEl.textContent = file.name;
      this._drawWaveform();
    } catch (err) {
      this._nameEl.textContent = 'Load error';
      console.error('SamplerPanel: failed to load file', err);
    }
  }

  // ── Recording ────────────────────────────────────────────────

  async _toggleRecord() {
    if (this._recording) {
      this._stopRecord();
    } else {
      await this._startRecord();
    }
  }

  async _startRecord() {
    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      this._nameEl.textContent = 'Mic denied';
      return;
    }

    this._recChunks = [];
    this._mediaRec  = new MediaRecorder(this._mediaStream);
    this._mediaRec.ondataavailable = e => {
      if (e.data.size > 0) this._recChunks.push(e.data);
    };
    this._mediaRec.onstop = () => this._onRecordStop();

    this._mediaRec.start();
    this._recording = true;
    this._recBtn.textContent = '⏹ STOP';
    this._recBtn.classList.add('recording');
    this._nameEl.textContent = 'Recording…';
  }

  _stopRecord() {
    if (!this._mediaRec) return;
    this._mediaRec.stop();
    this._mediaStream?.getTracks().forEach(t => t.stop());
    this._mediaStream = null;
    this._recording  = false;
    this._recBtn.textContent = '⏺ REC';
    this._recBtn.classList.remove('recording');
  }

  async _onRecordStop() {
    this._nameEl.textContent = 'Processing…';
    const blob      = new Blob(this._recChunks, { type: 'audio/webm' });
    const arrayBuf  = await blob.arrayBuffer();
    try {
      const audioBuf  = await this.audioContext.decodeAudioData(arrayBuf);
      const name      = 'mic-recording-' + new Date().toISOString().slice(11, 19) + '.wav';
      const { id }    = this.sampleStore.save(name, audioBuf);
      this.machine.setBuffer(audioBuf, id, name);
      this._autoTrim(audioBuf);
      this._nameEl.textContent = name;
      this._drawWaveform();
    } catch (err) {
      this._nameEl.textContent = 'Record error';
      console.error('SamplerPanel: failed to decode recording', err);
    }
  }

  // ── Auto-trim ────────────────────────────────────────────────

  /**
   * Scan all channels of an AudioBuffer, find where audio meaningfully
   * starts and ends, and set sample.start / sample.end accordingly.
   *
   * Algorithm:
   *   - Threshold: RMS of a small window must exceed THRESH_DB dBFS.
   *   - Scan forward for first window above threshold → start.
   *   - Scan backward for last window above threshold → end.
   *   - Add a small pad (PAD_SEC) around each edge so attack/release aren't clipped.
   *   - If no signal found above threshold, leave trim at 0/1 (no change).
   */
  _autoTrim(buffer) {
    const THRESH_LINEAR = 0.008; // ~−42 dBFS — catches even quiet content
    const PAD_SEC       = 0.01;  // 10 ms pad on each side
    const WINDOW_FRAMES = Math.floor(buffer.sampleRate * 0.005); // 5 ms RMS window

    const numFrames = buffer.length;
    const numCh     = buffer.numberOfChannels;

    // Build a mono peak envelope (max abs across channels per frame)
    const peak = new Float32Array(numFrames);
    for (let ch = 0; ch < numCh; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < numFrames; i++) {
        const v = Math.abs(data[i]);
        if (v > peak[i]) peak[i] = v;
      }
    }

    // RMS over a sliding window
    const rmsAbove = i => {
      let sum = 0;
      const from = Math.max(0, i - WINDOW_FRAMES);
      const to   = Math.min(numFrames, i + WINDOW_FRAMES);
      for (let j = from; j < to; j++) sum += peak[j] * peak[j];
      const rms = Math.sqrt(sum / (to - from));
      return rms >= THRESH_LINEAR;
    };

    // Forward scan
    let startFrame = 0;
    for (let i = 0; i < numFrames; i++) {
      if (rmsAbove(i)) { startFrame = i; break; }
    }

    // Backward scan
    let endFrame = numFrames;
    for (let i = numFrames - 1; i >= 0; i--) {
      if (rmsAbove(i)) { endFrame = i; break; }
    }

    // If we found no signal (startFrame === 0 and endFrame === numFrames and no content), skip
    if (startFrame === 0 && endFrame === numFrames) return;

    // Apply pad
    const padFrames = Math.floor(PAD_SEC * buffer.sampleRate);
    startFrame = Math.max(0,          startFrame - padFrames);
    endFrame   = Math.min(numFrames,  endFrame   + padFrames);

    const startNorm = startFrame / numFrames;
    const endNorm   = endFrame   / numFrames;

    this.machine.setParam('sample.start', startNorm);
    this.machine.setParam('sample.end',   endNorm);
    this._startKnob?.setValue(startNorm);
    this._endKnob?.setValue(endNorm);
  }

  /** Convert MIDI note number to name like C4, F#3. */
  _midiName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }
}
