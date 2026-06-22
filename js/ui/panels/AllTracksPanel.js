/**
 * AllTracksPanel.js
 * -----------------
 * ALL tab: an all-tracks overview. One compact step row per track, stacked and
 * vertically scrollable. A RENDERER over every track's `Step[]` (like StepGrid /
 * PianoRoll) — it does not edit. Clicking a row selects that track.
 *
 * Each row shows the whole pattern (all `stepCount` cells, scaled small) so you
 * can read the arrangement at a glance. Cells reuse the StepGrid CSS classes
 * (step-cell / has-note / has-data / beat-start / playing) at a compact size.
 *
 * A self-contained requestAnimationFrame loop drives the per-row playhead while
 * the panel is mounted; it stops automatically once the panel's DOM is replaced
 * (guarded on isConnected), like the Oscilloscope loop.
 */

export class AllTracksPanel {
  render(ctx) {
    this._ctx   = ctx;
    this.state  = ctx.state;
    const { container, state } = ctx;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'alltracks-wrap';
    this._wrap = wrap;
    this._rows = [];   // { cells: HTMLElement[], seq, lastHi }

    state.project.tracks.forEach((track, i) => {
      wrap.appendChild(this._buildRow(track, i));
    });

    container.appendChild(wrap);
    this._startPlayheadLoop();
  }

  _buildRow(track, i) {
    const { state } = this;
    const seq = track.sequencer;

    const row = document.createElement('div');
    row.className = 'alltracks-row';
    row.classList.toggle('selected', i === state.selectedTrackIndex);
    row.classList.toggle('muted', !!track.muted);
    // Clicking the row (label or empty space) selects the track.
    row.addEventListener('click', () => state.selectTrack(i));

    const label = document.createElement('div');
    label.className = 'alltracks-label';

    // Top line: track number + mute toggle. The M dot mirrors TrackRow's mute dot
    // — clicking it toggles mute (and the row's dimmed `muted` state) without
    // selecting the track. We update this row inline and emit `muteChanged` so the
    // TrackRow dots (and any other listener) re-sync.
    const top = document.createElement('div');
    top.className = 'alltracks-top';
    const num = document.createElement('span');
    num.textContent = `T${i + 1}`;
    const mute = document.createElement('span');
    mute.className = 'alltracks-mute';
    mute.classList.toggle('active', !!track.muted);
    mute.textContent = 'M';
    mute.title = 'Mute / unmute';
    mute.addEventListener('click', (e) => {
      e.stopPropagation();              // don't also select the track
      track.muted ? track.unmute() : track.mute();
      mute.classList.toggle('active', !!track.muted);
      row.classList.toggle('muted', !!track.muted);
      this.state.emit('muteChanged', { track });   // keep TrackRow's dot in sync
    });
    top.appendChild(num);
    top.appendChild(mute);
    label.appendChild(top);

    const type = document.createElement('span');
    type.className = 'alltracks-type';
    type.textContent = track.machine?.type?.toUpperCase().replace('.', ' ') ?? '';
    label.appendChild(type);
    row.appendChild(label);

    const strip = document.createElement('div');
    strip.className = 'alltracks-strip';

    const cells = [];
    for (let s = 0; s < seq.stepCount; s++) {
      const cell = document.createElement('div');
      cell.className = 'alltracks-cell';
      strip.appendChild(cell);
      cells.push(cell);
    }
    row.appendChild(strip);

    const rowState = { cells, seq, lastHi: -1, row, mute, track };
    this._paintRow(rowState);
    this._rows.push(rowState);
    return row;
  }

  /** Re-sync a row's muted visuals from the track (mute can be toggled from the
   *  TrackRow dot too; SynthPanel routes muteChanged → refresh). */
  _paintMute(rowState) {
    const muted = !!rowState.track.muted;
    rowState.row.classList.toggle('muted', muted);
    rowState.mute.classList.toggle('active', muted);
  }

  /** Paint every cell's static state (note / data / beat). Cheap; called once
   *  per build and on stepChanged. Playhead is handled separately in the loop. */
  _paintRow(rowState) {
    const { cells, seq } = rowState;
    for (let s = 0; s < cells.length; s++) {
      const step = seq.steps[s];
      const cell = cells[s];
      const hasNote = !!step?.active;
      const hasData = !!(step && (step.hasPLocks || step.hasCondition));
      cell.className = [
        'alltracks-cell',
        hasNote ? 'has-note' : '',
        hasData ? 'has-data' : '',
        (s % 4 === 0) ? 'beat-start' : '',
        (s === rowState.lastHi) ? 'playing' : '',
      ].filter(Boolean).join(' ');
    }
  }

  /** Re-paint all rows (e.g. after a stepChanged or muteChanged from elsewhere). */
  refresh() {
    if (!this._wrap || !this._wrap.isConnected) return;
    this._rows.forEach(r => { this._paintRow(r); this._paintMute(r); });
  }

  // ── Per-row playhead (self-contained rAF) ──────────────────
  _startPlayheadLoop() {
    const tick = () => {
      // Stop once the panel is detached (tab/track switch replaced it).
      if (!this._wrap || !this._wrap.isConnected) return;
      this._rows.forEach(r => {
        const seq = r.seq;
        const playing = seq.clock?.isPlaying;
        const hi = playing
          ? ((seq._stepIndex - 1 + seq.stepCount) % seq.stepCount)
          : -1;
        if (hi === r.lastHi) return;
        // Clear previous, set new — toggle just the two affected cells.
        if (r.lastHi >= 0 && r.cells[r.lastHi]) r.cells[r.lastHi].classList.remove('playing');
        if (hi >= 0 && r.cells[hi]) r.cells[hi].classList.add('playing');
        r.lastHi = hi;
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
