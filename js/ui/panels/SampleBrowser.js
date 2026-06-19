/**
 * SampleBrowser.js
 * ----------------
 * Full-screen overlay for finding samples to load into any sampler machine.
 *
 * Two tabs:
 *   CURATED  — hand-picked CC0 one-shots (samples/curated.json), filterable by
 *              category. Always reliable, no network search needed.
 *   ARCHIVE  — live search of archive.org (no auth). Pick an item → list its
 *              loose audio files → load one. In local/curator mode each file
 *              gets a ★ TAG button to add it to the curated list (exported as a
 *              fresh curated.json to drop back into samples/).
 *
 * Loading: the panel never touches the audio graph itself — it calls the
 * `onLoad(url, name)` callback the host sampler passes in, which runs the same
 * fetch → decodeAudioData → setBuffer path as a local file.
 *
 * Usage:
 *   new SampleBrowser({ curated, onLoad });   // opens immediately
 */

import { search, listFiles, itemPageUrl } from '../../state/ArchiveSearch.js';

export class SampleBrowser {
  /**
   * @param {object}  opts
   * @param {import('../../state/CuratedSamples.js').CuratedSamples} opts.curated
   * @param {(url:string,name:string)=>Promise<void>} opts.onLoad
   */
  constructor({ curated, onLoad }) {
    this.curated = curated;
    this.onLoad  = onLoad;
    this._tab    = 'curated';
    this._filter = 'all';
    this._abort  = null;          // in-flight search/list AbortController
    this._build();
    // Pull the manifest + curator probe in; re-render once known so the
    // ★ ADD / ✕ REMOVE affordances appear if a curate server is running.
    this.curated.load().then(() => {
      this._build();   // rebuild header so the curator note shows/hides
      this._renderBody();
    });
  }

  /** True when the local curate server answered — enables ★ ADD / ✕ REMOVE. */
  get curator() {
    return this.curated.isCurator;
  }

  _build() {
    // Rebuilt once after the curator probe resolves — drop any prior overlay so
    // they don't stack.
    this.overlay?.remove();
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay sample-browser-overlay';
    this.overlay.addEventListener('mousedown', e => {
      if (e.target === this.overlay) this.close();
    });

    const box = document.createElement('div');
    box.className = 'sample-browser-box';

    // Header: title + tabs + close
    const header = document.createElement('div');
    header.className = 'sample-browser-header';

    const title = document.createElement('span');
    title.className = 'sample-browser-title';
    title.textContent = 'LOAD SAMPLE';
    header.appendChild(title);

    this._tabBtns = {};
    for (const [id, label] of [['curated', 'CURATED'], ['archive', 'ARCHIVE.ORG']]) {
      const b = document.createElement('button');
      b.className = 'btn sample-browser-tab';
      b.textContent = label;
      b.addEventListener('click', () => this._setTab(id));
      header.appendChild(b);
      this._tabBtns[id] = b;
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    // Curator badge — present only when the local curate server answered. Edits
    // (★ ADD / ✕ REMOVE) write samples/curated.json directly; no export step.
    if (this.curator) {
      const badge = document.createElement('span');
      badge.className = 'sample-browser-curator';
      badge.textContent = '● CURATOR';
      badge.title = 'Curate server running — ★ ADD / ✕ REMOVE edit samples/curated.json. Commit to publish.';
      header.appendChild(badge);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn sample-browser-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    box.appendChild(header);

    // Search row (archive tab) — built once, shown/hidden per tab.
    this._searchRow = document.createElement('div');
    this._searchRow.className = 'sample-browser-search';
    this._searchInput = document.createElement('input');
    this._searchInput.type = 'text';
    this._searchInput.className = 'modal-input';
    this._searchInput.placeholder = 'Search archive.org audio (e.g. "drum machine samples")…';
    this._searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._runSearch();
    });
    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn';
    searchBtn.textContent = 'SEARCH';
    searchBtn.addEventListener('click', () => this._runSearch());
    this._searchRow.appendChild(this._searchInput);
    this._searchRow.appendChild(searchBtn);
    box.appendChild(this._searchRow);

    // Filter chips (curated tab).
    this._filterRow = document.createElement('div');
    this._filterRow.className = 'sample-browser-filters';
    box.appendChild(this._filterRow);

    // Scrollable body.
    this._body = document.createElement('div');
    this._body.className = 'sample-browser-body';
    box.appendChild(this._body);

    // Status line.
    this._status = document.createElement('div');
    this._status.className = 'sample-browser-status';
    box.appendChild(this._status);

    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);

