/**
 * MultiSamplerPanel.js
 * --------------------
 * SYNTH tab panel for MultiSamplerMachine.
 *
 * Layout:
 *   [GLOBAL group: Mode (select), Speed, Level]
 *   [Zone 0 strip] … [Zone N strip]   (each: LOAD/REC/clear + mini waveform +
 *                                       LoVel/HiVel/Root/Level/Start/End knobs +
 *                                       Pitch toggle)
 *
 * Each zone is independent (its own buffer + velocity range). Reuses the shared
 * `.sampler-*` / `.param-group` styling so it reflows responsively.
 */

import { KnobWidget } from '../KnobWidget.js';
import { bufferToWav } from '../../state/SampleStore.js';
import { MAX_ZONES } from '../../machines/MultiSamplerMachine.js';
import { SampleBrowser } from './SampleBrowser.js';
import { CuratedSamples } from '../../state/CuratedSamples.js';

const ZONE_WAVE_H = 56;

export class MultiSamplerPanel {
  constructor(container, ctx, sampleStore, audioContext) {
    this.container    = container;
    this.ctx          = ctx;
    this.sampleStore  = sampleStore;
    this.audioContext = audioContext;
    this.machine      = ctx.machine;

    this._zoneCanvases = [];
    this._recState = {};   // zoneIndex → { recording, mediaRec, stream, chunks }

    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'sampler-wrap';

    const m = this.machine;

    // ── Global controls ──
    const groupsRow = document.createElement('div');
    groupsRow.className = 'sampler-groups';
    wrap.appendChild(groupsRow);

    const makeGroup = (label, parent = groupsRow) => {
      const g = document.createElement('div');
      g.className = 'param-group';
      const lbl = document.createElement('div');
      lbl.className = 'param-group-label';
      lbl.textContent = label;
      g.appendChild(lbl);
      const body = document.createElement('div');
      body.className = 'param-group-body';
      g.appendChild(body);
      parent.appendChild(g);
      return body;
    };

    const addKnob = (dst, path, label, min, max, fmt, onAfter) => {
      const knob = new KnobWidget({
        label, min, max,
        value: m.getParam(path),
        size: 52,
        fmt,
        onChange: v => { this.ctx.writeValue(m, path, v, false); onAfter?.(); },
        onRelease: () => this.ctx.emitStep?.(),
      });
      dst.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
      return knob;
    };

    const globalG = makeGroup('GLOBAL');
    globalG.appendChild(this._makeModeSelect());
    addKnob(globalG, 'sample.speed', 'SPEED', 0.125, 4, v => v.toFixed(2) + 'x');
    // Master output level lives on the AMP page (LEVEL knob), not here.

    // ── Zone strips ──
    for (let i = 0; i < MAX_ZONES; i++) {
      wrap.appendChild(this._makeZoneStrip(i, makeGroup, addKnob));
    }

    this.container.appendChild(wrap);

    requestAnimationFrame(() => {
      for (let i = 0; i < MAX_ZONES; i++) { this._setupZoneCanvas(i); this._drawZone(i); }
    });
    const ro = new ResizeObserver(() => {
      for (let i = 0; i < MAX_ZONES; i++) { this._setupZoneCanvas(i); this._drawZone(i); }
    });
    ro.observe(wrap);
    this.ctx.activeWidgets.push({ destroy: () => ro.disconnect() });
  }

  _makeModeSelect() {
    const row = document.createElement('div');
    row.className = 'param-row sampler-toggle';
    const label = document.createElement('span');
    label.className = 'param-label label';
    label.textContent = 'MODE';
    const sel = document.createElement('select');
    sel.className = 'param-select';
    [['velocity', 'VEL LAYER'], ['round', 'ROUND-ROBIN']].forEach(([val, txt]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = txt;
      if (this.machine.getParam('mode') === val) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.ctx.writeValue(this.machine, 'mode', sel.value, true);
    });
    row.appendChild(label);
    row.appendChild(sel);
    return row;
  }

