/**
 * MixerPanel.js
 * -------------
 * MIXER tab: one strip per track (level knob, DLY/CRUSH/REV/DJ-filter knob grid,
 * FX on/off toggles, click-to-select). Extracted from SynthPanel.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { container, activeWidgets, knobByPath, state, fxBar }
 *
 * fxBar is the SynthPanel header FX bar element, kept in sync when a strip's
 * FX toggle changes the selected track.
 */

import { KnobWidget } from '../KnobWidget.js';

export class MixerPanel {
  render(ctx) {
    const { container, activeWidgets, knobByPath, state, fxBar } = ctx;
    const tracks = state.project.tracks;

    const wrapper = document.createElement('div');
    wrapper.className = 'mixer-wrapper';

    tracks.forEach((track, i) => {
      const strip = document.createElement('div');
      strip.className = 'mixer-strip';
      strip.classList.toggle('mixer-strip-selected', i === state.selectedTrackIndex);

      // Track label
      const label = document.createElement('div');
      label.className = 'mixer-strip-label';
      label.textContent = `T${i + 1}`;
      strip.appendChild(label);

      const typeLbl = document.createElement('div');
      typeLbl.className = 'mixer-strip-type';
      typeLbl.textContent = track.machine?.type?.toUpperCase().replace('.', ' ') ?? '';
      strip.appendChild(typeLbl);

      // ── LEVEL knob (linked to output.level on the machine) ──
      const levelVal = track.machine.getParam('output.level') ?? 0.8;
      const levelKnob = new KnobWidget({
        label:   'LEVEL',
        min:     0,
        max:     1,
        value:   levelVal,
        bipolar: false,
        size:    44,
        fmt:     v => Math.round(v * 100) + '%',
        onChange: v => {
          track.machine.setParam('output.level', v);
          track._pool?.syncParams();
          // Keep SynthPanel knob in sync when this track is selected
          if (i === state.selectedTrackIndex) {
            const linked = knobByPath.get('output.level');
            if (linked) linked.setValue(v);
          }
        },
      });
      strip.appendChild(levelKnob.el);
      activeWidgets.push(levelKnob);

      // ── 2×2 grid: DLY, CRUSH, REV, DJ FILT ──
      const grid = document.createElement('div');
      grid.className = 'mixer-knob-grid';
      strip.appendChild(grid);

      const fxDefs = [
        { obj: track.delayFX,    path: 'delay.wet',  label: 'DLY',     bipolar: false },
        { obj: track.bitcrushFX, path: 'crush.wet',  label: 'CRUSH',   bipolar: false },
        { obj: track.reverbFX,   path: 'reverb.wet', label: 'REV',     bipolar: false },
        { obj: null,             path: 'dj',         label: 'DJ FILT', bipolar: true  },
      ];
      fxDefs.forEach(({ obj, path, label: fxLabel, bipolar }) => {
        const val = path === 'dj' ? (track.djFilter ?? 0) : (obj.getParam(path) ?? 0);
        const knob = new KnobWidget({
          label:   fxLabel,
          min:     bipolar ? -1 : 0,
          max:     1,
          value:   val,
          bipolar,
          size:    44,
          fmt:     v => {
            if (path === 'dj') {
              if (Math.abs(v) < 0.02) return 'FLAT';
              return v < 0 ? 'LPF ' + Math.round(-v * 100) + '%' : 'HPF ' + Math.round(v * 100) + '%';
            }
            return Math.round(v * 100) + '%';
          },
          onChange: v => {
            if (path === 'dj') {
              track.applyDJFilter(v);
            } else {
              obj.setParam(path, v);
              if (i === state.selectedTrackIndex) {
                const linked = knobByPath.get(path);
                if (linked) linked.setValue(v);
              }
            }
          },
        });
        grid.appendChild(knob.el);
        activeWidgets.push(knob);
      });

      // ── FX on/off toggles ──
      const fxToggles = document.createElement('div');
      fxToggles.className = 'mixer-fx-toggles';

      [
        { fx: track.delayFX,    label: 'DLY'   },
        { fx: track.bitcrushFX, label: 'CRUSH' },
        { fx: track.reverbFX,   label: 'REV'   },
      ].forEach(({ fx, label: fxLabel }) => {
        const btn = document.createElement('button');
        btn.className = 'mixer-fx-toggle';
        const update = () => {
          const on = fx.enabled ?? false;
          btn.textContent = fxLabel;
          btn.classList.toggle('on', on);
        };
        update();
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          fx.setEnabled(!fx.enabled);
          update();
          // Keep the header FX bar in sync when this is the selected track
          if (i === state.selectedTrackIndex && fxBar) {
            fxBar.querySelectorAll('._updateState').forEach(el => el._updateState?.());
            fxBar.querySelectorAll('[data-fxtab]').forEach(wrap => wrap._updateState?.());
          }
        });
        fxToggles.appendChild(btn);
      });

      strip.appendChild(fxToggles);

      // Click strip to select track
      strip.addEventListener('click', (e) => {
        if (e.target.closest('.knob-canvas')) return;
        state.selectTrack(i);
        // Re-render to update selection highlight
        wrapper.querySelectorAll('.mixer-strip').forEach((s, j) => {
          s.classList.toggle('mixer-strip-selected', j === i);
        });
      });

      wrapper.appendChild(strip);
    });

    container.appendChild(wrapper);
  }
}
