/**
 * PianoRollPanel.js
 * -----------------
 * ROLL tab: a per-track piano roll. A RENDERER over the existing Step[] model —
 * it draws and edits the track's notes spatially (Y = pitch, X = step) but does
 * NOT change the data model. Every note block is one `voice` on a `Step`:
 *   left   = step.index * colW + voice.nudge * colW
 *   width  = voice.length * colW
 *   top    = (127 - voice.note) * rowH
 *   tint   = voice.velocity
 *
 * Edits (manual mode only):
 *   click empty cell      → add a voice at that pitch/step (step.active = true)
 *   click a note block    → select that step (emits selectStepAbs → TRIG/SYNTH
 *                           tabs drive p-locks / condition / chance / retrigger)
 *   drag a block's right edge → voice.length (snap to whole steps; Alt = fine)
 *   Alt-drag a block body     → voice.nudge (−0.99 .. +0.99 of a step)
 *   double-click a block      → remove that voice
 *
 * Out-of-scale pitch rows are shaded (noteInScale). The X axis shows ALL steps
 * (stepCount, 1–64) scrolled horizontally — paging is dissolved here.
 *
 * Renders into ctx.container via the standard _makeTabContext shape. Notes-only:
 * deeper per-step editing stays in the TRIG / SYNTH tabs.
 */

import { noteInScale } from '../../state/Scales.js';
import { settings }    from '../../state/Settings.js';

const COL_W   = 30;   // px per step
const ROW_H   = 14;   // px per semitone
const N_NOTES = 128;  // MIDI 0..127
const EDGE_PX = 7;    // grab zone at a block's right edge for length-resize
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

export class PianoRollPanel {
  render(ctx) {
    this._ctx   = ctx;
    this.track  = ctx.track;
    this.seq    = ctx.track.sequencer;
    this.state  = ctx.state;
    this.editable = (ctx.track.sequencerMode ?? 'manual') === 'manual';

    const { container } = ctx;
    container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'roll-root';

    // Scroll viewport holds the keys gutter (sticky) + the grid surface.
    const scroller = document.createElement('div');
    scroller.className = 'roll-scroller';
    this._scroller = scroller;

    const keys = this._buildKeysGutter();
    const grid = this._buildGrid();

    scroller.appendChild(keys);
    scroller.appendChild(grid);
    root.appendChild(scroller);
    container.appendChild(root);

    // Centre the view on existing notes (else C4) once laid out.
    requestAnimationFrame(() => this._centreScroll());
  }

  /**
   * Full note rebuild — recreates all blocks (e.g. note added/removed/changed
   * from the step grid). Keeps scroll position (only the blocks are replaced).
   * Called by SynthPanel on `stepChanged`. No-op if the grid was detached (stale
   * event after a track/tab switch replaced this instance).
   */
  refresh() {
    if (!this._grid || !this._grid.isConnected) return;
    this._renderNotes(this._grid);
  }

  /**
   * Selection changed — re-tint the .sel class WITHOUT recreating block DOM, so
   * an in-flight double-click (remove) still lands on its original element.
   * Called by SynthPanel on `stepSelected`.
   */
  refreshTints() {
    if (!this._grid || !this._grid.isConnected) return;
    const selAbs = this._selectedAbsStep();
    this._grid.querySelectorAll('.roll-note').forEach(block => {
      block.classList.toggle('sel', Number(block.dataset.step) === selAbs);
    });
  }

  // ── Pitch keys gutter (left, sticky) ───────────────────────
  _buildKeysGutter() {
    const gutter = document.createElement('div');
    gutter.className = 'roll-keys';
    gutter.style.height = `${N_NOTES * ROW_H}px`;

    for (let n = N_NOTES - 1; n >= 0; n--) {
      const key = document.createElement('div');
      const pc  = n % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(pc);
      key.className = 'roll-key' + (isBlack ? ' black' : '') + (pc === 0 ? ' octave' : '');
      key.style.top    = `${(N_NOTES - 1 - n) * ROW_H}px`;
      key.style.height = `${ROW_H}px`;
      // Label every key so it's easy to follow; C rows carry the octave number
      // and are emphasised (.octave) so the eye can still anchor on them.
      key.textContent = pc === 0
        ? `C${Math.floor(n / 12) - 1}`
        : NOTE_NAMES[pc];
      gutter.appendChild(key);
    }
    return gutter;
  }

