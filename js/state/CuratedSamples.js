/**
 * CuratedSamples.js
 * -----------------
 * Loads the hand-picked CC0 sample list (samples/curated.json) and, in curator
 * mode, edits it on disk via the local curate server.
 *
 * The curated list works ONLINE for everyone — it's just samples/curated.json,
 * served statically. Editing it is the privileged part: a browser can't write
 * to disk, so adding/removing entries posts to tools/curate_server.py, which
 * writes the file. That server only runs on the author's own machine, so it is
 * the safety mechanic — anyone can browse + load, only the curator (you, running
 * the server locally) can change the shipped list. Add → commit → live for all.
 *
 * Curator mode is detected at load time by pinging GET /curate/status. With a
 * plain static server (python3 -m http.server) the ping fails and the ★/✕
 * affordances stay hidden.
 *
 * Manifest shape: { version, items: [ {name, category, url, source, license} ] }
 */

const MANIFEST_URL = 'samples/curated.json';
const STATUS_URL   = '/curate/status';
const ADD_URL      = '/curate/add';
const REMOVE_URL   = '/curate/remove';

export class CuratedSamples {
  constructor() {
    this._items   = [];     // current manifest entries (authoritative copy)
    this._curator = false;  // true when the curate server is answering
    this._loaded  = false;
  }

  /** Fetch the manifest + probe for the curate server. Safe to call repeatedly. */
  async load() {
    if (this._loaded) return;
    await Promise.all([this._loadManifest(), this._probeCurator()]);
    this._loaded = true;
  }

  async _loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        this._items = Array.isArray(json) ? json : (json.items ?? []);
      }
    } catch (_) {
      this._items = [];
    }
  }

  async _probeCurator() {
    try {
      const res = await fetch(STATUS_URL, { cache: 'no-store' });
      this._curator = res.ok && (await res.json())?.curator === true;
    } catch (_) {
      this._curator = false;
    }
  }

  /** True when the local curate server is present (★ ADD / ✕ REMOVE enabled). */
  get isCurator() {
    return this._curator;
  }

  /** All curated entries (de-duped by url). */
  list() {
    const byUrl = new Map();
    for (const e of this._items) byUrl.set(e.url, e);
    return [...byUrl.values()];
  }

  /** Distinct categories present, for filter chips. */
  categories() {
    return [...new Set(this.list().map(e => e.category).filter(Boolean))].sort();
  }

  /** Whether this url is already curated (so the UI can show ✓ instead of ADD). */
  has(url) {
    return this._items.some(e => e.url === url);
  }

  /**
   * Add a sample to the curated list ON DISK (curator mode only). Posts to the
   * curate server, which writes samples/curated.json; on success the entry is
   * mirrored into the in-memory list so the UI updates immediately.
   * @param {{name:string,category?:string,url:string,source?:string,license?:string}} entry
   * @returns {Promise<boolean>} true if added (or already present)
   */
  async add(entry) {
    if (!this._curator) return false;
    if (this.has(entry.url)) return true;
    const res = await fetch(ADD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error(`curate add failed (HTTP ${res.status})`);
    this._items.push({
      name:     entry.name,
      category: entry.category ?? 'misc',
      url:      entry.url,
      source:   entry.source ?? '',
      license:  entry.license ?? 'Public Domain (archive.org)',
    });
    return true;
  }

  /**
   * Remove a curated entry ON DISK (curator mode only).
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async remove(url) {
    if (!this._curator) return false;
    const res = await fetch(REMOVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error(`curate remove failed (HTTP ${res.status})`);
    this._items = this._items.filter(e => e.url !== url);
    return true;
  }
}
