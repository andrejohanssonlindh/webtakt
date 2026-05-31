/**
 * StepGrid.js
 * -----------
 * Renders the 16-step sequencer grid for the currently selected track.
 *
 * Step visual states (border color):
 *   empty (no data, no note) — dark border
 *   has-data (p-locks only)  — orange border
 *   has-note (active note)   — red border
 *   selected                 — light gray background
 *   playing                  — white flash (sequencer cursor)
 *   beat-start (every 4th)   — four corner dots
 *
 * Clicking a step SELECTS it (toggles). Notes are added via the keyboard.
 *
 * Owns:    16 step cell DOM elements
 * Depends: AppState.js
 * Used by: index.html (mounted to #step-grid)
 *
 * Public:
 *   new StepGrid(containerEl, appState)
 *   render()              — re-render all step cells
 *   highlightStep(index)  — visually highlight the playing step
 *
 * Listens to AppState events:
 *   'trackSelected' → rebuild grid for new track
 *   'stepSelected'  → re-render to show selection state
 *   'stepChanged'   → re-render when a step's note/data changes
 */

export class StepGrid {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(container, state) {
    this.container = container;
    this.state     = state;
    this._cells    = [];
    this._activeHighlight = -1;

    this._build();
    state.on('trackSelected', () => this._build());
    state.on('stepSelected',  () => this.render());
    state.on('stepChanged',   () => this.render());
  }

  _build() {
    this.container.innerHTML = '';
    this._cells = [];
    this._activeHighlight = -1;

    const grid = document.createElement('div');
    grid.className = 'step-grid-inner';

    const steps = this.state.selectedTrack.sequencer.getVisibleSteps();

    steps.forEach((step, i) => {
      const cell = document.createElement('div');
      cell.className = 'step-cell';
      cell.dataset.index = i;

      // Step number label — pointer-events: none in CSS so clicks pass through
      const numEl = document.createElement('span');
      numEl.className = 'step-num';
      cell.appendChild(numEl);

      cell.addEventListener('click', () => {
        this.state.selectStep(i);
      });

      cell.addEventListener('dblclick', e => {
        e.stopPropagation();
        const track = this.state.selectedTrack;
        const visibleSteps = track.sequencer.getVisibleSteps();
        const target = visibleSteps[i];

        if (target.active) {
          target.active = false;
        } else {
          // Add note: find the lowest note among all active steps; fall back to 36 (C2)
          const allSteps = track.sequencer.steps;
          const activeNotes = allSteps.filter(s => s.active).map(s => s.voices[0]?.note ?? 60);
          const lowestNote = activeNotes.length > 0 ? Math.min(...activeNotes) : 36;
          target.active = true;
          target.voices = [{ note: lowestNote, velocity: 100, length: 1, nudge: 0 }];
        }

        this.state.emit('stepChanged', {
          trackIndex: this.state.selectedTrackIndex,
          stepIndex:  i,
          step: target,
        });
        this.state.selectStep(-1);
      });

      grid.appendChild(cell);
      this._cells.push(cell);
    });

    this.container.appendChild(grid);
    this.render();
  }

  render() {
    const steps = this.state.selectedTrack.sequencer.getVisibleSteps();
    steps.forEach((step, i) => {
      this.renderCell(this._cells[i], step, i);
    });
  }

