/**
 * BeatRepeatPanel.js
 * ------------------
 * SYNTH tab panel for BeatRepeatMachine.
 *
 * Layout:
 *   [LOAD FILE] [↺ RESET] [⏺ REC] [⤓ WAV]  name
 *   [Waveform — drag the capture region (START handle + LENGTH end handle)]
 *   [ROLL group: Rate (select), Repeats, Gate, Decay]
 *   [SLICE group: Start, Length, P.Ramp]
 *   [PLAYBACK group: Speed, Reverse]
 *   [OUTPUT group: Level]
 */

import { KnobWidget } from '../KnobWidget.js';
import { bufferToWav } from '../../state/SampleStore.js';
import { addBrowseButton } from './sampleBrowserButton.js';

const WAVEFORM_H = 100;

export class BeatRepeatPanel {
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

    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'sampler-wrap';

    // ── Top bar ──
    const topBar = document.createElement('div');
    topBar.className = 'sampler-topbar';

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

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn sampler-reset-btn';
    resetBtn.textContent = '↺ RESET';
    resetBtn.title = 'Clear sample and reset all settings to defaults';
    resetBtn.addEventListener('click', () => this._resetAll());
    topBar.appendChild(resetBtn);

    this._recBtn = document.createElement('button');
    this._recBtn.className = 'btn sampler-rec-btn';
    this._recBtn.textContent = '⏺ REC';
    this._recBtn.addEventListener('click', () => this._toggleRecord());
    topBar.appendChild(this._recBtn);

    this._dlBtn = document.createElement('button');
    this._dlBtn.className = 'btn sampler-dl-btn';
    this._dlBtn.textContent = '⤓ WAV';
    this._dlBtn.title = 'Download sample as WAV';
    this._dlBtn.addEventListener('click', () => this._downloadSample());
    topBar.appendChild(this._dlBtn);

    this._nameEl = document.createElement('span');
    this._nameEl.className = 'sampler-name';
    this._nameEl.textContent = this.machine.sampleName || '(no sample)';
    topBar.appendChild(this._nameEl);

    wrap.appendChild(topBar);

    // ── Waveform ──
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

    // ── Param groups ──
    const m = this.machine;
    const groupsRow = document.createElement('div');
    groupsRow.className = 'sampler-groups';
    wrap.appendChild(groupsRow);

    const makeGroup = (label) => {
      const g = document.createElement('div');
      g.className = 'param-group';
      const lbl = document.createElement('div');
      lbl.className = 'param-group-label';
      lbl.textContent = label;
      g.appendChild(lbl);
      const body = document.createElement('div');
      body.className = 'param-group-body';
      g.appendChild(body);
      groupsRow.appendChild(g);
      return body;
    };

    const addKnob = (dst, path, label, min, max, fmt) => {
      const knob = new KnobWidget({
        label, min, max,
        value: m.getParam(path),
        size: 56,
        fmt,
        onChange: v => {
          this.ctx.writeValue(m, path, v, false);
          if (path === 'sample.start' || path === 'length') this._drawWaveform();
        },
        onRelease: () => this.ctx.emitStep?.(),
      });
      dst.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      if (path === 'sample.start') this._startKnob  = knob;
      if (path === 'length')       this._lengthKnob = knob;
      return knob;
    };

    const rollG = makeGroup('ROLL');
    rollG.appendChild(this._makeRateSelect());
    addKnob(rollG, 'repeats', 'REPEATS', 1, 32, v => String(Math.round(v)));
    addKnob(rollG, 'gate',    'GATE',    0.05, 1, v => Math.round(v * 100) + '%');
    addKnob(rollG, 'decay',   'DECAY',   0, 1, v => Math.round(v * 100) + '%');

    const sliceG = makeGroup('SLICE');
    addKnob(sliceG, 'sample.start', 'START',  0, 1,   v => Math.round(v * 100) + '%');
    addKnob(sliceG, 'length',       'LENGTH', 0.001, 1, v => Math.round(v * 100) + '%');
    addKnob(sliceG, 'pitch.ramp',   'P.RAMP', -12, 12, v => (v >= 0 ? '+' : '') + Math.round(v) + 'st');

