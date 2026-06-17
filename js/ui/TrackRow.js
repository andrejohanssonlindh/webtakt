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
    // Set by boot.js once the Keyboard exists; used to finger-drum tracks in
    // drum mode (tap = play). Null until then — the tap handler no-ops safely.
    this.keyboard  = null;

    this._build();
    state.on('trackSelected',   () => this.render());
    state.on('holdModeChanged', () => this.render());
    state.on('drumModeChanged', () => this.render());
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
      this._bindTrackButton(btn, track, i);
      this.container.appendChild(btn);
      return btn;
    });
    this.render();
  }

  /**
   * Wire one track button. Normally a tap selects the track (and a tap on the
   * mute dot toggles mute). In DRUM MODE a tap instead finger-drums the track —
   * on phones there's no keyboard, so the digit-key drumming (see Keyboard
   * `_drumNoteOn`) is unreachable; tapping the track plays it instead. We press
   * on pointerdown and release on pointerup/cancel so holding the pad sustains,
   * mirroring the on-screen piano keys. The mute dot always toggles mute, even
   * in drum mode, so it stays reachable.
   */
  _bindTrackButton(btn, track, i) {
    let drumming = false;

    btn.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('mute-dot')) {
        track.muted ? track.unmute() : track.mute();
        this.render();
        return;
      }
      if (this.state.drumMode && this.keyboard) {
        e.preventDefault();              // no synthesized click / scroll hijack
        drumming = true;
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        this.keyboard._drumNoteOn(i);
      }
    });

    const releaseDrum = () => {
      if (!drumming) return;
      drumming = false;
      this.keyboard?._drumNoteOff(i);
    };
    btn.addEventListener('pointerup',     releaseDrum);
    btn.addEventListener('pointercancel', releaseDrum);

    // Selection happens on click (fires only when NOT drumming — drum-mode
    // pointerdown calls preventDefault, suppressing the synthesized click).
    // The mute dot is handled on pointerdown above, so don't also select here.
    btn.addEventListener('click', (e) => {
      if (this.state.drumMode) return;
      if (e.target.classList.contains('mute-dot')) return;
      this.state.selectTrack(i);
    });
  }

  render() {
    // Drum mode turns the track buttons into finger-drum pads (tap = play),
    // so flag the container for the pad styling / hover cue.
    this.container.classList.toggle('drum-mode', this.state.drumMode);

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
