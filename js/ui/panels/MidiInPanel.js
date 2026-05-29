/**
 * MidiInPanel.js
 * --------------
 * MIDI tab: MIDI In source port, channel filter, and CC → param mappings for
 * the selected track. Extracted from SynthPanel.
 *
 * NOTE: distinct from MidiPanel.js, which is the SYNTH-tab layout for the MIDI
 * *out* machine. This is the per-track MIDI *in* routing config.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { track, container, midiEngine }
 */

export class MidiInPanel {
  render(ctx) {
    const { track, container, midiEngine } = ctx;
    const midi = midiEngine;

    if (!midi?.available) {
      const msg = document.createElement('div');
      msg.className = 'midi-unavailable';
      msg.textContent = 'Web MIDI not available. Use Chrome/Edge and allow MIDI access.';
      container.appendChild(msg);
      return;
    }

    const inputs = [...midi.inputs.values()];

    // ── Input port ───────────────────────────────────────────────
    const portSection = document.createElement('div');
    portSection.className = 'midi-section';

    const portLabel = document.createElement('div');
    portLabel.className = 'midi-section-label';
    portLabel.textContent = 'MIDI In Source';
    portSection.appendChild(portLabel);

    const portSel = document.createElement('select');
    portSel.className = 'midi-select';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— off —';
    portSel.appendChild(noneOpt);

    inputs.forEach(inp => {
      const opt = document.createElement('option');
      opt.value = inp.id;
      opt.textContent = inp.name;
      if (inp.id === track.midiIn.inputId) opt.selected = true;
      portSel.appendChild(opt);
    });

    portSel.addEventListener('change', () => {
      track.midiIn.inputId = portSel.value || null;
    });
    portSection.appendChild(portSel);
    container.appendChild(portSection);

    // ── Channel filter ───────────────────────────────────────────
    const chSection = document.createElement('div');
    chSection.className = 'midi-section';

    const chLabel = document.createElement('div');
    chLabel.className = 'midi-section-label';
    chLabel.textContent = 'Channel Filter';
    chSection.appendChild(chLabel);

    const chSel = document.createElement('select');
    chSel.className = 'midi-select';

    const allOpt = document.createElement('option');
    allOpt.value = '0';
    allOpt.textContent = 'All channels';
    chSel.appendChild(allOpt);

    for (let c = 1; c <= 16; c++) {
      const opt = document.createElement('option');
      opt.value = String(c);
      opt.textContent = `Ch ${c}`;
      if (c === track.midiIn.channel) opt.selected = true;
      chSel.appendChild(opt);
    }
    if (track.midiIn.channel === 0) chSel.value = '0';

    chSel.addEventListener('change', () => {
      track.midiIn.channel = parseInt(chSel.value, 10);
    });
    chSection.appendChild(chSel);
    container.appendChild(chSection);

    // ── CC mappings ──────────────────────────────────────────────
    const ccSection = document.createElement('div');
    ccSection.className = 'midi-section';

    const ccTitle = document.createElement('div');
    ccTitle.className = 'midi-section-label';
    ccTitle.textContent = 'CC → Param Mappings';
    ccSection.appendChild(ccTitle);

    const rebuildMappings = () => {
      // Remove all mapping rows (leave the title)
      ccSection.querySelectorAll('.midi-cc-row, .midi-cc-add').forEach(el => el.remove());

      track.midiIn.ccMappings.forEach((mapping, i) => {
        const row = document.createElement('div');
        row.className = 'midi-cc-row';

        const ccInput = document.createElement('input');
        ccInput.type      = 'number';
        ccInput.min       = 0;
        ccInput.max       = 127;
        ccInput.value     = mapping.cc;
        ccInput.className = 'midi-cc-num';
        ccInput.title     = 'CC number (0–127)';
        ccInput.addEventListener('change', () => {
          mapping.cc = Math.max(0, Math.min(127, parseInt(ccInput.value, 10) || 0));
        });

        const arrow = document.createElement('span');
        arrow.className   = 'midi-cc-arrow';
        arrow.textContent = '→';

        const paramSel = document.createElement('select');
        paramSel.className = 'midi-select midi-cc-param';

        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '— none —';
        paramSel.appendChild(emptyOpt);

        const groups = track.getAssignableParams();
        groups.forEach(g => {
          const optgroup = document.createElement('optgroup');
          optgroup.label = g.group;
          g.items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.path;
            opt.textContent = item.label;
            if (item.path === mapping.param) opt.selected = true;
            optgroup.appendChild(opt);
          });
          paramSel.appendChild(optgroup);
        });

        paramSel.addEventListener('change', () => {
          mapping.param = paramSel.value;
        });

        const rmBtn = document.createElement('button');
        rmBtn.className   = 'btn midi-cc-rm';
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', () => {
          track.midiIn.ccMappings.splice(i, 1);
          rebuildMappings();
        });

        row.appendChild(ccInput);
        row.appendChild(arrow);
        row.appendChild(paramSel);
        row.appendChild(rmBtn);
        ccSection.appendChild(row);
      });

      const addBtn = document.createElement('button');
      addBtn.className   = 'btn midi-cc-add';
      addBtn.textContent = '+ Add CC';
      addBtn.addEventListener('click', () => {
        track.midiIn.ccMappings.push({ cc: 1, param: '' });
        rebuildMappings();
      });
      ccSection.appendChild(addBtn);
    };

    rebuildMappings();
    container.appendChild(ccSection);
  }
}