  // ── Grid surface (the editable area) ───────────────────────
  _buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'roll-grid';
    this._grid = grid;

    const stepCount = this.seq.stepCount;
    grid.style.width  = `${stepCount * COL_W}px`;
    grid.style.height = `${N_NOTES * ROW_H}px`;

    // Out-of-scale row shading (skip when chromatic — scaleIndex 0).
    if (this.track.scaleIndex > 0) {
      for (let n = N_NOTES - 1; n >= 0; n--) {
        if (noteInScale(n, this.track.scaleIndex, this.track.leadNote)) continue;
        const row = document.createElement('div');
        row.className = 'roll-row-block';
        row.style.top = `${(N_NOTES - 1 - n) * ROW_H}px`;
        row.style.height = `${ROW_H}px`;
        grid.appendChild(row);
      }
    }

    // Beat columns (every 4 steps) for orientation.
    for (let s = 0; s < stepCount; s += 4) {
      const bar = document.createElement('div');
      bar.className = 'roll-beat-col';
      bar.style.left = `${s * COL_W}px`;
      grid.appendChild(bar);
    }

    // Note blocks.
    this._renderNotes(grid);

    // Click on empty grid → add a note.
    grid.addEventListener('mousedown', e => this._onGridMouseDown(e));

    return grid;
  }

  _renderNotes(grid) {
    // Clear any existing blocks + active-row bands (keep static scale/beat decor).
    grid.querySelectorAll('.roll-note, .roll-row-active').forEach(el => el.remove());

    const selAbs = this._selectedAbsStep();
    const steps  = this.seq.steps;

    // Pitch rows that hold at least one note → faint full-width band, so used
    // notes are easy to scan across the whole length.
    const usedNotes = new Set();
    for (let si = 0; si < this.seq.stepCount; si++) {
      const step = steps[si];
      if (step?.active) step.voices.forEach(v => usedNotes.add(v.note));
    }
    usedNotes.forEach(note => {
      const band = document.createElement('div');
      band.className = 'roll-row-active';
      band.style.top = `${(N_NOTES - 1 - note) * ROW_H}px`;
      band.style.height = `${ROW_H}px`;
      grid.appendChild(band);
    });

    for (let si = 0; si < this.seq.stepCount; si++) {
      const step = steps[si];
      if (!step || !step.active) continue;
      step.voices.forEach((v, vi) => {
        const block = document.createElement('div');
        block.className = 'roll-note';
        if (si === selAbs) block.classList.add('sel');
        block.style.left   = `${(si + (v.nudge || 0)) * COL_W}px`;
        block.style.width  = `${Math.max(0.2, v.length || 1) * COL_W}px`;
        block.style.top    = `${(N_NOTES - 1 - v.note) * ROW_H}px`;
        block.style.height = `${ROW_H}px`;
        block.style.opacity = String(0.45 + 0.55 * ((v.velocity ?? 100) / 127));
        block.title = `${NOTE_NAMES[v.note % 12]}${Math.floor(v.note / 12) - 1}  step ${si + 1}  len ${v.length}`;
        block.dataset.step  = si;
        block.dataset.voice = vi;
        block.addEventListener('mousedown', e => this._onNoteMouseDown(e, si, vi));
        block.addEventListener('dblclick', e => this._onNoteDblClick(e, si, vi));
        grid.appendChild(block);
      });
    }
  }

  // ── Interactions ───────────────────────────────────────────

  _onGridMouseDown(e) {
    if (!this.editable) return;
    if (e.target !== this._grid) return;   // clicks on note blocks handled separately
    const { step, note } = this._cellFromEvent(e);
    if (step == null) return;

    const target = this.seq.steps[step];
    if (!target) return;
    if (target.active) {
      target.addVoice(note, this.track.trigVelocity ?? 100, 1, 0);
    } else {
      target.active = true;
      target.voices = [{ note, velocity: this.track.trigVelocity ?? 100, length: 1, nudge: 0 }];
    }
    this._emitStepChanged(step);
    this._renderNotes(this._grid);
  }

  _onNoteMouseDown(e, si, vi) {
    e.stopPropagation();
    if (!this.editable) { this._selectStep(si); return; }
    const step  = this.seq.steps[si];
    const voice = step?.voices[vi];
    if (!voice) return;

    const block   = e.currentTarget;
    const rect     = block.getBoundingClientRect();
    const onEdge   = (rect.right - e.clientX) <= EDGE_PX;

    if (onEdge) {
      this._beginLengthDrag(e, voice, si, block);
    } else if (e.altKey) {
      this._beginNudgeDrag(e, voice, si, block);
    } else {
      this._selectStep(si);
    }
  }

  _beginLengthDrag(e, voice, si, block) {
    e.preventDefault();
    const startX = e.clientX;
    const startLen = voice.length || 1;
    const move = ev => {
      const dSteps = (ev.clientX - startX) / COL_W;
      let len = this._snapStep(startLen + dSteps, ev.altKey);   // snap to sync grid
      const minLen = 16 / settings.gridBase;
      len = Math.max(minLen, Math.min(this.seq.stepCount, len));
      voice.length = len;
      block.style.width = `${len * COL_W}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this._emitStepChanged(si);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _beginNudgeDrag(e, voice, si, block) {
    e.preventDefault();
    const startX = e.clientX;
    const startNudge = voice.nudge || 0;
    const move = ev => {
      let nudge = this._snapStep(startNudge + (ev.clientX - startX) / COL_W, ev.altKey);
      nudge = Math.max(-0.99, Math.min(0.99, nudge));
      voice.nudge = nudge;
      block.style.left = `${(si + nudge) * COL_W}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this._emitStepChanged(si);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _onNoteDblClick(e, si, vi) {
    e.stopPropagation();
    e.preventDefault();
    if (!this.editable) return;
    const step = this.seq.steps[si];
    if (!step) return;
    step.removeVoice(vi);   // auto-clears active when the last voice goes
    this._emitStepChanged(si);
    this._renderNotes(this._grid);
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Snap a step-space value to the sync-knob grid. One step = a 1/16 note; the
   * grid base spans a whole note (32 / 64 / 128). So the finest sub-step is
   * 16/gridBase of a step (base 32 → 0.5, 64 → 0.25, 128 → 0.125). Holding Alt
   * bypasses snapping for free placement.
   */
  _snapStep(value, fine) {
    if (fine) return value;
    const unit = 16 / settings.gridBase;   // step fraction per grid unit
    return Math.round(value / unit) * unit;
  }

  _cellFromEvent(e) {
    const rect = this._grid.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const step = Math.floor(x / COL_W);
    const note = 127 - Math.floor(y / ROW_H);
    if (step < 0 || step >= this.seq.stepCount || note < 0 || note > 127) {
      return { step: null, note: null };
    }
    return { step, note };
  }

  _selectStep(absIndex) {
    // Absolute-step selection: boot jumps to the step's page then selects it, so
    // the step grid + TRIG/SYNTH tabs follow. The resulting `stepSelected` event
    // re-tints blocks via refreshTints() — we must NOT rebuild blocks here, or an
    // in-flight double-click (remove) would lose its target element.
    this.state.emit('selectStepAbs', { absIndex });
  }

  _selectedAbsStep() {
    if (this.state.selectedStepIndex < 0) return -1;
    return this.seq.pageOffset * 16 + this.state.selectedStepIndex;
  }

  _emitStepChanged(absIndex) {
    this.state.emit('stepChanged', {
      trackIndex: this.state.selectedTrackIndex,
      stepIndex:  absIndex,
      step:       this.seq.steps[absIndex],
    });
  }

  _centreScroll() {
    if (!this._scroller) return;
    // Centre vertically on the mean of existing notes, else C4 (MIDI 60).
    const notes = [];
    for (const s of this.seq.steps) {
      if (s?.active) s.voices.forEach(v => notes.push(v.note));
    }
    const centreNote = notes.length
      ? notes.reduce((a, b) => a + b, 0) / notes.length
      : 60;
    const y = (N_NOTES - 1 - centreNote) * ROW_H - this._scroller.clientHeight / 2;
    this._scroller.scrollTop = Math.max(0, y);
  }
}
