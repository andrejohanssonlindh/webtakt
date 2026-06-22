/**
 * MixerPanel.js
 * -------------
 * MIXER tab: one strip per track. Reflects the current FX model — a track can
 * carry any number of reorderable FX blocks (FXPipelinePanel) and assign up to
 * four global keybinds (FX 1–4) to the ones that matter. The mixer shows, per
 * track: a LEVEL fader, a wet/mix knob + ON/OFF for each KEY-BOUND FX block, and
 * a DJ filter. Tracks with no binds show just LEVEL + DJ.
 *
 * Three responsive tiers (single panel, layout chosen at render time):
 *   • Desktop  (>1024px) — full strips in a wrapping row.
 *   • Tablet   (≤1024px) — same strip content, reflowed into a grid.
 *   • Phone    (≤640px)  — LIGHT mode: a track pick-list chip row at the top
 *                          (curate which tracks show, default first 6, persisted)
 *                          then compact LEVEL + DJ-only strips in a grid.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { container, activeWidgets, knobByPath, state, renderContent }
 *
 * Toggling a strip's FX on/off emits `fxEnabledChanged`; SynthPanel listens for
 * that to refresh the header chain mini-outline.
 */

import { KnobWidget } from '../KnobWidget.js';
import { FX_TYPE_LABELS } from '../../state/Track.js';
import { TYPE_GLYPH } from './FXPipelinePanel.js';

// Responsive breakpoints — must match the CSS (RESPONSIVE.md: tablet ≤1024, phone ≤640).
const PHONE_MQ  = '(max-width: 640px)';
const TABLET_MQ = '(max-width: 1024px)';

// Phone light-mode track selection persists across sessions (independent of the
// project, like Settings). Default = first 6 tracks.
const PHONE_PICKS_KEY = 'webtakt_mixer_phone_tracks';
const PHONE_DEFAULT_COUNT = 6;

export class MixerPanel {
  render(ctx) {
    this._ctx = ctx;
    const { container, state } = ctx;
    this._tracks = state.project.tracks;

    // Tablet/iPad uses the same LIGHT mode as phone (pick-list + LEVEL/DJ-only
    // strips) — the full bound-FX strips are a desktop-only affordance.
    const light = window.matchMedia(TABLET_MQ).matches;

    const wrapper = document.createElement('div');
    wrapper.className = 'mixer-wrapper' + (light ? ' mixer-light' : ' mixer-desktop');

    if (light) {
      // Pick-list chips, then LEVEL + DJ-only strips for the picked tracks.
      container.appendChild(this._renderPhonePicks());
      const picks = this._getPhonePicks();
      this._tracks.forEach((track, i) => {
        if (!picks.has(i)) return;
        wrapper.appendChild(this._strip(track, i, { light: true }));
      });
    } else {
      // Desktop: full strips (LEVEL + bound-FX grid + DJ) for every track.
      this._tracks.forEach((track, i) => {
        wrapper.appendChild(this._strip(track, i, { light: false }));
      });
    }

    container.appendChild(wrapper);
  }

  // ── One track strip ────────────────────────────────────────

