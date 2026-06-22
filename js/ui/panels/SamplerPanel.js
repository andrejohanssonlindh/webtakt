/**
 * SamplerPanel.js
 * ---------------
 * Custom SYNTH tab for SamplerMachine.
 *
 * Layout (top→bottom):
 *   [File picker]  [Reset]  [Record]  [WAV download]  [sample name / status]
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
import { bufferToWav } from '../../state/SampleStore.js';
import { addBrowseButton } from './sampleBrowserButton.js';

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

    this._dragging    = null; // 'start' | 'end' | 'loopStart' | null
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

    // Reset button — drops the sample AND all settings back to defaults, for a
    // clean start. (Swapping machines now carries the sample + comparable
    // settings over; this is the explicit "start anew" escape hatch.)
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn sampler-reset-btn';
    resetBtn.textContent = '↺ RESET';
    resetBtn.title = 'Clear sample and reset all settings to defaults';
    resetBtn.addEventListener('click', () => this._resetAll());
    topBar.appendChild(resetBtn);

    // Record button
    this._recBtn = document.createElement('button');
    this._recBtn.className = 'btn sampler-rec-btn';
    this._recBtn.textContent = '⏺ REC';
    this._recBtn.addEventListener('click', () => this._toggleRecord());
    topBar.appendChild(this._recBtn);

    // Download button — exports the loaded/recorded buffer as a WAV file.
    this._dlBtn = document.createElement('button');
    this._dlBtn.className = 'btn sampler-dl-btn';
    this._dlBtn.textContent = '⤓ WAV';
    this._dlBtn.title = 'Download sample as WAV';
    this._dlBtn.addEventListener('click', () => this._downloadSample());
    topBar.appendChild(this._dlBtn);

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

    // ── Param sections ───────────────────────────────────────
    // Same labelled-section layout as DefaultMachinePanel (`.param-group`), so
    // the sampler reflows 3-up desktop → 2-up iPad → 1-up phone like every other
    // machine. Each group gets a `.param-group-body` to drop knobs/toggles into.
    const m = this.machine;

    // Row container so the groups reflow side-by-side (the wrap itself is a
    // column). Matches DefaultMachinePanel's `.panel-content` flex-row of groups.
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
        label,
        min,
        max,
        value: m.getParam(path),
        size: 56,
        fmt,
        onChange: v => {
          this.ctx.writeValue(m, path, v, false);
          // When START moves forward past LOOP ST, drag LOOP ST along so the
          // knob/line/param all agree (otherwise the loop line clamps to start
          // visually while the knob shows a stale lower value).
          if (path === 'sample.start') this._clampLoopStartToStart();
          this._drawWaveform();
        },
        onRelease: () => {
          this.ctx.emitStep?.();
          this._drawWaveform();
        },
      });
      dst.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      return knob;
    };

    const trimG = makeGroup('TRIM');
    this._startKnob     = addKnob(trimG, 'sample.start',     'START',   0, 1, v => Math.round(v * 100) + '%');
    this._endKnob       = addKnob(trimG, 'sample.end',       'END',     0, 1, v => Math.round(v * 100) + '%');
    this._loopStartKnob = addKnob(trimG, 'sample.loopStart', 'LOOP ST', 0, 1, v => Math.round(v * 100) + '%');

    const playG = makeGroup('PLAYBACK');
    addKnob(playG, 'sample.speed', 'SPEED', 0.125, 4, v => v.toFixed(2) + 'x');
    addKnob(playG, 'sample.gain',  'GAIN',  0, 20,    v => v.toFixed(1) + 'x');
    addKnob(playG, 'sample.root',  'ROOT',  0, 127,   v => this._midiName(Math.round(v)));
    playG.appendChild(this._makeToggle('PITCH', 'sample.pitch'));
    playG.appendChild(this._makeToggle('REV',   'sample.reverse'));
    playG.appendChild(this._makeToggle('LOOP',  'sample.loop'));

    // Master output level lives on the AMP page (LEVEL knob), not here.
    const outG = makeGroup('OUTPUT');
    // SAMPLE LEN button — sets trig length to match the trimmed sample duration
    this._sampleLenBtn = this._makeSampleLenBtn();
    outG.appendChild(this._sampleLenBtn);

    this.container.appendChild(wrap);
    addBrowseButton(this);

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

  _makeSampleLenBtn() {
    const wrap = document.createElement('div');
    wrap.className = 'sampler-toggle';

    const btn = document.createElement('button');
    btn.className   = 'btn sampler-action-btn';
    btn.textContent = 'SMPL LEN';
    btn.title       = 'Set trig length to trimmed sample duration (at root pitch)';

    btn.addEventListener('click', () => {
      if (!this.machine.hasBuffer) return;
      const track = this.ctx.getTrack?.();
      if (!track) return;

      const buf       = this.machine._buffer;
      const startNorm = this.machine.getParam('sample.start');
      const endNorm   = this.machine.getParam('sample.end');
      const speed     = this.machine.getParam('sample.speed') || 1;
      // Use only speed, not pitch — length covers the full sample at any note
      const durSec    = (endNorm - startNorm) * buf.duration / speed;

      const secondsPerTick = track.sequencer.clock._secondsPerTick;
      const lengthTicks    = Math.max(1 / 16, durSec / secondsPerTick);

      // Write to selected step or all steps (same logic as the LENGTH knob)
      const state   = this.ctx.state;
      const hasStep = state?.selectedStepIndex >= 0;
      if (hasStep) {
        const step = track.sequencer.getVisibleSteps()[state.selectedStepIndex];
        if (step) {
          step.length = lengthTicks;
          state.emit('stepChanged', {
            trackIndex: state.selectedTrackIndex,
            stepIndex:  state.selectedStepIndex,
            step,
          });
        }
      } else {
        track.sequencer.steps.forEach(s => { s.length = lengthTicks; });
        // Re-render trig tab so the LENGTH knob snaps to the new value
        if (state?.activeTab === 'trig') state.emit('tabChanged', { tab: 'trig' });
      }
    });

    wrap.appendChild(btn);
    return wrap;
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
      if (path === 'sample.loop') this._drawWaveform();
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
    this._refreshDownloadBtn();
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

    // Loop-start handle — cyan dashed line (only drawn when loop is on)
    const loopStartRaw = this.machine.getParam('sample.loopStart');
    const loopStartClamped = Math.max(
      this.machine.getParam('sample.start'),
      Math.min(this.machine.getParam('sample.end'), loopStartRaw)
    );
    const loopStartX = loopStartClamped * w;
    if (this.machine.getParam('sample.loop')) {
      gc.save();
      gc.strokeStyle = '#00bcd4';
      gc.lineWidth = 2;
      gc.setLineDash([4, 3]);
      gc.beginPath();
      gc.moveTo(loopStartX, 0);
      gc.lineTo(loopStartX, h);
      gc.stroke();
      gc.setLineDash([]);
      gc.restore();
    }

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
    if (this.machine.getParam('sample.loop')) {
      gc.fillStyle = '#00bcd4';
      gc.textAlign = loopStartX < 30 ? 'left' : 'right';
      gc.fillText('L', loopStartX + (loopStartX < 30 ? 3 : -3), 24);
    }
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
      const pos       = getPos(e);
      const start     = this.machine.getParam('sample.start');
      const end       = this.machine.getParam('sample.end');
      const loopStart = this.machine.getParam('sample.loopStart');

      const dStart     = Math.abs(pos - start);
      const dEnd       = Math.abs(pos - end);
      const dLoopStart = Math.abs(pos - loopStart);
      const loopOn     = this.machine.getParam('sample.loop');

      if (loopOn && dLoopStart < SNAP && dLoopStart < dStart && dLoopStart < dEnd) {
        this._dragging = 'loopStart';
      } else if (dStart < SNAP && dStart <= dEnd) {
        this._dragging = 'start';
      } else if (dEnd < SNAP) {
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
      let path;
      if (this._dragging === 'loopStart') {
        path = 'sample.loopStart';
        this._loopStartKnob?.setValue(pos);
      } else {
        path = this._dragging === 'start' ? 'sample.start' : 'sample.end';
      }
      this.ctx.writeValue(this.machine, path, pos, false);
      if (path === 'sample.start') this._clampLoopStartToStart();
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

  // ── Download ─────────────────────────────────────────────────

  /** Enable the WAV button only when a buffer is present. */
  _refreshDownloadBtn() {
    if (this._dlBtn) this._dlBtn.disabled = !this.machine.hasBuffer;
  }

  /** Export the loaded/recorded AudioBuffer as a PCM16 WAV download. */
  _downloadSample() {
    const buffer = this.machine.getBuffer?.();
    if (!buffer) return;
    const wav  = bufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url  = URL.createObjectURL(blob);
    // Derive a .wav filename from the sample name (strip any existing ext).
    const base = (this.machine.sampleName || 'sample').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * RESET: drop the sample and reset every param to its default — a clean start
   * for when the user switched here intending to begin anew (machine swaps now
   * carry the sample + comparable settings over, so this is the explicit escape
   * hatch). Resets all voice slots, not just the canonical, then re-renders.
   */
  _resetAll() {
    const track = this.ctx.getTrack?.();
    // Reset every param to its SPEC default on the canonical machine.
    for (const p of this.machine.getParamList?.() ?? []) {
      if (p.default !== undefined) this.machine.setParam(p.path, p.default);
    }
    // Drop the buffer on every slot (incl. canonical), then fan the reset
    // params to all slots.
    if (track?._pool?.clearSampleBuffers) track._pool.clearSampleBuffers();
    else this.machine.clearBuffer?.();   // no pool (shouldn't happen) — clear canonical
    track?._pool?.syncParams?.();
    this._nameEl.textContent = '(no sample)';
    // Rebuild the WHOLE synth tab so embedding panels (e.g. SampleSwarmPanel's
    // swarm-knob row) refresh too, not just this sampler section. Falls back to a
    // local re-render if the host ctx doesn't expose renderContent.
    if (this.ctx.renderContent) this.ctx.renderContent();
    else this._render();
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
    this._clampLoopStartToStart();
  }

  /**
   * Pull LOOP ST up to START whenever START moves past it. Keeps the loop-start
   * knob, the drawn loop line, and the stored param in agreement — without this
   * the line clamps to START visually while the knob still reads the lower
   * (often 0) value, so the loop appears not to start until you drag past START.
   */
  _clampLoopStartToStart() {
    const start = this.machine.getParam('sample.start');
    if (this.machine.getParam('sample.loopStart') < start) {
      this.ctx.writeValue(this.machine, 'sample.loopStart', start, false);
      this._loopStartKnob?.setValue(start);
    }
  }

  /** Convert MIDI note number to name like C4, F#3. */
  _midiName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }
}
