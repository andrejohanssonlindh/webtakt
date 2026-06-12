/**
 * loudness.js
 * -----------
 * Loudness bench for Webtakt machines.
 *
 * Renders every (audio-producing) machine through the production stack offline,
 * under identical playing conditions, and measures peak + RMS loudness per
 * machine. Produces a table plus a suggested per-machine gain to normalise all
 * machines to a common reference (the loudest machine), so you can "tune" the
 * relative levels of instruments that are currently mismatched.
 *
 * This reuses the test harness (makeOfflineTrack / rms) — see runner.js.
 *
 * NOT a pass/fail test. It is a measurement tool: read the table, then bake the
 * suggested levels into each machine's default 'output.level' (or wherever the
 * gain lives).
 */

import { makeOfflineTrack, fireStep, rms } from './runner.js';

// ─── Config ──────────────────────────────────────────────────────────────────

// Machines to measure. Excludes those that can't render offline:
//   sampler / wt-sampler — need a loaded buffer / AudioWorklet
//   midi                 — no audio output
const MACHINES = [
  'synth', 'fm', 'kick.silk', 'kick.hard', 'kick.analogue', 'snare', 'snare.analogue',
  'hihat', 'hihat.analogue', 'noise',
  'transient', 'swarm', 'cymbal', 'cymbal.analogue', 'wood', 'clapp', 'clapp.analogue',
  'tom.analogue', 'wavetable',
  'karplus', 'marimba', 'bass', 'comb', 'chord', 'strings', 'moogish', 'sample-swarm',
];

// Sample-swarm needs a buffer injected before it makes sound.
function makeToneBuffer(ctx, freq = 261.63, dur = 0.5) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d   = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * freq * i / ctx.sampleRate);
  return buf;
}

const NOTE      = 60;    // C4
const VELOCITY  = 100;
const HITS      = 8;     // fire 8 steps — spans the whole voice pool round-robin
const STEP_SEC  = 0.5;   // 120 BPM eighth-ish spacing; long enough for tails
const RENDER_SEC = HITS * STEP_SEC + 1.0;  // + tail for the last hit

// ─── Measurement ───────────────────────────────────────────────────────────────

function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
  return p;
}

function dbfs(lin) {
  return lin > 0 ? 20 * Math.log10(lin) : -Infinity;
}

/**
 * Render one machine under standard conditions, return { peak, rms } over the
 * whole buffer.
 */
async function measure(machineType) {
  const { track, ctx, sampleRate } = await makeOfflineTrack(machineType, RENDER_SEC, { bpm: 120 });

  // Neutralise the signal chain so we measure the machine, not the filter/FX.
  // Filter wide open; FX off (they default off, but be explicit / defensive).
  try { track.filter.setParam('filter.cutoff', 20000); } catch (_) {}
  try { track.filter.setParam('filter.resonance', 0.0001); } catch (_) {}

  // sample-swarm: inject a tone buffer so it produces sound.
  if (machineType === 'sample-swarm' && track.machine.setBuffer) {
    track.machine.setBuffer(makeToneBuffer(ctx));
  }

  // Fire HITS steps spaced STEP_SEC apart.
  for (let i = 0; i < HITS; i++) {
    fireStep(track, 0.05 + i * STEP_SEC, { note: NOTE, velocity: VELOCITY });
  }

  const rendered = await ctx.startRendering();
  const data     = rendered.getChannelData(0);
  return { peak: peak(data), rms: rms(data), sampleRate };
}

