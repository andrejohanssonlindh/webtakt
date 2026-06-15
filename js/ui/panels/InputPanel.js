/**
 * InputPanel.js
 * -------------
 * Custom SYNTH tab for InputMachine (live audio capture).
 * Shown instead of DefaultMachinePanel when track.machine.type === 'input'.
 *
 * Layout:
 *   [Enable Input button / permission + error states]
 *   [Input device dropdown]
 *   [Level knob]   [Gate toggle: Continuous / Note-gated]
 *   [Latency readout]
 *
 * getUserMedia is permission-gated and needs a user gesture, so input is NOT
 * auto-enabled on load — the user presses "Enable Input" (mirrors how MidiPanel
 * surfaces availability). Device enumeration only returns labels AFTER access is
 * granted once, so the device list is (re)populated post-enable.
 *
 * Receives panel context from SynthPanel._makePanelContext().
 * See design/input-machine.md.
 */

import { KnobWidget } from '../KnobWidget.js';

export class InputPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} ctx — standard panel context (track, machine, activeWidgets, …)
   */
  constructor(container, ctx) {
    this.container = container;
    this.ctx       = ctx;
    this.track     = ctx.track;
    this.machine   = ctx.machine;
    this.audio     = ctx.state?.project?.audio ?? null;
    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    const secureOk = typeof window !== 'undefined' && (window.isSecureContext ?? true);
    const gumOk    = !!navigator.mediaDevices?.getUserMedia;

    if (!gumOk || !secureOk) {
      const msg = document.createElement('div');
      msg.className   = 'input-unavailable';
      msg.textContent = !secureOk
        ? 'Live input needs a secure context (HTTPS or localhost).'
        : 'Audio input (getUserMedia) is not available in this browser.';
      this.container.appendChild(msg);
      return;
    }

    // ── Enable / status ─────────────────────────────────────────
    const statusSection = document.createElement('div');
    statusSection.className = 'input-section';

    const enableBtn = document.createElement('button');
    enableBtn.className = 'btn input-enable';
    // Reflect the machine's real state (it reads .active, the single source of
    // truth) so the button never gets stuck out of sync after STOP/panic.
    const paintEnable = () => {
      const live = this.machine.active;
      enableBtn.textContent = live ? '● Input live (click to stop)' : 'Enable Input';
      enableBtn.classList.toggle('active', live);
    };
    paintEnable();
    enableBtn.addEventListener('click', async () => {
      if (this.machine.active) {
        // Toggle OFF — release the stream on every slot so the mic clears.
        this.track.disableInput();
        paintEnable();
        this._renderError();
        return;
      }
      enableBtn.disabled    = true;
      enableBtn.textContent = 'Requesting…';
      // Enable on ALL voice slots (Track.enableInput), so note-gated play sounds
      // on whichever slot the round-robin picks, not just slot 0.
      const ok = await this.track.enableInput();
      enableBtn.disabled = false;
      if (ok) {
        await this._populateDevices(deviceSel);   // labels exposed after a grant
      }
      paintEnable();
      this._renderError();
    });
    statusSection.appendChild(enableBtn);

    this._errorEl = document.createElement('div');
    this._errorEl.className = 'input-error';
    statusSection.appendChild(this._errorEl);
    this.container.appendChild(statusSection);
    this._renderError();

    // ── Input level meter ───────────────────────────────────────
    // Horizontal bar: green → yellow → orange → red as the signal climbs. Driven
    // by a rAF loop reading the machine's pre-level analyser. Lets you confirm
    // signal is actually arriving even if you can't hear it (gate/level/routing).
    const meterSection = document.createElement('div');
    meterSection.className = 'input-section';
    const meterLabel = document.createElement('div');
    meterLabel.className   = 'input-section-label';
    meterLabel.textContent = 'Input Level';
    meterSection.appendChild(meterLabel);

    const meter = document.createElement('div');
    meter.className = 'input-meter';
    const fill = document.createElement('div');
    fill.className = 'input-meter-fill';
    meter.appendChild(fill);
    const peakTick = document.createElement('div');
    peakTick.className = 'input-meter-peak';
    meter.appendChild(peakTick);
    meterSection.appendChild(meter);
    this.container.appendChild(meterSection);
    this._startMeter(fill, peakTick);

    // ── Device picker ───────────────────────────────────────────
    const devSection = document.createElement('div');
    devSection.className = 'input-section';

    const devLabel = document.createElement('div');
    devLabel.className   = 'input-section-label';
    devLabel.textContent = 'Input Device';
    devSection.appendChild(devLabel);

    const deviceSel = document.createElement('select');
    deviceSel.className = 'input-select';
    deviceSel.addEventListener('change', async () => {
      const id = deviceSel.value || null;
      if (this.machine.active) {
        // Re-open on every slot with the new device (Track fans out the change).
        await this.machine.setDevice(id);   // sets canonical selection (+ re-acquires slot 0)
        await this.track.enableInput();      // mirror device + re-acquire all slots
      } else {
        await this.machine.setDevice(id);    // just remember the selection
      }
      this._renderError();
    });
    devSection.appendChild(deviceSel);
    this.container.appendChild(devSection);
    this._populateDevices(deviceSel);

    // ── Level + Gate ────────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'input-knob-row';

    const gainKnob = new KnobWidget({
      label:   'Gain',
      min:     0,
      max:     8,
      value:   this.machine.getParam('input.gain'),
      bipolar: false,
      size:    64,
      fmt:     v => `${v.toFixed(1)}×`,
      onChange: v => this.ctx.writeValue(this.machine, 'input.gain', v, true),
    });
    row.appendChild(gainKnob.el);
    this.ctx.activeWidgets.push(gainKnob);

    const levelKnob = new KnobWidget({
      label:   'Level',
      min:     0,
      max:     1,
      value:   this.machine.getParam('output.level'),
      bipolar: false,
      size:    64,
      fmt:     v => `${Math.round(v * 100)}%`,
      onChange: v => this.ctx.writeValue(this.machine, 'output.level', v, true),
    });
    row.appendChild(levelKnob.el);
    this.ctx.activeWidgets.push(levelKnob);

    // Gate toggle — Continuous (default) vs. Note-gated. Flipping it re-applies
    // the per-voice amp gate via Track._applyInputGate.
    const gateWrap = document.createElement('div');
    gateWrap.className = 'input-gate-wrap';

    const gateLabel = document.createElement('div');
    gateLabel.className   = 'input-section-label';
    gateLabel.textContent = 'Gate';
    gateWrap.appendChild(gateLabel);

    const gateBtn = document.createElement('button');
    gateBtn.className = 'btn input-gate-toggle';
    const paintGate = () => {
      const gated = this.machine.gated;
      gateBtn.textContent = gated ? 'Note-gated' : 'Continuous';
      gateBtn.classList.toggle('active', gated);
      gateBtn.title = gated
        ? 'Steps / keys chop the live input (trance-gate)'
        : 'Input passes through continuously';
    };
    paintGate();
    gateBtn.addEventListener('click', () => {
      // Write the gate mode directly (not via writeValue → it would create a
      // per-step p-lock; gate mode is a whole-track setting). Sync to all slots.
      this.machine.setParam('input.gate', !this.machine.gated);
      this.track._pool?.syncParams();
      // reset: flipping the mode is an explicit intent to re-baseline the gate
      // (continuous pinned it OPEN at 1.0; gated must force it closed).
      this.track._applyInputGate({ reset: true });
      paintGate();
    });
    gateWrap.appendChild(gateBtn);
    row.appendChild(gateWrap);

    this.container.appendChild(row);

    // ── Latency readout ─────────────────────────────────────────
    const lat = this.audio?.getLatencySeconds?.();
    const latEl = document.createElement('div');
    latEl.className = 'input-latency';
    latEl.textContent = lat != null
      ? `Round-trip latency ≈ ${Math.round(lat * 1000)} ms`
      : 'Round-trip latency: unknown (browser doesn’t report it)';
    latEl.title = 'Browser input→output latency. Some delay is unavoidable in-browser.';
    this.container.appendChild(latEl);
  }

  /**
   * Drive the level meter from the machine's input analyser on a rAF loop.
   * Registers a destroy hook so the loop stops when the panel re-renders / the
   * tab changes (SynthPanel calls activeWidgets.destroy() on rerender).
   * @param {HTMLElement} fill     — the coloured fill element
   * @param {HTMLElement} peakTick — the peak-hold marker
   */
  _startMeter(fill, peakTick) {
    let raf       = 0;
    let peakHold  = 0;     // decaying peak marker (0–1)
    let stopped   = false;
    const tick = () => {
      if (stopped) return;
      const { rms, peak } = this.machine.getInputLevel();
      // Map linear amplitude → meter percent on a dBFS scale (−60 dB floor → 0%,
      // 0 dBFS → 100%). Audio is logarithmic, so a dB scale makes quiet speech /
      // line levels clearly visible instead of hugging the left edge.
      const dbToPct = (amp) => {
        if (amp <= 1e-4) return 0;
        const db = 20 * Math.log10(amp);          // ≤0 dBFS
        return Math.max(0, Math.min(1, (db + 60) / 60));
      };
      fill.style.width = `${(dbToPct(rms) * 100).toFixed(1)}%`;
      // Colour by peak dBFS: green < −18, yellow −18..−6, orange −6..−1, red ≥ −1.
      const peakPct = dbToPct(peak);
      let colour;
      if      (peakPct >= 0.98) colour = 'var(--meter-red, #e23b3b)';     // ≥ −1 dB
      else if (peakPct >= 0.90) colour = 'var(--meter-orange, #e2851b)';  // ≥ −6 dB
      else if (peakPct >= 0.70) colour = 'var(--meter-yellow, #d9c020)';  // ≥ −18 dB
      else                      colour = 'var(--meter-green, #2ec27e)';
      fill.style.background = colour;
      // Peak hold with slow decay (in percent space).
      peakHold = Math.max(peakPct, peakHold - 0.01);
      peakTick.style.left = `${(peakHold * 100).toFixed(1)}%`;
      peakTick.style.opacity = peakHold > 0.01 ? '1' : '0';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Stop the loop on panel teardown.
    this.ctx.activeWidgets.push({ destroy: () => { stopped = true; cancelAnimationFrame(raf); } });
  }

  /** Render the machine's last error (denied / no device / etc.), if any. */
  _renderError() {
    if (!this._errorEl) return;
    const err = this.machine.lastError;
    if (!err) { this._errorEl.textContent = ''; return; }
    const name = err.name || '';
    let msg;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      msg = 'Permission denied. Allow microphone/input access and try again.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      msg = 'Selected input device not found (unplugged?). Pick another.';
    } else if (name === 'NotReadableError') {
      msg = 'Input device is busy or unreadable (in use by another app?).';
    } else {
      msg = err.message || 'Could not open audio input.';
    }
    this._errorEl.textContent = msg;
  }

  /**
   * Fill the device dropdown from enumerateDevices(). Labels are only populated
   * after input has been granted once; before that, devices show as generic.
   * @param {HTMLSelectElement} sel
   */
  async _populateDevices(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'System default';
    sel.appendChild(def);

    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) { /* leave just the default */ }

    const current = this.machine.getDevice();
    devices
      .filter(d => d.kind === 'audioinput')
      .forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Input ${i + 1}`;
        if (d.deviceId === current) opt.selected = true;
        sel.appendChild(opt);
      });
    if (!current) sel.value = '';
  }
}
