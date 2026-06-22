/**
 * SlicerPanel.js
 * --------------
 * SYNTH tab panel for SlicerMachine.
 *
 * Layout (top→bottom):
 *   [LOAD FILE] [↺ RESET] [⏺ REC] [⤓ WAV]  name
 *   [Waveform canvas — slice grid drawn as vertical dividers; click a slice to
 *    select it (sets SLICE and flips SLICE BY → fixed). Active slice highlighted.]
 *   [SLICES group: Slices, Slice, SliceBy, Base]
 *   [PLAYBACK group: Gate, Speed, Gain, Reverse, Loop]
 *   [OUTPUT group: Level]
 */

import { KnobWidget } from '../KnobWidget.js';
import { bufferToWav } from '../../state/SampleStore.js';
import { addBrowseButton } from './sampleBrowserButton.js';

const WAVEFORM_H = 100;

export class SlicerPanel {
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
    this._canvasEl    = null;
    this._dragging    = null; // 'start' | 'end' | 'slice' | null

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

    // ── Waveform canvas ──
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'sampler-canvas-wrap';
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.className = 'sampler-waveform';
    this._canvasEl.style.width   = '100%';
    this._canvasEl.style.height  = '100%';
    this._canvasEl.style.display = 'block';
    this._canvasEl.style.cursor  = 'pointer';
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
          if (path === 'sample.start') this._clampEndToStart();
          this._drawWaveform();
        },
        onRelease: () => this.ctx.emitStep?.(),
      });
      dst.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      if (path === 'slice')        this._sliceKnob  = knob;
      if (path === 'slices')       this._slicesKnob = knob;
      if (path === 'sample.start') this._startKnob  = knob;
      if (path === 'sample.end')   this._endKnob    = knob;
      return knob;
    };

    const sliceG = makeGroup('SLICES');
    addKnob(sliceG, 'slices', 'SLICES', 1, 64, v => String(Math.round(v)));
    addKnob(sliceG, 'slice',  'SLICE',  0, 63, v => String(Math.round(v)));
    sliceG.appendChild(this._makeModeSelect());
    addKnob(sliceG, 'slice.base', 'BASE', 0, 127, v => this._midiName(Math.round(v)));

    const trimG = makeGroup('TRIM');
    addKnob(trimG, 'sample.start', 'START', 0, 1, v => Math.round(v * 100) + '%');
    addKnob(trimG, 'sample.end',   'END',   0, 1, v => Math.round(v * 100) + '%');

    const playG = makeGroup('PLAYBACK');
    addKnob(playG, 'gate',         'GATE',  0.02, 1, v => Math.round(v * 100) + '%');
    addKnob(playG, 'sample.speed', 'SPEED', 0.125, 4, v => v.toFixed(2) + 'x');
    addKnob(playG, 'sample.gain',  'GAIN',  0, 20, v => v.toFixed(1) + 'x');
    playG.appendChild(this._makeToggle('REV',  'sample.reverse'));
    playG.appendChild(this._makeToggle('LOOP', 'sample.loop'));

    // Master output level lives on the AMP page (LEVEL knob), not here.

    this.container.appendChild(wrap);
    addBrowseButton(this);

    requestAnimationFrame(() => { this._setupCanvas(); this._drawWaveform(); });
    const ro = new ResizeObserver(() => { this._setupCanvas(); this._drawWaveform(); });
    ro.observe(canvasWrap);
    this.ctx.activeWidgets.push({ destroy: () => ro.disconnect() });

    this._setupClick();
  }

  _makeModeSelect() {
    const row = document.createElement('div');
    row.className = 'param-row sampler-toggle';
    const label = document.createElement('span');
    label.className = 'param-label label';
    label.textContent = 'BY';
    const sel = document.createElement('select');
    sel.className = 'param-select';
    ['note', 'fixed'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt.toUpperCase();
      if (this.machine.getParam('slice.mode') === opt) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.ctx.writeValue(this.machine, 'slice.mode', sel.value, true);
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

    const count   = Math.max(1, Math.round(this.machine.getParam('slices')));
    const active  = ((Math.round(this.machine.getParam('slice')) % count) + count) % count;

    // Trim region — slices divide [startX, endX], not the whole width.
    const startN = this.machine.getParam('sample.start');
    const endN   = this.machine.getParam('sample.end');
    const startX = Math.min(startN, endN) * w;
    const endX   = Math.max(startN, endN) * w;
    const regionW = Math.max(1, endX - startX);
    const sliceW  = regionW / count;

    // Active slice highlight (within the region).
    gc.fillStyle = 'rgba(255, 170, 40, 0.16)';
    gc.fillRect(startX + active * sliceW, 0, sliceW, h);

    // Waveform.
    const buf  = this.machine._buffer;
    const data = buf.getChannelData(0);
    const numSamples = data.length;
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

    // Dim trimmed-out regions.
    gc.fillStyle = 'rgba(0,0,0,0.45)';
    gc.fillRect(0, 0, startX, h);
    gc.fillRect(endX, 0, w - endX, h);

    // Slice dividers within the region + index labels (skip when too dense).
    gc.font = '9px monospace';
    gc.textAlign = 'left';
    const showLabels = sliceW > 14;
    for (let i = 0; i <= count; i++) {
      const x = startX + i * sliceW;
      const isActiveEdge = (i === active);
      gc.strokeStyle = isActiveEdge ? '#ffb300' : 'rgba(120,160,120,0.5)';
      gc.lineWidth = isActiveEdge ? 2 : 1;
      gc.beginPath();
      gc.moveTo(x, 0);
      gc.lineTo(x, h);
      gc.stroke();
      if (showLabels && i < count) {
        gc.fillStyle = i === active ? '#ffb300' : '#6b8b6b';
        gc.fillText(String(i), x + 2, h - 3);
      }
    }

    // Trim handles — green START, amber END (drawn over the grid).
    gc.strokeStyle = '#8bc34a';
    gc.lineWidth = 2;
    gc.beginPath(); gc.moveTo(startX, 0); gc.lineTo(startX, h); gc.stroke();
    gc.strokeStyle = '#ffb300';
    gc.beginPath(); gc.moveTo(endX, 0); gc.lineTo(endX, h); gc.stroke();
  }

  /** Keep END ≥ START. */
  _clampEndToStart() {
    const s = this.machine.getParam('sample.start');
    if (this.machine.getParam('sample.end') < s) {
      this.ctx.writeValue(this.machine, 'sample.end', s, false);
      this._endKnob?.setValue(s);
    }
  }

  _setupClick() {
    const canvas = this._canvasEl;
    if (!canvas) return;
    const SNAP = 0.03;
    const getX = e => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / rect.width;
      return Math.max(0, Math.min(1, x));
    };
    const apply = abs => {
      if (this._dragging === 'start') {
        this.ctx.writeValue(this.machine, 'sample.start', abs, false);
        this._startKnob?.setValue(abs);
        this._clampEndToStart();
      } else if (this._dragging === 'end') {
        this.ctx.writeValue(this.machine, 'sample.end', abs, false);
        this._endKnob?.setValue(abs);
      } else {
        // Pick a slice WITHIN the trim region → switch to fixed mode.
        const lo = Math.min(this.machine.getParam('sample.start'), this.machine.getParam('sample.end'));
        const hi = Math.max(this.machine.getParam('sample.start'), this.machine.getParam('sample.end'));
        const span = Math.max(1e-6, hi - lo);
        const rel = Math.max(0, Math.min(0.9999, (abs - lo) / span));
        const count = Math.max(1, Math.round(this.machine.getParam('slices')));
        const idx = Math.max(0, Math.min(count - 1, Math.floor(rel * count)));
        this.ctx.writeValue(this.machine, 'slice.mode', 'fixed', false);
        this.ctx.writeValue(this.machine, 'slice', idx, false);
        this._sliceKnob?.setValue(idx);
      }
      this._drawWaveform();
    };
    const down = e => {
      if (!this.machine.hasBuffer) return;
      const abs = getX(e);
      const start = this.machine.getParam('sample.start');
      const end   = this.machine.getParam('sample.end');
      if (Math.abs(abs - start) < SNAP && Math.abs(abs - start) <= Math.abs(abs - end)) this._dragging = 'start';
      else if (Math.abs(abs - end) < SNAP) this._dragging = 'end';
      else this._dragging = 'slice';
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
      console.error('SlicerPanel: failed to load file', err);
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
      console.error('SlicerPanel: failed to decode recording', err);
    }
  }

  _midiName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }
}