// ─── Bench runner ────────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function runLoudness() {
  const rows = [];
  for (const m of MACHINES) {
    try {
      const { peak, rms } = await measure(m);
      rows.push({ machine: m, peak, rms, error: null });
    } catch (e) {
      rows.push({ machine: m, peak: 0, rms: 0, error: e.message });
    }
  }

  const ok = rows.filter(r => !r.error);
  // Reference = MEDIAN RMS across machines — tune everything toward the middle
  // of the pack (best headroom + balance). Peak is kept as a clipping guard.
  const refRms  = median(ok.map(r => r.rms));
  const refPeak = Math.max(...ok.map(r => r.peak), 0);

  for (const r of rows) {
    // Suggested gain = match this machine's RMS to the median RMS.
    r.gain = (r.rms > 0 && refRms > 0) ? refRms / r.rms : 0;
    // Projected peak after applying the gain — flag if it would clip (> 1.0).
    r.projPeak = r.peak * r.gain;
    r.refRms  = refRms;
    r.refPeak = refPeak;
  }

  return { rows, refRms, refPeak, timestamp: new Date().toISOString() };
}

// ─── Rendering to DOM ──────────────────────────────────────────────────────────

export function renderLoudness(result, el, getCurrentLevel) {
  const { rows, refRms, refPeak } = result;
  el.textContent = '';

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);

  const append = (text, color) => {
    const span = document.createElement('span');
    span.textContent = text + '\n';
    if (color) span.style.color = color;
    el.appendChild(span);
  };

  append(`Reference (MEDIAN RMS) = ${refRms.toFixed(4)}   (loudest peak = ${refPeak.toFixed(3)})`, '#aaa');
  append(`Conditions: note ${NOTE}, vel ${VELOCITY}, ${HITS} hits, filter open, FX off.\n`, '#666');

  append(
    `${pad('MACHINE', 14)}${padL('RMS', 9)}${padL('PEAK', 8)}${padL('GAIN×', 9)}` +
    `${padL('PROJ PK', 9)}${padL('SUGG LVL', 11)}`,
    '#888'
  );
  append('─'.repeat(60), '#444');

  // Sort loudest → quietest by RMS (the tuning target).
  const sorted = [...rows].sort((a, b) => b.rms - a.rms);

  for (const r of sorted) {
    if (r.error) {
      append(`${pad(r.machine, 14)}  ERROR: ${r.error}`, '#f88');
      continue;
    }
    const cur  = getCurrentLevel ? getCurrentLevel(r.machine) : null;
    // Suggested new output.level = current level × gain. NOT clamped — when it
    // exceeds 1.0 the machine's internal amp must absorb the rest (level can't
    // exceed 1.0), which is flagged by showing the raw value.
    const sugg = cur != null ? cur * r.gain : null;

    // Colour by how far off the RMS is from the median.
    const ratio = r.gain;  // 1 = matched, >1 = too quiet, <1 = too loud
    let color = '#8f8';
    if (ratio > 1.5 || ratio < 0.67) color = '#fd8';
    if (ratio > 3   || ratio < 0.33) color = '#f88';

    // Flag projected clipping in red on the PROJ PK column inline.
    const projStr = r.projPeak.toFixed(3) + (r.projPeak > 0.99 ? '!' : ' ');
    const suggStr = sugg != null
      ? (sugg > 1 ? sugg.toFixed(2) + '*' : sugg.toFixed(3))
      : '—';

    append(
      `${pad(r.machine, 14)}${padL(r.rms.toFixed(4), 9)}${padL(r.peak.toFixed(3), 8)}` +
      `${padL(r.gain.toFixed(2) + '×', 9)}${padL(projStr, 9)}${padL(suggStr, 11)}`,
      color
    );
  }

  append('\nNOTE: machines already carry a fixed LOUDNESS_TRIM (js/machines/LoudnessTrim.js)', '#777');
  append('applied after output.level. After tuning, judge convergence by the RMS column', '#777');
  append('clustering near the target — the SUGG LVL column does NOT account for the trim.', '#777');
  append('\nTarget = median RMS — everything tuned toward the middle of the pack.', '#666');
  append('GAIN×    = multiply current RMS by this to hit the median.', '#666');
  append('PROJ PK  = peak after applying the gain;  "!" = would exceed ~0 dBFS (clip risk).', '#666');
  append('SUGG LVL = current output.level × GAIN×.  "*" = exceeds 1.0, so the machine\'s', '#666');
  append('           internal amp must be scaled up (output.level maxes at 1.0).', '#666');
}
