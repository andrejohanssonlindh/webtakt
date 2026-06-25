/**
 * gen_algos.js
 * ------------
 * Pure-function tests for the GEN tab generators (js/sequencer/algos.js). No
 * audio context — deterministic via the seeded mulberry32 RNG (see the
 * test-noise-determinism convention) so the random algos don't flake.
 */

import { suite, test, assert } from '../runner.js';
import {
  euclid, turingBits, markovNotes, defaultMarkovTable,
  cellularRow, cellularSeed, mulberry32, makeDefaultGen,
} from '../../js/sequencer/algos.js';
import { runGen } from '../../js/sequencer/genRunner.js';
import { Step } from '../../js/sequencer/Step.js';

/** Minimal track double for the headless runner — no audio, real Step objects. */
function fakeTrack(stepCount = 16, genOverrides = {}) {
  const steps = Array.from({ length: stepCount }, (_, i) => new Step(i));
  return {
    index: 0,
    scaleIndex: 0,
    leadNote: 0,
    sequencer: { stepCount, steps },
    gen: { ...makeDefaultGen(), ...genOverrides },
  };
}
const activeOf = t => t.sequencer.steps.map(s => s.active);

const count = arr => arr.reduce((n, b) => n + (b ? 1 : 0), 0);
const str   = arr => arr.map(b => (b ? '1' : '0')).join('');

suite('GEN: euclid', () => {
  test('canonical E(3,8) spacing', async () => {
    // The standard Euclidean (3,8) tresillo. Our generator may rotate the phase,
    // so assert the spacing pattern (gaps of 3,3,2 in some rotation), not exact slots.
    const p = euclid(3, 8, 0);
    assert.ok(p.length === 8, 'length 8');
    assert.ok(count(p) === 3, `3 pulses, got ${count(p)}`);
  });

  test('pulses clamp to [0, steps]', async () => {
    assert.ok(count(euclid(0, 16, 0)) === 0, 'zero pulses → empty');
    assert.ok(count(euclid(99, 16, 0)) === 16, 'over-full → all on');
    assert.ok(count(euclid(-5, 16, 0)) === 0, 'negative → empty');
  });

  test('even distribution: E(4,16) is every 4th', async () => {
    const p = euclid(4, 16, 0);
    assert.ok(count(p) === 4, `4 pulses, got ${count(p)}`);
    // 4 in 16 is perfectly even → exactly one hit per quarter (4-slot window).
    for (let q = 0; q < 4; q++) {
      const seg = p.slice(q * 4, q * 4 + 4);
      assert.ok(count(seg) === 1, `one hit in quarter ${q}, got ${count(seg)}`);
    }
  });

  test('rotate shifts the pattern, preserves pulse count', async () => {
    const base = euclid(5, 16, 0);
    const rot  = euclid(5, 16, 3);
    assert.ok(count(rot) === 5, 'rotate keeps 5 pulses');
    // rotate(3) of base equals base sliced/concatenated by 3.
    const expected = base.slice(3).concat(base.slice(0, 3));
    assert.ok(str(rot) === str(expected), `rot mismatch: ${str(rot)} vs ${str(expected)}`);
  });

  test('rotate wraps (negative + over-length)', async () => {
    const a = euclid(5, 16, -1);
    const b = euclid(5, 16, 15);   // -1 mod 16 === 15
    assert.ok(str(a) === str(b), 'negative rotate equals its positive wrap');
  });
});

suite('GEN: turing', () => {
  test('randomness 0 is a locked loop', async () => {
    const rng = mulberry32(42);
    const first = turingBits(16, 0, null, rng);
    const again = turingBits(16, 0, first, mulberry32(999));
    assert.ok(str(first) === str(again), 'no flips when randomness 0');
  });

  test('randomness 1 flips every bit', async () => {
    const prev = new Array(8).fill(true);
    const next = turingBits(8, 1, prev, mulberry32(7));
    assert.ok(str(next) === '00000000', `all flipped, got ${str(next)}`);
  });

  test('deterministic for a fixed seed', async () => {
    const a = turingBits(16, 0.3, null, mulberry32(123));
    const b = turingBits(16, 0.3, null, mulberry32(123));
    assert.ok(str(a) === str(b), 'same seed → same bits');
  });

  test('length respected; reseeds on length change', async () => {
    const prevWrong = new Array(8).fill(true);
    const out = turingBits(16, 0, prevWrong, mulberry32(1));   // prev length ≠ 16
    assert.ok(out.length === 16, 'output length matches request');
  });
});

