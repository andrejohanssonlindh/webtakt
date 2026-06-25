/**
 * sync_knob.js — unified MS/BPM sync-knob model tests
 *
 * Guards the migration of synced time params from beat-division strings to the
 * integer 1/32-count model (see design/audio-signal-chain.md (Unified Sync-Knob Model)). Covers DelayFX,
 * ReverbFX, LFO and Arpeggiator: BPM-mode timing math, serialise round-trip,
 * and legacy `*.bpmDiv` → `*.bpmCount32` back-compat on load.
 */

import { suite, test, assert, makeOfflineTrack, fireStep, rms } from '../runner.js';
import * as BpmSync from '../../js/util/BpmSync.js';
import { count32ToSeconds, divToCount32, quantizeCount, formatCount32,
         setSnapResolution } from '../../js/util/BpmSync.js';
import { KnobWidget } from '../../js/ui/KnobWidget.js';

suite('Sync knob (MS/BPM unified)', () => {

  test('BpmSync: free-drag quantizes to the Settings grid (1/32 / 1/64 / 1/128)', () => {
    // The synced knobs step one grid unit per the user's resolution. Stored
    // counts are always in 1/32 units, so 1/64 → 0.5-unit steps, 1/128 → 0.25.
    try {
      setSnapResolution(32);                       // default: whole 1/32 units
      assert.ok(quantizeCount(30.4) === 30, '1/32 grid: 30.4 → 30');
      assert.ok(quantizeCount(30.6) === 31, '1/32 grid: 30.6 → 31');

      setSnapResolution(64);                        // 1/64 → 0.5-unit steps
      assert.near(quantizeCount(30.4), 30.5, 1e-9, '1/64 grid: 30.4 → 30.5');
      assert.near(quantizeCount(30.2), 30.0, 1e-9, '1/64 grid: 30.2 → 30');

      setSnapResolution(128);                       // 1/128 → 0.25-unit steps
      assert.near(quantizeCount(30.2), 30.25, 1e-9, '1/128 grid: 30.2 → 30.25');
      assert.near(quantizeCount(30.1), 30.0,  1e-9, '1/128 grid: 30.1 → 30');

      // Labels: at most TWO terms (N wholes + one exact fraction). Sub-whole
      // values are a single reduced fraction.
      assert.ok(formatCount32(32)   === '1/1',     '32 → 1/1');
      assert.ok(formatCount32(30)   === '15/16',   '30 → 15/16 (one reduced fraction)');
      assert.ok(formatCount32(30.5) === '61/64',   '30.5 → 61/64');
      assert.ok(formatCount32(30.25) === '121/128','30.25 → 121/128');
      assert.ok(formatCount32(0.5)  === '1/64',    'bare 0.5 → 1/64');
      assert.ok(formatCount32(0.25) === '1/128',   'bare 0.25 → 1/128');
    } finally {
      setSnapResolution(32);                        // restore default for other tests
    }
  });

  test('minBpmCount: floor follows the grid (lets values go below 1/32)', () => {
    // The "can't go below 1/32" bug: sync knobs hardcoded min:1. The BPM floor must
    // be ONE grid step so 1/64 (0.5) and 1/128 (0.25) become reachable.
    try {
      setSnapResolution(32);  assert.ok(BpmSync.minBpmCount() === 1,    '1/32 floor = 1');
      setSnapResolution(64);  assert.ok(BpmSync.minBpmCount() === 0.5,  '1/64 floor = 0.5');
      setSnapResolution(128); assert.ok(BpmSync.minBpmCount() === 0.25, '1/128 floor = 0.25');
      // At the finest grid, the floor labels as 1/128 and quantize keeps it there.
      assert.ok(formatCount32(0.25) === '1/128', '0.25 → 1/128');
      assert.near(quantizeCount(0.3), 0.25, 1e-9, '0.3 snaps to the 1/128 floor');
    } finally {
      setSnapResolution(32);
    }
  });

  test('formatCount32: whole-note + single fraction, never 3 terms', () => {
    // Regression: above 2/1 the label used to read "2/1 + 33/32" … "2/1 + 63/32".
    // Now it is N whole notes + ONE exact fraction, at most two terms total.
    assert.ok(formatCount32(64)  === '2/1',        '64 → 2/1');
    assert.ok(formatCount32(128) === '4/1',        '128 → 4/1');
    assert.ok(formatCount32(65)  === '2/1 + 1/32', '65 → 2/1 + 1/32');
    assert.ok(formatCount32(96)  === '3/1',        '96 → 3/1');
    assert.ok(formatCount32(97)  === '3/1 + 1/32', '97 → 3/1 + 1/32 (not 2/1 + 1/1 + …)');
    assert.ok(formatCount32(112) === '3/1 + 1/2',  '112 → 3/1 + 1/2');
    assert.ok(formatCount32(40)  === '1/1 + 1/4',  '40 → 1/1 + 1/4');
    assert.ok(formatCount32(64.25) === '2/1 + 1/128', '64.25 → 2/1 + 1/128');
    assert.ok(formatCount32(65.25) === '2/1 + 5/128', '65.25 → 2/1 + 5/128 (exact odd numerator)');
    // No label anywhere in the range has more than two "+"-joined terms.
    for (let c = 1; c <= 128; c += 0.25) {
      const label = formatCount32(c);
      const terms = label.split(' + ').length;
      assert.ok(terms <= 2, `count ${c} label "${label}" has ${terms} terms (max 2)`);
    }
  });

  test('BpmSync: raising the grid FILLS IN fine snap steps (1/32↔1/16 reachable)', () => {
    // The reported bug: switching to a finer grid "did not change the knobs" —
    // because the snap set only added ONE 1/64 point below 1/32, nothing between
    // 1/32 (count 1) and 1/16 (count 2). The fine region (≤1/4 = 8 units) must be
    // filled at the user's resolution so shift-snap reaches every step there.
    try {
      setSnapResolution(32);
      const at32 = BpmSync.MUSICAL_SNAP_32;
      // Default 1/32: every whole count through 1/4, then coarse divisions.
      assert.ok(JSON.stringify(at32.slice(0, 8)) === JSON.stringify([1,2,3,4,5,6,7,8]),
        `1/32 fine region = 1..8, got ${at32.slice(0, 8)}`);
      assert.ok(!at32.some(v => Math.abs(v - 1.5) < 1e-9), '1/32 has NO 1.5 (1/64) point');

      setSnapResolution(64);
      const at64 = BpmSync.MUSICAL_SNAP_32;
      // 1/64: the half-steps between 1/32 and 1/16 (and on up) now exist.
      assert.ok(at64.some(v => Math.abs(v - 1.5) < 1e-9), '1/64 fills 1.5 (1/32+1/64)');
      assert.ok(at64.some(v => Math.abs(v - 2.5) < 1e-9), '1/64 fills 2.5 (1/16+1/64)');
      // Fine region is every 0.5 from 0.5 to 8.
      const fine64 = at64.filter(v => v <= 8);
      const expect64 = []; for (let v = 0.5; v <= 8 + 1e-9; v += 0.5) expect64.push(v);
      assert.ok(JSON.stringify(fine64) === JSON.stringify(expect64),
        `1/64 fine region every 0.5, got ${fine64}`);

      setSnapResolution(128);
      const at128 = BpmSync.MUSICAL_SNAP_32;
      assert.ok(at128.some(v => Math.abs(v - 1.25) < 1e-9), '1/128 fills 1.25 (1/32+1/128)');
      assert.ok(at128.some(v => Math.abs(v - 1.75) < 1e-9), '1/128 fills 1.75 (1/32+3/128)');

      // Coarse divisions above 1/4 are unchanged regardless of grid.
      [12, 16, 24, 32, 48, 64, 96, 128].forEach(c =>
        assert.ok(at128.some(v => Math.abs(v - c) < 1e-9), `coarse ${c} present at 1/128`));

      // Fine-step labels are a single reduced fraction (sub-whole, one term).
      assert.ok(formatCount32(1.5)  === '3/64',  '1.5 → 3/64');
      assert.ok(formatCount32(2.5)  === '5/64',  '2.5 → 5/64');
      assert.ok(formatCount32(1.25) === '5/128', '1.25 → 5/128');
    } finally {
      setSnapResolution(32);
    }
  });

  test('KnobWidget BPM mode: EVERY drag position lands on the Settings grid', () => {
    // Regression for "BPM mode shows lower granularity than the grid setting"
    // (e.g. 3/32 + 31/64 at a 1/32 grid). The fix wires BpmSync.quantizeCount into
    // KnobWidget as a `quantize` hook so the free-drag path can't produce off-grid
    // floats. This drives the REAL knob across its whole 0..1 sweep (the same path
    // a pointer drag takes via _setFromNorm) and asserts every emitted value is an
    // exact multiple of the grid step. It prints offenders so a future regression
    // says WHICH positions broke, not just that one did.
    const STEPS = 500;                               // fine sweep across the range
    const cases = [
      { grid: 32,  step: 1,    min: 1, max: 64 },    // 1/32 → whole units
      { grid: 64,  step: 0.5,  min: 1, max: 64 },    // 1/64 → half units
      { grid: 128, step: 0.25, min: 1, max: 64 },    // 1/128 → quarter units
    ];
    try {
      for (const { grid, step, min, max } of cases) {
        setSnapResolution(grid);
        let emitted = min;
        const knob = new KnobWidget({
          label: 'T', min, max, value: min,
          quantize: quantizeCount,
          onChange: v => { emitted = v; },
        });
        const offenders = [];
        for (let i = 0; i <= STEPS; i++) {
          const norm = i / STEPS;                    // sweep the full knob travel
          knob._setFromNorm(norm);                   // exact path a drag takes
          const v = emitted;
          // On-grid ⇔ v / step is (near) an integer. Tight epsilon so genuine
          // sub-grid noise (e.g. 4.46875 = "1/8 + 31/64" at a 1/32 grid) is caught
          // while float dust from norm→value→quantize is not. This is THE rule the
          // bug violated; the label is printed only for human-readable diagnostics.
          const ratio  = v / step;
          const onGrid = Math.abs(ratio - Math.round(ratio)) < 1e-6;
          if (!onGrid) {
            offenders.push(`norm=${norm.toFixed(3)} v=${v} label="${formatCount32(v)}"`);
          }
        }
        if (offenders.length) {
          console.warn(`[sync grid 1/${grid}] ${offenders.length} off-grid positions:`);
          offenders.slice(0, 12).forEach(o => console.warn('   ' + o));
        }
        assert.ok(offenders.length === 0,
          `grid 1/${grid}: ${offenders.length} off-grid positions (see console)`);
      }
    } finally {
      setSnapResolution(32);
    }
  });

  test('KnobWidget BPM drag: steps ONE grid unit at a time (not every 1/32)', () => {
    // Regression for "1/128 grid jumps 1/128 → 5/128 → 9/128" (steps of 1/32). A
    // range-proportional drag moves ≈1 count/px so quantize only ever lands on
    // integer counts. dragStep pacing must make consecutive stops differ by exactly
    // ONE grid step. Drives the REAL knob with synthetic pointer moves.
    const dispatch = (el, type, x) => el.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: 0, bubbles: true, cancelable: true }));

    const cases = [
      { grid: 64,  step: 0.5  },
      { grid: 128, step: 0.25 },
    ];
    try {
      for (const { grid, step } of cases) {
        setSnapResolution(grid);
        const seen = [];
        const knob = new KnobWidget({
          label: 'T', min: step, max: 64, value: step,
          quantize: quantizeCount, dragStep: step,
          onChange: v => { if (seen[seen.length - 1] !== v) seen.push(v); },
        });
        // Press at x=0, then drag right pixel-by-pixel. 4px per step (STEP_PX), so
        // ~40px climbs ~10 steps — enough to see the increment size.
        dispatch(knob._canvas, 'mousedown', 0);
        for (let x = 1; x <= 60; x++) dispatch(window, 'mousemove', x);
        dispatch(window, 'mouseup', 60);

        assert.gt(seen.length, 4, `1/${grid}: drag produced several stops (${seen.length})`);
        // Every consecutive pair differs by exactly one grid step (no 1/32 jumps).
        const bad = [];
        for (let i = 1; i < seen.length; i++) {
          const d = seen[i] - seen[i - 1];
          if (Math.abs(d - step) > 1e-6) bad.push(`${seen[i-1]}→${seen[i]} (Δ${d})`);
        }
        if (bad.length) console.warn(`[drag 1/${grid}] non-grid steps:`, bad.slice(0, 8));
        assert.ok(bad.length === 0, `1/${grid}: ${bad.length} non-single-step jumps (see console)`);
        knob.destroy();   // remove window listeners so later dispatches don't hit it
      }
    } finally {
      setSnapResolution(32);
    }
  });

  test('KnobWidget BPM mode: clamps the grid step within [min,max]', () => {
    // Rounding must never push the emitted value past the knob's range (a coarse
    // 1/32 grid on a knob whose min is a sub-grid 0.25 must not round below it).
    try {
      setSnapResolution(32);
      let emitted = 0;
      const knob = new KnobWidget({
        label: 'T', min: 1, max: 64, value: 1,
        quantize: quantizeCount,
        onChange: v => { emitted = v; },
      });
      knob._setFromNorm(0);    // hard left
      assert.ok(emitted >= 1, `min respected, got ${emitted}`);
      knob._setFromNorm(1);    // hard right
      assert.ok(emitted <= 64, `max respected, got ${emitted}`);
    } finally {
      setSnapResolution(32);
    }
  });

  test('BpmSync: count32ToSeconds + divToCount32 are consistent', () => {
    // 120 BPM: one 1/32 = (60/120)/8 = 0.0625s. 8×1/32 = 1/4 = 0.5s.
    assert.near(count32ToSeconds(1, 120), 0.0625, 1e-9, '1/32 @120');
    assert.near(count32ToSeconds(8, 120), 0.5,    1e-9, '1/4 @120');
    assert.ok(divToCount32('1/32') === 1,  '1/32 → 1');
    assert.ok(divToCount32('1/8')  === 4,  '1/8 → 4');
    assert.ok(divToCount32('1/4')  === 8,  '1/4 → 8');
    assert.ok(divToCount32('1/1')  === 32, '1/1 → 32');
  });

  test('DelayFX: bpm mode sets delay time from 1/32 count', async () => {
    const { track, ctx } = await makeOfflineTrack('synth', 0.1);   // clock 120 BPM
    const d = track.delayFX;
    d.setBpm(120);
    d.setParam('delay.syncMode', 'bpm');
    d.setParam('delay.bpmCount32', 8);   // 1/4 = 0.5s @120

    // The math the node is driven from (delay time uses setTargetAtTime, which
    // only reaches its target after the audio graph runs, so reading
    // delayTime.value synchronously would still show the default).
    assert.near(count32ToSeconds(8, 120), 0.5, 1e-9, 'count32ToSeconds(8,120) = 0.5');

    // Render so the setTargetAtTime ramp settles, then confirm the node followed.
    await ctx.startRendering();
    assert.near(d._delayNode.delayTime.value, 0.5, 0.02, 'delay node settled to bpm-derived time');
  });

  test('ReverbFX: bpm pre-delay + bpmDiv back-compat on load', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const r = track.reverbFX;
    r.setBpm(120);
    r.setParam('reverb.syncMode', 'bpm');
    r.setParam('reverb.bpmCount32', 4);  // 1/16 = 0.25s, clamped to 0.5 max
    assert.near(r.getParam('reverb.predelay'), 0.25, 0.001, 'predelay from bpm count');

    // Legacy project: division string must map to a count and the old key drop.
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.reverbFX.fromJSON({ params: { 'reverb.syncMode': 'bpm', 'reverb.bpmDiv': '1/8' }, enabled: false });
    assert.ok(t2.reverbFX.getParam('reverb.bpmCount32') === 4, '1/8 → count 4');
    assert.ok(t2.reverbFX.getParam('reverb.bpmDiv') === undefined, 'legacy key dropped');
  });

  test('LFO: bpm count drives osc Hz (count = period) + back-compat', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const lfo = track.lfos[0];
    lfo.setParam('lfo.syncMode', 'bpm');
    lfo.setParam('lfo.bpmCount32', 8);   // 1/4 = 0.5s period → 2 Hz @120
    lfo.start();
    assert.near(lfo._lfoOsc.frequency.value, 2, 1e-6, 'osc Hz from bpm count');

    // Advanced per-section count fields exist and serialise.
    lfo.setParam('lfo.adsr.a.bpmCount32', 6);
    const j = lfo.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.lfos[0].fromJSON(j);
    assert.ok(t2.lfos[0].getParam('lfo.bpmCount32') === 8, 'global count round-trip');
    assert.ok(t2.lfos[0].getParam('lfo.adsr.a.bpmCount32') === 6, 'section count round-trip');

    // Legacy lfo.bpmDiv string maps to count.
    const { track: t3 } = await makeOfflineTrack('synth', 0.1);
    t3.lfos[0].fromJSON({ index: 0, params: { 'lfo.syncMode': 'bpm', 'lfo.bpmDiv': '1/4' } });
    assert.ok(t3.lfos[0].getParam('lfo.bpmCount32') === 8, 'lfo bpmDiv → count 8');
  });

  test('Arpeggiator: bpm gap from count + per-step + back-compat', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const arp = track.arp;
    arp.setBpm(120);
    arp.setParam('syncMode', 'bpm');
    arp.setParam('bpmCount32', 8);  // 1/4 = 0.5s gap
    assert.near(arp._gapSec('bpm', 0, 8), 0.5, 1e-9, 'arp gap from count');

    // Legacy arp + per-step bpmDiv strings map to counts; old keys dropped.
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.arp.fromJSON({
      enabled: false,
      params: {
        syncMode: 'bpm', bpmDiv: '1/8',
        steps: [{ semitone: 0, syncMode: 'bpm', bpmDiv: '1/16', gate: 100 }],
      },
    });
    assert.ok(t2.arp.getParam('bpmCount32') === 4, 'arp bpmDiv → count 4');
    assert.ok(t2.arp.getParam('bpmDiv') === undefined, 'arp legacy key dropped');
    assert.ok(t2.arp.getParam('steps')[0].bpmCount32 === 2, 'step bpmDiv → count 2');
    assert.ok(t2.arp.getParam('steps')[0].bpmDiv === undefined, 'step legacy key dropped');
  });

  test('Arpeggiator: input mode buildInputCycle (absolute notes + pattern + cycle len)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const arp = track.arp;
    arp.setBpm(120);
    arp.setParam('mode', 'input');
    arp.setParam('pattern', 'up');
    arp.setParam('syncMode', 'bpm');
    arp.setParam('bpmCount32', 4);   // 1/8 = 0.25s gap @120
    arp.setParam('variance', 0);
    arp.setParam('gate', 0);

    // held notes are {note, velocity} objects, ascending; t0 is the second arg.
    const held = [{ note: 60, velocity: 100 }, { note: 64, velocity: 100 }, { note: 67, velocity: 100 }]; // C E G
    const { events, cycleSec } = arp.buildInputCycle(held, 0);

    assert.ok(events.length === 3, 'one event per held note');
    // Absolute pitches, laid out at their true values (no root offset).
    assert.ok(events[0].note === 60 && events[1].note === 64 && events[2].note === 67,
      'up pattern keeps absolute notes ascending');
    // Gap of 0.25s between successive note starts.
    assert.near(events[1].time - events[0].time, 0.25, 1e-9, 'gap from bpm count');
    assert.near(cycleSec, 0.75, 1e-9, 'cycle length = noteCount * gap');

    // 'down' reverses the order.
    arp.setParam('pattern', 'down');
    const down = arp.buildInputCycle(held, 0).events;
    assert.ok(down[0].note === 67 && down[2].note === 60, 'down pattern reverses');

    // Steps must NOT trigger input mode — buildEvents returns nothing.
    const stepEvents = arp.buildEvents(60, 100, 0, 0.5, 0.5);
    assert.ok(stepEvents.length === 0, 'input mode is not step-triggered');
  });

  test('Arpeggiator: input-random buildInputCycle (notes around held roots, cycle len)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const arp = track.arp;
    arp.setBpm(120);
    arp.setParam('mode', 'input-random');
    arp.setParam('syncMode', 'bpm');
    arp.setParam('bpmCount32', 4);   // 1/8 = 0.25s gap @120
    arp.setParam('variance', 0);
    arp.setParam('rGate', 0);
    arp.setParam('noteCount', 5);
    arp.setParam('range', 3);

    const held = [{ note: 60, velocity: 100 }, { note: 72, velocity: 90 }]; // C4, C5
    const { events, cycleSec } = arp.buildInputCycle(held, 0);

    // The cycle LEADS with the held note(s) themselves (all roots, flagged
    // root:true, played as pressed), then noteCount-1 random notes. So with a
    // 2-note chord held: 2 lead events + (5-1) random = 6 events.
    const leads   = events.filter(ev => ev.root);
    const rolls   = events.filter(ev => !ev.root);
    assert.ok(leads.length === held.length, 'lead = one event per held root');
    assert.ok(rolls.length === 5 - 1, 'noteCount-1 random events after the lead');
    assert.ok(events.length === held.length + (5 - 1), 'lead + random event count');
    assert.near(cycleSec, 5 * 0.25, 1e-9, 'cycle length = noteCount * gap');

    // Lead notes are the held pitches exactly, at t0, carrying their own velocity.
    leads.forEach(ev => {
      const h = held.find(x => x.note === ev.note);
      assert.ok(h, `lead note ${ev.note} is a held pitch`);
      assert.ok(ev.velocity === h.velocity, 'lead note carries its key velocity');
      assert.near(ev.time, 0, 1e-9, 'lead notes start at t0');
    });

    // Random notes start one gap after the lead and are equally spaced (variance 0).
    assert.near(rolls[0].time, 0.25, 1e-9, 'first random note a gap after the lead');
    assert.near(rolls[1].time - rolls[0].time, 0.25, 1e-9, 'equal gap from bpm count');

    // Every random note must sit within ±range of one of the held roots and carry
    // that root's velocity.
    rolls.forEach(ev => {
      const ok = held.some(h => Math.abs(ev.note - h.note) <= 3);
      assert.ok(ok, `note ${ev.note} within ±range of a held root`);
      const root = held.find(h => Math.abs(ev.note - h.note) <= 3);
      assert.ok(ev.velocity === root.velocity, 'note inherits its root velocity');
    });

    // Steps must NOT trigger input-random — buildEvents returns nothing.
    const stepEvents = arp.buildEvents(60, 100, 0, 0.5, 0.5);
    assert.ok(stepEvents.length === 0, 'input-random is not step-triggered');
    assert.ok(arp.isLiveInputMode(), 'input-random reports as a live input mode');
  });

  test('Arpeggiator: input mode fires steps normally (recorded notes play back)', async () => {
    // Regression: a step recorded by the live-input arp must still play on
    // playback. Input mode's buildEvents() returns [], so _fireStep must route
    // the step through the NORMAL path (arpFiresSteps=false) — not the arp branch
    // (which would swallow the step into zero events → silence).
    const { track, ctx } = await makeOfflineTrack('synth', 0.4);
    const arp = track.arp;
    arp.enabled = true;
    arp.setParam('mode', 'input');

    // Fire a normal note step while the arp sits in input mode.
    fireStep(track, 0.0, { note: 60, velocity: 110, length: 2 });

    const buf  = await ctx.startRendering();
    const data = buf.getChannelData(0);
    assert.ok(rms(data) > 0.001, 'input-mode step produces audio (not swallowed by arp)');
  });

  test('Sequencer: stepIndexAtTime spreads arp-cycle notes across steps (capture)', async () => {
    // Regression: a live-input-arp cycle is scheduled in one synchronous burst.
    // Capture must place each note by its scheduled time, not "now", or the whole
    // chord piles onto one step. stepIndexAtTime is the mapping that prevents that.
    const { track } = await makeOfflineTrack('synth', 0.1);  // 120 BPM
    const seq = track.sequencer;
    seq.stepCount = 16;

    // Simulate the clock state: step 4 was the last one fired, at t=0.0.
    // secondsPerTick @120/4 = 0.125s; an 1/8 arp gap = 0.25s = 2 ticks.
    seq._stepIndex = 5;            // tick handler already advanced past step 4
    seq.lastScheduledTime = 0.0;

    const c = seq.stepIndexAtTime(0.30);   // 2.4 ticks past step 4
    const e = seq.stepIndexAtTime(0.55);   // 4.4 ticks
    const g = seq.stepIndexAtTime(0.80);   // 6.4 ticks
    assert.ok(c.absStep === 6,  'first note → step 6');
    assert.ok(e.absStep === 8,  'second note → step 8 (one 1/8 later)');
    assert.ok(g.absStep === 10, 'third note → step 10');
    assert.ok(c.absStep !== e.absStep && e.absStep !== g.absStep, 'notes land on distinct steps');
    assert.near(c.nudge, 0.4, 1e-9, 'sub-step nudge preserved');

    // Wraps around the pattern length.
    const wrap = seq.stepIndexAtTime(0.0 + 13 * 0.125);  // step 4 + 13 = 17 → 1
    assert.ok(wrap.absStep === 1, 'absStep wraps mod stepCount');

    // No clock tick yet → null (capture is skipped). The sentinel is `null`;
    // 0 is a valid AudioContext tick time (used as the fired time above).
    seq.lastScheduledTime = null;
    assert.ok(seq.stepIndexAtTime(1.0) === null, 'null before first tick');
  });

  test('Arpeggiator: arp.rate/gate/variance virtual mod params (p-lock + LFO targets)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);
    const arp = track.arp;

    // arp.gate / arp.variance alias the real fields directly.
    arp.setParam('arp.gate', 250);
    assert.ok(arp.getParam('gate') === 250, 'arp.gate aliases gate');
    arp.setParam('arp.variance', 0.4);
    assert.near(arp.getParam('variance'), 0.4, 1e-9, 'arp.variance aliases variance');

    // arp.rate maps to speed in ms mode, bpmCount32 in bpm mode.
    arp.setParam('syncMode', 'ms');
    arp.setParam('arp.rate', 180);
    assert.ok(arp.getParam('speed') === 180, 'arp.rate → speed in ms mode');
    assert.ok(arp.getParam('arp.rate') === 180, 'arp.rate reads speed in ms mode');

    arp.setParam('syncMode', 'bpm');
    arp.setParam('arp.rate', 8);
    assert.ok(arp.getParam('bpmCount32') === 8, 'arp.rate → bpmCount32 in bpm mode');
    assert.ok(arp.getParam('arp.rate') === 8, 'arp.rate reads bpmCount32 in bpm mode');

    // Descriptor bounds follow the active sync mode for rate.
    const bpmRate = arp.modParamDescriptors().find(p => p.path === 'arp.rate');
    assert.ok(bpmRate.max === 64, 'rate descriptor max=64 in bpm mode');
    arp.setParam('syncMode', 'ms');
    const msRate = arp.modParamDescriptors().find(p => p.path === 'arp.rate');
    assert.ok(msRate.max === 2000, 'rate descriptor max=2000 in ms mode');

    // Track exposes them as jsOnly LFO destinations + in the assignable list.
    const resolved = track._resolveAudioParam('arp.rate');
    assert.ok(resolved && resolved.jsOnly === true && resolved.audioParam === null,
      'arp.rate resolves as jsOnly LFO destination');
    arp.enabled = true;
    const groups = track.getAssignableParams();
    const arpGroup = groups.find(g => g.group === 'Arp');
    assert.ok(arpGroup && arpGroup.items.some(i => i.path === 'arp.variance'),
      'Arp group present in assignable params when enabled');
  });

  test('Envelope: per-stage tempo-sync resolves seconds + round-trips', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);   // clock 120 BPM
    const env = track.envelope;
    env.setBpm(120);

    // Default ms mode: attack stays the raw seconds value.
    env.setParam('env.attack', 0.05);
    assert.near(env._stageSeconds('env', 'attack'), 0.05, 1e-9, 'ms stage = raw seconds');

    // BPM mode: attack follows the 1/32 count (8 = 1/4 = 0.5s @120).
    env.setParam('env.attack.syncMode', 'bpm');
    env.setParam('env.attack.bpmCount32', 8);
    assert.near(env._stageSeconds('env', 'attack'), 0.5, 1e-6, 'bpm stage from count');

    // BPM change re-resolves live (no write-back to env.attack).
    env.setBpm(60);
    assert.near(env._stageSeconds('env', 'attack'), 1.0, 1e-6, 'bpm stage follows tempo');

    // Filter env stage independent.
    env.setParam('fenv.release.syncMode', 'bpm');
    env.setParam('fenv.release.bpmCount32', 4);
    env.setBpm(120);
    assert.near(env._stageSeconds('fenv', 'release'), 0.25, 1e-6, 'fenv stage from count');

    // p-lock-style override wins for both mode + count.
    const secs = env._stageSeconds('env', 'attack', { 'env.attack.bpmCount32': 4 });
    assert.near(secs, 0.25, 1e-6, 'override count honoured');

    // Round-trip the new sync params.
    const json = env.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.envelope.fromJSON(json);
    assert.ok(t2.envelope.getParam('env.attack.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.envelope.getParam('env.attack.bpmCount32') === 8, 'count round-trip');
    assert.ok(t2.envelope.getParam('fenv.release.bpmCount32') === 4, 'fenv count round-trip');
  });

  test('FMMachine: per-operator ADSR tempo-sync resolves seconds + round-trips', async () => {
    const { track } = await makeOfflineTrack('fm', 0.1);   // clock 120 BPM
    const fm = track.machine;
    fm.setBpm(120);

    // Default ms mode: op1 attack stays the raw seconds value.
    fm.setParam('op1.env.a', 0.05);
    assert.near(fm._stageSeconds('op1', 'a'), 0.05, 1e-9, 'ms stage = raw seconds');

    // BPM mode: attack follows the 1/32 count (8 = 1/4 = 0.5s @120).
    fm.setParam('op1.env.a.syncMode', 'bpm');
    fm.setParam('op1.env.a.bpmCount32', 8);
    assert.near(fm._stageSeconds('op1', 'a'), 0.5, 1e-6, 'bpm stage from count');

    // BPM change re-resolves live (no write-back to op1.env.a).
    fm.setBpm(60);
    assert.near(fm._stageSeconds('op1', 'a'), 1.0, 1e-6, 'bpm stage follows tempo');
    assert.near(fm.getParam('op1.env.a'), 0.05, 1e-9, 'seconds param untouched in bpm mode');

    // Per-operator independence: op2 release is its own synced stage.
    fm.setParam('op2.env.r.syncMode', 'bpm');
    fm.setParam('op2.env.r.bpmCount32', 4);
    fm.setBpm(120);
    assert.near(fm._stageSeconds('op2', 'r'), 0.25, 1e-6, 'op2 release from count');
    // op3 left in ms mode is unaffected.
    fm.setParam('op3.env.d', 0.2);
    assert.near(fm._stageSeconds('op3', 'd'), 0.2, 1e-9, 'untouched op stays ms');

    // BPM propagates through the track (onBpmChanged → VoicePool → machine).
    track.onBpmChanged(60);
    assert.near(track.machine._stageSeconds('op1', 'a'), 1.0, 1e-6, 'track BPM reaches FM machine');
    track.onBpmChanged(120);

    // Round-trip the new sync params.
    const json = fm.toJSON();
    const { track: t2 } = await makeOfflineTrack('fm', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('op1.env.a.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.machine.getParam('op1.env.a.bpmCount32') === 8, 'count round-trip');
    assert.ok(t2.machine.getParam('op2.env.r.bpmCount32') === 4, 'op2 count round-trip');

    // Back-compat: a legacy FM project with no sync keys defaults to ms mode.
    const { track: t3 } = await makeOfflineTrack('fm', 0.1);
    t3.machine.fromJSON({ type: 'fm', params: { 'op1.env.a': 0.02 } });
    assert.ok(t3.machine.getParam('op1.env.a.syncMode') === 'ms', 'missing syncMode defaults to ms');
    assert.near(t3.machine._stageSeconds('op1', 'a'), 0.02, 1e-9, 'legacy stage = raw seconds');
  });

  test('Strings vibrato: Hz↔BPM sync resolves the vibrato LFO rate', async () => {
    const { track } = await makeOfflineTrack('strings', 0.1);   // clock 120 BPM
    const m = track.machine;
    m.setBpm(120);

    // Hz mode (default): rate is the raw Hz value.
    m.setParam('vibrato.rate', 5);
    assert.ok(m.getParam('vibrato.syncMode') === 'hz', 'defaults to hz');
    assert.near(m._effectiveVibratoHz(), 5, 1e-9, 'hz mode = raw Hz');

    // BPM mode: rate derives from the 1/32 PERIOD count (8 = 1/4 = 0.5s @120 → 2 Hz).
    m.setParam('vibrato.syncMode', 'bpm');
    m.setParam('vibrato.bpmCount32', 8);
    assert.near(m._effectiveVibratoHz(), 2, 1e-6, 'bpm mode rate from count');

    // Tempo change re-resolves live; the Hz param is untouched.
    m.setBpm(60);   // 1/4 = 1.0s → 1 Hz
    assert.near(m._effectiveVibratoHz(), 1, 1e-6, 'bpm rate follows tempo');
    assert.near(m.getParam('vibrato.rate'), 5, 1e-9, 'hz param untouched in bpm mode');

    // BPM reaches the machine through the track plumbing.
    track.onBpmChanged(120);
    assert.near(track.machine._effectiveVibratoHz(), 2, 1e-6, 'track BPM reaches strings machine');

    // Round-trip the sync params; legacy project (no keys) defaults to hz.
    const json = m.toJSON();
    const { track: t2 } = await makeOfflineTrack('strings', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('vibrato.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.machine.getParam('vibrato.bpmCount32') === 8, 'count round-trip');

    const { track: t3 } = await makeOfflineTrack('strings', 0.1);
    t3.machine.fromJSON({ type: 'strings', params: { 'vibrato.rate': 7 } });
    assert.ok(t3.machine.getParam('vibrato.syncMode') === 'hz', 'missing syncMode defaults to hz');
    assert.near(t3.machine._effectiveVibratoHz(), 7, 1e-9, 'legacy rate = raw Hz');
  });

  test('WT-sampler sweep: Hz↔BPM sync resolves the sweep LFO rate', async () => {
    const { track } = await makeOfflineTrack('wt-sampler', 0.1);   // clock 120 BPM
    const m = track.machine;
    m.setBpm(120);

    m.setParam('sweep.speed', 4);
    assert.ok(m.getParam('sweep.syncMode') === 'hz', 'defaults to hz');
    assert.near(m._effectiveSweepHz(), 4, 1e-9, 'hz mode = raw Hz');

    m.setParam('sweep.syncMode', 'bpm');
    m.setParam('sweep.bpmCount32', 8);     // 1/4 = 0.5s @120 → 2 Hz
    assert.near(m._effectiveSweepHz(), 2, 1e-6, 'bpm mode rate from count');

    m.setBpm(60);                          // 1/4 = 1.0s → 1 Hz
    assert.near(m._effectiveSweepHz(), 1, 1e-6, 'bpm rate follows tempo');
    assert.near(m.getParam('sweep.speed'), 4, 1e-9, 'hz param untouched in bpm mode');

    track.onBpmChanged(120);
    assert.near(track.machine._effectiveSweepHz(), 2, 1e-6, 'track BPM reaches wt-sampler machine');

    const json = m.toJSON();
    const { track: t2 } = await makeOfflineTrack('wt-sampler', 0.1);
    t2.machine.fromJSON(json);
    assert.ok(t2.machine.getParam('sweep.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.machine.getParam('sweep.bpmCount32') === 8, 'count round-trip');

    const { track: t3 } = await makeOfflineTrack('wt-sampler', 0.1);
    t3.machine.fromJSON({ type: 'wt-sampler', params: { 'sweep.speed': 6 } });
    assert.ok(t3.machine.getParam('sweep.syncMode') === 'hz', 'missing syncMode defaults to hz');
    assert.near(t3.machine._effectiveSweepHz(), 6, 1e-9, 'legacy rate = raw Hz');
  });

  test('Chorus FX: Hz↔BPM sync resolves the LFO rate (period→Hz)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.1);   // clock 120 BPM
    const ch = track.chorusFX;
    ch.setBpm(120);

    ch.setParam('chorus.rate', 0.55);
    assert.ok(ch.getParam('chorus.syncMode') === 'hz', 'defaults to hz');
    assert.near(ch._effectiveRateHz(), 0.55, 1e-9, 'hz mode = raw Hz');

    // BPM mode: count is the PERIOD. 16 = 1/2 = 1.0s @120 → 1 Hz.
    ch.setParam('chorus.syncMode', 'bpm');
    ch.setParam('chorus.bpmCount32', 16);
    assert.near(ch._effectiveRateHz(), 1, 1e-6, 'bpm mode rate from period count');

    ch.setBpm(60);   // 1/2 = 2.0s → 0.5 Hz
    assert.near(ch._effectiveRateHz(), 0.5, 1e-6, 'bpm rate follows tempo');
    assert.near(ch.getParam('chorus.rate'), 0.55, 1e-9, 'hz param untouched in bpm mode');

    // BPM reaches the chorus through the track plumbing.
    track.onBpmChanged(120);
    assert.near(track.chorusFX._effectiveRateHz(), 1, 1e-6, 'track BPM reaches chorus');

    // Round-trip; legacy project (no keys) defaults to hz.
    const json = ch.toJSON();
    const { track: t2 } = await makeOfflineTrack('synth', 0.1);
    t2.chorusFX.fromJSON(json);
    assert.ok(t2.chorusFX.getParam('chorus.syncMode') === 'bpm', 'syncMode round-trip');
    assert.ok(t2.chorusFX.getParam('chorus.bpmCount32') === 16, 'count round-trip');

    const { track: t3 } = await makeOfflineTrack('synth', 0.1);
    t3.chorusFX.fromJSON({ params: { 'chorus.rate': 2 }, enabled: false });
    assert.ok(t3.chorusFX.getParam('chorus.syncMode') === 'hz', 'missing syncMode defaults to hz');
    assert.near(t3.chorusFX._effectiveRateHz(), 2, 1e-9, 'legacy rate = raw Hz');
  });

});
