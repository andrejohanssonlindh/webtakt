/**
 * DeckPanel.js
 * ------------
 * DECK tab: DJ-style crossfade between two decks (Project instances) managed by
 * DeckManager. Two symmetric deck columns (A left, B right) with a constant-power
 * crossfader between them.
 *
 * Per deck: LOAD a song file, CONTROL (point the editing UI at this deck),
 * SILENCE (mute this deck's bus independent of the fader), UNLOAD (tear the deck
 * out of the graph + free CPU). The crossfader rides both deck buses.
 *
 * Workflow: fade A→B, then UNLOAD A to free resources and LOAD the next song
 * into the now-free deck A, fade back. Endless mixing into new songs.
 *
 * Reads everything live from ctx.state.decks (the DeckManager). Structural
 * actions emit DeckManager events; index.html listens and re-renders the app.
 */
export class DeckPanel {
  /** @param {object} ctx — SynthPanel tab context (uses ctx.state, ctx.container, ctx.openModal) */
  render(ctx) {
    const decks = ctx.state.decks;
    const root  = ctx.container;
    root.innerHTML = '';

    if (!decks) {
      root.innerHTML = '<div class="deck-empty">Deck manager unavailable.</div>';
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'deck-panel';

    wrap.appendChild(this._buildDeckColumn(ctx, decks, 'A'));
    wrap.appendChild(this._buildFader(ctx, decks));
    wrap.appendChild(this._buildDeckColumn(ctx, decks, 'B'));

    root.appendChild(wrap);
  }

  // ── One deck column (A or B) ────────────────────────────────
  _buildDeckColumn(ctx, decks, id) {
    const col = document.createElement('div');
    col.className = 'deck-col deck-col-' + id.toLowerCase();
    if (decks.active === id) col.classList.add('deck-controlled');

    // Header: label + state
    const head = document.createElement('div');
    head.className = 'deck-col-head';
    const loaded = decks.isLoaded(id);
    head.innerHTML =
      `<span class="deck-label">DECK ${id}</span>` +
      `<span class="deck-state ${loaded ? 'loaded' : 'empty'}">` +
        `${loaded ? (decks.isSilenced(id) ? 'SILENCED' : (decks.isAudible(id) ? 'PLAYING' : 'CUED')) : 'EMPTY'}` +
      `</span>`;
    col.appendChild(head);

    // Filename (deck A may have none until imported; B gets one on load)
    const nameRow = document.createElement('div');
    nameRow.className = 'deck-filename';
    const fname = decks.name(id);
    nameRow.textContent = fname || (loaded ? '(unnamed)' : '—');
    nameRow.title = fname || '';
    col.appendChild(nameRow);

    // LOAD (file picker)
    const loadBtn = document.createElement('button');
    loadBtn.className = 'deck-btn deck-load';
    loadBtn.textContent = loaded ? '↻ LOAD NEW' : '⤓ LOAD SONG';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    loadBtn.addEventListener('click', () => {
      const doPick = () => fileInput.click();
      // Confirm only if replacing an already-audible deck (avoid nuking a live mix)
      if (decks.isLoaded(id) && decks.isAudible(id) && ctx.openModal) {
        ctx.openModal(`Deck ${id} is playing. Replace its song?`, null, doPick);
      } else {
        doPick();
      }
    });
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await decks.loadFile(id, file);
      fileInput.value = '';
    });
    col.appendChild(loadBtn);
    col.appendChild(fileInput);

    // CONTROL
    const ctrlBtn = document.createElement('button');
    ctrlBtn.className = 'deck-btn deck-control';
    ctrlBtn.classList.toggle('active', decks.active === id);
    ctrlBtn.textContent = decks.active === id ? `◉ CONTROL ${id}` : `CONTROL ${id}`;
    // Can't control an empty deck — nothing to edit until a song is loaded.
    ctrlBtn.disabled = !loaded;
    if (!loaded) ctrlBtn.title = 'Load a song into this deck first';
    ctrlBtn.addEventListener('click', () => decks.setControl(id));
    col.appendChild(ctrlBtn);

    // SILENCE
    const silBtn = document.createElement('button');
    silBtn.className = 'deck-btn deck-silence';
    silBtn.classList.toggle('active', decks.isSilenced(id));
    silBtn.textContent = decks.isSilenced(id) ? '🔇 SILENCED' : 'SILENCE';
    silBtn.disabled = !loaded;
    silBtn.addEventListener('click', () => decks.setSilenced(id, !decks.isSilenced(id)));
    col.appendChild(silBtn);

    // UNLOAD
    const other = id === 'A' ? 'B' : 'A';
    const unloadBtn = document.createElement('button');
    unloadBtn.className = 'deck-btn deck-unload';
    unloadBtn.textContent = '✕ UNLOAD';
    // Can't unload the last loaded deck (nothing left to control).
    unloadBtn.disabled = !loaded || !decks.isLoaded(other);
    unloadBtn.title = (!loaded || decks.isLoaded(other)) ? '' : 'Load the other deck first';
    unloadBtn.addEventListener('click', () => {
      const doUnload = () => decks.unload(id);
      if (decks.isAudible(id) && ctx.openModal) {
        ctx.openModal(`Unload deck ${id}? It's currently playing.`, null, doUnload);
      } else {
        doUnload();
      }
    });
    col.appendChild(unloadBtn);

    return col;
  }

  // ── Crossfader (centre) ─────────────────────────────────────
  _buildFader(ctx, decks) {
    const box = document.createElement('div');
    box.className = 'deck-fader-box';

    const title = document.createElement('div');
    title.className = 'deck-fader-title';
    title.textContent = 'CROSSFADER';
    box.appendChild(title);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'deck-fader';
    slider.min = '0';
    slider.max = '1000';
    slider.step = '1';
    slider.value = String(Math.round(decks.crossfade * 1000));
    slider.addEventListener('input', () => {
      decks.setCrossfade(parseInt(slider.value, 10) / 1000);
      this._updateReadout(box, decks);
    });
    box.appendChild(slider);

    const ends = document.createElement('div');
    ends.className = 'deck-fader-ends';
    ends.innerHTML = '<span>A</span><span class="deck-fader-readout">50 / 50</span><span>B</span>';
    box.appendChild(ends);

    this._updateReadout(box, decks);
    return box;
  }

  _updateReadout(box, decks) {
    const x = decks.crossfade;
    const aPct = Math.round((1 - x) * 100);
    const bPct = Math.round(x * 100);
    const out = box.querySelector('.deck-fader-readout');
    if (out) out.textContent = `${aPct} / ${bPct}`;
  }
}
