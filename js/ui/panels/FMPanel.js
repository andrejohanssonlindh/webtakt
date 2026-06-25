/**
 * FMPanel.js
 * ----------
 * Custom SYNTH tab layout for FMMachine.
 * Schematic column (left) + 2×2 operator grid (right).
 *
 * Receives the same panel context as DefaultMachinePanel:
 *   { machine, step, hasStep, container, activeWidgets, writeValue, emitStep, fmtParam }
 *
 * Per-operator ADSR tempo-sync: each operator's A/D/R knob carries a clickable
 * MS/BPM label in its body (center-click toggles, like the FX delay knob and
 * ADSRWidget). In BPM mode the knob drives a 1/32 count (`${path}.bpmCount32`)
 * shown as "1/8", shift-snapping to musical divisions; FMMachine resolves it to
 * seconds at note-fire from the track BPM. Sustain has no duration → no toggle.
 * See js/machines/FMMachine.js and design/audio-signal-chain.md (Unified Sync-Knob Model).
 */

import { KnobWidget } from '../KnobWidget.js';
import { formatCount32, count32ToSeconds, MUSICAL_SNAP_32, quantizeCount, minBpmCount } from '../../util/BpmSync.js';

// Count bounds for BPM-mode operator-env knobs (1/32 … 4 bars in 1/32 units).
const FM_COUNT_HI = 128;

