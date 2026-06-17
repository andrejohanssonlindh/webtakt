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
 *   audioSampleRate    — SAMPLE_RATE_OPTIONS id (default 'auto'). Output rate;
 *                        fixed at AudioContext creation so it applies on reload.
 *                        'auto' = 22 kHz on phone-class hardware (cures the
 *                        Android underrun crackle), native elsewhere. Lower rates
 *                        cost less CPU. See resolveSampleRate.
 *   audioLatency       — LATENCY_OPTIONS id (default 'auto'). latencyHint → buffer
 *                        size; 'auto' = 'interactive' (low latency) everywhere —
 *                        we fix phone crackle via the rate, not the buffer, to
 *                        avoid lag. Applied on reload. See AudioEngine.js.
 *   keybinds           — { play, record, stopAll, manual, hold, arp, octaveUp,
 *                        octaveDown, moveLeft, moveRight, fx1, fx2, fx3, fx4 }: each
 *                        an `event.code` string (layout-independent). Handled in
 *                        index.html keydown. arp toggles the arp; octaveUp/octaveDown
 *                        shift the on-screen keyboard octave; moveLeft/moveRight shift
 *                        one step — moving the selected trigger, or rotating the whole
 *                        pattern when no step is selected; fx1..fx4 are four generic
 *                        FX binds, each toggling whatever FX block the SELECTED
 *                        track maps it to (assigned per track in the FX pane —
 *                        see Track._fxBinds). Track keys (not rebindable):
 *                          digit 1–N        → mute / unmute that track
 *                          Shift + digit    → select (switch to) that track
 *                          Alt   + digit    → jump to that pattern page
 *   capturePlay        — when true (default), the Play/Stop key (Space) is handled
 *                        globally and blurs the focused control first, so it never
 *                        also re-clicks a focused button. Off = native behaviour.
 *   capsNormalizeKeys  — when true (default), CapsLock-uppercased letters match
 *                        their lowercase bind (A behaves as a) for piano + letter
 *                        shortcuts. Off = case-sensitive (A can be bound separately).
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

// ── Audio engine options (applied at AudioContext creation — see AudioEngine.js) ──
// These can't change on a live context, so a change only takes effect on the next
// page load (SettingsPanel shows a "reload to apply" note).

/**
 * Output sample rate. 'auto' = pick per device (low on phone-class hardware,
 * native elsewhere — see resolveSampleRate). 'native' = always pass no rate and
 * let the platform choose. A numeric `rate` is passed straight to the context.
 */
export const SAMPLE_RATE_OPTIONS = [
  { id: 'auto',   label: 'Auto (device)',   rate: null  },
  { id: 'native', label: 'Native (full)',   rate: null  },
  { id: '48000',  label: '48 kHz',          rate: 48000 },
  { id: '44100',  label: '44.1 kHz',        rate: 44100 },
  { id: '24000',  label: '24 kHz (low)',    rate: 24000 },
  { id: '22050',  label: '22.05 kHz (low)', rate: 22050 },
];

/**
 * latencyHint → output buffer size tradeoff. 'interactive' = smallest buffer
 * (lowest latency, most prone to underrun/crackle on weak CPUs); 'playback' =
 * larger buffer (fewer dropouts, more latency). 'auto' lets the runtime pick a
 * sensible default per device (see resolveLatencyHint).
 */
export const LATENCY_OPTIONS = [
  { id: 'auto',        label: 'Auto (device)' },
  { id: 'interactive', label: 'Low (interactive)' },
  { id: 'balanced',    label: 'Balanced' },
  { id: 'playback',    label: 'Safe (playback)' },
];

/**
 * True only on PHONE-CLASS hardware: a coarse pointer AND a phone-sized viewport
 * (≤640px, the app's phone breakpoint). This deliberately EXCLUDES tablets — the
 * confirmed underrun crackle was on weak Android phones (OnePlus 9 Pro, Galaxy
 * S22); a large-screen iPad (M-series) has the CPU headroom to run native rate +
 * low latency fine and never underran. So phone-class devices get the lighter
 * audio defaults, tablets/desktop keep full quality. Width is a proxy for "small
 * mobile" (we can't read CPU class from the browser).
 */
