/**
 * MachinePickerPanel.js
 * ---------------------
 * MACHINE tab: searchable grid of machine cards grouped by family (Drums /
 * Melodic / Sampler / MIDI). Clicking a card swaps the track's machine type.
 * Extracted from SynthPanel.
 *
 * MACHINE_GROUPS is the canonical source of truth for available machine types
 * and lives here. SynthPanel re-exports MACHINE_GROUPS / MACHINE_DEFS as static
 * getters delegating to this module for backward compatibility.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, container, state, renderContent }
 */

// Machine definitions shown in the machine tab, grouped
export const MACHINE_GROUPS = [
  {
    label: 'Drums',
    defs: [
      { type: 'kick.silk', label: 'Kick Silk', desc: 'Clean sine + pitch sweep' },
      { type: 'kick.hard', label: 'Kick Hard', desc: 'Sub + saturation + drive' },
      { type: 'snare',     label: 'Snare',     desc: 'Tone + noise' },
      { type: 'hihat',     label: 'HiHat',     desc: 'Inharmonic oscs' },
      { type: 'cymbal',    label: 'Cymbal',    desc: 'Crash / ride cymbal' },
      { type: 'clapp',     label: 'Clapp',     desc: '808-style layered clap' },
      { type: 'wood',      label: 'Wood',      desc: 'Clave / rimshot / cowbell' },
      { type: 'transient', label: 'Transient', desc: 'Click + body sweep' },
      { type: 'noise',     label: 'Noise',     desc: 'Shaped noise + crush' },
    ],
  },
  {
    label: 'Melodic',
    defs: [
      { type: 'synth',     label: 'Synth',     desc: 'Dual osc + sub' },
      { type: 'bass',      label: 'Bass',      desc: 'Bassline + glide + drive' },
      { type: 'chord',     label: 'Chord',     desc: '4-voice chord sequencer' },
      { type: 'wavetable', label: 'Wavetable', desc: 'Morphing wavetable osc' },
      { type: 'swarm',     label: 'Swarm',     desc: '7 saws + drift' },
      { type: 'fm',        label: 'FM',        desc: '4-op FM synth' },
      { type: 'karplus',   label: 'Karplus',   desc: 'Plucked string' },
      { type: 'marimba',   label: 'Marimba',   desc: 'Inharmonic bar percussion' },
      { type: 'comb',      label: 'Comb',      desc: 'Resonator / comb filter' },
    ],
  },
  {
    label: 'Sampler',
    defs: [
      { type: 'sampler',      label: 'Sampler',    desc: 'Load file or record mic' },
      { type: 'wt-sampler',   label: 'WT Sampler', desc: 'Morph between two samples' },
      { type: 'sample-swarm', label: 'Smp Swarm',  desc: '7-voice sample swarm cluster' },
    ],
  },
  {
    label: 'MIDI',
    defs: [
      { type: 'midi', label: 'MIDI Out', desc: 'Send notes to external MIDI device' },
    ],
  },
];

/** Flat list of all machine defs (backward-compat: SynthPanel.MACHINE_DEFS). */
export const MACHINE_DEFS = MACHINE_GROUPS.flatMap(g => g.defs);

export class MachinePickerPanel {
  render(ctx) {
    const { track, container, state, renderContent } = ctx;
    const current = track.machine?.type ?? 'synth';

    // ── Search input ──────────────────────────────────────────
    const searchWrap = document.createElement('div');
    searchWrap.className = 'machine-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type        = 'text';
    searchInput.placeholder = 'Filter machines…';
    searchInput.className   = 'machine-search';
    searchWrap.appendChild(searchInput);
    container.appendChild(searchWrap);

    // ── Grid container ────────────────────────────────────────
    const gridWrap = document.createElement('div');
    gridWrap.className = 'machine-grid-wrap';
    container.appendChild(gridWrap);

    const allCards = []; // { el, def, colEl }

    MACHINE_GROUPS.forEach(group => {
      const col = document.createElement('div');
      col.className = 'machine-group';
      gridWrap.appendChild(col);

      const heading = document.createElement('div');
      heading.className   = 'machine-group-heading';
      heading.textContent = group.label;
      col.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'machine-grid';
      col.appendChild(grid);

      group.defs.forEach(def => {
        const btn = document.createElement('button');
        btn.className = 'machine-card btn';
        btn.classList.toggle('selected', def.type === current);
        btn.innerHTML = `
          <span class="machine-card-label">${def.label}</span>
          <span class="machine-card-desc">${def.desc}</span>
        `;

        btn.addEventListener('click', () => {
          if (def.type === current) return;
          track.setMachine(def.type);
          state.emit('trackSelected', {
            index: state.selectedTrackIndex,
            track,
          });
          renderContent();
        });

        grid.appendChild(btn);
        allCards.push({ el: btn, def, colEl: col });
      });
    });

    // ── Filter logic ──────────────────────────────────────────
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      allCards.forEach(({ el, def }) => {
        const match = !q
          || def.label.toLowerCase().includes(q)
          || def.desc.toLowerCase().includes(q)
          || def.type.toLowerCase().includes(q);
        el.style.display = match ? '' : 'none';
      });
      // Hide entire group column when all its cards are hidden
      MACHINE_GROUPS.forEach(group => {
        const cards = allCards.filter(c => group.defs.some(d => d.type === c.def.type));
        const anyVisible = cards.some(c => c.el.style.display !== 'none');
        if (cards[0]?.colEl) cards[0].colEl.style.display = anyVisible ? '' : 'none';
      });
    });
  }
}
