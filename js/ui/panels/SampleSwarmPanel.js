/**
 * SampleSwarmPanel.js
 * -------------------
 * SYNTH tab panel for SampleSwarmMachine.
 *
 * Layout:
 *   [SamplerPanel — load/record/waveform/sample params]
 *   [Swarm params row: Spread, Detune, Height, Noise Amt, Noise Rate]
 */

import { SamplerPanel } from './SamplerPanel.js';
import { KnobWidget }   from '../KnobWidget.js';

export class SampleSwarmPanel {
  constructor(container, ctx, sampleStore, audioContext) {
    this.container    = container;
    this.ctx          = ctx;
    this.sampleStore  = sampleStore;
    this.audioContext = audioContext;
    this.machine      = ctx.machine;

    this._render();
  }

  _render() {
    this.container.innerHTML = '';

    // ── Sampler section (waveform + sample controls) ──
    const samplerWrap = document.createElement('div');
    this.container.appendChild(samplerWrap);
    new SamplerPanel(samplerWrap, this.ctx, this.sampleStore, this.audioContext);

    // ── Swarm params row ──
    const swarmRow = document.createElement('div');
    swarmRow.className = 'sampler-param-row';

    const swarmDefs = [
      { path: 'spread',       label: 'SPREAD', min: 0,   max: 100,  fmt: v => Math.round(v) + '¢'                            },
      { path: 'swarm.detune', label: 'DETUNE', min: 0,   max: 50,   fmt: v => Math.round(v) + '¢'                            },
      { path: 'height',       label: 'HEIGHT', min: 0,   max: 1,    fmt: v => Math.round(v * 100) + '%'                      },
      { path: 'slope',        label: 'SLOPE',  min: -1,  max: 1,    fmt: v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%' },
      { path: 'noise.amount', label: 'NOISE',  min: 0,   max: 50,   fmt: v => Math.round(v) + '¢'                            },
      { path: 'noise.color',  label: 'N.RATE', min: 0,   max: 1,    fmt: v => Math.round(v * 100) + '%'                      },
    ];

    swarmDefs.forEach(({ path, label, min, max, fmt }) => {
      const knob = new KnobWidget({
        label,
        min,
        max,
        value: this.machine.getParam(path),
        size: 56,
        fmt,
        onChange: v => this.ctx.writeValue(this.machine, path, v, false),
        onRelease: () => this.ctx.emitStep?.(),
      });
      swarmRow.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
    });

    this.container.appendChild(swarmRow);
  }
}
