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
    // Only fires when the scroll target is NOT inside a knob or select.
    this._scrollHandler = (e) => {
      const tag = e.target.tagName;
      if (e.target.closest('.knob-cell') || e.target.closest('.mod-wheel-track') || tag === 'SELECT' || tag === 'INPUT') return;
      const idx = e.clientX < window.innerWidth / 2 ? 0 : 1;
      this.scrollControl(idx, e.deltaY);
    };
    document.addEventListener('wheel', this._scrollHandler, { passive: true });
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
    const sel = document.createElement('select');
    sel.className = 'mod-wheel-select';
    sel.title = `MW${index + 1} — assign a parameter`;
    el.appendChild(sel);

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

    track_el.addEventListener('mousedown', (e) => {
      dragging = true;
      startY   = e.clientY;
      startVal = value;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dy = (startY - e.clientY) / 120;
      value = Math.max(0, Math.min(1, startVal + dy));
      setThumb(value);
      this._applyWheel(index, value);
    });

    document.addEventListener('mouseup', () => { dragging = false; });

    // ── Selector change ───────────────────────────────────────
    sel.addEventListener('change', () => {
      const track = this.state.selectedTrack;
      track.modWheelTargets[index] = sel.value || null;
      // Sync wheel position to the current value of the assigned param
      value = this._currentNorm(index);
      setThumb(value);
    });

    return {
      el,
      sel,
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
    // 300px of scroll = full range; negate so scroll-up = value increase
    const delta = -deltaY / 300;
    w.setValue(w.getValue() + delta);
    this._applyWheel(wheelIndex, w.getValue());
  }

  /** Rebuild the selector options for the selected track. */
  render() {
    const track = this.state.selectedTrack;
    const groups = track.getAssignableParams();

    this._wheels.forEach((wheel, i) => {
      const sel     = wheel.sel;
      const current = track.modWheelTargets[i] ?? '';

      sel.innerHTML = '';

      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = `MW${i + 1}`;
      sel.appendChild(noneOpt);

      groups.forEach(({ group, items }) => {
        const og = document.createElement('optgroup');
        og.label = group;
        items.forEach(({ path, label }) => {
          const o = document.createElement('option');
          o.value = path;
          o.textContent = label;
          if (path === current) o.selected = true;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });

      sel.value = current;

      // Sync thumb to current param value
      wheel.setValue(this._currentNorm(i));
    });
  }

  destroy() {
    document.removeEventListener('wheel', this._scrollHandler);
  }
}
