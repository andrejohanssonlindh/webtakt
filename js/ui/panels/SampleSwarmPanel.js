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

    // ── Swarm param sections ──
    // Grouped (SWARM / NOISE) in a `.sampler-groups` row so they reflow
    // side-by-side like the embedded SamplerPanel's groups above.
    const groupsRow = document.createElement('div');
    groupsRow.className = 'sampler-groups';
    this.container.appendChild(groupsRow);

    const makeGroup = (label) => {
      const g = document.createElement('div');
      g.className = 'param-group';
      const lbl = document.createElement('div');
      lbl.className = 'param-group-label';
      lbl.textContent = label;
      g.appendChild(lbl);
      const body = document.createElement('div');
      body.className = 'param-group-body';
      g.appendChild(body);
      groupsRow.appendChild(g);
      return body;
    };

    const addKnob = (dst, { path, label, min, max, fmt }) => {
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
      dst.appendChild(knob.el);
      this.ctx.activeWidgets.push(knob);
    };

    const swarmG = makeGroup('SWARM');
    addKnob(swarmG, { path: 'spread',       label: 'SPREAD', min: 0,  max: 100, fmt: v => Math.round(v) + '¢'                            });
    addKnob(swarmG, { path: 'swarm.detune', label: 'DETUNE', min: 0,  max: 50,  fmt: v => Math.round(v) + '¢'                            });
    addKnob(swarmG, { path: 'height',       label: 'HEIGHT', min: 0,  max: 1,   fmt: v => Math.round(v * 100) + '%'                      });
    addKnob(swarmG, { path: 'slope',        label: 'SLOPE',  min: -1, max: 1,   fmt: v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%' });

    const noiseG = makeGroup('NOISE');
    addKnob(noiseG, { path: 'noise.amount', label: 'NOISE',  min: 0,  max: 50,  fmt: v => Math.round(v) + '¢'                            });
    addKnob(noiseG, { path: 'noise.color',  label: 'N.RATE', min: 0,  max: 1,   fmt: v => Math.round(v * 100) + '%'                      });
  }
}