  /**
   * Build one mixer strip. `light` (phone) = LEVEL + DJ only; otherwise also a
   * row per key-bound FX (FX 1–4).
   */
  _strip(track, i, { light }) {
    const { state } = this._ctx;

    const strip = document.createElement('div');
    strip.className = 'mixer-strip';
    strip.classList.toggle('mixer-strip-selected', i === state.selectedTrackIndex);

    const label = document.createElement('div');
    label.className = 'mixer-strip-label';
    label.textContent = `T${i + 1}`;
    strip.appendChild(label);

    const typeLbl = document.createElement('div');
    typeLbl.className = 'mixer-strip-type';
    typeLbl.textContent = track.machine?.type?.toUpperCase().replace('.', ' ') ?? '';
    strip.appendChild(typeLbl);

    strip.appendChild(this._levelKnob(track, i).el);

    // → FX send toggle: routes this track through the global FX track before the
    // bus (insert). Hidden if there's no FX track (older/edge projects).
    const sendBtn = this._sendToggle(track);
    if (sendBtn) strip.appendChild(sendBtn);

    // Bound-FX cells (desktop only), laid 2-per-row so all 4 binds fit in two
    // rows without the strip growing tall enough to scroll. One cell per
    // assigned bind 1–4.
    if (!light) {
      const grid = document.createElement('div');
      grid.className = 'mixer-fx-grid';
      const seen = new Set();
      for (let n = 1; n <= 4; n++) {
        const id = track.getFXBindBlock(n);
        if (!id || seen.has(id)) continue;   // skip empty / duplicate binds
        seen.add(id);
        const cell = this._boundFXRow(track, i, n, id);
        if (cell) grid.appendChild(cell);
      }
      if (grid.children.length) strip.appendChild(grid);
    }

    strip.appendChild(this._djKnob(track, i).el);

    // Click strip body to select the track (ignore clicks on knobs/controls).
    // selectTrack emits stepSelected → SynthPanel re-renders the whole content,
    // so the selection highlight (and selected-track knob links) refresh for free.
    strip.addEventListener('click', (e) => {
      if (e.target.closest('.knob-canvas, .mixer-fx-toggle, button')) return;
      if (i !== state.selectedTrackIndex) state.selectTrack(i);
    });

    return strip;
  }