    this._onKey = e => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._onKey);

    this._setTab('curated');
  }

  _setTab(id) {
    this._tab = id;
    for (const [tid, b] of Object.entries(this._tabBtns)) {
      b.classList.toggle('active', tid === id);
    }
    this._searchRow.style.display = id === 'archive' ? 'flex' : 'none';
    this._filterRow.style.display = id === 'curated' ? 'flex' : 'none';
    this._renderBody();
    if (id === 'archive') this._searchInput.focus();
  }

  // ── Curated tab ────────────────────────────────────────────────

  _renderBody() {
    this._body.innerHTML = '';
    if (this._tab === 'curated') this._renderCurated();
    else this._renderArchiveItems();
  }

  _renderCurated() {
    const items = this.curated.list();
    const cats  = this.curated.categories();

    // Filter chips
    this._filterRow.innerHTML = '';
    const mkChip = (label, val) => {
      const c = document.createElement('button');
      c.className = 'btn sample-browser-chip' + (this._filter === val ? ' active' : '');
      c.textContent = label;
      c.addEventListener('click', () => { this._filter = val; this._renderCurated(); });
      this._filterRow.appendChild(c);
    };
    mkChip('ALL', 'all');
    cats.forEach(c => mkChip(c.toUpperCase(), c));

    const shown = items.filter(e => this._filter === 'all' || e.category === this._filter);
    if (shown.length === 0) {
      this._setStatus(items.length === 0
        ? 'Curated list empty or still loading…'
        : 'No samples in this category.');
      return;
    }
    this._setStatus(`${shown.length} curated sample${shown.length === 1 ? '' : 's'}`);

    for (const e of shown) {
      this._body.appendChild(this._fileRow({
        name:   e.name,
        sub:    `${e.category} · ${e.source || 'curated'}`,
        url:    e.url,
        loadName: e.name,
        removable: this.curator,
      }));
    }
  }

  // ── Archive tab ────────────────────────────────────────────────

  async _runSearch() {
    const q = this._searchInput.value.trim();
    if (!q) return;
    this._abort?.abort();
    this._abort = new AbortController();
    this._setStatus('Searching archive.org…');
    this._body.innerHTML = '';
    try {
      const items = await search(q, { signal: this._abort.signal });
      this._archiveItems = items;
      this._renderArchiveItems();
    } catch (err) {
      if (err.name !== 'AbortError') this._setStatus('Search failed: ' + err.message);
    }
  }

  _renderArchiveItems() {
    this._body.innerHTML = '';
    const items = this._archiveItems ?? [];
    if (items.length === 0) {
      this._setStatus('Search archive.org for sample packs (CC0 / public-domain audio).');
      return;
    }
    this._setStatus(`${items.length} items — click one to list its audio files`);
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'sample-browser-item';

      const main = document.createElement('div');
      main.className = 'sample-browser-item-main';
      const name = document.createElement('div');
      name.className = 'sample-browser-item-name';
      name.textContent = it.title;
      const sub = document.createElement('div');
      sub.className = 'sample-browser-item-sub';
      sub.textContent = `${it.identifier} · ${it.downloads.toLocaleString()} downloads`;
      main.appendChild(name);
      main.appendChild(sub);
      main.style.cursor = 'pointer';
      main.addEventListener('click', () => this._openItem(it, row));
      row.appendChild(main);

      const link = document.createElement('a');
      link.className = 'btn sample-browser-extlink';
      link.textContent = '↗';
      link.title = 'View on archive.org';
      link.href = itemPageUrl(it.identifier);
      link.target = '_blank';
      link.rel = 'noopener';
      row.appendChild(link);

      this._body.appendChild(row);
    }
  }

  async _openItem(it, itemRow) {
    // Toggle: collapse if already expanded.
    const existing = itemRow.nextElementSibling;
    if (existing && existing.classList.contains('sample-browser-files')) {
      existing.remove();
      return;
    }
    // Remove any other open file list (one at a time).
    this._body.querySelectorAll('.sample-browser-files').forEach(n => n.remove());

    const files = document.createElement('div');
    files.className = 'sample-browser-files';
    files.textContent = 'Loading file list…';
    itemRow.after(files);

    this._abort?.abort();
    this._abort = new AbortController();
    try {
      const list = await listFiles(it.identifier, { signal: this._abort.signal });
      files.innerHTML = '';
      if (list.length === 0) {
        files.textContent = 'No decodable audio files (item may be a .zip archive).';
        return;
      }
      for (const f of list) {
        files.appendChild(this._fileRow({
          name:   f.name,
          sub:    `${f.format} · ${formatSize(f.size)}`,
          url:    f.url,
          loadName: f.name,
          taggable: this.curator,
          tagEntry: { name: f.name.replace(/\.[^.]+$/, ''), category: guessCategory(f.name), url: f.url, source: it.identifier },
        }));
      }
    } catch (err) {
      if (err.name !== 'AbortError') files.textContent = 'Failed: ' + err.message;
    }
  }

  // ── Shared file row ────────────────────────────────────────────

  /**
   * One loadable file/sample row with a LOAD button, plus optional ★ ADD
   * (archive tab, curator) or ✕ remove (curated tab, curator). ADD/REMOVE post
   * to the curate server, which writes samples/curated.json on disk.
   */
  _fileRow({ name, sub, url, loadName, taggable = false, tagEntry = null, removable = false }) {
    const row = document.createElement('div');
    row.className = 'sample-browser-file';

    const info = document.createElement('div');
    info.className = 'sample-browser-file-info';
    const n = document.createElement('div');
    n.className = 'sample-browser-file-name';
    n.textContent = name;
    const s = document.createElement('div');
    s.className = 'sample-browser-file-sub';
    s.textContent = sub;
    info.appendChild(n);
    info.appendChild(s);
    row.appendChild(info);

    if (taggable) {
      const tag = document.createElement('button');
      tag.className = 'btn sample-browser-tag';
      const refresh = () => {
        const done = this.curated.has(url);
        tag.textContent = done ? '✓ ADDED' : '★ ADD';
        tag.classList.toggle('active', done);
        tag.disabled = done;
      };
      refresh();
      tag.title = 'Add to the curated list (writes samples/curated.json)';
      tag.addEventListener('click', async () => {
        tag.disabled = true;
        try {
          await this.curated.add(tagEntry);
          refresh();
          this._setStatus(`Added "${tagEntry.name}" to curated.json — commit to publish.`);
        } catch (err) {
          tag.disabled = false;
          this._setStatus('Add failed: ' + (err.message || err));
        }
      });
      row.appendChild(tag);
    }

    if (removable) {
      const rm = document.createElement('button');
      rm.className = 'btn sample-browser-tag';
      rm.textContent = '✕';
      rm.title = 'Remove from the curated list (writes samples/curated.json)';
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        try {
          await this.curated.remove(url);
          this._renderCurated();
          this._setStatus('Removed from curated.json — commit to publish.');
        } catch (err) {
          rm.disabled = false;
          this._setStatus('Remove failed: ' + (err.message || err));
        }
      });
      row.appendChild(rm);
    }

    const load = document.createElement('button');
    load.className = 'btn sample-browser-loadbtn';
    load.textContent = 'LOAD';
    load.addEventListener('click', async () => {
      load.disabled = true;
      load.textContent = '…';
      this._setStatus(`Loading ${loadName}…`);
      try {
        await this.onLoad(url, loadName);
        this._setStatus(`Loaded ${loadName}`);
        this.close();
      } catch (err) {
        load.disabled = false;
        load.textContent = 'LOAD';
        this._setStatus('Load failed: ' + (err.message || err));
      }
    });
    row.appendChild(load);

    return row;
  }

  _setStatus(msg) {
    this._status.textContent = msg;
  }

  close() {
    this._abort?.abort();
    document.removeEventListener('keydown', this._onKey);
    this.overlay.remove();
  }
}

function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** Cheap filename → category guess for the curator's convenience. */
function guessCategory(name) {
  const n = name.toLowerCase();
  if (/kick|bass ?drum|\bbd\b/.test(n)) return 'kick';
  if (/snare|rim|clap|\bsd\b/.test(n))  return 'snare';
  if (/hat|hi.?hat|\bhh\b|cymbal|crash|ride/.test(n)) return 'hat';
  if (/\btom\b|conga|bongo/.test(n))    return 'tom';
  if (/clave|cowbell|tamb|shaker|wood|click|block|stick|perc/.test(n)) return 'perc';
  if (/sine|saw|squ|tri|noise|wave|synth|pad|lead/.test(n)) return 'synth';
  return 'misc';
}
