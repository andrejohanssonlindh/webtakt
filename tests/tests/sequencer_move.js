/**
 * sequencer_move.js
 * -----------------
 * Sequencer.moveStep — single-trigger MOVE with collision-push and pattern-wide
 * wrap. Drives the TRIG ◀ MOVE / MOVE ▶ buttons and the ArrowLeft/Right keybind.
 *
 * Model (see Sequencer.moveStep):
 *   - empty adjacent slot  → trigger slides in; other notes untouched
 *   - occupied adjacent    → contiguous run pushed by one until the first gap
 *   - wrap at stepCount    → last ↔ first, never page-local
 */

import { suite, test, assert, makeOfflineTrack } from '../runner.js';

/** Lay a fresh pattern: `actives` is a list of indices to activate. */
function setPattern(seq, count, actives) {
  seq.stepCount = count;
  for (let i = 0; i < count; i++) {
    const s = seq.steps[i];
    s.active = actives.includes(i);
    s.voices = [{ note: 60 + i, velocity: 100, length: 1, nudge: 0 }];  // unique note tags identity
  }
}

/** Indices of active steps, in order, as a comparable string. */
function activeIdx(seq) {
  const out = [];
  for (let i = 0; i < seq.stepCount; i++) if (seq.steps[i].active) out.push(i);
  return out.join(',');
}

/** assert two active-index lists match (arrays or comparable strings). */
function sameActive(seq, expected, msg) {
  assert.ok(activeIdx(seq) === expected.join(','),
    `${msg}: got [${activeIdx(seq)}], expected [${expected.join(',')}]`);
}

suite('Sequencer.moveStep', () => {
  test('empty adjacent slot: trigger slides in, neighbours untouched', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    // (A)()()(B)  → move A right → ()(A)()(B). B must NOT move.
    setPattern(seq, 4, [0, 3]);
    const bNote = seq.steps[3].note;

    const to = seq.moveStep(0, +1);
    assert.ok(to === 1, 'A moved to slot 1');
    sameActive(seq, [1, 3], 'A→1, B stays at 3');
    assert.ok(seq.steps[3].note === bNote, 'B untouched (still its own note)');
    assert.ok(seq.steps[0].active === false, 'origin slot is now empty');
  });

  test('left/right symmetry: moving left also leaves a far note alone', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    // (A)()()(B) → move B LEFT → (A)()(B)(). A must NOT move (regression: left used
    // to drag the far note).
    setPattern(seq, 4, [0, 3]);
    const aNote = seq.steps[0].note;

    const to = seq.moveStep(3, -1);
    assert.ok(to === 2, 'B moved to slot 2');
    sameActive(seq, [0, 2], 'A stays at 0, B→2');
    assert.ok(seq.steps[0].note === aNote, 'A untouched');
  });

  test('occupied adjacent: push the contiguous run by one', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    // (A)(B)()() → move A right → ()(A)(B)(). A and B both shift; gap absorbs it.
    setPattern(seq, 4, [0, 1]);
    const aNote = seq.steps[0].note, bNote = seq.steps[1].note;

    const to = seq.moveStep(0, +1);
    assert.ok(to === 1, 'A moved to slot 1');
    sameActive(seq, [1, 2], 'A→1, B pushed to 2');
    assert.ok(seq.steps[1].note === aNote && seq.steps[2].note === bNote, 'identities preserved through push');
  });

  test('push stops at the first gap (steps beyond it never move)', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    // (A)(B)()(C) → move A right → ()(A)(B)(C). C is past the gap → must stay.
    setPattern(seq, 4, [0, 1, 3]);
    const cNote = seq.steps[3].note;

    seq.moveStep(0, +1);
    sameActive(seq, [1, 2, 3], 'A→1, B→2, C stays at 3');
    assert.ok(seq.steps[3].note === cNote, 'C beyond the gap is untouched');
  });

  test('wrap at pattern boundary (last → first), 16 steps', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    setPattern(seq, 16, [15]);                 // a single note on step 16
    const to = seq.moveStep(15, +1);
    assert.ok(to === 0, 'step 16 wraps to step 1 on a 16-step pattern');
    sameActive(seq, [0], 'note now on step 1');
  });

  test('no wrap mid-pattern: step 16 → 17 on a 32-step pattern', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    setPattern(seq, 32, [15]);                 // note on step 16 (index 15)
    const to = seq.moveStep(15, +1);
    assert.ok(to === 16, 'step 16 advances to step 17 (no page wrap)');
    sameActive(seq, [16], 'note now on step 17');
  });

  test('full pattern in that direction is a no-op', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    setPattern(seq, 4, [0, 1, 2, 3]);          // every slot occupied
    const to = seq.moveStep(0, +1);
    assert.ok(to === 0, 'no empty slot ahead → move is a no-op');
    sameActive(seq, [0, 1, 2, 3], 'pattern unchanged');
  });

  test('shiftAll rotates the whole pattern with wrap-around', async () => {
    const { track } = await makeOfflineTrack('synth', 0.05);
    const seq = track.sequencer;
    // (A)()(B)() → shift right → ()(A)()(B); shift left from there → back.
    setPattern(seq, 4, [0, 2]);
    seq.shiftAll(+1);
    sameActive(seq, [1, 3], 'right shift moves every note one slot up');
    seq.shiftAll(-1);
    sameActive(seq, [0, 2], 'left shift is the inverse');

    // Wrap: a note on the last step rotates to the first on a right shift.
    setPattern(seq, 4, [3]);
    seq.shiftAll(+1);
    sameActive(seq, [0], 'last step wraps to first');
  });
});
