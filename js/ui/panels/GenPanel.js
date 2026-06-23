/**
 * GenPanel.js
 * -----------
 * GEN tab: a per-track ALGORITHMIC sequencer. Unlike ROLL/ALL (pure renderers
 * over hand-edited steps), GEN *writes* the track's Step[] from two independent
 * layers. The config lives on the track (track.gen, persisted) so each track has
 * its own generator; switching tracks/tabs reloads it.
 *
 * Two layers (see genRunner.js / makeDefaultGen):
 *   RHYTHM — which steps fire: OFF (manual) | ALL | EUCLID | TURING | CELLULAR
 *   PITCH  — what note each ACTIVE step plays: FIXED | SCALE | MARKOV
 * Any combination: e.g. EUCLID + MARKOV = a Euclidean groove whose notes wander
 * musically (the Markov walk advances once per active step, so it's no longer
 * forced 16/16). RHYTHM = OFF detaches the generator so the pattern freezes for
 * hand-editing and GEN never overwrites it again.
 *
 * Live regen — NO generate button. Any selector/knob change rewrites the steps
 * immediately (emits stepChanged so StepGrid/ROLL/TRIG refresh), so you watch the
 * pattern morph. REGEN/BAR additionally re-runs the evolving layers once per bar
 * while playing.
 *
 * Edits coexistence: GEN owns each step's `.active` + voices[0] note/velocity. It
 * PRESERVES per-step p-locks / condition / chance on steps that stay active, and
 * clears them only on steps it switches off.
 *
 * Standard panel context (see SynthPanel._makeTabContext):
 *   { track, container, activeWidgets, state }
 */

import { KnobWidget } from '../KnobWidget.js';
import { runGen, resetGenState } from '../../sequencer/genRunner.js';

const RHYTHMS = [
  { id: 'off',      label: 'OFF' },
  { id: 'manual',   label: 'MANUAL' },
  { id: 'all',      label: 'ALL' },
  { id: 'euclid',   label: 'EUCLID' },
  { id: 'turing',   label: 'TURING' },
  { id: 'cellular', label: 'CELLULAR' },
];

const PITCHES = [
  { id: 'fixed',  label: 'FIXED' },
  { id: 'scale',  label: 'SCALE' },
  { id: 'markov', label: 'MARKOV' },
];

const EVOLVING_RHYTHM = new Set(['turing', 'cellular']);

export class GenPanel {
  render(ctx) {
    const { track, container, activeWidgets, state } = ctx;
    this.track = track;
    this.state = state;
    this.gen   = track.gen;

    container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'gen-root';
    container.appendChild(root);
    this._root = root;

    // Two side-by-side groups (RHYTHM | PITCH) — they wrap below each other on
    // narrow screens via CSS. Each column = its selector + a params slot that
    // _renderParams refills. A full-width footer holds REGEN/BAR (shared).
    const cols = document.createElement('div');
    cols.className = 'gen-cols';
    root.appendChild(cols);

    const rhythmCol = this._buildColumn('RHYTHM', RHYTHMS, 'rhythm', (id) => {
      // Leaving/entering an evolving rhythm reseeds; OFF freezes the pattern.
      if (id !== 'off') { this._resetEvolving(); this._regenerate(); }
    });
    const pitchCol = this._buildColumn('PITCH', PITCHES, 'pitch', () => this._regenerate());
    cols.appendChild(rhythmCol.el);
    cols.appendChild(pitchCol.el);
    this._rhythmParams = rhythmCol.params;
    this._pitchParams  = pitchCol.params;

    this._footer = document.createElement('div');
    this._footer.className = 'gen-footer';
    root.appendChild(this._footer);

    // Tab-switch cleanup: SynthPanel destroys activeWidgets on _renderContent, so
    // register a handler that disposes whatever knobs this panel currently owns.
    activeWidgets.push({ destroy: () => this._myKnobs?.forEach(k => k.destroy?.()) });

    this._renderParams();
  }

