/**
 * TrackRow.js
 * -----------
 * Renders the horizontal row of 8 track selector buttons at the top of the UI.
 * Each button shows: track number, machine type, mute state, follow indicator.
 * Clicking a track button selects it in AppState.
 * Clicking the mute area on a button toggles mute.
 *
 * Owns:    DOM elements for the track row
 * Depends: AppState.js
 * Used by: index.html (mounted to #track-row)
 *
 * Public:
 *   new TrackRow(containerEl, appState)
 *   render()   — full re-render (called on track selection or mute change)
 *
 * Listens to AppState events:
 *   'trackSelected' → re-render to update selected state
 */

export class TrackRow {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(container, state) {
    this.container = container;
    this.state     = state;
    this._buttons  = [];

    this._build();
    state.on('trackSelected', () => this.render());
  }

  // Machine types available for selection, in cycle order
  static MACHINE_TYPES = ['synth', 'kick.silk', 'kick.hard', 'snare', 'hihat', 'fm', 'drum'];

  _build() {
    this.container.innerHTML = '';
    this._buttons = this.state.project.tracks.map((track, i) => {
      const btn = document.createElement('button');
      btn.className = 'track-btn btn';
      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('mute-dot')) {
          track.muted ? track.unmute() : track.mute();
          this.render();
        } else {
          this.state.selectTrack(i);
        }
      });
      this.container.appendChild(btn);
      return btn;
    });
    this.render();
  }

  render() {
    this.state.project.tracks.forEach((track, i) => {
      const btn = this._buttons[i];
      const selected = i === this.state.selectedTrackIndex;

      btn.classList.toggle('selected', selected);
      btn.classList.toggle('muted', track.muted);

      const soundLine = track.loadedSoundName
        ? `<span class="track-sound">${track.loadedSoundName}</span>`
        : '';
      btn.innerHTML = `
        <span class="track-num">${i + 1}</span>
        <span class="track-type">${track.machine?.type ?? '—'}</span>
        ${soundLine}
        <span class="mute-dot ${track.muted ? 'active' : ''}">M</span>
        ${track.followSource !== null ? `<span class="follow-ind">→${track.followSource + 1}</span>` : ''}
      `;
    });
  }
}
