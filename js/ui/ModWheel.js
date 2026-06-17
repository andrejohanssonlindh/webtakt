/**
 * ModWheel.js
 * -----------
 * Two assignable mod wheels on the left side of the UI.
 *
 * Each wheel:
 *   - Has a compact param selector at the top (replaces the click-on-label pattern).
 *   - Responds to vertical mouse drag on the wheel track.
 *   - Can also be controlled by scroll gestures anywhere on the screen OUTSIDE a knob:
 *       scrolling on the LEFT half of the viewport → MW1
 *       scrolling on the RIGHT half of the viewport → MW2
 *
 * Assignment writes directly to the resolved AudioParam (absolute value in lfoMin–lfoMax
 * range), not additively like LFOs. The wheel position (0–1) is mapped linearly.
 *
 * Owns:    2 wheel DOM elements, assignment state per track (stored in track.modWheelTargets)
 * Depends: AppState.js, Track.js
 * Used by: index.html (mounted to #mod-wheels)
 *
 * Public:
 *   new ModWheel(containerEl, appState)
 *   render()   — update selectors and visuals for selected track
 *   destroy()  — remove global event listeners
 */

import { settings } from '../state/Settings.js';

export class ModWheel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/AppState.js').AppState} state
   */
  constructor(container, state) {
    this.container = container;
    this.state     = state;
    this._wheels   = [];

    this._build();
    state.on('trackSelected', () => this.render());

    // Scroll-zone control: left half → MW1, right half → MW2
    // Only fires when the scroll target is NOT inside a knob or the wheel menu.
    this._scrollHandler = (e) => {
      const tag = e.target.tagName;
      if (e.target.closest('.knob-cell') || e.target.closest('.mod-wheel-track') ||
          e.target.closest('.mw-select') || tag === 'INPUT') return;
      const idx = e.clientX < window.innerWidth / 2 ? 0 : 1;
      this.scrollControl(idx, e.deltaY);
    };
    document.addEventListener('wheel', this._scrollHandler, { passive: true });

    // Click-outside closes any open wheel dropdown (mirrors the FX add-menu).
    this._docClick = (e) => {
      if (e.target.closest('.mw-select')) return;
      this._closeAllMenus();
    };
    document.addEventListener('click', this._docClick);
  }

  /** Close every open mod-wheel param dropdown. */
  _closeAllMenus() {
    this._wheels.forEach(w => w.menu?.classList.add('hidden'));
  }

  _build() {
    this.container.innerHTML = '';
    this._wheels = [];

    for (let i = 0; i < 2; i++) {
      const wheel = this._createWheel(i);
      this.container.appendChild(wheel.el);
      this._wheels.push(wheel);
    }
    this.render();
  }

  /** @param {number} index */
  _createWheel(index) {
    const el = document.createElement('div');
    el.className = 'mod-wheel';

    // ── Param selector ────────────────────────────────────────
    // Custom dropdown (mirrors the FX +ADD menu) instead of a native <select>:
    // the native option list is rendered by the OS and is tiny/unreadable on
    // phone (and unstyleable everywhere). This is our own styleable DOM —
    // legible at every viewport. (Future fix: convert the app's other native
    // dropdowns to this same pattern.)
    const selWrap = document.createElement('div');
    selWrap.className = 'mw-select';

    const selBtn = document.createElement('button');
    selBtn.className = 'mw-select-btn';
    selBtn.title = `MW${index + 1} — assign a parameter`;

    const menu = document.createElement('div');
    menu.className = 'mw-select-menu hidden';

    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = menu.classList.contains('hidden');
      this._closeAllMenus();
      if (wasHidden) menu.classList.remove('hidden');
    });

    selWrap.appendChild(selBtn);
    selWrap.appendChild(menu);
    el.appendChild(selWrap);

    // ── Wheel track + thumb ───────────────────────────────────
    const track_el = document.createElement('div');
    track_el.className = 'mod-wheel-track';

    const thumb = document.createElement('div');
    thumb.className = 'mod-wheel-thumb';

    track_el.appendChild(thumb);
    el.appendChild(track_el);

    // Value: 0.0–1.0 (0 = bottom, 1 = top)
    let value = 0.5;

    const setThumb = (v) => {
      thumb.style.top = `${(1 - v) * 84}%`;
    };
    setThumb(value);

    // ── Drag interaction ──────────────────────────────────────
    let dragging = false;
    let startY   = 0;
    let startVal = 0;

    // Pointer-agnostic drag: works for mouse and (on phone, where this wheel is
    // kept — Surface D) touch. e.touches[0] / changedTouches mirror the touch
    // idiom used in ADSRWidget. touchstart preventDefault stops the page
    // scrolling under the drag.
    const dragStart = (e) => {
      dragging = true;
      startY   = (e.touches ? e.touches[0] : e).clientY;
      startVal = value;
      e.preventDefault();
    };
    const dragMove = (e) => {
      if (!dragging) return;
      const clientY = (e.touches ? e.touches[0] : e).clientY;
      const dy = (startY - clientY) / 120;
      value = Math.max(0, Math.min(1, startVal + dy));
      setThumb(value);
      this._applyWheel(index, value);
    };
    const dragEnd = () => { dragging = false; };

    track_el.addEventListener('mousedown',  dragStart);
    document.addEventListener('mousemove',  dragMove);
    document.addEventListener('mouseup',    dragEnd);

    track_el.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove',  dragMove,  { passive: false });
    document.addEventListener('touchend',   dragEnd);
    document.addEventListener('touchcancel',dragEnd);

    // Pick a param from the dropdown: write the assignment, sync the thumb to the
    // newly-targeted param's current value, close the menu, refresh the label.
    const choose = (path) => {
      const track = this.state.selectedTrack;
      track.modWheelTargets[index] = path || null;
      value = this._currentNorm(index);
      setThumb(value);
      menu.classList.add('hidden');
      this.render();
    };

    return {
      el,
      selBtn,
      menu,
      choose,
      thumb,
      getValue: () => value,
      setValue: (v) => {
        value = Math.max(0, Math.min(1, v));
        setThumb(value);
      },
    };
  }

  /**
   * Return the current value of the assigned param as a 0–1 normalised position.
   * Falls back to 0.5 if unassigned or unresolvable.
   * @param {number} wheelIndex
   */
  _currentNorm(wheelIndex) {
    const track = this.state.selectedTrack;
    const path  = track.modWheelTargets[wheelIndex];
    if (!path) return 0.5;
    const resolved = track.resolveModWheelParam(path);
    if (!resolved) return 0.5;
    // Direct-AudioParam targets (amp.pan, amp.level) have no owning param object —
    // read the live AudioParam value instead of obj.getParam.
    // Custom descriptors (trig.tone, trig.velocity) carry their own getParam.
    const current = resolved.obj === null
      ? resolved.audioParam.value
      : resolved.getParam
        ? resolved.getParam()
        : resolved.obj.getParam(path);
    return Math.max(0, Math.min(1, (current - resolved.min) / (resolved.max - resolved.min)));
  }

  /**
   * Apply a wheel position to the assigned parameter.
   * Calls obj.setParam so _params is persisted and the AudioParam is scheduled.
   * Emits 'paramChanged' so SynthPanel can update knob displays and viz.
   * @param {number} wheelIndex
   * @param {number} value — 0.0–1.0
   */
  _applyWheel(wheelIndex, value) {
    const track = this.state.selectedTrack;
    const path  = track.modWheelTargets[wheelIndex];
    if (!path) return;

    const resolved = track.resolveModWheelParam(path);
    if (!resolved) return;

    const mapped = resolved.min + value * (resolved.max - resolved.min);

    if (resolved.obj === null) {
      // Direct-AudioParam targets (amp.pan, amp.level) have no owning param object
      // — write the AudioParam smoothly to avoid zipper noise.
      resolved.audioParam.setTargetAtTime(mapped, track.audio.context.currentTime, 0.005);
    } else if (resolved.setParam) {
      // Custom descriptors (trig.tone, trig.velocity) carry their own setter.
      resolved.setParam(mapped);
    } else {
      // setParam handles both AudioParam-backed and JS-only params correctly
      resolved.obj.setParam(path, mapped);
    }

    this.state.emit('paramChanged', { path, value: mapped });
  }

  /**
   * Apply a scroll delta to one wheel (also used internally by the scroll zone handler).
   * @param {number} wheelIndex — 0 or 1
   * @param {number} deltaY     — scroll delta (positive = scroll down)
   */
  scrollControl(wheelIndex, deltaY) {
    const w = this._wheels[wheelIndex];
    if (!w) return;
    // 300px of scroll = full range at sensitivity 1.0; the user-set sensitivity
    // scales travel (lower = calmer, higher = faster). Negate so scroll-up =
    // value increase.
    const sens  = settings.get('modWheelSensitivity') ?? 1.0;
    const delta = (-deltaY / 300) * sens;
    w.setValue(w.getValue() + delta);
    this._applyWheel(wheelIndex, w.getValue());
  }

  /** Rebuild the custom dropdown (button label + menu items) for the selected track. */
  render() {
    const track = this.state.selectedTrack;
    const groups = track.getAssignableParams();

    this._wheels.forEach((wheel, i) => {
      const current = track.modWheelTargets[i] ?? '';

      // Button label: the assigned param's label, or the bare "MWn" when unassigned.
      let curLabel = `MW${i + 1}`;
      for (const { items } of groups) {
        const hit = items.find(it => it.path === current);
        if (hit) { curLabel = hit.label; break; }
      }
      wheel.selBtn.textContent = curLabel;
      wheel.selBtn.classList.toggle('mw-select-assigned', !!current);

      // Menu: a "none" row, then each group as a sticky header + its items
      // (same shape as the FX +ADD menu).
      const menu = wheel.menu;
      menu.innerHTML = '';

      const noneItem = document.createElement('button');
      noneItem.className = 'mw-select-item';
      noneItem.textContent = `MW${i + 1} (none)`;
      if (!current) noneItem.classList.add('mw-select-item-active');
      noneItem.addEventListener('click', () => wheel.choose(''));
      menu.appendChild(noneItem);

      groups.forEach(({ group, items }) => {
        const h = document.createElement('div');
        h.className = 'mw-select-header';
        h.textContent = group;
        menu.appendChild(h);
        items.forEach(({ path, label }) => {
          const item = document.createElement('button');
          item.className = 'mw-select-item';
          item.textContent = label;
          if (path === current) item.classList.add('mw-select-item-active');
          item.addEventListener('click', () => wheel.choose(path));
          menu.appendChild(item);
        });
      });

      // Sync thumb to current param value
      wheel.setValue(this._currentNorm(i));
    });
  }

  destroy() {
    document.removeEventListener('wheel', this._scrollHandler);
    document.removeEventListener('click', this._docClick);
  }
}
