/**
 * WavetableSamplerPanel.js
 * ------------------------
 * Custom SYNTH tab for WavetableSamplerMachine.
 *
 * Layout:
 *   [Slot A: badge | LOAD | ▶ | ⏺ | name]    [Slot B: …]
 *   [Slot A waveform canvas with S/E handles] [Slot B waveform canvas with S/E handles]
 *   [MORPH] [SPEED] [LEVEL]  [PITCH] [LOOP] [REV]
 *   [Root A knob]  [Root B knob]
 *
 * Each slot's S (start) and E (end) handles are draggable on its canvas.
 * The ▶ button auditions that slot alone (morph forced to 0 for A, 1 for B).
 * The ⏺ button records mic into that slot.
 */

import { KnobWidget } from '../KnobWidget.js';

const WAVE_H  = 96;  // canvas CSS height per slot
const SNAP_PX = 10;  // pixel snap zone for handle pick-up

export class WavetableSamplerPanel {
  constructor(container, ctx, sampleStore, audioContext) {
    this.container    = container;
    this.ctx          = ctx;
    this.sampleStore  = sampleStore;
    this.audioContext = audioContext;
    this.machine      = ctx.machine;

    // Per-slot recording state
    this._rec = {
      A: { active: false, stream: null, recorder: null, chunks: [], btn: null },
      B: { active: false, stream: null, recorder: null, chunks: [], btn: null },
    };

    // Per-slot canvas refs and sizes
    this._canvas  = { A: null, B: null };
    this._cw      = { A: 0, B: 0 };
    this._dragging = null; // { slot, handle: 'start'|'end'|'loopStart' }
    this._loopStartKnob = { A: null, B: null };

    // Preview source nodes (one per slot, stopped on next preview)
    this._previewSrc = { A: null, B: null };

    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'wt-sampler-wrap';

    // ── Two sample slots ─────────────────────────────────────
    const slotsRow = document.createElement('div');
    slotsRow.className = 'wt-sampler-slots';

    for (const slot of ['A', 'B']) {
      const { el, canvas } = this._makeSlot(slot);
      slotsRow.appendChild(el);
      this._canvas[slot] = canvas;
    }
    wrap.appendChild(slotsRow);

    // ── Params row ───────────────────────────────────────────
    const paramRow = document.createElement('div');
    paramRow.className = 'wt-sampler-params';

    const m = this.machine;

    const addKnob = (path, label, min, max, fmt, size = 56) => {
      const knob = new KnobWidget({
        label, min, max, size, fmt,
        value: m.getParam(path),
        onChange: v => this.ctx.writeValue(m, path, v, false),
        onRelease: () => this.ctx.emitStep?.(),
      });
      paramRow.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      return knob;
    };

    addKnob('morph',        'MORPH',  0,     1,   v => Math.round(v * 100) + '%', 64);
    addKnob('sample.speed', 'SPEED',  0.125, 4,   v => v.toFixed(2) + 'x');
    addKnob('output.level', 'LEVEL',  0,     1,   v => Math.round(v * 100) + '%');

    paramRow.appendChild(this._makeToggle('PITCH', 'sample.pitch'));
    paramRow.appendChild(this._makeToggle('LOOP',  'sample.loop'));
    paramRow.appendChild(this._makeToggle('REV',   'sample.reverse'));

    wrap.appendChild(paramRow);

    // ── Root + Gain row ──────────────────────────────────────
    const rootRow = document.createElement('div');
    rootRow.className = 'wt-sampler-root-row';

    for (const slot of ['A', 'B']) {
      const color = slot === 'A' ? '#4caf50' : '#ffb300';

      const rootKnob = new KnobWidget({
        label: `Root ${slot}`, min: 0, max: 127, size: 44,
        value: m.getParam(`sample.root${slot}`),
        fmt: v => this._midiName(Math.round(v)),
        onChange: v => this.ctx.writeValue(m, `sample.root${slot}`, v, false),
        onRelease: () => this.ctx.emitStep?.(),
      });
      rootKnob.el.style.setProperty('--knob-label-color', color);
      rootRow.appendChild(rootKnob.el);
      this.ctx.activeWidgets.push(rootKnob);

      const gainKnob = new KnobWidget({
        label: `Gain ${slot}`, min: 0, max: 4, size: 44,
        value: m.getParam(`sample.gain${slot}`),
        fmt: v => v.toFixed(2) + 'x',
        onChange: v => this.ctx.writeValue(m, `sample.gain${slot}`, v, false),
        onRelease: () => this.ctx.emitStep?.(),
      });
      gainKnob.el.style.setProperty('--knob-label-color', color);
      rootRow.appendChild(gainKnob.el);
      this.ctx.activeWidgets.push(gainKnob);

      const loopStartKnob = new KnobWidget({
        label: `LpSt ${slot}`, min: 0, max: 1, size: 44,
        value: m.getParam(`sample.loopStart${slot}`),
        fmt: v => Math.round(v * 100) + '%',
        onChange: v => {
          this.ctx.writeValue(m, `sample.loopStart${slot}`, v, false);
          this._drawSlot(slot);
        },
        onRelease: () => this.ctx.emitStep?.(),
      });
      loopStartKnob.el.style.setProperty('--knob-label-color', '#00bcd4');
      rootRow.appendChild(loopStartKnob.el);
      this.ctx.activeWidgets.push(loopStartKnob);
      this._loopStartKnob[slot] = loopStartKnob;
    }
    wrap.appendChild(rootRow);

    // ── Sweep row ────────────────────────────────────────────
    const sweepRow = document.createElement('div');
    sweepRow.className = 'wt-sampler-root-row';

    const sweepDepthKnob = new KnobWidget({
      label: 'SWP DEPTH', min: 0, max: 1, size: 48,
      value: m.getParam('sweep.depth'),
      fmt: v => Math.round(v * 100) + '%',
      onChange: v => this.ctx.writeValue(m, 'sweep.depth', v, false),
      onRelease: () => this.ctx.emitStep?.(),
    });
    sweepRow.appendChild(sweepDepthKnob.el);
    this.ctx.activeWidgets.push(sweepDepthKnob);

    const sweepSpeedKnob = new KnobWidget({
      label: 'SWP SPEED', min: 0.05, max: 20, size: 48,
      value: m.getParam('sweep.speed'),
      fmt: v => v < 1 ? v.toFixed(2) + 'Hz' : v.toFixed(1) + 'Hz',
      onChange: v => this.ctx.writeValue(m, 'sweep.speed', v, false),
      onRelease: () => this.ctx.emitStep?.(),
    });
    sweepRow.appendChild(sweepSpeedKnob.el);
    this.ctx.activeWidgets.push(sweepSpeedKnob);

    wrap.appendChild(sweepRow);
    this.container.appendChild(wrap);

    // Initial draw after layout settles
    requestAnimationFrame(() => {
      for (const slot of ['A', 'B']) {
        this._setupCanvas(slot);
        this._drawSlot(slot);
      }
    });

    // Re-draw on resize
    const ro = new ResizeObserver(() => {
      for (const slot of ['A', 'B']) {
        this._setupCanvas(slot);
        this._drawSlot(slot);
      }
    });
    ro.observe(slotsRow);
    this.ctx.activeWidgets.push({ destroy: () => ro.disconnect() });

    // Global drag listeners (attached once, cleaned up on destroy)
    const onMove = e => this._onDragMove(e);
    const onUp   = e => this._onDragUp(e);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    this.ctx.activeWidgets.push({
      destroy: () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
    });
  }