  /**
   * Update a single cell's visual state.
   * @param {HTMLElement} cell
   * @param {import('../sequencer/Step.js').Step} step
   * @param {number} index
   */
  renderCell(cell, step, index) {
    const seq        = this.state.selectedTrack.sequencer;
    const absIndex   = seq.pageOffset * 16 + index;
    const isInactive = absIndex >= seq.stepCount;
    const isSelected = index === this.state.selectedStepIndex;
    const isPlaying  = index === this._activeHighlight;
    const isBeat     = index % 4 === 0;

    // Border state: note > data > empty
    const hasNote = step.active;
    const hasData = step.hasPLocks || step.hasCondition;

    cell.className = [
      'step-cell',
      isInactive ? 'inactive'   : '',
      hasNote    ? 'has-note'   : '',
      hasData    ? 'has-data'   : '',
      step.hasPLocks    ? 'has-plock' : '',
      isSelected ? 'selected'  : '',
      isPlaying  ? 'playing'   : '',
      isBeat     ? 'beat-start': '',
    ].filter(Boolean).join(' ');

    // Condition dot — injected as child element since ::before is taken by beat-start
    let condDot = cell.querySelector('.step-cond-dot');
    if (step.hasCondition) {
      if (!condDot) {
        condDot = document.createElement('span');
        condDot.className = 'step-cond-dot';
        cell.appendChild(condDot);
      }
    } else {
      condDot?.remove();
    }

    // Step number
    const numEl = cell.querySelector('.step-num');
    if (numEl) numEl.textContent = absIndex + 1;

    // Voice dots — up to 8 slots, one per recorded voice
    const MAX_VOICE_DOTS = 8;
    let dotsEl = cell.querySelector('.step-voice-dots');
    if (!dotsEl) {
      dotsEl = document.createElement('span');
      dotsEl.className = 'step-voice-dots';
      cell.appendChild(dotsEl);
    }
    dotsEl.innerHTML = '';
    const voiceCount = step.active ? Math.min(step.voices.length, MAX_VOICE_DOTS) : 0;

    // Sum voices from gates still ringing that reach forward over THIS step.
    // A gate covers steps (origin, origin+spanSteps) along play order, wrapping
    // mod stepCount — so a long note paints sustain dots only on the steps it
    // actually spans, not on every other step in the row. Only while playing:
    // when stopped, wall-clock keeps advancing but nothing is really ringing, so
    // a frozen gate must not keep lighting steps up.
    const nowMs  = performance.now();
    const gates  = (seq.clock?.isPlaying) ? (seq._activeGates ?? []) : [];
    const stepCount = seq.stepCount;
    const coversThisStep = (g) => {
      const span = g.spanSteps ?? 1;
      // distance from the gate's origin to this step, forward, modulo the pattern
      const dist = ((absIndex - g.absStep) % stepCount + stepCount) % stepCount;
      return dist >= 1 && dist < span;   // (origin, origin+span) — not the origin itself
    };
    const rawSustain = gates
      .filter(g => g.endMs > nowMs && coversThisStep(g))
      .reduce((sum, g) => sum + g.voiceCount, 0);
    const sustainCount = Math.min(rawSustain, MAX_VOICE_DOTS);

    // Green dots for this step's own voices, then white for sustained voices.
    // sustainCount is additive on top of voiceCount (step 10 with 2 green + 3 white → 5 dots).
    const totalActive = Math.min(voiceCount + sustainCount, MAX_VOICE_DOTS);
    for (let d = 0; d < MAX_VOICE_DOTS; d++) {
      const dot = document.createElement('span');
      if (d < voiceCount) {
        dot.className = 'step-voice-dot active';
      } else if (d < totalActive) {
        dot.className = 'step-voice-dot sustain';
      } else {
        dot.className = 'step-voice-dot';
      }
      dotsEl.appendChild(dot);
    }

    cell.title = step.active
      ? `Step ${absIndex + 1}: ${step.voices.length} voice${step.voices.length > 1 ? 's' : ''} — ${step.voices.map(v => this._noteName(v.note)).join(', ')}`
      : `Step ${absIndex + 1}: empty`;
  }

  _noteName(midi) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  }

  /**
   * Visually highlight the currently playing step.
   * @param {number} index — step index, or -1 to clear
   */
  highlightStep(index) {
    const prev = this._activeHighlight;
    this._activeHighlight = index;

    if (prev >= 0 && this._cells[prev]) {
      const steps = this.state.selectedTrack.sequencer.getVisibleSteps();
      this.renderCell(this._cells[prev], steps[prev], prev);
    }
    if (index >= 0 && this._cells[index]) {
      this._cells[index].classList.add('playing');
    }
  }
}