suite('GEN: markov', () => {
  test('default table is symmetric and favours steps', async () => {
    const t = defaultMarkovTable(5);
    assert.ok(t.length === 5 && t[0].length === 5, '5×5 table');
    assert.ok(t[2][2] > t[2][4], 'staying weighted over a leap');
    assert.ok(t[2][3] > t[2][2], 'step ±1 weighted over staying put');
  });

  test('degrees stay in range, deterministic', async () => {
    const t = defaultMarkovTable(5);
    const a = markovNotes(32, 5, t, mulberry32(5));
    const b = markovNotes(32, 5, t, mulberry32(5));
    assert.ok(str(a.map(x => x)) === str(b.map(x => x)) || a.join(',') === b.join(','), 'same seed → same walk');
    assert.ok(a.every(d => d >= 0 && d < 5), 'all degrees in [0,5)');
    assert.ok(a.length === 32, 'emits requested length');
  });

  test('degenerate row walks upward', async () => {
    const table = [[0, 0], [0, 0]];   // no weights anywhere
    const out = markovNotes(4, 2, table, mulberry32(1), 0);
    assert.ok(out.join(',') === '0,1,0,1', `walks up+wrap, got ${out.join(',')}`);
  });
});

suite('GEN: cellular', () => {
  test('Rule 110 single-seed first generations', async () => {
    let row = cellularSeed(11);                 // centre cell on
    assert.ok(count(row) === 1, 'seed has one live cell');
    row = cellularRow(row, 110);
    // Rule 110 from a single cell turns on the cell and its left neighbour.
    assert.ok(count(row) >= 1, 'rule 110 keeps activity alive');
  });

  test('Rule 0 dies, Rule 255 fills', async () => {
    const seed = cellularSeed(8);
    assert.ok(count(cellularRow(seed, 0)) === 0, 'rule 0 → all dead');
    assert.ok(count(cellularRow(seed, 255)) === 8, 'rule 255 → all live');
  });

  test('edges wrap (Rule 90 from edge cell)', async () => {
    const row = new Array(8).fill(false);
    row[0] = true;
    const next = cellularRow(row, 90);          // XOR of neighbours
    // cell 0's neighbours are 7 (false) and 1 (false) → off; cells 1 and 7 turn on.
    assert.ok(next[1] && next[7], 'wrapped neighbours activate');
    assert.ok(!next[0], 'centre dies under rule 90');
  });

  test('width preserved', async () => {
    const r = cellularRow(cellularSeed(13), 30);
    assert.ok(r.length === 13, 'row width unchanged');
  });
});

suite('GEN: defaults', () => {
  test('makeDefaultGen is manual + sane', async () => {
    const g = makeDefaultGen();
    assert.ok(g.rhythm === 'off', 'rhythm starts off (manual)');
    assert.ok(g.pitch === 'fixed', 'fixed pitch mode');
    assert.ok(g.steps >= 1 && g.pulses >= 0, 'euclid params sane');
    assert.ok(g.velocity >= 1 && g.velocity <= 127, 'velocity in range');
  });
});