  _makeZoneStrip(i, makeGroup, addKnob) {
    const strip = document.createElement('div');
    strip.className = 'multi-zone-strip';

    // Header: zone number + load / rec / clear + name
    const head = document.createElement('div');
    head.className = 'sampler-topbar';

    const tag = document.createElement('span');
    tag.className = 'param-group-label';
    tag.textContent = `ZONE ${i}`;
    head.appendChild(tag);

    const fileLabel = document.createElement('label');
    fileLabel.className = 'btn sampler-load-btn';
    fileLabel.textContent = 'LOAD';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) this._loadFile(i, file);
    });
    fileLabel.appendChild(fileInput);
    head.appendChild(fileLabel);

    // BROWSE (curated + archive.org) into this specific zone.
    const browseBtn = document.createElement('button');
    browseBtn.className = 'btn sampler-browse-btn';
    browseBtn.textContent = '🔍';
    browseBtn.title = 'Browse curated + archive.org samples into this zone';
    browseBtn.addEventListener('click', () => {
      this._curated = this._curated || new CuratedSamples();
      new SampleBrowser({
        curated: this._curated,
        onLoad: async (url, name) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const fname = /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.wav`;
          const file = new File([blob], fname, { type: blob.type || 'audio/wav' });
          await this._loadFile(i, file);
          // Remember the remote source so saving the track persists this zone's
          // link (re-fetched on reload when the local copy is gone).
          this.machine.zoneSampleUrls[i] = url;
        },
      });
    });
    head.appendChild(browseBtn);

    const recBtn = document.createElement('button');
    recBtn.className = 'btn sampler-rec-btn';
    recBtn.textContent = '⏺';
    recBtn.title = 'Record mic into this zone';
    recBtn.addEventListener('click', () => this._toggleRecord(i, recBtn));
    head.appendChild(recBtn);

    const clrBtn = document.createElement('button');
    clrBtn.className = 'btn sampler-reset-btn';
    clrBtn.textContent = '✕';
    clrBtn.title = 'Clear this zone';
    clrBtn.addEventListener('click', () => {
      const track = this.ctx.getTrack?.();
      this.machine.clearBufferAt(i);
      track?._pool?.syncParams?.();
      this._drawZone(i);
      this._nameEls[i].textContent = '(empty)';
    });
    head.appendChild(clrBtn);

    this._nameEls = this._nameEls || [];
    const nameEl = document.createElement('span');
    nameEl.className = 'sampler-name';
    nameEl.textContent = this.machine.zoneSampleNames[i] || '(empty)';
    this._nameEls[i] = nameEl;
    head.appendChild(nameEl);

    strip.appendChild(head);

    // Mini waveform
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'sampler-canvas-wrap multi-zone-canvas';
    canvasWrap.style.height = ZONE_WAVE_H + 'px';
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvasWrap.appendChild(canvas);
    this._zoneCanvases[i] = canvas;
    strip.appendChild(canvasWrap);

    // Knob row for this zone
    const body = makeGroup(`ZONE ${i} MAP`, strip);
    addKnob(body, `zone${i}.loVel`, 'LO V',  0, 127, v => String(Math.round(v)));
    addKnob(body, `zone${i}.hiVel`, 'HI V',  0, 127, v => String(Math.round(v)));
    addKnob(body, `zone${i}.root`,  'ROOT',  0, 127, v => this._midiName(Math.round(v)));
    addKnob(body, `zone${i}.level`, 'LVL',   0, 4,   v => v.toFixed(2) + 'x');
    addKnob(body, `zone${i}.start`, 'STRT',  0, 1,   v => Math.round(v * 100) + '%', () => this._drawZone(i));
    addKnob(body, `zone${i}.end`,   'END',   0, 1,   v => Math.round(v * 100) + '%', () => this._drawZone(i));
    body.appendChild(this._makeToggle(`zone${i}.pitch`, 'PITCH'));

    return strip;
  }

  _makeToggle(path, label) {
    const wrap = document.createElement('div');
    wrap.className = 'sampler-toggle';
    const btn = document.createElement('button');
    btn.className = 'btn sampler-toggle-btn' + (this.machine.getParam(path) ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const v = !this.machine.getParam(path);
      this.ctx.writeValue(this.machine, path, v, true);
      btn.classList.toggle('active', v);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // ── Canvas ──

  _setupZoneCanvas(i) {
    const canvas = this._zoneCanvases[i];
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const dpr  = window.devicePixelRatio || 1;
    const w    = wrap.clientWidth  || 300;
    const h    = wrap.clientHeight || ZONE_WAVE_H;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const gc = canvas.getContext('2d');
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.scale(dpr, dpr);
    canvas._w = w; canvas._h = h;
  }

  _drawZone(i) {
    const canvas = this._zoneCanvases[i];
    if (!canvas) return;
    const w = canvas._w || canvas.offsetWidth || 300;
    const h = canvas._h || ZONE_WAVE_H;
    const gc = canvas.getContext('2d');
    gc.clearRect(0, 0, w, h);
    gc.fillStyle = '#1a1a2e';
    gc.fillRect(0, 0, w, h);

    const buf = this.machine.getBufferAt(i);
    if (!buf) {
      gc.fillStyle = '#555';
      gc.font = '11px monospace';
      gc.textAlign = 'center';
      gc.fillText('empty', w / 2, h / 2 + 4);
      return;
    }

    const startN = this.machine.getParam(`zone${i}.start`);
    const endN   = this.machine.getParam(`zone${i}.end`);
    const sX = startN * w, eX = endN * w;
    gc.fillStyle = 'rgba(90, 180, 90, 0.12)';
    gc.fillRect(sX, 0, eX - sX, h);

    const data = buf.getChannelData(0);
    const mid = h / 2, step = data.length / w;
    gc.beginPath();
    gc.strokeStyle = '#4caf50';
    gc.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      let mn = 1, mx = -1;
      const from = Math.floor(x * step), to = Math.floor((x + 1) * step);
      for (let j = from; j < to; j++) { const v = data[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const y1 = mid - mx * mid, y2 = mid - mn * mid;
      if (x === 0) gc.moveTo(x, y1);
      gc.lineTo(x, y1); gc.lineTo(x, y2);
    }
    gc.stroke();

    gc.strokeStyle = '#8bc34a'; gc.lineWidth = 1.5;
    gc.beginPath(); gc.moveTo(sX, 0); gc.lineTo(sX, h); gc.stroke();
    gc.strokeStyle = '#ffb300';
    gc.beginPath(); gc.moveTo(eX, 0); gc.lineTo(eX, h); gc.stroke();
  }

  // ── Loading / recording (per zone) ──

  async _loadFile(i, file) {
    this._nameEls[i].textContent = 'Loading…';
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
      const { id } = this.sampleStore.save(file.name, audioBuf);
      // Local file → no remote source (clear any prior URL on this zone).
      this.machine.setBufferAt(i, audioBuf, id, file.name, null);
      this.ctx.getTrack?.()?._pool?.syncParams?.();
      this._nameEls[i].textContent = file.name;
      this._setupZoneCanvas(i);
      this._drawZone(i);
    } catch (err) {
      this._nameEls[i].textContent = 'Load error';
      console.error('MultiSamplerPanel: load failed', err);
    }
  }

  async _toggleRecord(i, btn) {
    const st = this._recState[i] || {};
    if (st.recording) {
      st.mediaRec?.stop();
      st.stream?.getTracks().forEach(t => t.stop());
      st.recording = false;
      btn.textContent = '⏺';
      btn.classList.remove('recording');
      return;
    }
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      this._nameEls[i].textContent = 'Mic denied';
      return;
    }
    st.chunks = [];
    st.mediaRec = new MediaRecorder(st.stream);
    st.mediaRec.ondataavailable = e => { if (e.data.size > 0) st.chunks.push(e.data); };
    st.mediaRec.onstop = async () => {
      this._nameEls[i].textContent = 'Processing…';
      const blob = new Blob(st.chunks, { type: 'audio/webm' });
      try {
        const audioBuf = await this.audioContext.decodeAudioData(await blob.arrayBuffer());
        const name = `zone${i}-rec-` + new Date().toISOString().slice(11, 19) + '.wav';
        const { id } = this.sampleStore.save(name, audioBuf);
        this.machine.setBufferAt(i, audioBuf, id, name, null); // mic rec → no remote source
        this.ctx.getTrack?.()?._pool?.syncParams?.();
        this._nameEls[i].textContent = name;
        this._setupZoneCanvas(i);
        this._drawZone(i);
      } catch (err) {
        this._nameEls[i].textContent = 'Record error';
      }
    };
    st.mediaRec.start();
    st.recording = true;
    this._recState[i] = st;
    btn.textContent = '⏹';
    btn.classList.add('recording');
    this._nameEls[i].textContent = 'Recording…';
  }

  _midiName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }
}
