/**
 * MidiInPanel.js
 * --------------
 * MIDI tab: MIDI In source port, channel filter, note transpose, CC → param
 * mappings, and a live note console.
 *
 * Layout: two columns inside the panel-content flex-wrap.
 *   Left  — config (port, channel, transpose, CC mappings)
 *   Right — note console (scrolling log of received notes + timestamps)
 *
 * Returns a cleanup function from render() so SynthPanel can remove the
 * midiEngine listener when the tab is torn down.
 */

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const MAX_LOG    = 40;

function midiNoteName(n) {
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

export class MidiInPanel {
  /** @returns {() => void} cleanup function */
  render(ctx) {
    const { track, container, midiEngine } = ctx;
    const midi = midiEngine;

    if (!midi?.available) {
      const msg = document.createElement('div');
      msg.className = 'midi-unavailable';
      msg.textContent = 'Web MIDI not available. Use Chrome/Edge and allow MIDI access.';
      container.appendChild(msg);
      return null;
    }

    const inputs = [...midi.inputs.values()];

    // ── Left column ──────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'midi-in-col midi-in-col--config';

    // ── Input port ──
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
    left.appendChild(portSection);

    // ── Channel filter ──
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
    left.appendChild(chSection);

    // ── Note transpose ──
    const transposeSection = document.createElement('div');
    transposeSection.className = 'midi-section';
    const transposeLabel = document.createElement('div');
    transposeLabel.className = 'midi-section-label';
    transposeLabel.textContent = 'Note Transpose';
    transposeSection.appendChild(transposeLabel);

    const transposeRow = document.createElement('div');
    transposeRow.className = 'midi-transpose-row';

    const transposeDown = document.createElement('button');
    transposeDown.className = 'btn midi-transpose-btn';
    transposeDown.textContent = '−12';
    const transposeUp = document.createElement('button');
    transposeUp.className = 'btn midi-transpose-btn';
    transposeUp.textContent = '+12';

    const transposeDisplay = document.createElement('div');
    transposeDisplay.className = 'midi-transpose-display';

    const updateTransposeDisplay = () => {
      const v = track.midiIn.noteTranspose ?? 0;
      const sign = v > 0 ? '+' : '';
      transposeDisplay.textContent = sign + v;
      transposeDisplay.style.color = v !== 0 ? 'var(--accent)' : 'var(--text)';
    };
    updateTransposeDisplay();

    transposeDown.addEventListener('click', () => {
      track.midiIn.noteTranspose = Math.max(-48, (track.midiIn.noteTranspose ?? 0) - 12);
      updateTransposeDisplay();
    });
    transposeUp.addEventListener('click', () => {
      track.midiIn.noteTranspose = Math.min(48, (track.midiIn.noteTranspose ?? 0) + 12);
      updateTransposeDisplay();
    });
    transposeDisplay.addEventListener('dblclick', () => {
      track.midiIn.noteTranspose = 0;
      updateTransposeDisplay();
    });

    transposeRow.appendChild(transposeDown);
    transposeRow.appendChild(transposeDisplay);
    transposeRow.appendChild(transposeUp);
    transposeSection.appendChild(transposeRow);
    left.appendChild(transposeSection);

    // ── CC mappings ──
    const ccSection = document.createElement('div');
    ccSection.className = 'midi-section';
    const ccTitle = document.createElement('div');
    ccTitle.className = 'midi-section-label';
    ccTitle.textContent = 'CC → Param Mappings';
    ccSection.appendChild(ccTitle);

    const rebuildMappings = () => {
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
        paramSel.addEventListener('change', () => { mapping.param = paramSel.value; });

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
    left.appendChild(ccSection);

    // ── Right column — note console ──────────────────────────────
    const right = document.createElement('div');
    right.className = 'midi-in-col midi-in-col--console';

    const consoleLabel = document.createElement('div');
    consoleLabel.className = 'midi-section-label';
    consoleLabel.textContent = 'MIDI Monitor';
    right.appendChild(consoleLabel);

    const consoleEl = document.createElement('div');
    consoleEl.className = 'midi-console';
    right.appendChild(consoleEl);

    const clearBtn = document.createElement('button');
    clearBtn.className   = 'btn midi-console-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => { consoleEl.innerHTML = ''; });
    right.appendChild(clearBtn);

    // Append a log entry and auto-scroll.
    const addEntry = (type, text) => {
      // Trim oldest entries
      while (consoleEl.children.length >= MAX_LOG) {
        consoleEl.removeChild(consoleEl.firstChild);
      }
      const row = document.createElement('div');
      row.className = `midi-console-row midi-console-row--${type}`;

      const ts = document.createElement('span');
      ts.className = 'midi-console-ts';
      const now = new Date();
      ts.textContent = now.toLocaleTimeString('en-GB', { hour12: false }) +
        '.' + String(now.getMilliseconds()).padStart(3, '0');

      const msg = document.createElement('span');
      msg.className = 'midi-console-msg';
      msg.textContent = text;

      row.appendChild(ts);
      row.appendChild(msg);
      consoleEl.appendChild(row);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    // Listen to all MIDI note-on/off from any input.
    const onNoteOn = (_inputId, ch, note, vel) => {
      addEntry('on', `▶ ${midiNoteName(note)}  vel ${vel}  ch ${ch}`);
    };
    const onNoteOff = (_inputId, ch, note) => {
      addEntry('off', `■ ${midiNoteName(note)}  ch ${ch}`);
    };

    midi.onNoteOn(onNoteOn);
    midi.onNoteOff(onNoteOff);

    container.appendChild(left);
    container.appendChild(right);

    return () => {
      midi.offNoteOn(onNoteOn);
      midi.offNoteOff(onNoteOff);
    };
  }
}