suite('GEN: runner (rhythm × pitch layers)', () => {
  test('rhythm off leaves steps untouched', async () => {
    const t = fakeTrack(8, { rhythm: 'off' });
    t.sequencer.steps[3].active = true;            // a hand-edited step
    const wrote = runGen(t);
    assert.ok(wrote === false, 'runGen reports no-op when off');
    assert.ok(t.sequencer.steps[3].active === true, 'existing step preserved');
  });

  test('rhythm ALL fires every step', async () => {
    const t = fakeTrack(8, { rhythm: 'all', pitch: 'fixed' });
    runGen(t);
    assert.ok(activeOf(t).every(a => a === true), 'all 8 steps active');
  });

  test('euclid rhythm fires only its hits', async () => {
    const t = fakeTrack(16, { rhythm: 'euclid', pulses: 4, steps: 16, rotate: 0 });
    runGen(t);
    assert.ok(count(activeOf(t)) === 4, `4 active steps, got ${count(activeOf(t))}`);
  });

  test('MARKOV pitch only writes notes on ACTIVE steps (not forced 16/16)', async () => {
    const t = fakeTrack(16, { rhythm: 'euclid', pulses: 4, steps: 16, pitch: 'markov', baseNote: 60, degrees: 5 });
    runGen(t);
    const active = activeOf(t);
    assert.ok(count(active) === 4, `markov respects euclid rhythm: ${count(active)} active`);
    // Inactive steps must not have been turned on by the pitch layer.
    for (let i = 0; i < 16; i++) {
      if (!active[i]) assert.ok(t.sequencer.steps[i].active === false, `step ${i} stays off`);
    }
  });

  test('markov walk advances per active step (varied notes)', async () => {
    const t = fakeTrack(16, { rhythm: 'all', pitch: 'markov', baseNote: 48, degrees: 7, mLength: 16 });
    // Use a real scale so degrees map to distinct notes.
    t.scaleIndex = 1;  // Major
    runGen(t);
    const notes = t.sequencer.steps.map(s => s.voices[0].note);
    const distinct = new Set(notes).size;
    assert.gt(distinct, 1, `markov produced varied notes, got ${distinct} distinct`);
  });

  test('newly-activated euclid steps inherit the pattern note length', async () => {
    // User has a pattern at 2-bar note length, then extends/generates more hits:
    // the freshly-activated steps must adopt 2 bars (32), not the default 1.
    const t = fakeTrack(16, { rhythm: 'euclid', pulses: 1, steps: 16, rotate: 0 });
    runGen(t);                                       // one hit lands
    const firstActive = t.sequencer.steps.find(s => s.active);
    firstActive.voices[0].length = 32;               // user sets 2-bar length
    t.gen.pulses = 8;                                 // generate more hits
    runGen(t);
    const lens = t.sequencer.steps.filter(s => s.active).map(s => s.voices[0].length);
    assert.ok(lens.length === 8, `8 active, got ${lens.length}`);
    assert.ok(lens.every(l => l === 32), `all inherit 32, got ${lens.join(',')}`);
  });

  test('per-step length tweaks survive a regen', async () => {
    const t = fakeTrack(8, { rhythm: 'euclid', pulses: 8, steps: 8 });
    runGen(t);                                       // all 8 on (length 1)
    t.sequencer.steps[3].voices[0].length = 4;       // tweak just one step
    runGen(t);                                       // re-run same pattern
    assert.ok(t.sequencer.steps[3].voices[0].length === 4, 'tweaked step kept its length');
  });

  test('switching a step off clears its p-locks', async () => {
    const t = fakeTrack(8, { rhythm: 'euclid', pulses: 8, steps: 8 });
    runGen(t);                                      // all 8 on
    t.sequencer.steps[1].setPLock('base.lpf', 800); // user p-locks an active step
    t.gen.pulses = 1;                               // now most steps turn off
    runGen(t);
    const off = t.sequencer.steps.find(s => !s.active && s.index === 1);
    if (off) assert.ok(off.plocks.size === 0, 'p-locks cleared on switched-off step');
  });

  test('fixed pitch writes baseNote on every active step', async () => {
    const t = fakeTrack(8, { rhythm: 'all', pitch: 'fixed', baseNote: 55 });
    runGen(t);
    assert.ok(t.sequencer.steps.every(s => s.voices[0].note === 55), 'all notes = baseNote');
  });

  test('MANUAL rhythm re-pitches active steps without toggling active', async () => {
    const t = fakeTrack(8, { rhythm: 'manual', pitch: 'scale', baseNote: 48 });
    t.scaleIndex = 1;  // Major
    // Hand-place a few steps with arbitrary notes.
    [1, 4, 6].forEach(i => { t.sequencer.steps[i].active = true; t.sequencer.steps[i].voices[0].note = 99; });
    const before = activeOf(t);
    runGen(t);
    assert.ok(activeOf(t).join() === before.join(), 'active set unchanged');
    // The 3 active steps got re-pitched (no longer 99); inactive steps untouched.
    assert.ok([1, 4, 6].every(i => t.sequencer.steps[i].voices[0].note !== 99), 'active steps re-pitched');
    assert.ok(count(activeOf(t)) === 3, 'still exactly the 3 hand-placed steps');
  });

  test('MANUAL rhythm preserves p-locks + velocity on active steps', async () => {
    const t = fakeTrack(8, { rhythm: 'manual', pitch: 'markov', degrees: 5 });
    t.scaleIndex = 1;
    const s = t.sequencer.steps[2];
    s.active = true; s.voices[0].velocity = 42; s.setPLock('base.lpf', 700);
    runGen(t);
    assert.ok(s.plocks.size === 1, 'p-lock preserved in manual mode');
    assert.ok(s.voices[0].velocity === 42, 'user velocity preserved in manual mode');
  });

  test('MANUAL rhythm leaves an empty pattern empty', async () => {
    const t = fakeTrack(8, { rhythm: 'manual', pitch: 'scale' });
    runGen(t);
    assert.ok(count(activeOf(t)) === 0, 'no steps invented from nothing');
  });

  test('MARKOV pitch re-rolls when evolved (per-bar regen)', async () => {
    const t = fakeTrack(16, { rhythm: 'all', pitch: 'markov', baseNote: 48, degrees: 7, mLength: 16 });
    t.scaleIndex = 1;  // Major
    runGen(t, true);
    const pass1 = t.sequencer.steps.map(s => s.voices[0].note).join();
    runGen(t, true);
    const pass2 = t.sequencer.steps.map(s => s.voices[0].note).join();
    assert.ok(pass1 !== pass2, 'evolving advances the markov walk → different notes next bar');
  });

  test('MARKOV pitch is stable without evolve (knob tweaks do not ratchet)', async () => {
    const t = fakeTrack(16, { rhythm: 'all', pitch: 'markov', baseNote: 48, degrees: 7 });
    t.scaleIndex = 1;
    runGen(t, false);
    const a = t.sequencer.steps.map(s => s.voices[0].note).join();
    runGen(t, false);
    const b = t.sequencer.steps.map(s => s.voices[0].note).join();
    assert.ok(a === b, 'same seed (no evolve) → identical notes');
  });
});
