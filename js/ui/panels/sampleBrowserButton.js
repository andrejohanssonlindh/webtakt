/**
 * sampleBrowserButton.js
 * ----------------------
 * Shared "BROWSE" affordance for every sampler panel. Inserts a BROWSE button
 * next to the panel's LOAD FILE label and opens the SampleBrowser overlay.
 *
 * The chosen remote URL is fetched into a File and handed to the panel's own
 * `_loadFile(file)` — so each sampler's existing decode → store → setBuffer →
 * auto-trim path runs identically to a local file pick (no per-panel changes
 * beyond calling addBrowseButton in _render).
 *
 * A single shared CuratedSamples instance is reused across panels so locally
 * tagged entries (curator mode) are consistent everywhere.
 */

import { SampleBrowser }   from './SampleBrowser.js';
import { CuratedSamples }  from '../../state/CuratedSamples.js';

let _curated = null;
function curated() {
  if (!_curated) _curated = new CuratedSamples();
  return _curated;
}

/**
 * @param {object} panel  a sampler panel instance with:
 *   .container (HTMLElement), ._loadFile(File)→Promise, optionally
 *   ._nameEl (status span). The LOAD FILE label is found by `.sampler-load-btn`.
 */
export function addBrowseButton(panel) {
  const loadBtn = panel.container.querySelector('.sampler-load-btn');
  if (!loadBtn) return; // panel layout changed — fail silent, BROWSE is additive

  const browse = document.createElement('button');
  browse.className = 'btn sampler-browse-btn';
  browse.textContent = '🔍 BROWSE';
  browse.title = 'Browse curated + archive.org samples (no login)';
  browse.addEventListener('click', () => {
    new SampleBrowser({
      curated: curated(),
      onLoad: (url, name) => loadUrlInto(panel, url, name),
    });
  });
  loadBtn.after(browse);
}

/** Fetch a remote sample URL into a File and run it through the panel loader. */
async function loadUrlInto(panel, url, name) {
  if (panel._nameEl) panel._nameEl.textContent = 'Fetching…';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  // Give it a sane filename (archive names can carry odd chars / no ext).
  const fname = /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.wav`;
  const file = new File([blob], fname, { type: blob.type || 'audio/wav' });
  await panel._loadFile(file);
}