export function isPhoneClass() {
  try {
    return window.matchMedia('(pointer: coarse)').matches
        && window.matchMedia('(max-width: 640px)').matches;
  } catch (_) { return false; }
}

/**
 * Resolve the stored sample-rate setting to a number (or null = native). 'auto'
 * → 22050 on phone-class hardware (the rate that fixed the crackle on-device
 * while keeping low latency), native everywhere else.
 */
export function resolveSampleRate(id) {
  if (id === 'auto') return isPhoneClass() ? 22050 : null;
  return SAMPLE_RATE_OPTIONS.find(o => o.id === id)?.rate ?? null;
}

/**
 * Resolve the stored latency setting to a value the AudioContext accepts. 'auto'
 * → 'interactive' (low latency). We do NOT inflate the buffer on phones: dropping
 * the sample rate (resolveSampleRate above) is the lever that fixes the crackle
 * without the audible lag that 'playback' added on-device. 'interactive' is the
 * right default everywhere; users can still pick 'playback' manually if needed.
 */
export function resolveLatencyHint(id) {
  if (id === 'auto') return 'interactive';
  return id;
}

export const DEFAULTS = Object.freeze({
  bpmGrid:             '1/32',
  modWheelSensitivity: 1.0,
  // Audio engine — applied at AudioContext creation (effective on reload).
  // Both default to 'auto': phone-class devices get 22 kHz (fixes the Android
  // underrun crackle while keeping low latency); tablets/desktop get native rate
  // + interactive latency. See resolveSampleRate / resolveLatencyHint.
  audioSampleRate:     'auto',   // SAMPLE_RATE_OPTIONS id
  audioLatency:        'auto',   // LATENCY_OPTIONS id
  keybinds: {
    play:    'Space',
    record:  'Enter',
    stopAll: 'Backspace',
    manual:  'KeyM',
    hold:     'KeyX',
    // Selected-track toggles: arp on/off + the four FX bypass toggles.
    // Key order matches the fx-bar left→right: C=Crush, V=Reverb, B=Delay, N=Chorus.
    arp:      'KeyZ',
    // On-screen keyboard octave shift (mirrors the OCT+/OCT- buttons).
    octaveUp:   'ArrowUp',
    octaveDown: 'ArrowDown',
    // Shift one step left/right (mirrors the TRIG ◀/▶ buttons): moves the selected
    // trigger, or rotates the whole pattern when no step is selected.
    moveLeft:   'ArrowLeft',
    moveRight:  'ArrowRight',
    // Four generic FX binds. Each track assigns these to specific FX blocks
    // (FX pipeline pane) — pressing the key toggles the assigned block on the
    // SELECTED track only. Defaults keep the old C/V/B/N keys.
    fx1:      'KeyC',
    fx2:      'KeyV',
    fx3:      'KeyB',
    fx4:      'KeyN',
  },
  capturePlay:       true,
  capsNormalizeKeys: true,
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
        // Migrate the legacy per-effect FX binds (fxCrush/fxReverb/fxDelay/
        // fxChorus) to the four generic binds (fx1..fx4) if the user had rebound
        // them and the new keys aren't set. Keeps their chosen keys; the new
        // binds are now assignable to any FX per track (see Track._fxBinds).
        const legacy = { fx1: 'fxCrush', fx2: 'fxReverb', fx3: 'fxDelay', fx4: 'fxChorus' };
        for (const [now, old] of Object.entries(legacy)) {
          if (saved.keybinds && saved.keybinds[old] != null && saved.keybinds[now] == null) {
            data.keybinds[now] = saved.keybinds[old];
          }
        }
        for (const old of ['fxCrush', 'fxReverb', 'fxDelay', 'fxChorus']) {
          delete data.keybinds[old];
        }
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

  /** Set one keybind by action name (any key in DEFAULTS.keybinds). */
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