    const playG = makeGroup('PLAYBACK');
    addKnob(playG, 'sample.speed', 'SPEED', 0.125, 4, v => v.toFixed(2) + 'x');
    playG.appendChild(this._makeToggle('REV', 'sample.reverse'));

    const outG = makeGroup('OUTPUT');
    addKnob(outG, 'output.level', 'LEVEL', 0, 1, v => Math.round(v * 100) + '%');

    this.container.appendChild(wrap);
    addBrowseButton(this);

    requestAnimationFrame(() => { this._setupCanvas(); this._drawWaveform(); });
    const ro = new ResizeObserver(() => { this._setupCanvas(); this._drawWaveform(); });
    ro.observe(canvasWrap);
    this.ctx.activeWidgets.push({ destroy: () => ro.disconnect() });

    this._setupDrag();
  }

  _makeRateSelect() {
    const row = document.createElement('div');
    row.className = 'param-row sampler-toggle';
    const label = document.createElement('span');
    label.className = 'param-label label';
    label.textContent = 'RATE';
    const sel = document.createElement('select');
    sel.className = 'param-select';
    ['1/4', '1/8', '1/16', '1/32'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (this.machine.getParam('rate') === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.ctx.writeValue(this.machine, 'rate', sel.value, true);
    });
    row.appendChild(label);
    row.appendChild(sel);
    return row;
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
    wrap.appendChild(btn);
    return wrap;
  }

  // ── Canvas ──

  _setupCanvas() {
    const canvas = this._canvasEl;
    const wrap   = canvas.parentElement;
    const dpr    = window.devicePixelRatio || 1;
    const w      = wrap.clientWidth  || 400;
    const h      = wrap.clientHeight || WAVEFORM_H;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const gc = canvas.getContext('2d');
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.scale(dpr, dpr);
    this._canvasW = w;
    this._canvasH = h;
  }

  _drawWaveform() {
    this._refreshDownloadBtn();
    const canvas = this._canvasEl;
    if (!canvas) return;
    const w  = this._canvasW || canvas.offsetWidth || 400;
    const h  = this._canvasH || WAVEFORM_H;
    const gc = canvas.getContext('2d');

    gc.clearRect(0, 0, w, h);
    gc.fillStyle = '#1a1a2e';
    gc.fillRect(0, 0, w, h);

    if (!this.machine.hasBuffer) {
      gc.fillStyle = '#555';
      gc.font = '13px monospace';
      gc.textAlign = 'center';
      gc.fillText('No sample loaded', w / 2, h / 2 + 5);
      return;
    }

    const startN = this.machine.getParam('sample.start');
    const lenN   = this.machine.getParam('length');
    const startX = startN * w;
    const endX   = Math.min(1, startN + lenN) * w;

    // Capture region highlight (red — it's the bit that rolls).
    gc.fillStyle = 'rgba(230, 80, 80, 0.15)';
    gc.fillRect(startX, 0, endX - startX, h);

    // Waveform.
    const buf  = this.machine._buffer;
    const data = buf.getChannelData(0);
    const numSamples = data.length;
    const mid  = h / 2;
    const step = numSamples / w;
    gc.beginPath();
    gc.strokeStyle = '#ef7d7d';
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

    // Handles — START (green) + END/length (amber).
    gc.strokeStyle = '#8bc34a';
    gc.lineWidth = 2;
    gc.beginPath(); gc.moveTo(startX, 0); gc.lineTo(startX, h); gc.stroke();
    gc.strokeStyle = '#ffb300';
    gc.beginPath(); gc.moveTo(endX, 0); gc.lineTo(endX, h); gc.stroke();
  }

  _setupDrag() {
    const canvas = this._canvasEl;
    if (!canvas) return;
    const SNAP = 0.03;
    const getX = e => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / rect.width;
      return Math.max(0, Math.min(1, x));
    };
    const apply = abs => {
      const start = this.machine.getParam('sample.start');
      if (this._dragging === 'start') {
        const newStart = Math.min(abs, 0.999);
        // Keep the end fixed where possible: adjust length so end stays put.
        const oldEnd = Math.min(1, start + this.machine.getParam('length'));
        this.ctx.writeValue(this.machine, 'sample.start', newStart, false);
        const newLen = Math.max(0.001, oldEnd - newStart);
        this.ctx.writeValue(this.machine, 'length', newLen, false);
        this._startKnob?.setValue(newStart);
        this._lengthKnob?.setValue(newLen);
      } else { // 'end' → set length from start
        const newLen = Math.max(0.001, Math.min(1 - start, abs - start));
        this.ctx.writeValue(this.machine, 'length', newLen, false);
        this._lengthKnob?.setValue(newLen);
      }
      this._drawWaveform();
    };
    const down = e => {
      if (!this.machine.hasBuffer) return;
      const abs   = getX(e);
      const start = this.machine.getParam('sample.start');
      const end   = Math.min(1, start + this.machine.getParam('length'));
      if (Math.abs(abs - start) < SNAP && Math.abs(abs - start) <= Math.abs(abs - end)) this._dragging = 'start';
      else this._dragging = 'end';
      apply(abs);
      e.preventDefault();
    };
    const move = e => { if (this._dragging) apply(getX(e)); };
    const up   = () => { if (this._dragging) { this._dragging = null; this.ctx.emitStep?.(); } };

    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
    this.ctx.activeWidgets.push({
      destroy: () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchend', up);
      }
    });
  }

  // ── Download / load / record (parallel to SamplerPanel) ──

  _refreshDownloadBtn() {
    if (this._dlBtn) this._dlBtn.disabled = !this.machine.hasBuffer;
  }

  _downloadSample() {
    const buffer = this.machine.getBuffer?.();
    if (!buffer) return;
    const wav  = bufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url  = URL.createObjectURL(blob);
    const base = (this.machine.sampleName || 'sample').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url; a.download = `${base}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  _resetAll() {
    const track = this.ctx.getTrack?.();
    for (const p of this.machine.getParamList?.() ?? []) {
      if (p.default !== undefined) this.machine.setParam(p.path, p.default);
    }
    if (track?._pool?.clearSampleBuffers) track._pool.clearSampleBuffers();
    else this.machine.clearBuffer?.();
    track?._pool?.syncParams?.();
    this._nameEl.textContent = '(no sample)';
    if (this.ctx.renderContent) this.ctx.renderContent();
    else this._render();
  }

  async _loadFile(file) {
    this._nameEl.textContent = 'Loading…';
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
      const { id } = this.sampleStore.save(file.name, audioBuf);
      this.machine.setBuffer(audioBuf, id, file.name);
      this._nameEl.textContent = file.name;
      this._drawWaveform();
    } catch (err) {
      this._nameEl.textContent = 'Load error';
      console.error('BeatRepeatPanel: failed to load file', err);
    }
  }

  async _toggleRecord() {
    if (this._recording) this._stopRecord();
    else await this._startRecord();
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
    this._mediaRec.ondataavailable = e => { if (e.data.size > 0) this._recChunks.push(e.data); };
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
    const blob     = new Blob(this._recChunks, { type: 'audio/webm' });
    const arrayBuf = await blob.arrayBuffer();
    try {
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
      const name     = 'mic-recording-' + new Date().toISOString().slice(11, 19) + '.wav';
      const { id }   = this.sampleStore.save(name, audioBuf);
      this.machine.setBuffer(audioBuf, id, name);
      this._nameEl.textContent = name;
      this._drawWaveform();
    } catch (err) {
      this._nameEl.textContent = 'Record error';
      console.error('BeatRepeatPanel: failed to decode recording', err);
    }
  }
}
