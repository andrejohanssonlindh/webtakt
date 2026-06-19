/**
 * ArchiveSearch.js
 * ----------------
 * Live sample discovery from the Internet Archive (archive.org).
 *
 * Why archive.org: its search + metadata + download endpoints all send
 * `Access-Control-Allow-Origin: *`, so the browser can fetch audio bytes
 * directly with NO API key and NO auth flow. (Freesound, by contrast, needs an
 * OAuth token.) See design/sample-browser.md.
 *
 * Two-step model — items contain many loose files:
 *   1. search(query)        → matching items   { identifier, title, downloads }
 *   2. listFiles(identifier)→ audio files in an item, as ready-to-load URLs
 *
 * This module is pure data access — no DOM. The SampleBrowser panel renders it
 * and hands a chosen file URL to the sampler's loader (same fetch →
 * decodeAudioData → setBuffer path as a local file).
 */

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const META_URL   = 'https://archive.org/metadata';
const DL_BASE    = 'https://archive.org/download';

// Formats we can decode in the browser. Lower-cased archive.org `format` values.
const AUDIO_FORMATS = new Set([
  'wave', 'wav', 'vbr mp3', 'mp3', 'flac', 'ogg vorbis', 'aiff', 'aif', '24bit flac',
]);

// Files bigger than this are almost certainly full songs/mixes, not one-shots,
// and decoding them stalls the tab — hide them from the file list by default.
const MAX_ONESHOT_BYTES = 6 * 1024 * 1024; // 6 MB

// Duration cap. Size alone is a bad proxy: a 10-minute track encoded as Ogg
// Vorbis can come in UNDER the 6 MB byte cap, so it passes the size filter,
// loads, draws a waveform — then a single key-press plays ten minutes from a
// silent intro and feels like "it doesn't play". archive.org gives us `length`
// (seconds) in the metadata, so filter on actual duration. 30 s comfortably
// covers one-shots and most loops while excluding full tracks.
const MAX_ONESHOT_SECONDS = 30;

// archive.org's audio mediatype is dominated by spoken-word collections
// (LibriVox audiobooks, old-time radio, podcasts). A bare keyword like "bird"
// matches the full text of those items and buries actual samples under
// audiobooks. We exclude the worst offenders so music/SFX content floats up.
// (Collection ids are archive.org's own — verified against live search.)
const EXCLUDE_COLLECTIONS = [
  'librivoxaudio',     // LibriVox audiobooks (huge)
  'audio_bookspoetry', // other spoken-word books/poetry
  'oldtimeradio',      // old-time radio dramas
  'radioprograms',     // misc radio shows
  'podcasts',          // podcast feeds
];
const EXCLUDE_SUBJECTS = ['audiobook', 'podcast', 'radio drama'];

/**
 * Search archive.org audio items.
 * @param {string} query        free text (matched against title/subject/text)
 * @param {object} [opts]
 * @param {number} [opts.rows]   max items (default 30)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{identifier:string,title:string,downloads:number}[]>}
 */
export async function search(query, opts = {}) {
  const rows = opts.rows ?? 30;

  // Match the keyword against the item TITLE rather than its full text — a
  // search for "bird" should find items *named* for birds, not every audiobook
  // chapter that says the word. Then drop the spoken-word collections/subjects
  // that otherwise dominate mediatype:audio. Sort by downloads so the useful,
  // well-shared packs float up. (opts.broad keeps the old full-text behaviour
  // for the rare case a title search comes up empty.)
  const field   = opts.broad ? '' : 'title:';
  const exCols  = EXCLUDE_COLLECTIONS.map(c => `NOT collection:(${c})`).join(' AND ');
  const exSubs  = EXCLUDE_SUBJECTS.map(s => `NOT subject:(${s})`).join(' AND ');
  const q = `${field}(${query}) AND mediatype:(audio) AND ${exCols} AND ${exSubs}`;
  const params = new URLSearchParams();
  params.set('q', q);
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'downloads');
  params.append('sort[]', 'downloads desc');
  params.set('rows', String(rows));
  params.set('output', 'json');

  const res = await fetch(`${SEARCH_URL}?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`archive.org search HTTP ${res.status}`);
  const json = await res.json();
  const docs = json?.response?.docs ?? [];

  // Title search came up empty (unusual/long phrase) — retry once across the
  // full text so the user still gets results rather than a blank list.
  if (docs.length === 0 && !opts.broad) {
    return search(query, { ...opts, broad: true });
  }

  return docs.map(d => ({
    identifier: d.identifier,
    title:      Array.isArray(d.title) ? d.title[0] : (d.title ?? d.identifier),
    downloads:  d.downloads ?? 0,
  }));
}

/**
 * List the decodable audio files inside one archive.org item, as load-ready
 * entries. Skips oversized files (likely full tracks, not one-shots).
 * @param {string} identifier
 * @param {object} [opts]
 * @param {boolean} [opts.includeLarge]  include files over the one-shot caps
 *                                       (byte size AND duration)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{name:string,url:string,format:string,size:number,duration:number,source:string}[]>}
 */
export async function listFiles(identifier, opts = {}) {
  const res = await fetch(`${META_URL}/${encodeURIComponent(identifier)}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`archive.org metadata HTTP ${res.status}`);
  const meta = await res.json();
  const files = meta?.files ?? [];

  const out = [];
  const seen = new Set(); // de-dupe same basename across formats (prefer wav/flac)
  // Sort so lossless/wav come first → if the same clip exists as wav + mp3 we
  // keep the wav and drop the mp3 dupe.
  const ranked = files
    .filter(f => AUDIO_FORMATS.has((f.format || '').toLowerCase()))
    .sort((a, b) => formatRank(a.format) - formatRank(b.format));

  for (const f of ranked) {
    const size = parseInt(f.size, 10) || 0;
    const duration = parseFloat(f.length) || 0; // seconds; 0 when archive omits it
    if (!opts.includeLarge) {
      if (size > MAX_ONESHOT_BYTES) continue;
      // Duration is the better filter (see MAX_ONESHOT_SECONDS). Only applied
      // when archive.org actually reported a length — keep unknown-length files.
      if (duration && duration > MAX_ONESHOT_SECONDS) continue;
    }
    const base = f.name.replace(/\.[^.]+$/, '');
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({
      name:   f.name,
      url:    `${DL_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
      format: f.format || '',
      size,
      duration,
      source: identifier,
    });
  }
  // Smallest first — one-shots before loops.
  out.sort((a, b) => a.size - b.size);
  return out;
}

function formatRank(fmt) {
  const f = (fmt || '').toLowerCase();
  if (f.includes('flac')) return 0;
  if (f.includes('wav') || f === 'aiff' || f === 'aif') return 1;
  return 2; // mp3 / ogg
}

/** Public item page, for attribution / "view source" links. */
export function itemPageUrl(identifier) {
  return `https://archive.org/details/${encodeURIComponent(identifier)}`;
}
