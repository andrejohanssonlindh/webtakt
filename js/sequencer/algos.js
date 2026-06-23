/**
 * algos.js
 * --------
 * Pure, DOM-free pattern generators for the GEN tab. Each function takes plain
 * parameters and returns plain arrays — no Step, no Track, no audio. The GenPanel
 * is the only caller; it maps these outputs onto the track's Step[] model. Kept
 * pure so they unit-test deterministically (seeded RNG, no Web Audio) per the
 * test-noise-determinism convention.
 *
 *   euclid(pulses, steps, rotate)            → boolean[steps]   (hit pattern)
 *   turingBits(length, randomness, prev, rng)→ boolean[length]  (shift register)
 *   markovNotes(length, degrees, table, rng) → number[length]   (scale-degree indices)
 *   cellularRow(prev, rule)                  → boolean[width]    (elementary CA step)
 *
 * The evolving generators (turing/markov/cellular) take the previous state so the
 * caller can step them forward each bar; pass an empty/seed state for the first.
 */

/** mulberry32 — small, fast, seedable PRNG. Returns a function → [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Euclidean rhythm — distribute `pulses` hits as evenly as possible across
 * `steps` slots, then rotate. Bjorklund's algorithm via the "bucket" method.
 * @param {number} pulses  number of hits (clamped 0..steps)
 * @param {number} steps   pattern length (>=1)
 * @param {number} rotate  left-rotation in steps (any integer; wraps)
 * @returns {boolean[]} length === steps
 */
export function euclid(pulses, steps, rotate = 0) {
  const n = Math.max(1, steps | 0);
  const k = Math.max(0, Math.min(n, pulses | 0));
  const out = new Array(n).fill(false);
  if (k === 0) return out;
  if (k === n) return out.fill(true);
  // Bresenham-style even distribution: a hit lands wherever the running
  // accumulator rolls over. Gives the canonical Euclidean spacing.
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) { bucket -= n; out[i] = true; }
  }
  // Rotate left by `rotate` (wrap). Negative rotates right.
  const r = ((rotate % n) + n) % n;
  if (r === 0) return out;
  return out.slice(r).concat(out.slice(0, r));
}

/**
 * Turing-machine shift register. The bit array loops; each step a bit may flip
 * with probability `randomness` (0 = locked loop, 1 = fully random each pass).
 * @param {number} length     register length (>=1)
 * @param {number} randomness  0..1 flip probability per bit
 * @param {boolean[]|null} prev previous bits (regenerated/seeded if missing or wrong length)
 * @param {() => number} rng   RNG in [0,1)
 * @returns {boolean[]} new bits, length === length
 */
export function turingBits(length, randomness, prev, rng) {
  const n = Math.max(1, length | 0);
  let bits = (Array.isArray(prev) && prev.length === n)
    ? prev.slice()
    : Array.from({ length: n }, () => rng() < 0.5);
  for (let i = 0; i < n; i++) {
    if (rng() < randomness) bits[i] = !bits[i];
  }
  return bits;
}

/**
 * Markov note walk over scale-degree indices. `table[i]` is an array of weights
 * for moving from degree i to each degree j (length === degrees). A first-order
 * chain; the caller supplies the table (or use defaultMarkovTable below).
 * @param {number} length    number of notes to emit (>=1)
 * @param {number} degrees   number of distinct degrees (>=1)
 * @param {number[][]} table degrees×degrees transition weights
 * @param {() => number} rng  RNG in [0,1)
 * @param {number} start     starting degree index
 * @returns {number[]} degree indices, length === length
 */
export function markovNotes(length, degrees, table, rng, start = 0) {
  const n = Math.max(1, length | 0);
  const d = Math.max(1, degrees | 0);
  const out = new Array(n);
  let cur = Math.max(0, Math.min(d - 1, start | 0));
  for (let i = 0; i < n; i++) {
    out[i] = cur;
    const row = table[cur] ?? [];
    let total = 0;
    for (let j = 0; j < d; j++) total += row[j] ?? 0;
    if (total <= 0) { cur = (cur + 1) % d; continue; }  // degenerate row → walk up
    let roll = rng() * total;
    let next = d - 1;
    for (let j = 0; j < d; j++) {
      roll -= row[j] ?? 0;
      if (roll < 0) { next = j; break; }
    }
    cur = next;
  }
  return out;
}

/**
 * A reasonable default transition table over `degrees` degrees: favours staying
 * put or stepping ±1, with a small chance of a leap. Symmetric and self-scaling.
 */
export function defaultMarkovTable(degrees) {
  const d = Math.max(1, degrees | 0);
  const table = [];
  for (let i = 0; i < d; i++) {
    const row = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
      const dist = Math.abs(i - j);
      row[j] = dist === 0 ? 3 : dist === 1 ? 4 : dist === 2 ? 1 : 0.3;
    }
    table.push(row);
  }
  return table;
}

/**
 * One step of an elementary cellular automaton (Wolfram). Each cell's next state
 * is decided by the 8-bit `rule` keyed on (left, self, right). Edges wrap.
 * @param {boolean[]} prev  current row (>=1 wide)
 * @param {number} rule     0..255 (e.g. 110, 90, 30)
 * @returns {boolean[]} next row, same width
 */
export function cellularRow(prev, rule) {
  const n = prev.length;
  if (n === 0) return [];
  const r = rule & 0xff;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const l = prev[(i - 1 + n) % n] ? 1 : 0;
    const c = prev[i] ? 1 : 0;
    const rt = prev[(i + 1) % n] ? 1 : 0;
    const idx = (l << 2) | (c << 1) | rt;       // 0..7
    out[i] = ((r >> idx) & 1) === 1;
  }
  return out;
}

/** A single-centre-cell seed row of the given width (classic CA starting point). */
export function cellularSeed(width) {
  const n = Math.max(1, width | 0);
  const row = new Array(n).fill(false);
  row[n >> 1] = true;
  return row;
}

/**
 * Default per-track GEN config (see Track.gen). The generator is built from TWO
 * independent layers:
 *   rhythm — which steps fire     ('off' = hand-edited; leave Step[] alone)
 *   pitch  — what note each active step plays
 * So e.g. rhythm:'euclid' + pitch:'markov' = a Euclidean groove whose notes wander
 * musically; rhythm:'all' + pitch:'markov' = a note on every step. The GenPanel
 * mutates these fields and re-runs on change; the evolving state (`prevBits` /
 * `prevRow` / markov walk) is runtime-only and not persisted (reseeded on load).
 */
export function makeDefaultGen() {
  return {
    rhythm:    'off',       // 'off' (manual) | 'all' | 'euclid' | 'turing' | 'cellular'
    pitch:     'fixed',     // 'fixed' | 'scale' | 'markov'
    seed:      1,           // RNG seed for the evolving layers (deterministic regen)
    regen:     false,       // re-run each bar (evolving rhythm/pitch)
    baseNote:  60,          // MIDI note for fixed mode / scale + markov origin
    velocity:  100,         // hit velocity
    // Euclidean rhythm
    pulses:    4,
    steps:     16,
    rotate:    0,
    // Turing rhythm
    tLength:   16,
    randomness: 0.15,
    // Cellular rhythm
    rule:      110,
    // Markov pitch
    mLength:   16,
    degrees:   5,
  };
}
