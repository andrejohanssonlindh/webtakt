/**
 * Scales.js
 * ---------
 * Scale definitions and utility helpers.
 * Each scale is a sorted array of semitone intervals (0–11) relative to the root.
 * 0 = chromatic (no filtering).
 */

export const SCALE_DEFS = [
  { label: 'Chromatic',         intervals: [0,1,2,3,4,5,6,7,8,9,10,11] },
  { label: 'Major',             intervals: [0,2,4,5,7,9,11] },
  { label: 'Natural Minor',     intervals: [0,2,3,5,7,8,10] },
  { label: 'Harmonic Minor',    intervals: [0,2,3,5,7,8,11] },
  { label: 'Melodic Minor',     intervals: [0,2,3,5,7,9,11] },
  { label: 'Dorian',            intervals: [0,2,3,5,7,9,10] },
  { label: 'Phrygian',          intervals: [0,1,3,5,7,8,10] },
  { label: 'Lydian',            intervals: [0,2,4,6,7,9,11] },
  { label: 'Mixolydian',        intervals: [0,2,4,5,7,9,10] },
  { label: 'Locrian',           intervals: [0,1,3,5,6,8,10] },
  { label: 'Pentatonic Major',  intervals: [0,2,4,7,9] },
  { label: 'Pentatonic Minor',  intervals: [0,3,5,7,10] },
  { label: 'Blues',             intervals: [0,3,5,6,7,10] },
  { label: 'Whole Tone',        intervals: [0,2,4,6,8,10] },
  { label: 'Diminished',        intervals: [0,2,3,5,6,8,9,11] },
  { label: 'Augmented',         intervals: [0,3,4,7,8,11] },
  { label: 'Hungarian Minor',   intervals: [0,2,3,6,7,8,11] },
  { label: 'Phrygian Dominant', intervals: [0,1,4,5,7,8,10] },
  { label: 'Arabian',           intervals: [0,2,4,5,6,8,10] },
  { label: 'Japanese',          intervals: [0,1,5,7,8] },
];

/**
 * Returns true when `midiNote` belongs to the given scale/root.
 * @param {number} midiNote
 * @param {number} scaleName   — index into SCALE_DEFS (0 = chromatic)
 * @param {number} leadNote    — MIDI root note (0–11 used as pitch class)
 */
export function noteInScale(midiNote, scaleIndex, leadNote) {
  const def = SCALE_DEFS[scaleIndex];
  if (!def || scaleIndex === 0) return true;  // chromatic = all pass
  const pitchClass = ((midiNote - leadNote) % 12 + 12) % 12;
  return def.intervals.includes(pitchClass);
}

/**
 * Snap `midiNote` to the nearest note that belongs to the given scale/root.
 * Chromatic (scaleIndex 0) and unknown scales pass the note through unchanged.
 * Ties (a note exactly between two scale tones) resolve upward. Used by the
 * random arpeggiator so a selected scale constrains the rolled notes.
 * @param {number} midiNote
 * @param {number} scaleIndex — index into SCALE_DEFS (0 = chromatic)
 * @param {number} leadNote   — MIDI root note (pitch class 0–11 used)
 * @returns {number} an in-scale MIDI note (clamped 0–127)
 */
export function snapToScale(midiNote, scaleIndex, leadNote) {
  const def = SCALE_DEFS[scaleIndex];
  if (!def || scaleIndex === 0) return midiNote;
  if (noteInScale(midiNote, scaleIndex, leadNote)) return midiNote;
  // Search outward (±1, ±2 …) for the closest in-scale note; +d preferred on ties.
  for (let d = 1; d <= 12; d++) {
    const up = midiNote + d;
    if (up <= 127 && noteInScale(up, scaleIndex, leadNote)) return up;
    const down = midiNote - d;
    if (down >= 0 && noteInScale(down, scaleIndex, leadNote)) return down;
  }
  return midiNote;
}

/** Note names for the lead-note knob display */
export const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