export class FMPanel {
  render(ctx) {
    const { machine, track, step, hasStep, container, activeWidgets, knobByPath, writeValue, emitStep, fmtParam } = ctx;

    const getBpm = () => track?.clock?.bpm ?? 120;

    const allParams = machine.getParamList();
    const paramMap  = Object.fromEntries(allParams.map(p => [p.path, p]));

    // ── Shared knob factory ──────────────────────────────────────
    const mkKnob = (path, size) => {
      const p = paramMap[path];
      if (!p) return null;
      const hasPLock   = hasStep && step.plocks.has(path);
      const displayVal = hasPLock ? step.plocks.get(path) : machine.getParam(path);
      const isBipolar  = p.min < 0 && p.max > 0 && p.min === -p.max;
      const knob = new KnobWidget({
        label:   p.label,
        min:     p.min, max: p.max,
        value:   displayVal ?? p.default ?? p.min,
        bipolar: isBipolar,
        size,
        fmt:     v => fmtParam(p, v),
        onChange:  v => { writeValue(machine, path, v, false); knob.setHasPLock(hasStep); },
        onRelease: () => { if (hasStep) emitStep(); },
      });
      knob.setHasPLock(hasPLock);
      activeWidgets.push(knob);
      knobByPath?.set(path, knob);
      return knob;
    };

    // Phone-only collapse: graphics (per-op ADSR canvas + schematic) render
    // inside <details> that start OPEN on desktop/iPad and CLOSED on phone, so
    // the at-a-glance visuals stay on big screens but free vertical space where
    // it's tight. Re-evaluated on every render (tab switch reapplies correctly).
    const isPhone = window.matchMedia('(max-width: 640px)').matches;

    // ── Operator section factory ─────────────────────────────────
    // Each operator is a `.param-group` (same reflow as DefaultMachinePanel:
    // 3-up desktop → 2-up iPad → 1-up phone). Body = two knob rows (params +
    // ADSR) followed by a collapsible ADSR-shape canvas.
    const mkOpCell = (opKey, opLabel, role, roleClass, paramKeys) => {
      const cell = document.createElement('div');
      cell.className = 'param-group fm-op-group';

      const hdr = document.createElement('div');
      hdr.className = 'param-group-label fm-op-hdr';
      hdr.innerHTML = `<span class="fm-op-label">${opLabel}</span><span class="fm-op-role ${roleClass}">${role}</span>`;
      cell.appendChild(hdr);

      const body = document.createElement('div');
      body.className = 'fm-op-body';
      cell.appendChild(body);

      // Row 1 — param knobs (ratio, level, detune, [feedback]).
      const paramRow = document.createElement('div');
      paramRow.className = 'fm-op-krow';
      paramKeys.forEach(path => {
        const knob = mkKnob(path, 44);
        if (knob) paramRow.appendChild(knob.el);
      });
      body.appendChild(paramRow);

      // Row 2 — ADSR knobs + (collapsible) shape canvas.
      const adsrDiv     = document.createElement('div');
      adsrDiv.className = 'fm-op-adsr';

      const envKnobWrap     = document.createElement('div');
      envKnobWrap.className = 'fm-op-env-krow';

      // Shape canvas lives inside a phone-collapsible <details>.
      const envDetails = document.createElement('details');
      envDetails.className = 'fm-op-env-details';
      if (!isPhone) envDetails.open = true;
      const envSummary = document.createElement('summary');
      envSummary.className = 'fm-op-env-summary';
      envSummary.textContent = 'shape';
      envDetails.appendChild(envSummary);

      const envCanvas     = document.createElement('canvas');
      envCanvas.className = 'fm-op-env-canvas';

      const envKeys = [`${opKey}.env.a`, `${opKey}.env.d`, `${opKey}.env.s`, `${opKey}.env.r`];

      // Resolve a timed stage (a/d/r) to seconds, honouring its sync mode — so
      // the canvas shape reflects real durations even when a stage is BPM-synced.
      // Mirrors FMMachine._stageSeconds / Envelope._stageSeconds.
      const stageSecs = (key) => {
        if (machine.getParam(`${key}.syncMode`) === 'bpm') {
          return count32ToSeconds(machine.getParam(`${key}.bpmCount32`), getBpm());
        }
        return machine.getParam(key);
      };

      const drawEnvCanvas = () => {
        const W = envCanvas.clientWidth  || 60;
        const H = envCanvas.clientHeight || 40;
        const dpr = window.devicePixelRatio || 1;
        if (envCanvas.width !== W * dpr || envCanvas.height !== H * dpr) {
          envCanvas.width        = W * dpr;
          envCanvas.height       = H * dpr;
          envCanvas.style.width  = W + 'px';
          envCanvas.style.height = H + 'px';
        }
        const ctx2 = envCanvas.getContext('2d');
        ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx2.clearRect(0, 0, W, H);

        const A  = stageSecs(`${opKey}.env.a`);
        const D  = stageSecs(`${opKey}.env.d`);
        const S  = machine.getParam(`${opKey}.env.s`);
        const Rv = stageSecs(`${opKey}.env.r`);
        const total = A + D + 0.1 + Rv;
        const pad   = { l: 3, r: 3, t: 4, b: 4 };
        const uw    = W - pad.l - pad.r;
        const uh    = H - pad.t - pad.b;
        const xA    = pad.l + (A / total) * uw;
        const xD    = xA    + (D / total) * uw;
        const xS    = xD    + (0.1 / total) * uw;
        const xR    = xS    + (Rv / total) * uw;
        const yB    = pad.t + uh;
        const yT    = pad.t;
        const yS    = pad.t + uh * (1 - S);

        ctx2.beginPath();
        ctx2.moveTo(pad.l, yB);
        ctx2.lineTo(xA, yT);
        ctx2.lineTo(xD, yS);
        ctx2.lineTo(xS, yS);
        ctx2.lineTo(xR, yB);
        ctx2.strokeStyle = '#e8a020';
        ctx2.lineWidth   = 1.5;
        ctx2.lineJoin    = 'round';
        ctx2.stroke();

        ctx2.beginPath();
        ctx2.moveTo(pad.l, yB);
        ctx2.lineTo(xA, yT);
        ctx2.lineTo(xD, yS);
        ctx2.lineTo(xS, yS);
        ctx2.lineTo(xR, yB);
        ctx2.closePath();
        ctx2.fillStyle = 'rgba(232,160,32,0.08)';
        ctx2.fill();
      };

      envKeys.forEach((path, i) => {
        const envLabels = ['A', 'D', 'S', 'R'];
        const p = paramMap[path];
        if (!p) return;

        // Sustain has no duration → plain percent knob, no MS/BPM toggle.
        const syncable = !path.endsWith('.s');
        const modeKey  = `${path}.syncMode`;
        const countKey = `${path}.bpmCount32`;

        // P-lock-aware read of any param (step override wins when a step is held).
        const get = (key) => (hasStep && step.plocks.has(key))
          ? step.plocks.get(key) : machine.getParam(key);

        const isBpm = () => syncable && get(modeKey) === 'bpm';
        // Active param: the 1/32 count in BPM mode, raw seconds otherwise.
        const activeKey = () => isBpm() ? countKey : path;
        const range = () => isBpm()
          ? { min: minBpmCount(), max: FM_COUNT_HI }   // grid step floor (1/32…1/128)
          : { min: p.min, max: p.max };
        const fmt = (v) => {
          if (!syncable) return Math.round(v * 100) + '%';     // sustain
          return isBpm() ? formatCount32(v) : Math.round(v * 1000) + 'ms';
        };
        const centerLabel = () => syncable ? (isBpm() ? 'BPM' : 'MS') : null;

        const hasPLock = hasStep && (step.plocks.has(activeKey())
                                     || (syncable && step.plocks.has(modeKey)));
        const r0 = range();
        const knob = new KnobWidget({
          label:       envLabels[i],
          min:         r0.min, max: r0.max,
          value:       get(activeKey()) ?? p.default ?? r0.min,
          bipolar:     false,
          size:        44,
          fmt,
          centerLabel: centerLabel(),
          // BPM mode: quantize free drag to the grid, shift-snap to divisions.
          snapPoints:  isBpm() ? MUSICAL_SNAP_32 : null,
          quantize:    isBpm() ? quantizeCount : null,
          dragStep:    isBpm() ? minBpmCount() : null,
          onChange: v => {
            // The knob already quantized to the grid — store v as-is (Math.round
            // here would collapse 1/64 / 1/128 sub-counts back to integer 1/32).
            writeValue(machine, activeKey(), v, false);
            knob.setHasPLock(hasStep);
            drawEnvCanvas();
          },
          onRelease: () => { if (hasStep) emitStep(); },
          // Center-click flips MS↔BPM, then re-skin the knob to the new param.
          onCenterClick: !syncable ? null : () => {
            const next = isBpm() ? 'ms' : 'bpm';
            writeValue(machine, modeKey, next, false);
            const r = range();
            knob.setRange(r.min, r.max, fmt, isBpm() ? MUSICAL_SNAP_32 : null,
                          isBpm() ? quantizeCount : null, isBpm() ? minBpmCount() : null);
            knob.setValue(get(activeKey()) ?? r.min);
            knob.setCenterLabel(centerLabel());
            knob.setHasPLock(hasStep && (step.plocks.has(activeKey())
                                         || step.plocks.has(modeKey)));
            drawEnvCanvas();
            if (hasStep) emitStep();
          },
        });
        knob.setHasPLock(hasPLock);
        envKnobWrap.appendChild(knob.el);
        activeWidgets.push(knob);
      });

      adsrDiv.appendChild(envKnobWrap);
      envDetails.appendChild(envCanvas);
      adsrDiv.appendChild(envDetails);
      body.appendChild(adsrDiv);

      // Canvas has zero size while the <details> is collapsed; redraw when the
      // user expands it so it picks up real dimensions.
      envDetails.addEventListener('toggle', () => {
        if (envDetails.open) requestAnimationFrame(drawEnvCanvas);
      });

      if (envDetails.open) requestAnimationFrame(drawEnvCanvas);
      return cell;
    };

    // ── Layout: operator sections, OUTPUT, then schematic at bottom ──
    const wrap = document.createElement('div');
    wrap.className = 'fm-wrap';

    // Operator sections — `.param-group` row reflowing 3/2/1-up. Carrier first
    // (OP1) so the signal-flow reads top-down on a stacked phone layout.
    const opsRow = document.createElement('div');
    opsRow.className = 'fm-ops-row';
    opsRow.appendChild(mkOpCell('op1', 'OP1', 'CARRIER', 'fm-role-carrier', ['op1.ratio', 'op1.level', 'op1.detune']));
    opsRow.appendChild(mkOpCell('op2', 'OP2', 'MOD+FB',  'fm-role-fb',      ['op2.ratio', 'op2.level', 'op2.feedback', 'op2.detune']));
    opsRow.appendChild(mkOpCell('op3', 'OP3', 'MOD',     'fm-role-mod',     ['op3.ratio', 'op3.level', 'op3.detune']));
    opsRow.appendChild(mkOpCell('op4', 'OP4', 'MOD',     'fm-role-mod',     ['op4.ratio', 'op4.level', 'op4.detune']));

    // Master output level ('output.level') is hosted on the AMP page (LEVEL knob),
    // not here — only the per-operator levels (op1–op4) live in the synth panel.

    wrap.appendChild(opsRow);

    // Schematic — reference visual at the very bottom, phone-collapsible.
    const schDetails = document.createElement('details');
    schDetails.className = 'fm-sch-details';
    if (!isPhone) schDetails.open = true;
    const schSummary = document.createElement('summary');
    schSummary.className = 'fm-sch-summary';
    schSummary.textContent = 'Operator routing';
    schDetails.appendChild(schSummary);

    const schWrap = document.createElement('div');
    schWrap.className = 'fm-left';
    const schCanvas = document.createElement('canvas');
    schCanvas.className = 'fm-sch-canvas';
    schWrap.appendChild(schCanvas);
    schDetails.appendChild(schWrap);
    wrap.appendChild(schDetails);

    if (schDetails.open) _drawSchematic(schCanvas, schWrap);
    schDetails.addEventListener('toggle', () => {
      if (schDetails.open) _drawSchematic(schCanvas, schWrap);
    });

    container.appendChild(wrap);
  }
}

