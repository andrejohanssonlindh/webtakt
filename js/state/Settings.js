/**
 * Settings.js
 * -----------
 * Global, app-wide user preferences — distinct from a *project* (Project.js).
 * These are not part of a song; they describe how THIS browser behaves and
 * persist across sessions and projects in localStorage.
 *
 * Persisted (continuously, on every change — there is no "save" button):
 *   bpmGrid            — finest BPM-sync division the synced knobs can reach /
 *                        snap to. One of GRID_OPTIONS (1/32 default, 1/64, 1/128).
 *                        Drives BpmSync's snap points; counts stay 1/32 units so
 *                        existing projects are never rescaled (a 1/64 note is the
 *                        fractional count 0.5). See js/util/BpmSync.js.
 *   modWheelSensitivity — scroll → mod-wheel travel multiplier (0.1–3.0, 1 = the
 *                        historical 300px-per-full-range feel). Lower = calmer.
 *   keybinds           — { play, record, stopAll }: each an `event.code` string
 *                        (layout-independent). Bound in index.html transport.
 *   keyboardLayout     — preset name for the on-screen piano's computer-key map
 *                        (see Keyboard.js KB_LAYOUTS). 'swedish' is the default.
 *                        The special value 'custom' uses `customLayout` instead.
 *   customLayout       — user-editable { lower[12], chromatic[14] } char rows
 *                        (white-key + black-key positions). `upper` (folded mode)
 *                        is derived from these. Seeded from Swedish; edited via
 *                        the Custom keyboard editor in the Settings pane.
 *
 * A single shared instance (`settings`) is exported so every consumer reads the
 * same live object. Subscribe via on(fn) for change notifications.
 *
 * Owns:    the preferences object + localStorage persistence + subscriber list
 * Depends: nothing
 * Used by: index.html, ModWheel.js, Keyboard.js, BpmSync.js (grid), SettingsPanel
 */

const STORAGE_KEY = 'webtakt_settings';

/** Finest BPM-sync divisions the user can pick. Value = grid units per whole note. */
export const GRID_OPTIONS = [
  { id: '1/32',  label: '1/32',  base: 32  },
  { id: '1/64',  label: '1/64',  base: 64  },
  { id: '1/128', label: '1/128', base: 128 },
];

export const DEFAULTS = Object.freeze({
  bpmGrid:             '1/32',
  modWheelSensitivity: 1.0,
  keybinds: {
    play:    'Space',
    record:  'Enter',
    stopAll: 'Backspace',
  },
  keyboardLayout: 'swedish',
  // Seeded from the Swedish preset; the Custom editor overwrites per key.
  // Full width: 14 white slots + 14 black slots so every on-screen key is
  // bindable (the Swedish preset leaves the last two white keys unbound, '').
  customLayout: {
    lower:     ['a','s','d','f','g','h','j','k','l','ö','ä',"'",'',''],
    chromatic: ['w','e','','t','y','u','','o','p','','','','',''],
  },
});

class Settings {
  constructor() {
    this._subs = [];
    this._data = this._load();
  }

  _load() {
    // Start from a deep copy of DEFAULTS, then overlay anything persisted so a
    // newly-added setting falls back to its default instead of being undefined.
    const data = {
      ...DEFAULTS,
      keybinds: { ...DEFAULTS.keybinds },
      customLayout: this._cloneCustom(DEFAULTS.customLayout),
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        Object.assign(data, saved);
        data.keybinds = { ...DEFAULTS.keybinds, ...(saved.keybinds ?? {}) };
        data.customLayout = {
          lower:     [...(saved.customLayout?.lower     ?? DEFAULTS.customLayout.lower)],
          chromatic: [...(saved.customLayout?.chromatic ?? DEFAULTS.customLayout.chromatic)],
        };
      }
    } catch (e) {
      console.warn('Webtakt: could not load settings', e);
    }
    return data;
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch (e) {
      console.warn('Webtakt: could not save settings', e);
    }
  }

  // ── Generic accessors ──────────────────────────────────────
  get(key)            { return this._data[key]; }

  set(key, value) {
    this._data[key] = value;
    this._save();
    this._emit();
  }

  /** Set one transport keybind by action name ('play'|'record'|'stopAll'). */
  setKeybind(action, code) {
    this._data.keybinds = { ...this._data.keybinds, [action]: code };
    this._save();
    this._emit();
  }

  getKeybind(action) { return this._data.keybinds[action]; }

  // ── Custom keyboard layout ─────────────────────────────────
  _cloneCustom(c) { return { lower: [...c.lower], chromatic: [...c.chromatic] }; }

  /** The user's editable custom layout rows. */
  getCustomLayout() { return this._data.customLayout; }

  /**
   * Set one custom-layout key. `row` is 'lower' (white keys, idx 0–11) or
   * 'chromatic' (black-key slots, idx parallel to BLACK_NOTES). `char` is the
   * produced character (lower-cased), or '' to clear.
   */
  setCustomKey(row, idx, char) {
    const next = this._cloneCustom(this._data.customLayout);
    next[row][idx] = char;
    this._data.customLayout = next;
    this._save();
    this._emit();
  }

  /** Reset just the custom layout to the Swedish-seeded default. */
  resetCustomLayout() {
    this._data.customLayout = this._cloneCustom(DEFAULTS.customLayout);
    this._save();
    this._emit();
  }

  // ── Derived helpers ────────────────────────────────────────
  /** Grid units per whole note for the chosen finest division (32/64/128). */
  get gridBase() {
    return GRID_OPTIONS.find(o => o.id === this._data.bpmGrid)?.base ?? 32;
  }

  /** Reset every preference to its factory default and persist. */
  reset() {
    this._data = {
      ...DEFAULTS,
      keybinds: { ...DEFAULTS.keybinds },
      customLayout: this._cloneCustom(DEFAULTS.customLayout),
    };
    this._save();
    this._emit();
  }

  // ── Subscriptions ──────────────────────────────────────────
  on(fn)  { this._subs.push(fn); return () => this.off(fn); }
  off(fn) { this._subs = this._subs.filter(s => s !== fn); }
  _emit() { this._subs.forEach(fn => { try { fn(this._data); } catch (e) { console.error(e); } }); }
}

/** Single shared instance — import this everywhere. */
export const settings = new Settings();