  // ── Slot builder ─────────────────────────────────────────────

  _makeSlot(slot) {
    const color = slot === 'A' ? '#4caf50' : '#ffb300';
    const el    = document.createElement('div');
    el.className = 'wt-sampler-slot';

    // Top bar
    const bar = document.createElement('div');
    bar.className = 'wt-sampler-slot-bar';

    const badge = document.createElement('span');
    badge.className = 'wt-sampler-slot-badge';
    badge.textContent = slot;
    badge.style.color = color;
    bar.appendChild(badge);

    // LOAD
    const fileLabel = document.createElement('label');
    fileLabel.className = 'btn wt-sampler-load-btn';
    fileLabel.textContent = 'LOAD';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) this._loadFile(file, slot);
    });
    fileLabel.appendChild(fileInput);
    bar.appendChild(fileLabel);

    // ▶ Preview
    const playBtn = document.createElement('button');
    playBtn.className = 'btn wt-sampler-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = `Preview sample ${slot}`;
    playBtn.addEventListener('click', () => this._preview(slot));
    bar.appendChild(playBtn);

    // ⏺ Record
    const recBtn = document.createElement('button');
    recBtn.className = 'btn wt-sampler-rec-btn';
    recBtn.textContent = '⏺';
    recBtn.title = `Record mic into slot ${slot}`;
    recBtn.addEventListener('click', () => this._toggleRecord(slot));
    this._rec[slot].btn = recBtn;
    bar.appendChild(recBtn);

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'wt-sampler-slot-name';
    const existing = slot === 'A' ? this.machine.sampleNameA : this.machine.sampleNameB;
    nameEl.textContent = existing || '(none)';
    if (slot === 'A') this._nameElA = nameEl;
    else              this._nameElB = nameEl;
    bar.appendChild(nameEl);

    el.appendChild(bar);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'wt-sampler-waveform';
    canvas.style.cursor = 'ew-resize';
    canvas.addEventListener('mousedown', e => this._onDragStart(e, slot));
    el.appendChild(canvas);

    return { el, canvas };
  }

  // ── Canvas drawing ───────────────────────────────────────────

  _setupCanvas(slot) {
    const canvas = this._canvas[slot];
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.parentElement?.clientWidth || 200;
    const h   = WAVE_H;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const gc = canvas.getContext('2d');
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.scale(dpr, dpr);
    this._cw[slot] = w;
  }

  _drawSlot(slot) {
    const canvas = this._canvas[slot];
    if (!canvas) return;
    const color  = slot === 'A' ? '#4caf50' : '#ffb300';
    const buffer = slot === 'A' ? this.machine._bufferA : this.machine._bufferB;
    const startP = `sample.start${slot}`;
    const endP   = `sample.end${slot}`;
    const w      = this._cw[slot] || canvas.offsetWidth || 200;
    const h      = WAVE_H;
    const gc     = canvas.getContext('2d');

    gc.clearRect(0, 0, w, h);
    gc.fillStyle = '#1a1a2e';
    gc.fillRect(0, 0, w, h);

    if (!buffer) {
      gc.fillStyle = '#555';
      gc.font = '11px monospace';
      gc.textAlign = 'center';
      gc.fillText('No sample', w / 2, h / 2 + 4);
      return;
    }

    const sNorm = this.machine.getParam(startP);
    const eNorm = this.machine.getParam(endP);
    const sX    = sNorm * w;
    const eX    = eNorm * w;

    // Active region tint
    gc.fillStyle = `${color}22`;
    gc.fillRect(sX, 0, eX - sX, h);

    // Waveform
    const data = buffer.getChannelData(0);
    const n    = data.length;
    const mid  = h / 2;
    const step = n / w;
    gc.beginPath();
    gc.strokeStyle = color;
    gc.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      let mn = 1, mx = -1;
      const from = Math.floor(x * step);
      const to   = Math.floor((x + 1) * step);
      for (let i = from; i < to; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      const y1 = mid - mx * mid;
      const y2 = mid - mn * mid;
      if (x === 0) gc.moveTo(x, y1);
      gc.lineTo(x, y1);
      gc.lineTo(x, y2);
    }
    gc.stroke();

    // Loop-start handle — cyan dashed (only when loop is on)
    if (this.machine.getParam('sample.loop')) {
      const lsNorm = this.machine.getParam(`sample.loopStart${slot}`);
      const lsClamped = Math.max(sNorm, Math.min(eNorm, lsNorm));
      const lsX = lsClamped * w;
      gc.save();
      gc.strokeStyle = '#00bcd4';
      gc.lineWidth = 2;
      gc.setLineDash([4, 3]);
      gc.beginPath(); gc.moveTo(lsX, 0); gc.lineTo(lsX, h); gc.stroke();
      gc.setLineDash([]);
      gc.restore();
      gc.font = '10px monospace';
      gc.fillStyle = '#00bcd4';
      gc.textAlign = lsX < 20 ? 'left' : 'right';
      gc.fillText('L', lsX + (lsX < 20 ? 3 : -3), 22);
    }

    // Start handle (green tint)
    gc.strokeStyle = '#8bc34a';
    gc.lineWidth = 2;
    gc.beginPath(); gc.moveTo(sX, 0); gc.lineTo(sX, h); gc.stroke();
    gc.font = '10px monospace';
    gc.fillStyle = '#8bc34a';
    gc.textAlign = sX < 20 ? 'left' : 'right';
    gc.fillText('S', sX + (sX < 20 ? 3 : -3), 11);

    // End handle (slot colour)
    gc.strokeStyle = color;
    gc.lineWidth = 2;
    gc.beginPath(); gc.moveTo(eX, 0); gc.lineTo(eX, h); gc.stroke();
    gc.fillStyle = color;
    gc.textAlign = eX > w - 20 ? 'right' : 'left';
    gc.fillText('E', eX + (eX > w - 20 ? -3 : 3), 11);
  }

  // ── Drag logic ───────────────────────────────────────────────

  _onDragStart(e, slot) {
    const canvas = this._canvas[slot];
    const rect   = canvas.getBoundingClientRect();
    const posN   = (e.clientX - rect.left) / rect.width;
    const posX   = posN * this._cw[slot];

    const sN  = this.machine.getParam(`sample.start${slot}`);
    const eN  = this.machine.getParam(`sample.end${slot}`);
    const lsN = this.machine.getParam(`sample.loopStart${slot}`);
    const sX  = sN  * this._cw[slot];
    const eX  = eN  * this._cw[slot];
    const lsX = lsN * this._cw[slot];

    const dS     = Math.abs(posX - sX);
    const dE     = Math.abs(posX - eX);
    const dLs    = Math.abs(posX - lsX);
    const loopOn = this.machine.getParam('sample.loop');

    let handle;
    if (loopOn && dLs <= SNAP_PX && dLs < dS && dLs < dE) {
      handle = 'loopStart';
    } else if (dS <= SNAP_PX && dS <= dE) {
      handle = 'start';
    } else if (dE <= SNAP_PX) {
      handle = 'end';
    } else {
      handle = posN < (sN + eN) / 2 ? 'start' : 'end';
    }

    this._dragging = { slot, handle };
    e.preventDefault();
  }

  _onDragMove(e) {
    if (!this._dragging) return;
    const { slot, handle } = this._dragging;
    const canvas = this._canvas[slot];
    const rect   = canvas.getBoundingClientRect();
    const posN   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    let path;
    if (handle === 'loopStart') {
      path = `sample.loopStart${slot}`;
      this._loopStartKnob[slot]?.setValue(posN);
    } else {
      path = handle === 'start' ? `sample.start${slot}` : `sample.end${slot}`;
    }
    this.ctx.writeValue(this.machine, path, posN, false);
    this._drawSlot(slot);
  }

  _onDragUp() {
    if (this._dragging) {
      this._dragging = null;
      this.ctx.emitStep?.();
    }
  }

  // ── Preview ──────────────────────────────────────────────────

  _preview(slot) {
    // Stop any running preview for this slot
    const prev = this._previewSrc[slot];
    if (prev) { try { prev.stop(); } catch (_) {} this._previewSrc[slot] = null; }

    const buffer = slot === 'A' ? this.machine._bufferA : this.machine._bufferB;
    if (!buffer) return;

    // Use the morph worklet path: trigger noteOn with morph forced to slot extreme
    // so only the target buffer plays. Velocity 100, MIDI 60.
    const forcedMorph = slot === 'A' ? 0 : 1;
    const time = this.audioContext.currentTime + 0.01;
    this.machine.noteOn(60, 100, time, forcedMorph);
  }

  // ── Toggle helpers ───────────────────────────────────────────

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
      if (path === 'sample.loop') {
        for (const slot of ['A', 'B']) this._drawSlot(slot);
      }
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // ── File loading ─────────────────────────────────────────────

  async _loadFile(file, slot) {
    const nameEl = slot === 'A' ? this._nameElA : this._nameElB;
    nameEl.textContent = 'Loading…';
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
      const { id }   = this.sampleStore.save(file.name, audioBuf);

      if (slot === 'A') this.machine.setBufferA(audioBuf, id, file.name);
      else              this.machine.setBufferB(audioBuf, id, file.name);

      nameEl.textContent = file.name;
      this._setupCanvas(slot);
      this._autoTrim(audioBuf, slot);
      this._drawSlot(slot);
    } catch (err) {
      nameEl.textContent = 'Load error';
      console.error('WavetableSamplerPanel: load failed', err);
    }
  }

  // ── Recording ────────────────────────────────────────────────

  async _toggleRecord(slot) {
    const r = this._rec[slot];
    if (r.active) {
      this._stopRecord(slot);
    } else {
      const other = slot === 'A' ? 'B' : 'A';
      if (this._rec[other].active) this._stopRecord(other);
      await this._startRecord(slot);
    }
  }

  async _startRecord(slot) {
    const r      = this._rec[slot];
    const nameEl = slot === 'A' ? this._nameElA : this._nameElB;
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {
      nameEl.textContent = 'Mic denied';
      return;
    }
    r.chunks   = [];
    r.recorder = new MediaRecorder(r.stream);
    r.recorder.ondataavailable = e => { if (e.data.size > 0) r.chunks.push(e.data); };
    r.recorder.onstop = () => this._onRecordStop(slot);
    r.recorder.start();
    r.active = true;
    r.btn.textContent = '⏹';
    r.btn.classList.add('wt-sampler-rec-active');
    nameEl.textContent = 'Recording…';
  }

  _stopRecord(slot) {
    const r = this._rec[slot];
    if (!r.recorder) return;
    r.recorder.stop();
    r.stream?.getTracks().forEach(t => t.stop());
    r.stream = null;
    r.active = false;
    r.btn.textContent = '⏺';
    r.btn.classList.remove('wt-sampler-rec-active');
  }

  async _onRecordStop(slot) {
    const r      = this._rec[slot];
    const nameEl = slot === 'A' ? this._nameElA : this._nameElB;
    nameEl.textContent = 'Processing…';
    const blob     = new Blob(r.chunks, { type: 'audio/webm' });
    const arrayBuf = await blob.arrayBuffer();
    try {
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
      const name     = `mic-${slot}-` + new Date().toISOString().slice(11, 19) + '.wav';
      const { id }   = this.sampleStore.save(name, audioBuf);
      if (slot === 'A') this.machine.setBufferA(audioBuf, id, name);
      else              this.machine.setBufferB(audioBuf, id, name);
      nameEl.textContent = name;
      this._setupCanvas(slot);
      this._autoTrim(audioBuf, slot);
      this._drawSlot(slot);
    } catch (err) {
      nameEl.textContent = 'Record error';
      console.error('WavetableSamplerPanel: record failed', err);
    }
  }

  // ── Auto-trim ────────────────────────────────────────────────

  _autoTrim(buffer, slot) {
    const THRESH  = 0.008;
    const PAD_SEC = 0.01;
    const WIN     = Math.floor(buffer.sampleRate * 0.005);
    const frames  = buffer.length;
    const numCh   = buffer.numberOfChannels;

    const peak = new Float32Array(frames);
    for (let ch = 0; ch < numCh; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        const v = Math.abs(d[i]);
        if (v > peak[i]) peak[i] = v;
      }
    }

    const rmsAbove = i => {
      let sum = 0;
      const from = Math.max(0, i - WIN);
      const to   = Math.min(frames, i + WIN);
      for (let j = from; j < to; j++) sum += peak[j] * peak[j];
      return Math.sqrt(sum / (to - from)) >= THRESH;
    };

    let startFrame = 0;
    for (let i = 0; i < frames; i++) { if (rmsAbove(i)) { startFrame = i; break; } }
    let endFrame = frames;
    for (let i = frames - 1; i >= 0; i--) { if (rmsAbove(i)) { endFrame = i; break; } }

    if (startFrame === 0 && endFrame === frames) return; // no signal found

    const pad = Math.floor(PAD_SEC * buffer.sampleRate);
    startFrame = Math.max(0, startFrame - pad);
    endFrame   = Math.min(frames, endFrame + pad);

    const startNorm = startFrame / frames;
    const endNorm   = endFrame   / frames;

    this.machine.setParam(`sample.start${slot}`, startNorm);
    this.machine.setParam(`sample.end${slot}`,   endNorm);
    this._drawSlot(slot);
  }

  // ── Helpers ──────────────────────────────────────────────────

  _midiName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }
}