  /**
   * Build one labelled column: a header (title + selector button strip) over a
   * params slot the caller fills. Returns { el, params }.
   */
  _buildColumn(label, options, field, onPick) {
    const el = document.createElement('div');
    el.className = 'gen-col';

    const head = document.createElement('div');
    head.className = 'gen-col-head';
    const lbl = document.createElement('div');
    lbl.className = 'gen-col-title';
    lbl.textContent = label;
    head.appendChild(lbl);

    const strip = document.createElement('div');
    strip.className = 'gen-algo-row';
    options.forEach(o => {
      const btn = document.createElement('button');
      btn.className = 'gen-algo-btn' + (o.id === this.gen[field] ? ' active' : '');
      btn.textContent = o.label;
      btn.addEventListener('click', () => {
        if (this.gen[field] === o.id) return;
        this.gen[field] = o.id;
        strip.querySelectorAll('.gen-algo-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onPick?.(o.id);
        this._renderParams();
      });
      strip.appendChild(btn);
    });
    head.appendChild(strip);
    el.appendChild(head);

    const params = document.createElement('div');
    params.className = 'gen-col-params';
    el.appendChild(params);

    return { el, params };
  }

  /** Drop runtime evolving state so the next run starts from a clean seed. */
  _resetEvolving() {
    resetGenState(this.track);
  }

  // ── Param widgets per layer combination ────────────────────
  _renderParams() {
    this._myKnobs?.forEach(k => k.destroy?.());
    this._myKnobs = [];
    this._rhythmParams.innerHTML = '';
    this._pitchParams.innerHTML  = '';
    this._footer.innerHTML        = '';

    const g = this.gen;

    // ── RHYTHM column body ──
    if (g.rhythm === 'off') {
      this._hint(this._rhythmParams,
        'OFF — steps are hand-edited (TRIG / ROLL / grid). Pick a rhythm to generate them.');
    } else if (g.rhythm === 'manual') {
      this._hint(this._rhythmParams,
        'MANUAL — your hand-placed steps are the rhythm; GEN only sets their PITCH →');
    } else if (g.rhythm === 'euclid') {
      this._knobGroup(this._rhythmParams)(k => {
        k({ label: 'PULSES', min: 0, max: 32, value: g.pulses, fmt: v => `${Math.round(v)}`,
          onChange: v => { g.pulses = Math.round(v); this._regenerate(); } });
        k({ label: 'STEPS', min: 1, max: 64, value: g.steps, fmt: v => `${Math.round(v)}`,
          onChange: v => { g.steps = Math.round(v); this._regenerate(); } });
        k({ label: 'ROTATE', min: -32, max: 32, value: g.rotate, bipolar: true, fmt: v => `${Math.round(v)}`,
          onChange: v => { g.rotate = Math.round(v); this._regenerate(); } });
      });
    } else if (g.rhythm === 'turing') {
      this._knobGroup(this._rhythmParams)(k => {
        k({ label: 'LENGTH', min: 1, max: 64, value: g.tLength, fmt: v => `${Math.round(v)}`,
          onChange: v => { g.tLength = Math.round(v); this._resetEvolving(); this._regenerate(); } });
        k({ label: 'RANDOM', min: 0, max: 1, value: g.randomness, fmt: v => `${Math.round(v * 100)}%`,
          onChange: v => { g.randomness = v; this._regenerate(); } });
      });
    } else if (g.rhythm === 'cellular') {
      this._knobGroup(this._rhythmParams)(k => {
        k({ label: 'RULE', min: 0, max: 255, value: g.rule, fmt: v => `${Math.round(v)}`,
          onChange: v => { g.rule = Math.round(v); this._resetEvolving(); this._regenerate(); } });
      });
    }
    // 'all' has no rhythm knobs (empty column body).

    // ── PITCH column body ──
    if (g.rhythm !== 'off') {
      // Base note + velocity (every active step plays a note).
      this._noteRow(this._pitchParams);
      if (g.pitch === 'markov') {
        this._knobGroup(this._pitchParams)(k => {
          k({ label: 'LENGTH', min: 1, max: 64, value: g.mLength, fmt: v => `${Math.round(v)}`,
            onChange: v => { g.mLength = Math.round(v); this._regenerate(); } });
          k({ label: 'DEGREES', min: 2, max: 12, value: g.degrees, fmt: v => `${Math.round(v)}`,
            onChange: v => { g.degrees = Math.round(v); this._regenerate(); } });
        });
      } else if (g.pitch === 'fixed' && g.rhythm === 'manual') {
        // FIXED + MANUAL would flatten the user's hand-set notes — warn.
        this._hint(this._pitchParams, 'FIXED sets every hit to one NOTE — use SCALE or MARKOV to keep variety.');
      }
    }

    // ── Footer: REGEN/BAR when something evolves per pass (evolving rhythm or
    // MARKOV pitch). SCALE/FIXED are deterministic → nothing to re-roll. ──
    if (g.rhythm !== 'off' && (EVOLVING_RHYTHM.has(g.rhythm) || g.pitch === 'markov')) {
      this._regenButton(this._footer);
    }
  }

  /** Append a dim hint line to `parent`. */
  _hint(parent, text) {
    const note = document.createElement('div');
    note.className = 'gen-manual-note';
    note.textContent = text;
    parent.appendChild(note);
  }

  /** Returns a builder bound to `parent`: call with fn(k) where k(opts) makes+appends a knob. */
  _knobGroup(parent) {
    const row = document.createElement('div');
    row.className = 'gen-knob-row';
    parent.appendChild(row);
    return (build) => build(opts => {
      const k = new KnobWidget(opts);
      row.appendChild(k.el);
      this._myKnobs.push(k);
      return k;
    });
  }

  /** Base note (label depends on pitch mode) + velocity, appended to `parent`. */
  _noteRow(parent) {
    const g = this.gen;
    const row = document.createElement('div');
    row.className = 'gen-knob-row';
    parent.appendChild(row);

    const baseLabel = g.pitch === 'fixed' ? 'NOTE' : 'ROOT';
    const baseK = new KnobWidget({
      label: baseLabel, min: 0, max: 127, value: g.baseNote,
      fmt: v => noteName(Math.round(v)),
      onChange: v => { g.baseNote = Math.round(v); this._regenerate(); },
    });
    const velK = new KnobWidget({
      label: 'VEL', min: 1, max: 127, value: g.velocity, fmt: v => `${Math.round(v)}`,
      onChange: v => { g.velocity = Math.round(v); this._regenerate(); },
    });
    row.appendChild(baseK.el);
    row.appendChild(velK.el);
    this._myKnobs.push(baseK, velK);
  }

  _regenButton(parent) {
    const g = this.gen;
    const wrap = document.createElement('div');
    wrap.className = 'gen-regen-wrap';
    const btn = document.createElement('button');
    btn.className = 'gen-regen-btn' + (g.regen ? ' active' : '');
    btn.textContent = 'REGEN / BAR';
    btn.title = 'Re-run the generator once per bar while playing — evolving rhythm '
      + '(turing/cellular) and/or re-rolling the MARKOV pitch walk';
    btn.addEventListener('click', () => {
      g.regen = !g.regen;
      btn.classList.toggle('active', g.regen);
    });
    wrap.appendChild(btn);

    const step = document.createElement('button');
    step.className = 'gen-step-btn';
    step.textContent = 'STEP ▸';
    step.title = 'Advance the generator one iteration now';
    step.addEventListener('click', () => this._regenerate(true));
    wrap.appendChild(step);

    parent.appendChild(wrap);
  }

  // ── Generation ─────────────────────────────────────────────

  /**
   * Re-run the layers into the track's Step[] and refresh every renderer.
   * Delegates to the shared headless runner (genRunner.runGen) so the panel and
   * the per-bar Sequencer hook share one code path.
   * @param {boolean} evolve  advance evolving state (STEP button / per-bar); a
   *                          plain param change re-derives without ratcheting.
   */
  _regenerate(evolve = false) {
    if (this.gen.rhythm === 'off') return;
    if (runGen(this.track, evolve)) {
      this.state.emit('stepChanged', { trackIndex: this.track.index, stepIndex: -1, step: null });
    }
  }
}

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(midi) {
  const m = Math.max(0, Math.min(127, midi));
  return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}