// ── FM schematic drawing (pure canvas, no state dependency) ─────────────────

function _drawSchematic(canvas, schLeft) {
  requestAnimationFrame(() => {
    const W   = schLeft.clientWidth || 120;
    const H   = 130;
    const dpr = window.devicePixelRatio || 1;
    canvas.width        = W * dpr;
    canvas.height       = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const BLUE  = '#7db8e8';
    const AMBER = '#e8a020';
    const GREEN = '#80c080';
    const DIM   = '#484848';
    const R     = 2;
    const BW    = Math.min(W - 12, 42);
    const BH    = 15;
    const monoFont = 'bold 8px "JetBrains Mono",monospace';

    const lx = 4;
    const rx = W - BW - 4;
    const y4 = 5;
    const y3 = 5;
    const y2 = 54;
    const y1 = 100;

    function rr(x, y, w, h, fill, stroke) {
      ctx.beginPath();
      ctx.moveTo(x + R, y); ctx.lineTo(x + w - R, y); ctx.quadraticCurveTo(x + w, y, x + w, y + R);
      ctx.lineTo(x + w, y + h - R); ctx.quadraticCurveTo(x + w, y + h, x + w - R, y + h);
      ctx.lineTo(x + R, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - R);
      ctx.lineTo(x, y + R); ctx.quadraticCurveTo(x, y, x + R, y);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    }

    function lbl(x, y, w, h, text, col, bg) {
      rr(x, y, w, h, bg, col);
      ctx.fillStyle = col; ctx.font = monoFont;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2);
    }

    function seg(x1, y1, x2, y2) {
      ctx.strokeStyle = DIM; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    function arrowTip(tx, ty, dir) {
      ctx.fillStyle = DIM; ctx.beginPath();
      if (dir === 'down')  { ctx.moveTo(tx, ty); ctx.lineTo(tx - 4, ty - 6); ctx.lineTo(tx + 4, ty - 6); }
      if (dir === 'right') { ctx.moveTo(tx, ty); ctx.lineTo(tx - 6, ty - 4); ctx.lineTo(tx - 6, ty + 4); }
      ctx.closePath(); ctx.fill();
    }

    // Boxes
    lbl(lx, y4, BW, BH, 'OP4', BLUE,  '#1a2e40');
    lbl(rx, y3, BW, BH, 'OP3', BLUE,  '#1a2e40');
    lbl(lx, y2, BW, BH, 'OP2', GREEN, '#1a2a1a');
    lbl(rx, y1, BW, BH, 'OP1', AMBER, '#2a1f08');

    // OP4 → OP3
    const midY43 = y4 + BH / 2;
    seg(lx + BW, midY43, rx - 6, midY43);
    arrowTip(rx, midY43, 'right');

    // OP3 bottom → OP1 top
    const op3cx  = rx + BW / 2;
    seg(op3cx, y3 + BH, op3cx, y1 - 6);
    arrowTip(op3cx, y1, 'down');

    // OP2 feedback arc
    ctx.strokeStyle = '#4a7a4a'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(lx + BW / 2, y2 - 7, 9, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#80c080'; ctx.font = '9px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('↺', lx + BW / 2, y2 - 17);

    // OP2 → join OP3→OP1 line
    const op2midY = y2 + BH / 2;
    seg(lx + BW, op2midY, op3cx, op2midY);
    ctx.beginPath();
    ctx.arc(op3cx, op2midY, 3, 0, Math.PI * 2);
    ctx.fillStyle = DIM; ctx.fill();

    // OP1 → OUT
    const outY = y1 + BH + 5;
    seg(op3cx, y1 + BH, op3cx, outY + 2);
    arrowTip(op3cx, outY + 8, 'down');
    ctx.fillStyle = '#555'; ctx.font = 'bold 7px "JetBrains Mono",monospace';
    ctx.textAlign = 'center'; ctx.fillText('OUT', op3cx, outY + 18);
  });
}
