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

// Fade shape constants for the trig glow
const FADE_IN_MS  = 8;    // fast attack so even a 1-frame tap reads as lit
const FADE_OUT_MS = 180;  // smooth release tail

export class TrackRow {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(container, state) {
    this.container = container;
    this.state     = state;
    this._buttons  = [];
    this._rafId    = null;

    this._build();
    state.on('trackSelected',   () => this.render());
    state.on('holdModeChanged', () => this.render());
    this._startGlowLoop();
  }

  // Machine types available for selection, in cycle order
  static MACHINE_TYPES = ['synth', 'kick.silk', 'kick.hard', 'snare', 'hihat', 'fm', 'drum'];

  _startGlowLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      const now = performance.now();
      this.state.project.tracks.forEach((track, i) => {
        const btn = this._buttons[i];
        if (!btn) return;
        const seq = track.sequencer;
        const elapsed  = now - seq.lastFireTime;       // ms since fire started
        const duration = seq.lastFireDuration;         // gate length in ms

        let brightness = 0;
        if (elapsed >= 0) {
          if (elapsed < FADE_IN_MS) {
            // Attack
            brightness = elapsed / FADE_IN_MS;
          } else if (elapsed < duration) {
            // Hold — sustain at full with a gentle slow strobe for long notes
            const holdPhase = (elapsed - FADE_IN_MS) / Math.max(1, duration - FADE_IN_MS);
            // Slow sine strobe: amplitude shrinks for short notes, grows for long
            const strobeDepth = Math.min(0.35, (duration / 1000) * 0.12);
            brightness = 1 - strobeDepth * (0.5 - 0.5 * Math.cos(holdPhase * Math.PI * 2 * 2));
          } else {
            // Release tail
            const tail = elapsed - duration;
            brightness = Math.max(0, 1 - tail / FADE_OUT_MS);
          }
        }

        btn.style.setProperty('--trig-glow', brightness.toFixed(3));
      });
    };
    this._rafId = requestAnimationFrame(tick);
  }

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
        <span class="hold-dot ${track.held ? 'active' : ''}">H</span>
        ${track.followSource !== null ? `<span class="follow-ind">→${track.followSource + 1}</span>` : ''}
      `;
    });
  }
}