  /**
   * "→ FX" send toggle for a track: routes its output through the global FX
   * track (insert) when on. Returns null if the project has no FX track.
   */
  _sendToggle(track) {
    const { state } = this._ctx;
    const fxTrack = state.project.fxTrack;
    if (!fxTrack || track === fxTrack) return null;

    const btn = document.createElement('button');
    btn.className = 'mixer-send-toggle';
    const sync = () => {
      btn.textContent = track.fxSend ? '→ FX' : '→ FX';
      btn.classList.toggle('on', !!track.fxSend);
    };
    sync();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      track.setFXSend(!track.fxSend, fxTrack);
      sync();
      state.emit('fxSendChanged', { track });
    });
    return btn;
  }

  // ── Knob builders (shared across tiers) ────────────────────

  _levelKnob(track, i) {
    const { state, knobByPath, activeWidgets } = this._ctx;
    const knob = new KnobWidget({
      label: 'LEVEL',
      min: 0, max: 1, bipolar: false, size: 44,
      value: track.machine.getParam('output.level') ?? 0.8,
      fmt: v => Math.round(v * 100) + '%',
      onChange: v => {
        track.machine.setParam('output.level', v);
        track._pool?.syncParams();
        if (i === state.selectedTrackIndex) {
          knobByPath.get('output.level')?.setValue(v);
        }
      },
    });
    activeWidgets.push(knob);
    return knob;
  }

  _djKnob(track, i) {
    const { activeWidgets } = this._ctx;
    const knob = new KnobWidget({
      label: 'DJ FILT',
      min: -1, max: 1, bipolar: true, size: 44,
      value: track.djFilter ?? 0,
      fmt: v => {
        if (Math.abs(v) < 0.02) return 'FLAT';
        return v < 0 ? 'LPF ' + Math.round(-v * 100) + '%' : 'HPF ' + Math.round(v * 100) + '%';
      },
      onChange: v => track.applyDJFilter(v),
    });
    activeWidgets.push(knob);
    return knob;
  }

  /**
   * One bound-FX row: glyph + FX label + its primary (wet/mix/amount) knob +
   * ON/OFF toggle. Returns null if the bound block is missing or has no numeric
   * param to control.
   */
  _boundFXRow(track, i, bindN, id) {
    const { state, knobByPath, activeWidgets } = this._ctx;
    const fx   = track.getFXBlock(id);
    const type = track.getFXType(id);
    if (!fx) return null;

    const desc = this._primaryParam(fx);
    if (!desc) return null;

    const row = document.createElement('div');
    row.className = 'mixer-bound-fx';

    const head = document.createElement('div');
    head.className = 'mixer-bound-fx-head';
    head.innerHTML = `<span class="mixer-bound-fx-glyph">${TYPE_GLYPH[type] ?? '●'}</span>`
      + `<span class="mixer-bound-fx-name">${FX_TYPE_LABELS[type] ?? type}</span>`
      + `<span class="mixer-bound-fx-bind">FX${bindN}</span>`;
    row.appendChild(head);

    // Primary-param knob (e.g. wet / mix / amount). Reuse the selected-track →
    // synth-panel knob sync when the path is a base (non-namespaced) one the
    // panel also shows.
    const knob = new KnobWidget({
      label: (desc.label ?? 'WET').toUpperCase(),
      min: desc.min ?? 0, max: desc.max ?? 1, bipolar: (desc.min ?? 0) < 0, size: 40,
      value: fx.getParam(desc.path) ?? desc.default ?? 0,
      fmt: v => Math.round(v * 100) + '%',
      onChange: v => {
        fx.setParam(desc.path, v);
        if (i === state.selectedTrackIndex) knobByPath.get(desc.path)?.setValue(v);
      },
    });
    activeWidgets.push(knob);
    row.appendChild(knob.el);

    // ON/OFF toggle for this FX block (mirrors the per-bind keybind toggle).
    const btn = document.createElement('button');
    btn.className = 'mixer-fx-toggle';
    const sync = () => {
      btn.textContent = fx.enabled ? 'ON' : 'OFF';
      btn.classList.toggle('on', !!fx.enabled);
    };
    sync();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      fx.setEnabled?.(!fx.enabled);
      sync();
      state.emit?.('fxEnabledChanged', { trackIndex: i });
    });
    row.appendChild(btn);

    return row;
  }

  /**
   * Pick a bound FX block's primary control param. No universal "wet" exists
   * across FX types (Reverb=wet, Chorus=mix, Width=amount, Gate=depth, …), so
   * prefer a param whose path ends in wet/mix/amount/depth, else the first
   * non-hidden numeric param. Works for base blocks (bare paths) and FXInstance
   * proxies (namespaced `fxN.` paths) alike — both expose getParamList().
   * @returns {{path,label,min,max,default}|null}
   */
  _primaryParam(fx) {
    const list = fx.getParamList?.() ?? [];
    const numeric = list.filter(p => p.type === 'number' && !p.hidden);
    if (!numeric.length) return null;
    const wetLike = numeric.find(p => /\.(wet|mix|amount|depth)$/.test(p.path));
    return wetLike ?? numeric[0];
  }

  // ── Phone pick-list ────────────────────────────────────────

  /** The chip row letting the user curate which tracks the phone mixer shows. */
  _renderPhonePicks() {
    const picks = this._getPhonePicks();
    const bar = document.createElement('div');
    bar.className = 'mixer-phone-picks';

    const hint = document.createElement('div');
    hint.className = 'mixer-phone-picks-hint';
    hint.textContent = 'SHOW';
    bar.appendChild(hint);

    this._tracks.forEach((_, i) => {
      const chip = document.createElement('button');
      chip.className = 'mixer-pick-chip' + (picks.has(i) ? ' on' : '');
      chip.textContent = `T${i + 1}`;
      chip.addEventListener('click', () => {
        const next = this._getPhonePicks();
        if (next.has(i)) next.delete(i); else next.add(i);
        this._setPhonePicks(next);
        this._ctx.renderContent();   // rebuild strips for the new selection
      });
      bar.appendChild(chip);
    });

    return bar;
  }

  /** Persisted phone track selection → Set<trackIndex>, clamped to track count. */
  _getPhonePicks() {
    const n = this._tracks.length;
    let arr;
    try {
      arr = JSON.parse(localStorage.getItem(PHONE_PICKS_KEY) ?? 'null');
    } catch { arr = null; }
    if (!Array.isArray(arr)) {
      arr = Array.from({ length: Math.min(PHONE_DEFAULT_COUNT, n) }, (_, k) => k);
    }
    return new Set(arr.filter(i => Number.isInteger(i) && i >= 0 && i < n));
  }

  _setPhonePicks(set) {
    try {
      localStorage.setItem(PHONE_PICKS_KEY, JSON.stringify([...set].sort((a, b) => a - b)));
    } catch { /* quota — selection just won't persist */ }
  }
}
