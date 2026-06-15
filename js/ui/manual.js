/**
 * manual.js
 * ---------
 * Tier-1 in-app manual. Content lives here, centralized and keyed by tab name,
 * NOT scattered as `description` fields across every component. The 📖 button
 * in the transport bar opens the overlay for the active tab.
 *
 * MAINTENANCE RULE: if you add, remove, or change controls in any panel or
 * machine, update the matching entry in MANUAL_CONTENT or MACHINE_MANUAL here.
 *
 * To document a tab, add an entry to MANUAL_CONTENT below:
 *
 *   tabKey: {
 *     title: 'HUMAN TITLE',
 *     blurb: 'One or two sentences on what this tab is for.',
 *     items: [
 *       ['CONTROL NAME', 'What it does, in plain language.'],
 *       ...
 *     ],
 *   }
 *
 * Tabs without an entry simply show a "not yet documented" placeholder, so the
 * help affordance can ship before every section is written.
 *
 * SYNTH tab is special: its controls change per machine type. So in addition to
 * the generic `synth` entry in MANUAL_CONTENT (the fallback), per-machine
 * sections live in MACHINE_MANUAL, keyed by machine type (e.g. 'moogish',
 * 'fm'). When the SYNTH tab help opens, the overlay prefers the loaded
 * machine's entry and falls back to the generic one. Same `{ title, blurb,
 * items }` shape either way.
 */

export const MANUAL_CONTENT = {
  filter: {
    title: 'FILTER',
    blurb: 'Shapes the timbre by removing frequencies. The big knobs drive a ' +
           'single sweepable filter; the response curve shows the result live. ' +
           'A dedicated envelope can move the cutoff over the life of each note.',
    items: [
      ['ANALOGUE / DIGITAL', 'Switches the whole filter engine. DIGITAL is the ' +
                 'clean default. ANALOGUE swaps in a Moog-style 4-pole ladder ' +
                 '(fixed 24 dB/oct) with RC drift and saturation for a warmer, ' +
                 'less precise character — it also routes the track through the ' +
                 'analogue chain (BBD chorus). On ANALOGUE the SLOPE knob is ' +
                 'disabled (the ladder is fixed-slope) and DRIVE / DRIFT / ' +
                 'KEYTRK appear; "peaking" type has no ladder equivalent and ' +
                 'falls back to low-pass.'],
      ['TYPE',   'Filter character: low-pass (keeps lows), high-pass (keeps ' +
                 'highs), band-pass, notch, etc. Sets what the CUTOFF knob sweeps. ' +
                 'On the analogue ladder these are produced by Oberheim ' +
                 'pole-mixing.'],
      ['CUTOFF', 'The corner frequency. For a low-pass, everything above this ' +
                 'is rolled off — turn down to darken, up to brighten.'],
      ['RES',    'Resonance. Emphasises frequencies right at the cutoff. High ' +
                 'values ring or whistle and make sweeps vocal; extreme settings ' +
                 'can self-oscillate.'],
      ['GAIN',   'Output level of the filter stage. Use to tame the volume ' +
                 'boost that heavy resonance adds, or to drive the signal.'],
      ['ENV',    'Filter-envelope amount (bipolar). How far the filter ENV ' +
                 'below moves the cutoff. Positive opens the filter on attack, ' +
                 'negative closes it. At centre the envelope does nothing.'],
      ['SLOPE',  'Roll-off steepness (e.g. 12 vs 24 dB/oct). Steeper cuts ' +
                 'frequencies past the cutoff more aggressively. Digital engine ' +
                 'only — the analogue ladder is fixed at 24 dB/oct.'],
      ['DRIVE',  'Analogue only. Input saturation into the ladder. Pushes the ' +
                 'filter harder for warmth and harmonic grit; high values ' +
                 'overdrive into a fatter, dirtier tone.'],
      ['DRIFT',  'Analogue only. Adds slow random detuning of the filter\'s ' +
                 'internal stages, emulating component tolerance in real analog ' +
                 'hardware. A little adds life; more makes it unstable.'],
      ['KEYTRK', 'Analogue only. Key tracking — how much the cutoff follows the ' +
                 'played note pitch. At 100% the filter opens with higher notes, ' +
                 'keeping brightness consistent across the keyboard.'],
      ['BASE LPF / HPF', 'Always-on low-pass / high-pass applied before the ' +
                 'main filter. A fixed tone-shaping pre-stage — handy for ' +
                 'trimming sub rumble (HPF) or harsh fizz (LPF) globally.'],
      ['FILTER ENV (ADSR)', 'Attack / Decay / Sustain / Release for the cutoff ' +
                 'movement, scaled by the ENV knob. Drag the breakpoints or use ' +
                 'the knobs; a fast decay gives a classic plucky "wah".'],
      ['RESPONSE CURVE', 'Live plot of the filter\'s frequency response. ' +
                 'Reflects p-locked values when a step is selected, so you can ' +
                 'see exactly what a locked cutoff will sound like.'],
    ],
  },

  // Generic SYNTH fallback — shown when the loaded machine has no MACHINE_MANUAL
  // entry. Keep it conceptual; machine-specific detail belongs in MACHINE_MANUAL.
  synth: {
    title: 'SYNTH',
    blurb: 'The sound-generating core of the selected track. These controls ' +
           'belong to the loaded machine, so they change when you swap machines ' +
           'on the MACHINE tab — a sampler shows sample controls, an FM synth ' +
           'shows operators, and so on. Detune lives on the TRIG tab, not here. ' +
           'Open this help with a specific machine loaded for its own notes.',
    items: [],
  },

  machine: {
    title: 'MACHINE',
    blurb: 'Swap the synthesis engine on the selected track. Machines are ' +
           'grouped into Drums, Melodic, Analogue, and Sampler families. ' +
           'Click a card to commit the swap; use the ▶ preview button (on ' +
           'non-sampler cards) to audition without committing.',
    items: [
      ['Search', 'Type to filter machine names across all groups instantly.'],
      ['▶ (preview button)', 'Plays the machine\'s default sound on C4 using the ' +
                 'current track envelope. The track reverts after the release tail — ' +
                 'the swap is not committed. Samplers and MIDI have no default buffer ' +
                 'and are not previewable.'],
      ['Grouped cards', 'Cards are grouped by family (Drums / Melodic / Analogue / ' +
                 'Sampler / MIDI). Clicking a card commits the machine swap, replacing ' +
                 'the current machine and resetting its params to defaults.'],
    ],
  },

  sounds: {
    title: 'SOUNDS',
    blurb: 'Save and recall complete sound snapshots — the current machine type, ' +
           'all its params, filter, envelope, and FX chain. Use this to build a ' +
           'personal library and load favourite sounds onto any track.',
    items: [
      ['+ SAVE SOUND', 'Save the current track\'s full state (machine + filter + ' +
                 'envelope + FX) as a named sound. You will be prompted for a name.'],
      ['Tag chips', 'Filter the list to sounds with a given tag. + TAG creates a new ' +
                 'tag; tags are attached per-sound when saving. ALL shows everything.'],
      ['Sound cards', 'Each card shows the sound name and machine type. Click the card ' +
                 'to load it onto the track. Use ▶ to audition without loading.'],
      ['▶ (preview)', 'Plays a one-shot of the sound on the track without committing ' +
                 'the load. The track reverts after the release tail.'],
      ['× (delete)', 'Permanently removes the sound from the library.'],
    ],
  },

  scales: {
    title: 'SCALES',
    blurb: 'Constrains the on-screen keyboard and key-folding mode to a musical ' +
           'scale and root note. Notes outside the scale are filtered out when ' +
           'keyboard folding is on, so every key you press lands in-key.',
    items: [
      ['Scale dropdown', 'Choose a scale (major, minor, dorian, pentatonic, etc.) ' +
                 'from a searchable list. Chromatic means no constraint — all 12 ' +
                 'notes are available.'],
      ['Root (12 buttons)', 'Sets the tonic / root note of the scale. The preview ' +
                 'strip below updates immediately to show which pitches are active.'],
      ['Scale degree preview', 'Shows all 12 pitch classes; in-scale notes are ' +
                 'highlighted in amber. Useful for quickly checking which notes a ' +
                 'scale omits.'],
      ['KEYBOARD FOLD', 'When ON, the keyboard\'s a–\' / q–¨ rows map only to ' +
                 'in-scale notes in ascending order, skipping any out-of-scale ' +
                 'semitones. Makes playing in-key natural without thinking about it.'],
      ['OCT+ / OCT-', 'Shift the playable octave up/down. Bindable to keys in ' +
                 'Settings (default ↑ / ↓).'],
    ],
  },

  trig: {
    title: 'TRIG',
    blurb: 'Per-step playback parameters: how long a note lasts, how often it ' +
           'fires, where it sits in time, and what pitch it plays. Most knobs ' +
           'write a track-wide default when no step is selected, or a p-lock ' +
           'on the selected step.',
    items: [
      ['LENGTH', 'Note duration from 1/16 to 256 bars. With no step selected, sets ' +
                 'the default length for all new steps on this track.'],
      ['CHANCE', 'Probability the step fires each time the sequencer reaches it. ' +
                 '100% = always. 50% = fires half the time. Adds randomness and ' +
                 'variation without rewriting the pattern.'],
      ['DETUNE', 'Fine-tune in cents (±100¢). Shifts this step\'s pitch slightly ' +
                 'sharp or flat for subtle detuning or beating effects. Only shown ' +
                 'for machines that support osc.detune.'],
      ['TONE', 'Semitone transpose (±24). Shifts this step\'s note up or down in ' +
                 'semitone increments, independent of the keyboard note. Useful for ' +
                 'octave jumps or chord voicings baked into the pattern.'],
      ['VELOCITY', 'Note velocity (1–127). Sets how hard the step hits — most ' +
                 'machines and the envelope scale amplitude by velocity. Track-wide ' +
                 'default when no step selected; p-lockable per step.'],
      ['NUDGE', 'Step-only. Shifts this step\'s timing forward or backward within ' +
                 'its grid slot (±99%). Positive nudges it late; negative nudges it ' +
                 'early. Great for swing, groove, and humanisation.'],
      ['CONDITION', 'Step-only. Makes the step fire only on certain pattern ' +
                 'repetitions (e.g. "2:4" = fires on 2 out of every 4 passes). ' +
                 '"—" means always. Enables evolving, non-looping patterns.'],
      ['◀ SHIFT / SHIFT ▶', 'Rotate all steps in the pattern one position left or ' +
                 'right. The step that falls off one end wraps to the other.'],
      ['FILL PAGE (1/16 · 1/8 · 1/4 · 1/2)', 'Quick drum-fill. Stamps C4 onto the ' +
                 'current page at a note division: 1/16 = every step, 1/8 = every ' +
                 '2nd, 1/4 = every 4th (four-on-the-floor), 1/2 = every 8th. Pressing ' +
                 'a button again clears those steps only if all of them are already ' +
                 'active — otherwise it just fills the missing ones. So fill 1/16 ' +
                 'then 1/4 leaves notes on every step except the quarter-note hits.'],
      ['QUANTIZE', 'No-step view only. Pulls nudged steps back toward the grid ' +
                 '(0% = leave nudges as-is, 100% = snap all nudges to zero). ' +
                 'Useful for tidying a live-recorded pattern.'],
      ['NOTE FOLLOW', 'No-step view only. Makes this track\'s notes follow the pitch ' +
                 'played by another track in real time. Select a source track from ' +
                 'the dropdown; OFF disables.'],
      ['FLW DLY', 'No-step view only. Delay in ms before this track responds to the ' +
                 'Note Follow source. Lets you stagger melodic responses (0–500ms).'],
      ['RESET TRIG', 'Step-only. Clears the selected step: removes notes, resets ' +
                 'chance and condition to defaults, and clears all p-locks.'],
      ['Voice cards', 'Step-only. Show each note on the step with its pitch, length, ' +
                 'and any nudge offset. The × button removes an individual note ' +
                 'voice from a polyphonic step.'],
    ],
  },

  arp: {
    title: 'ARP',
    blurb: 'A per-track arpeggiator that turns held notes or a step pattern into ' +
           'a melodic sequence. Toggle it on/off without losing settings; pick a ' +
           'mode to control where the notes come from.',
    items: [
      ['ARP ON / ARP OFF', 'Enables or disables the arpeggiator without clearing the ' +
                 'settings. In INPUT mode, turning it off while you are still holding ' +
                 'keys hands the chord straight back to the keyboard, so the held ' +
                 'notes keep sounding as plain sustained voices.'],
      ['Mode: CHORD', 'Arpeggiate from a built-in chord type. Select the chord shape ' +
                 'and a pattern (Up / Down / UpDown / Random) to determine the order ' +
                 'the notes play.'],
      ['Mode: MANUAL', 'Define a custom step sequence: each step has its own semitone ' +
                 'offset from the root note, an independent RATE, and a GATE duration. ' +
                 'Add or remove steps freely. First step\'s NOTE is the root; ' +
                 'subsequent steps are relative (+/−).'],
      ['Mode: RANDOM', 'Generate random notes within a range around the root. NOTES ' +
                 'sets how many notes to pick each cycle; RANGE ± sets the semitone ' +
                 'window above and below.'],
      ['Mode: INPUT', 'Live keyboard-driven mode. Hold keys to form the chord and the ' +
                 'arpeggiator plays those held pitches. The held keys are the chord — ' +
                 'no step needed. Releasing the keys stops the arp and lets the last ' +
                 'notes ring out their normal release tail (no abrupt cut). With HOLD ' +
                 'on the chord latches and keeps arpeggiating even after you lift your ' +
                 'fingers or switch to another track; turn HOLD off to stop it. ' +
                 'Enable RECORD to capture what you play into the pattern.'],
      ['Mode: INPUT MANUAL', 'Live keyboard-driven version of MANUAL. The custom step ' +
                 'sequence (per-step semitone offset, RATE and GATE) plays relative to ' +
                 'the key you hold instead of a sequencer step: step 1 is the held note, ' +
                 'later steps are semitone moves from it. Hold a chord and the figure ' +
                 'runs from each held note at the same time. RECORD captures it too.'],
      ['PATTERN', 'Direction the arp traverses its notes: Up, Down, UpDown, or Random.'],
      ['RATE', 'How fast the arp fires notes. Double-click the knob centre to toggle ' +
                 'MS↔BPM mode. In BPM mode it snaps to musical divisions (e.g. 1/8, ' +
                 '1/16). P-lockable per step.'],
      ['GATE', 'How long each arp note sounds. 0ms (or LEGATO) ties notes together. ' +
                 'Double-click the knob centre to toggle MS↔BPM. P-lockable per step.'],
      ['VARIANCE', 'Adds random timing jitter to each arp step. 0% = precise; ' +
                 'higher values humanise the rhythm. P-lockable per step.'],
      ['NOTES (Random mode)', 'How many notes to randomly select each cycle.'],
      ['RANGE ± (Random mode)', 'Semitone window above and below the root within ' +
                 'which random notes are chosen.'],
    ],
  },

  amp: {
    title: 'AMP',
    blurb: 'Controls the volume envelope that shapes every note\'s loudness over ' +
           'time, plus stereo placement and velocity response. The ADSR curve ' +
           'applies to the track\'s amplitude on every triggered step.',
    items: [
      ['PAN', 'Stereo position from L100 (hard left) through C (centre) to R100 ' +
                 '(hard right). Bipolar knob; p-lockable per step for auto-pan effects.'],
      ['VEL', 'Velocity sensitivity. How much the step\'s velocity value scales the ' +
                 'amp envelope. At 100% a velocity-127 note is full amplitude and a ' +
                 'velocity-1 note is near-silent. At 0% velocity has no effect.'],
      ['Amp ADSR', 'The amplitude envelope. ATTACK — time from silence to peak. ' +
                 'DECAY — time from peak down to the sustain level. SUSTAIN — ' +
                 'level held while the note is on. RELEASE — fade-out time after ' +
                 'note-off. Each A/D/R knob can be toggled between MS and BPM sync ' +
                 '(double-click the knob centre).'],
    ],
  },

  lfo: {
    title: 'LFO',
    blurb: 'Low-frequency oscillators that modulate any assignable parameter over ' +
           'time — cutoff, pitch, level, pan, and more. Each track supports ' +
           'multiple LFOs; add more with +. Simple mode covers the essentials; ' +
           'Advanced mode adds per-segment depth and rate.',
    items: [
      ['LFO 1 / 2 / … / +', 'Sub-tab bar selects which LFO you are editing. + ' +
                 'adds a new LFO; ✕ removes the current one (only shown when there ' +
                 'are more than one).'],
      ['Destination', 'Searchable dropdown of every modulatable parameter on the ' +
                 'track (filter cutoff, resonance, envelope stages, machine params, ' +
                 'FX wet amounts, pan, and more). Select "— none —" to disconnect.'],
      ['Simple / Advanced', 'Simple mode: a single waveform + rate + depth. ' +
                 'Advanced mode reveals a 2×2 ADSR grid where each ADSR phase has ' +
                 'its own depth and rate, enabling complex evolving modulations.'],
      ['Wave', 'LFO waveform: sine (smooth), square (stepped), saw (rising ramp), ' +
                 'or tri (triangle). Determines the shape of the modulation curve.'],
      ['Trig', 'FRE = free-running (LFO never resets). TRG = triggered (LFO ' +
                 'restarts from Phase on each note-on). Use TRG for consistent ' +
                 'attack shapes; FRE for evolving textures.'],
      ['Rate', 'LFO speed. Double-click the knob centre to toggle HZ↔BPM. In BPM mode ' +
                 'the rate is tempo-locked to a musical division (e.g. 1/4, 1/8); ' +
                 'in HZ mode it sweeps freely from 0.001 to 20 Hz.'],
      ['Depth', 'How far the LFO moves the destination parameter. 0% = no movement; ' +
                 '100% = full range of the parameter.'],
      ['Phase', 'Starting phase of the LFO cycle (0–127). Only audible in TRG mode ' +
                 '— shifts where in the cycle the LFO begins on each note-on.'],
      ['Fade', 'Bipolar fade in/out. Positive: LFO ramps up from 0 to full depth ' +
                 'over the fade time (fade-in). Negative: ramps down (fade-out). ' +
                 '0 = instant full depth.'],
      ['Bias', 'Shifts the modulation window so the LFO moves only above (+) or ' +
                 'only below (−) the destination\'s current value. At 0 the LFO ' +
                 'sweeps symmetrically around the base value.'],
      ['Advanced: ADSR source', 'Own = the LFO has its own independent ADSR. ' +
                 'Amp sync = shares the track\'s amplitude envelope timing, so the ' +
                 'LFO modulation follows the note\'s shape automatically.'],
      ['Advanced: A/D/S/R cells', 'Each cell sets Depth (how far the LFO reaches in ' +
                 'that phase) and Rate (how fast it oscillates in that phase). A/D/R ' +
                 'also have a Time knob (duration in Own mode). Sustain has no time — ' +
                 'it holds until note-off.'],
    ],
  },

  midi: {
    title: 'MIDI',
    blurb: 'Configures incoming MIDI for this track. Map a MIDI input device and ' +
           'channel, transpose notes, and route MIDI CC messages to any modulatable ' +
           'parameter. The monitor log shows live MIDI activity for troubleshooting.',
    items: [
      ['MIDI In Source', 'Dropdown of available MIDI input devices (Web MIDI). ' +
                 'Select a device to route its note-on/off messages to this track. ' +
                 '"— off —" disables MIDI input.'],
      ['Channel Filter', 'Limit incoming notes to a single MIDI channel (Ch 1–16) ' +
                 'or accept all channels. Useful when one device sends on multiple ' +
                 'channels.'],
      ['Note Transpose', '+/− 12-semitone buttons shift all incoming MIDI notes up ' +
                 'or down in octave steps. Double-click the display to reset to 0.'],
      ['CC → Param Mappings', 'Map a MIDI CC number (0–127) to any assignable ' +
                 'parameter on the track. The CC value (0–127) is normalised to the ' +
                 'parameter\'s range in real time. + Add CC adds a new row; × removes it.'],
      ['MIDI Monitor', 'Scrolling log of note-on/off events received on any input, ' +
                 'with timestamps. Useful for confirming a controller is sending and ' +
                 'which notes/channels are arriving. Clear resets the log.'],
    ],
  },

  mixer: {
    title: 'MIXER',
    blurb: 'A compact one-strip-per-track overview of levels and FX sends for ' +
           'every track at once. Clicking a strip also selects that track. Knob ' +
           'changes here stay in sync with the matching FX tab knobs.',
    items: [
      ['LEVEL', 'Output level for this track\'s machine (0–100%). Linked to the ' +
                 'machine\'s output.level param — moving it here updates the SYNTH ' +
                 'tab knob for the selected track.'],
      ['DLY', 'Delay send level for this track (0–100%). Equivalent to the Wet ' +
                 'knob for Delay in the FX pane.'],
      ['CRUSH', 'Bitcrush send level for this track (0–100%). Equivalent to the ' +
                 'Wet knob for Crush in the FX pane.'],
      ['REV', 'Reverb send level for this track (0–100%). Equivalent to the ' +
                 'Wet knob for Reverb in the FX pane.'],
      ['DJ FILT', 'A per-track DJ-style filter. Bipolar: centre is flat. Turn ' +
                 'left to close a low-pass (cuts highs); turn right to open a ' +
                 'high-pass (cuts lows). Useful for build-ups and breakdowns.'],
      ['DLY / CRUSH / REV toggles', 'Enable or bypass each FX processor for this ' +
                 'track. Same as the per-block ON/OFF toggles in the FX pane.'],
    ],
  },

  deck: {
    title: 'DECK',
    blurb: 'DJ-style crossfade between two fully independent project instances ' +
           '(Deck A and Deck B). Fade from one song into another without stopping ' +
           'playback. Unload the outgoing deck to free CPU, then load the next song ' +
           'for endless mixing.',
    items: [
      ['LOAD SONG / ↻ LOAD NEW', 'Opens a file picker to load a Webtakt project ' +
                 '(.json) into this deck. Replaces the current song; asks for ' +
                 'confirmation if the deck is audible.'],
      ['CONTROL', 'Points the editing UI (tracks, steps, synth panel, etc.) at this ' +
                 'deck. Only one deck can be controlled at a time. Disabled if the ' +
                 'deck is empty.'],
      ['SILENCE', 'Mutes this deck\'s audio bus independently of the crossfader. ' +
                 'Use to cue a transition without the audience hearing the incoming ' +
                 'deck. Does not affect the other deck.'],
      ['✕ UNLOAD', 'Removes this deck\'s project from the audio graph and frees ' +
                 'CPU. Requires the other deck to be loaded first (you must always ' +
                 'have one active deck).'],
      ['CROSSFADER', 'Constant-power crossfade between decks A and B. Far left = ' +
                 'full deck A; far right = full deck B. The A/B percentage readout ' +
                 'shows the current split.'],
    ],
  },

  fx: {
    title: 'FX PIPELINE',
    blurb: 'The single home for this track\'s effects: reorder the chain, bypass ' +
           'blocks, add new effects, and edit every effect\'s params inline. ' +
           'Audio flows along the snaking path: INPUT → effects → OUTPUT. The ' +
           'default order is Delay → Crush → Chorus → Reverb, but order matters — ' +
           'reverb before crush sounds very different from crush before reverb. ' +
           'Opened with the FX button in the header FX bar; the icon row beside ' +
           'that button mirrors the chain (click an icon to jump here with that ' +
           'effect selected).',
    items: [
      ['Signal path', 'Each tile is one effect, shown in chain order. Drag a ' +
                 'tile onto another to place it before that one; drop on empty ' +
                 'path space to move it to the end. The whole chain is always ' +
                 'shown so you can see and rearrange every effect.'],
      ['ON / OFF', 'Each tile has an ON/OFF toggle that bypasses the effect ' +
                 'without removing it from the chain. Bypassed tiles are dimmed ' +
                 'but stay on the path (and dim in the header icon row too).'],
      ['Edit params', 'Click any tile — base effect or added — to select it; its ' +
                 'knobs appear inline below the path. Click the selected tile again ' +
                 'to deselect it. (The old per-FX header tabs were removed in ' +
                 'favour of this one editor.)'],
      ['Per-effect manual', 'With an effect tile selected, open this manual (📖 or ' +
                 'its key) to read THAT effect\'s own page; with no tile selected ' +
                 'it shows this FX-pipeline overview. So select a card, hit the ' +
                 'manual, and you get its specific help.'],
      ['FX bind', 'Each tile has a small dropdown to assign one of the four FX ' +
                 'keybinds (FX 1–4) to that effect, per track. Pressing the key ' +
                 '(default C / V / B / N, rebindable in Settings) toggles the ' +
                 'assigned effect ON/OFF on the SELECTED track — so the same key ' +
                 'can drive a different effect on each track. A block holds at ' +
                 'most one bind; assigning a bind that\'s in use steals it.'],
      ['Remove', 'Drag any tile to the BIN (under SAVE) to take it out of the ' +
                 'chain — or use the ✕ on the tile. Added effects are deleted; ' +
                 'the base four (Delay/Crush/Chorus/Reverb) are just detached and ' +
                 'can be re-added from + ADD FX (they keep their settings).'],
      ['Add FX', 'The + ADD FX menu adds another effect to the chain — including ' +
                 'a Filter (carve the mix post-effects), Distortion, Compressor, ' +
                 'a Normalizer (auto-levels the signal at that point so a loud ' +
                 'effect earlier in the chain doesn\'t blow up the level), or a ' +
                 'second copy of any base effect (e.g. two reverbs). A base effect ' +
                 'you removed reappears here as "(re-add)". Added effects can be ' +
                 'reordered and removed freely.'],
      ['Save', 'SAVE stores the whole pipeline (order + every effect\'s settings ' +
                 '+ added instances) as a named, tagged global preset.'],
      ['Load / presets popup', 'LOAD opens the FX-preset manager — a SOUNDS-style ' +
                 'popup with tag filters and one card per preset. ▶ PLAY DRY (pinned ' +
                 'at the top) plays the current track with NO effects; ▶ on a card ' +
                 'auditions that pipeline (a one-shot, then restores) so you can A/B ' +
                 'dry vs a pipeline vs dry. APPLY commits a preset to the track; ✎ ' +
                 'edits name/tags; ✕ deletes. Saved sounds also carry their FX ' +
                 'chain, so loading a sound restores its effects too.'],
    ],
  },

  delay: {
    title: 'DELAY',
    blurb: 'A per-track stereo delay with feedback. Adds echoes at a set time; ' +
           'feedback controls how many repeats you hear before they fade. Edit ' +
           'and bypass it from the FX pane (the delay\'s ON toggle must be on for ' +
           'it to pass audio).',
    items: [
      ['Time', 'Delay line length — the gap between the dry signal and its first ' +
                 'echo. Double-click the knob centre to toggle MS↔BPM. In BPM mode it ' +
                 'snaps to musical divisions (e.g. 1/8, 1/4) and tracks tempo ' +
                 'automatically. P-lockable in MS mode.'],
      ['Feedback', 'How much of the delayed signal is fed back into the delay ' +
                 'line (0–95%). Low values give a few clean echoes; high values ' +
                 'build into long, washy repeats. 95% approaches infinite sustain.'],
      ['Wet', 'Mix level of the delay signal added to the dry output (0–100%). ' +
                 'Does not remove the dry signal; the mixer LEVEL or amp envelope ' +
                 'controls overall track level. P-lockable and LFO-assignable.'],
    ],
  },

  crush: {
    title: 'CRUSH',
    blurb: 'A per-track bitcrusher that reduces audio quality to add grit and ' +
           'digital character. Bit depth reduction creates coarse quantisation ' +
           'noise; rate reduction mimics the aliasing of low-sample-rate audio.',
    items: [
      ['Bits', 'Bit depth (1–16). 16 = full resolution (no crush). Reducing this ' +
                 'quantises the waveform to fewer amplitude steps: 8-bit gives the ' +
                 'classic lo-fi game/computer sound; 1-bit is a hard sign fold. ' +
                 'Track-level only (not p-lockable).'],
      ['Rate', 'Sample-rate fraction (1%–100% of nyquist). Lowers the effective ' +
                 'sample rate via a pre-lowpass filter, adding aliasing smear. ' +
                 '100% = clean; lower values add muddy, crunchy lo-fi textures. ' +
                 'P-lockable and LFO-assignable.'],
      ['Wet', 'Mix level of the crushed signal (0–100%). P-lockable and LFO-assignable.'],
    ],
  },

  chorus: {
    title: 'CHORUS',
    blurb: 'A BBD-style stereo ensemble chorus ported from the Patina analogue ' +
           'engine. Two delay lines run at unrelated rates, producing the shimmer ' +
           'of a Juno or Solina ensemble rather than a simple single-voice chorus. ' +
           'Enabled automatically when a track is in Analogue mode; also available ' +
           'on any track from the FX pane.',
    items: [
      ['Mix', 'Wet level of the chorus (0–100%). The Patina mix law is used: ' +
                 'wet = mix × 0.85, dry = 1 − mix × 0.4, so even at full mix the ' +
                 'dry signal is not entirely removed. P-lockable and LFO-assignable.'],
      ['Rate', 'Speed of the left LFO (0.05–6 Hz). The right delay line runs at ' +
                 'rate × 1.27 — the deliberate mismatch between them is what ' +
                 'creates the ensemble shimmer rather than a single slow wobble. ' +
                 'Double-click the knob centre to toggle HZ↔BPM; in BPM mode the ' +
                 'rate locks to the tempo and snaps to musical divisions. ' +
                 'P-lockable in either mode, and LFO-assignable in HZ mode.'],
      ['Depth', 'Modulation depth — how far the LFOs swing the delay times ' +
                 '(0–100%). More depth = wider, lusher chorus; less = subtle ' +
                 'thickening. P-lockable and LFO-assignable.'],
    ],
  },

  reverb: {
    title: 'REVERB',
    blurb: 'An algorithmic convolution reverb using a synthesised exponential-' +
           'decay impulse response. Controls the room size (Decay), the gap ' +
           'before the reverb starts (Pre-dly), and brightness (Damp).',
    items: [
      ['Decay', 'Reverb tail length in seconds (0.1–8s). Short values give tight ' +
                 'rooms and plates; long values give halls and caverns. Changing ' +
                 'Decay rebuilds the IR — track-level only (not p-lockable).'],
      ['Pre-dly', 'Pre-delay before the reverb tail begins. Double-click the knob centre ' +
                 'to toggle MS↔BPM. Longer pre-delay separates the dry signal from ' +
                 'the reverb for clarity, or can sync to tempo for rhythmic ' +
                 'effects. Track-level only (rebuilds the IR on change).'],
      ['Damp', 'Low-pass cutoff on the wet signal (200 Hz–20 kHz). Lower values ' +
                 'roll off high frequencies in the tail — simulating absorption in ' +
                 'soft, carpeted spaces. Higher values keep the tail bright and ' +
                 'airy. P-lockable and LFO-assignable.'],
      ['Wet', 'Mix level of the reverb signal (0–100%). P-lockable and LFO-assignable.'],
    ],
  },

  normalizer: {
    title: 'NORMALIZER',
    blurb: 'An added FX block (+ ADD FX) that auto-levels the signal at its point ' +
           'in the chain. It watches the LOUD parts of whatever reaches it and ' +
           'drives them toward the Target level — so a hot effect earlier in the ' +
           'chain (a big distortion, a resonant filter, a reverb wash) gets turned ' +
           'DOWN, and a too-quiet point can be lifted UP. Because it measures the ' +
           'live signal, it re-adjusts on its own when the upstream chain changes. ' +
           'Place it AFTER the effects you want to tame. Must be ON to act; ' +
           'bypassed it passes through transparently.\n\n' +
           'Target is a SINGLE knob for both directions: set it BELOW the signal\'s ' +
           'level to turn it down, ABOVE to push it up. Around the natural level it ' +
           'sits near unity. Range 0 = no change at all (a quick A/B).',
    items: [
      ['Target', 'The level the loud parts are driven toward. One knob, both ways: ' +
                 'LOWER than the signal\'s level = turned DOWN (quieter), HIGHER = ' +
                 'lifted UP. A built-in ceiling caps extreme boost so near-silence ' +
                 'isn\'t amplified into noise.'],
      ['Range', 'How far it may push from no-change (0%) to full normalisation ' +
                '(100%). 0 leaves the signal untouched; 100% drives fully to ' +
                'Target. Scales both downward and upward correction.'],
      ['Speed', 'How fast it adapts. Low = slow, gentle levelling (less pumping); ' +
                'high = reacts quickly to level changes.'],
    ],
  },

  phaser: {
    title: 'PHASER',
    blurb: 'An added FX block (+ ADD FX). A phaser mixes the dry signal with a ' +
           'copy passed through a bank of allpass filters whose frequencies are ' +
           'swept by an LFO. Where the two copies meet they cancel, creating a row ' +
           'of moving notches that sweep up and down the spectrum — a swooshing, ' +
           'hollow, "jet plane" shimmer (think Small Stone / Phase 90 on guitars, ' +
           'pads, or drums). The effect lives in the SWEEP, so it is most obvious ' +
           'on sustained, harmonically rich sounds; on a short blip you mostly hear ' +
           'a tonal colour. Raise Wet from 0 to hear it (must be ON).',
    items: [
      ['Rate', 'Speed of the sweep LFO (0.05–8 Hz). Slow = a long, lazy swoosh; ' +
                'fast = a wobbly, vibrato-like churn.'],
      ['Depth', 'How far the notches sweep (0–1). Wider depth = a more dramatic, ' +
                'full-range swoosh; low depth = a narrow, subtle shimmer.'],
      ['Feedback', 'Feeds the output back through the allpass bank (0–0.9), ' +
                'sharpening the notches into resonant, whistling peaks. High values ' +
                'are the most obvious phaser sound.'],
      ['Wet', 'Mix of the phased copy against the dry (0–100%). The notches cancel ' +
                'deepest near 100% — start there to hear the effect, then back off ' +
                'to taste. At 0 the phaser is silent (pure dry).'],
    ],
  },
};

/**
 * Per-machine SYNTH-tab sections, keyed by machine type (`track.machine.type`).
 * Same shape as MANUAL_CONTENT entries. When present, the overlay shows the
 * matching entry instead of the generic `synth` one above. Document a machine
 * by reading its panel + machine source, then adding an entry here.
 */
export const MACHINE_MANUAL = {

  // ── MELODIC ────────────────────────────────────────────────────────────────

  synth: {
    title: 'SYNTH (Synth)',
    blurb: 'A dual-oscillator subtractive synth with a sub oscillator. Clean and ' +
           'direct — great for leads, basses, and anything that needs a simple, ' +
           'controllable tone.',
    items: [
      ['Waveform', 'Main oscillator waveform: sine, sawtooth, square, or triangle. ' +
                 'Determines the basic harmonic character before the filter.'],
      ['Sub Level', 'Level of the sub oscillator (sine, one octave below). Adds ' +
                 'weight and low-end body. At 0 it is silent; at 1 it matches the ' +
                 'main oscillator.'],
      ['Sub Waveform', 'Sub oscillator waveform. Square adds more harmonic content ' +
                 'to the sub — sine is cleaner and rounder.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  bass: {
    title: 'SYNTH (Bass)',
    blurb: 'A bassline machine with glide, a drive waveshaper, and an accent ' +
           'threshold. Modelled after a classic monophonic bass synth — ' +
           'sawtooth or square, with portamento between notes.',
    items: [
      ['Waveform', 'Sawtooth or square. Saw is the classic thick bass tone; ' +
                 'square is hollower and more mid-focused.'],
      ['Sub', 'Level of a pure sine sub oscillator, two octaves below the main. ' +
                 'Adds low-frequency weight without adding harmonics.'],
      ['Drive', 'Waveshaper saturation. 0 = clean; higher values push the ' +
                 'signal into soft clip for warmth and harmonics.'],
      ['Glide', 'Portamento time in ms. When > 0, the oscillator glides ' +
                 'continuously from the previous note\'s pitch to the new one. ' +
                 '0 = instant pitch change.'],
      ['Accent', 'Velocity threshold for accent. Notes with velocity ≥ this value ' +
                 'get a +6dB transient boost on the attack, then settle back to ' +
                 'normal level — the classic 303-style accent.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  chord: {
    title: 'SYNTH (Chord)',
    blurb: 'A 4-voice chord synth. Each note-on fires all four voices at ' +
           'chord-appropriate intervals, making it easy to lay down pads and ' +
           'harmony without manually programming multiple tracks.',
    items: [
      ['Chord', 'The chord type: major, minor, sus2, sus4, dim, aug, 7th, etc. ' +
                 'Determines the interval set spread across the 4 oscillators.'],
      ['Inversion', 'Chord inversion (0–3). Rotates which chord tone sits at the ' +
                 'bottom, changing the voicing without changing the pitch class content.'],
      ['Spread', 'Alternating detune in cents applied between voices for stereo ' +
                 'width. Higher values create a wider, chorus-like sound; 0 = tight.'],
      ['Waveform', 'Waveform for all 4 oscillators: sawtooth, square, triangle, ' +
                 'or sine.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  wavetable: {
    title: 'SYNTH (Wavetable)',
    blurb: 'A morphing wavetable oscillator. Two oscillator nodes crossfade ' +
           'between adjacent wavetable entries as you move the Pos knob, ' +
           'creating smooth timbral sweeps from sine through saw, square, and ' +
           'beyond to brighter, nasal, and vocal shapes.',
    items: [
      ['Pos', 'Wavetable position (0.0–7.0). Sweeps through 8 stored waveforms: ' +
                 '0=sine, 1=triangle, 2=saw, 3=square, 4=pulse25%, 5=bright saw, ' +
                 '6=hollow, 7=vocal/formant. Fractional values morph between ' +
                 'adjacent entries. This is the primary LFO target for classic ' +
                 'wavetable movement.'],
      ['Sub Level', 'Level of a sub oscillator one octave below, pure sine. ' +
                 'Adds low-end weight beneath the wavetable.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  swarm: {
    title: 'SYNTH (Swarm)',
    blurb: 'Seven detuned oscillators in a cluster — one root plus six swarm ' +
           'voices. The spread and slow random drift create a thick, analogue-' +
           'ensemble quality without any individual note standing out.',
    items: [
      ['Wave', 'Waveform for all oscillators: sawtooth, square, triangle, or sine.'],
      ['Spread', 'Detune spacing between swarm voices in cents. Low values create ' +
                 'subtle thickening; higher values widen the sound into a lush detuned ' +
                 'cluster.'],
      ['Height', 'Level of the 6 swarm voices relative to the root oscillator. At ' +
                 '0 only the root sounds; at 1 all seven voices are equal.'],
      ['Slope', 'Per-slot gain taper. 0 = flat (all swarm voices equal). Negative = ' +
                 'outer voices quieter (pyramidal). Positive = outer voices louder.'],
      ['Noise Amt', 'Depth of the random pitch drift in cents. Higher values make ' +
                 'the swarm drift more, like an unstable vintage ensemble.'],
      ['Noise Rate', 'How fast the random drift updates. 0 = very slow; 1 = rapid ' +
                 'flutter. Controls the drift texture from a slow shimmer to a ' +
                 'faster wobble.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  fm: {
    title: 'SYNTH (FM)',
    blurb: 'A 4-operator FM synthesizer. OP1 is the carrier (what you hear); ' +
           'OP2, OP3, and OP4 are modulators that shape OP1\'s timbre. OP2 has ' +
           'self-feedback for metallic and noise-like textures. Each operator ' +
           'has its own ADSR envelope.',
    items: [
      ['OPn Ratio', 'Frequency ratio of this operator relative to the base note. ' +
                 '1 = root, 2 = one octave up, 0.5 = one octave down, etc. Non-integer ' +
                 'ratios produce inharmonic, bell-like, or metallic timbres.'],
      ['OPn Level', 'For carriers (OP1): output amplitude. For modulators: ' +
                 'modulation index — how far the modulator pushes the carrier\'s ' +
                 'pitch. Higher values = more intense FM sidebands.'],
      ['OP2 Feedback', 'Self-modulation amount for OP2. Low values add subtle ' +
                 'harmonic richness; high values produce noise and metallic grit.'],
      ['OPn Detune', 'Fine-tune offset in cents (±50). Slightly detuning modulators ' +
                 'introduces beating and phase movement.'],
      ['OPn ADSR', 'Per-operator envelope. The carrier\'s envelope sets amplitude; ' +
                 'the modulators\' envelopes fade their modulation index over time — ' +
                 'a decaying modulator creates a classic bright-to-dark FM pluck. ' +
                 'A/D/R knobs have MS/BPM sync (double-click the knob centre to toggle).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  karplus: {
    title: 'SYNTH (Karplus)',
    blurb: 'A Karplus-Strong plucked-string synthesis. An exciter burst feeds a ' +
           'tuned delay-line with damped feedback, producing natural-sounding ' +
           'pizzicato strings, harps, and guitar tones.',
    items: [
      ['Damping', 'How quickly high frequencies decay (0=bright, 1=warm/dark). ' +
                 'Higher damping simulates softer string material and mutes the ' +
                 'upper harmonics faster.'],
      ['Feedback', 'Sustain of the string resonance (0.8–0.999). Higher values ' +
                 'give longer sustain; 0.999 is near-infinite. The decay of a real ' +
                 'pluck lives in this narrow range.'],
      ['Excite', 'Exciter burst length in ms. Shorter = sharp, precise pluck. ' +
                 'Longer = softer bowed-style attack with a slower onset.'],
      ['Excite Tone', 'High-frequency cutoff of the exciter noise (200–20000 Hz). ' +
                 'Lower values make the initial pluck darker and duller.'],
      ['Stretch', 'Pitch stretch in semitones (±12). Slightly detunes the effective ' +
                 'period of the resonator, shifting the pitch. A subtle non-zero ' +
                 'value can add a slightly inharmonic, more realistic character.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  marimba: {
    title: 'SYNTH (Marimba)',
    blurb: 'An inharmonic bar percussion synthesizer with three sinusoidal ' +
           'partials and a noise exciter. Models tuned percussion like marimba, ' +
           'xylophone, vibraphone, and metallophones.',
    items: [
      ['Decay 1', 'Decay of the fundamental (partial 1). This is the primary ' +
                 'sustain of the bar tone (0.2–8s).'],
      ['Decay 2', 'Decay of the second partial. Typically shorter than Decay 1 — ' +
                 'the upper modes of a real bar die faster.'],
      ['Decay 3', 'Decay of the third partial. Usually very short — the high mode ' +
                 'provides the bright initial click and fades quickly.'],
      ['P2 Ratio', 'Frequency ratio of the second partial relative to the fundamental. ' +
                 'Real marimba bars have non-integer ratios (~3.9, 9.9); adjusting ' +
                 'this dials in different percussion characters.'],
      ['P3 Ratio', 'Frequency ratio of the third partial (5–15). Higher ratios ' +
                 'produce bright, bell-like attacks.'],
      ['P2 Level', 'Amplitude of the second partial. Balances how prominent the ' +
                 'mid-range harmonic is relative to the fundamental.'],
      ['P3 Level', 'Amplitude of the third partial. Controls the brightness of ' +
                 'the initial transient.'],
      ['Mallet', 'Hardness of the mallet exciter (0–1). Softer mallets give a ' +
                 'warm, rounded attack; harder mallets produce a sharp, defined click.'],
      ['Mallet Tone', 'High-pass cutoff of the mallet noise (500–8000 Hz). Higher ' +
                 'values make the mallet click brighter and more defined.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  comb: {
    title: 'SYNTH (Comb)',
    blurb: 'A two-partial comb filter resonator. Two inharmonically-spaced sine ' +
           'partials decay at different rates, producing bell, gamelan, and ' +
           'metallic percussion tones. Tuned to MIDI pitch.',
    items: [
      ['Ratio', 'Frequency ratio of the second partial to the fundamental (0.5–8). ' +
                 'Integer ratios are harmonic; non-integer ratios produce metallic, ' +
                 'inharmonic bell tones. The default of ~2.76 gives a gamelan character.'],
      ['Decay', 'Decay of the fundamental (primary resonant ring time, 0.1–8s).'],
      ['Decay 2', 'Relative decay of the second partial (fraction of Decay). ' +
                 'Shorter values make the overtone fade faster than the fundamental, ' +
                 'like a real bell.'],
      ['Mix', 'Balance between the two partials. 0 = only fundamental; 1 = only ' +
                 'second partial; 0.5 = equal.'],
      ['Strike', 'Amplitude of the initial noise burst that excites the resonators. ' +
                 'Higher values create a more pronounced hit transient.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  strings: {
    title: 'SYNTH (Strings)',
    blurb: 'A polyphonic bowed-string section synthesizer. Multiple detuned ' +
           'oscillators pass through tone and body resonance filters, with a ' +
           'built-in vibrato LFO and selectable instrument modes.',
    items: [
      ['Mode', 'Instrument character (viola, violin, cello, etc.). Changes the ' +
                 'tuning intervals between section voices and the filter voicing.'],
      ['Ensemble', 'Detune spread across section voices in cents. 0 = all in unison ' +
                 '(thin); higher values give a wider, more organic ensemble chorus.'],
      ['Tone', 'Low-pass cutoff of the overall brightness filter (300–12000 Hz). ' +
                 'Lower values give a darker, more veiled tone.'],
      ['Body', 'Centre frequency of a bandpass body resonance (150–3000 Hz). ' +
                 'Emphasises the woody, hollow character of the instrument body.'],
      ['Resonance', 'Q of the body filter. Higher values make the body resonance ' +
                 'more pronounced — boosting a narrow band of frequencies.'],
      ['Bow', 'Level of an additional bowing noise that adds breath and texture to ' +
                 'the attack and sustain.'],
      ['Vibrato', 'Depth of the built-in vibrato LFO in cents (0–50¢). ' +
                 '0 = no vibrato; higher values give a natural pitch wavering.'],
      ['Vib Rate', 'Speed of the vibrato LFO (0.5–12 Hz). Typical violin vibrato ' +
                 'is around 5–7 Hz. Double-click the knob centre to toggle HZ↔BPM; ' +
                 'in BPM mode the rate locks to the tempo and snaps to musical ' +
                 'divisions (1/8, 1/4, …). P-lockable in either mode.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  moogish: {
    title: 'SYNTH (Moogish)',
    blurb: 'Three detuned oscillators through the Patina analogue engine — imperfect ' +
           'waveforms, a sub oscillator, thermal drift, and optional mains hum. ' +
           'Each voice has unique component tolerance baked in, so a polyphonic ' +
           'chord of Moogish notes is always slightly different per voice.',
    items: [
      ['O1 Wave / O2 Wave / O3 Wave', 'Waveform for each of the three main ' +
                 'oscillators: saw, square, triangle, or sine. Each osc uses ' +
                 'an imperfect PeriodicWave (slightly irregular harmonics) to ' +
                 'avoid the sterile sound of perfect digital waveforms.'],
      ['O1 Oct / O2 Oct / O3 Oct', 'Octave offset per oscillator (±2 octaves). ' +
                 'Stagger the octaves to build a thick, layered bass+mid+top texture.'],
      ['O1 Detune / O2 Detune / O3 Detune', 'Fine detune per oscillator in cents ' +
                 '(±50). Slight differences between the three create beating and ' +
                 'the characteristic Moog chorus feel.'],
      ['O1 Level / O2 Level / O3 Level', 'Mix level of each oscillator into the ' +
                 'output bus. Set any to 0 to disable it.'],
      ['Sub', 'Level of the sub oscillator (slightly imperfect sine, one octave ' +
                 'below osc1). Adds sub-bass weight.'],
      ['Noise', 'Level of white noise mixed in. Adds breathiness or is useful for ' +
                 'percussion-like transients when combined with the envelope.'],
      ['Drift', 'Thermal pitch drift amount — a slow random detuning of all ' +
                 'oscillators, emulating component temperature variation in vintage ' +
                 'analogue hardware. Each voice\'s tolerance offset is fixed per ' +
                 'instance; drift wanders on top of it.'],
      ['Hum', 'Level of mains hum (50 Hz or 60 Hz fundamental + 2nd harmonic). ' +
                 'Simulates the "circuit is never entirely quiet" floor of real ' +
                 'analogue gear. Keep this low unless you specifically want the effect.'],
      ['Hum Hz', '50 Hz (European mains) or 60 Hz (American mains). Affects the ' +
                 'pitch of the hum. Choose based on what sounds right for your context.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  // ── DRUMS (digital) ────────────────────────────────────────────────────────

  'kick.silk': {
    title: 'SYNTH (Kick Silk)',
    blurb: 'A clean sine-body kick using a persistent oscillator with a pitch ' +
           'sweep. Smooth and focused — closer to a 909 body than an 808. ' +
           'The sweep and punch shape the transient character.',
    items: [
      ['Tune', 'Body oscillator frequency in Hz (20–200). Sets the pitch of the ' +
                 'fundamental; lower values = deeper kick.'],
      ['Decay', 'Amplitude decay time after the hit (0.05–2s). Shorter = punchy ' +
                 'and tight; longer = boomy with a long tail.'],
      ['Sweep', 'How far the pitch sweeps down at the start of the hit (1×–8× ' +
                 'above Tune). Higher values produce the characteristic kick ' +
                 '"thump" as the pitch falls rapidly.'],
      ['Punch', 'Level of the initial transient click (0–1). Adds a high-frequency ' +
                 'impact layer on top of the body for more attack.'],
      ['Punch Decay', 'How quickly the punch transient fades (5–80ms). Shorter ' +
                 'values keep the click crisp and tight.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'kick.hard': {
    title: 'SYNTH (Kick Hard)',
    blurb: 'A sub-heavy kick with drive saturation and a sub oscillator. ' +
           'Combines the sine body of Kick Silk with a waveshaper and a sub, ' +
           'producing a harder, more saturated hit suited for techno and hard dance.',
    items: [
      ['Tune', 'Body oscillator frequency in Hz (20–200).'],
      ['Decay', 'Amplitude decay time (0.05–2s).'],
      ['Sweep', 'Pitch sweep multiplier at the start of the hit (1×–8×).'],
      ['Sub', 'Level of a sub oscillator one octave below the body. Adds low-end ' +
                 'weight; the sub passes through the drive waveshaper along with the body.'],
      ['Drive', 'Waveshaper saturation gain (1–6). Higher values push the body + sub ' +
                 'into harder saturation for a grittier, louder transient.'],
      ['Punch', 'Level of the initial click transient (0–1).'],
      ['Punch Decay', 'Fade time of the punch transient (5–80ms).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  snare: {
    title: 'SYNTH (Snare)',
    blurb: 'A tone+noise snare: a triangle-wave body oscillator crossed with ' +
           'high-passed noise, shaped by independent level controls for each ' +
           'component.',
    items: [
      ['Tune', 'Body oscillator frequency in Hz (100–400). Sets the tonal pitch ' +
                 'of the snare body.'],
      ['Decay', 'Overall amplitude decay time (0.05–1s).'],
      ['Tone', 'Level of the body oscillator relative to the noise (0–1). High ' +
                 'values bring out the tonal pitch; low values let the noise dominate.'],
      ['Snap', 'Level of the initial snap transient — a short burst that adds ' +
                 'click and definition at the start of the hit.'],
      ['Noise Cut', 'High-pass cutoff of the noise component (200–8000 Hz). ' +
                 'Higher values make the noise component thinner and brighter.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  hihat: {
    title: 'SYNTH (HiHat)',
    blurb: 'A multi-oscillator hi-hat using six inharmonically-spaced square ' +
           'waves through a high-pass filter. The same oscillator bank is used ' +
           'for both open and closed hats — length is controlled by the mode.',
    items: [
      ['Decay', 'Closed hi-hat decay time (0.01–0.25s).'],
      ['Open Decay', 'Open hi-hat decay time (0.1–2s). Only active when Open is on.'],
      ['Open', 'Toggle between closed and open hi-hat mode. When open, the ' +
                 'longer Open Decay is used.'],
      ['Cutoff', 'High-pass filter cutoff (500–12000 Hz). Removes low frequencies ' +
                 'from the oscillator mix; lower values allow more body into the ' +
                 'hat, higher values keep it thin and airy.'],
      ['Tone', 'Resonance of the high-pass filter (Q). Higher values emphasise ' +
                 'frequencies near the cutoff for a more metallic, ringy quality.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  clapp: {
    title: 'SYNTH (Clapp)',
    blurb: 'An 808-style layered clap. Three short noise bursts are fired in ' +
           'rapid succession through a bandpass filter, simulating the way ' +
           'multiple hands clapping together create a flam-like texture.',
    items: [
      ['Tone', 'Bandpass filter centre frequency (800–6000 Hz). Sets the tonal ' +
                 'colour of the clap body — lower values give a fatter, more ' +
                 'resonant clap; higher values make it snappier.'],
      ['Snap', 'Bandpass filter Q. Higher resonance makes the tonal character ' +
                 'more pronounced and ringy.'],
      ['Decay', 'Overall amplitude decay of the final burst layer (0.05–1s).'],
      ['Spread', 'Time gap between the three burst layers in ms (0–30ms). Higher ' +
                 'spread = a more audible flam/double-strike effect; lower = tight ' +
                 'and snappy.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  cymbal: {
    title: 'SYNTH (Cymbal)',
    blurb: 'A six-oscillator inharmonic cymbal using square waves at non-integer ' +
           'frequency ratios, shaped by a high-pass and bandpass filter pair. ' +
           'Three decay modes (closed/mid/open) cover hi-hat, mid cymbal, and ' +
           'open crash/ride.',
    items: [
      ['Tune', 'Base frequency of the oscillator bank (100–800 Hz). All six ' +
                 'oscillators are at fixed ratios above this; raising Tune shifts ' +
                 'the whole cymbal up in pitch.'],
      ['Tone', 'High-pass cutoff (200–8000 Hz). Removes low body and controls ' +
                 'brightness.'],
      ['Body', 'Bandpass emphasis centre frequency (500–16000 Hz). Adds a ' +
                 'resonant character at a specific frequency — like the ring of a ' +
                 'cymbal\'s metal.'],
      ['Resonance', 'Q of the body bandpass. Higher values make the ring more ' +
                 'pronounced and narrow.'],
      ['Decay', 'Closed mode decay time (0.05–0.5s).'],
      ['Mid Decay', 'Mid mode decay time (0.1–2s).'],
      ['Open Decay', 'Open mode decay time (0.5–8s).'],
      ['Mode', 'Selects which decay time is used: closed (short), mid, or open (long).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  wood: {
    title: 'SYNTH (Wood)',
    blurb: 'A two-resonator wood percussion synthesizer — clave, rimshot, ' +
           'cowbell, woodblock. Two bandpass resonators are driven by noise ' +
           'and a click oscillator.',
    items: [
      ['Freq 1', 'Centre frequency of the primary resonator (200–4000 Hz). ' +
                 'Sets the main tonal character of the wood hit.'],
      ['Freq 2', 'Centre frequency of the secondary resonator (400–8000 Hz). ' +
                 'Adds an overtone that, combined with Freq 1, gives the wooden ' +
                 'inharmonic double-strike quality.'],
      ['Ring', 'Q of both resonators. Higher values make the resonators ring ' +
                 'longer and more narrowly — from a dry thud to a ringing clave tone.'],
      ['Mix', 'Balance between the two resonators (0 = only Freq 1; 1 = only Freq 2).'],
      ['Decay', 'Overall amplitude decay time (0.001–0.4s).'],
      ['Click', 'Level of the click oscillator — a sine burst at Click Freq that ' +
                 'adds a sharp initial transient on top of the resonator noise.'],
      ['Click Freq', 'Frequency of the click transient oscillator (500–12000 Hz). ' +
                 'Higher values give a brighter, crisper click.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  transient: {
    title: 'SYNTH (Transient)',
    blurb: 'A pure transient / click generator — short body sweep, a click ' +
           'oscillator, and optional crack noise. Suited for punch layering, ' +
           'percussion accents, and electronic body clicks.',
    items: [
      ['Pitch', 'Starting pitch of the body sweep in Hz (0–2000). The body ' +
                 'oscillator sweeps from this frequency down to near zero over ' +
                 'Body Decay.'],
      ['Pitch End', 'Fraction of Body Decay at which the pitch sweep reaches its ' +
                 'target. Lower values make the sweep faster; higher values stretch it.'],
      ['Body Decay', 'Amplitude decay time of the body oscillator (10–2000ms). ' +
                 'Longer values give more sustain to the body thud.'],
      ['Body Wave', 'Waveform of the body oscillator: sine (smooth) or triangle ' +
                 '(slightly brighter with odd harmonics).'],
      ['Click Freq', 'Frequency of the click oscillator (100–8000 Hz). Sets the ' +
                 'pitch of the click transient.'],
      ['Click Decay', 'Decay time of the click burst (1–50ms). Very short for a ' +
                 'crisp snap; longer for a pitched \'tonk\'.'],
      ['Crack', 'Level of added noise on the click transient. A small amount of ' +
                 'noise adds texture and air to the click impact.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  noise: {
    title: 'SYNTH (Noise)',
    blurb: 'A shaped noise generator with a body bandpass, a colour bandpass, ' +
           'and an optional bitcrusher. Suited for sweeps, impacts, and lo-fi ' +
           'noise percussion.',
    items: [
      ['Color', 'Resonance of the colour bandpass filter. Higher values ' +
                 'emphasise a narrow frequency band, giving the noise a tonal ' +
                 'whistle or ring character.'],
      ['Color Freq', 'Centre frequency of the colour bandpass (200–8000 Hz). ' +
                 'Sweeping this creates the classic filtered noise sweep.'],
      ['Body Freq', 'Centre frequency of the body bandpass (80–2000 Hz). A ' +
                 'second, lower-frequency resonance layer that adds body weight.'],
      ['Body', 'Level of the body bandpass layer relative to the colour ' +
                 'bandpass. Balances the two spectral regions.'],
      ['Crush', 'Internal bitcrush on the noise signal (0–1). Adds digital ' +
                 'grit and quantisation noise on top of the analogue-style ' +
                 'bandpass shaping.'],
      ['Decay', 'Amplitude decay time (0.01–4s).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  // ── DRUMS (analogue / Patina) ──────────────────────────────────────────────

  'kick.analogue': {
    title: 'SYNTH (Kick Analog)',
    blurb: 'The Patina analogue kick. Imperfect oscillators, thermal drift, and ' +
           'a drive waveshaper model the character of a vintage drum machine kick ' +
           'that is slightly different every hit.',
    items: [
      ['Tune', 'Body oscillator frequency (20–200 Hz).'],
      ['Decay', 'Amplitude decay time (0.05–2s).'],
      ['Sweep', 'Pitch sweep multiplier at hit start (1×–8×).'],
      ['Sub', 'Level of the sub oscillator (one octave below, imperfect sine).'],
      ['Drive', 'Waveshaper saturation (1–6). Higher = more harmonic grit and ' +
                 'compression on the body + sub.'],
      ['Drift', 'Amount of random thermal pitch drift (0–1). Modelled on component ' +
                 'temperature variation — each instance has a fixed tolerance offset ' +
                 'plus this wandering drift on top.'],
      ['Punch', 'Level of the initial click transient (0–1).'],
      ['Punch Decay', 'Fade time of the punch transient (5–80ms).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'snare.analogue': {
    title: 'SYNTH (Snare Analog)',
    blurb: 'The Patina analogue snare. An imperfect triangle-wave body with ' +
           'pink noise, modelling the vintage snare character of analogue ' +
           'drum machines.',
    items: [
      ['Tune', 'Body oscillator frequency (100–400 Hz).'],
      ['Decay', 'Amplitude decay time (0.05–1s).'],
      ['Tone', 'Level of the body oscillator (0–1).'],
      ['Snap', 'Level of the transient snap layer (0–1).'],
      ['Noise Cut', 'High-pass cutoff of the pink-noise component (200–8000 Hz).'],
      ['Drift', 'Thermal pitch drift amount. Adds subtle tuning instability per hit.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'hihat.analogue': {
    title: 'SYNTH (HiHat Analog)',
    blurb: 'The Patina analogue hi-hat. Imperfect square oscillators at ' +
           'tolerance-skewed ratios, giving each instance a unique slightly ' +
           'non-identical character.',
    items: [
      ['Decay', 'Closed hi-hat decay time (0.01–0.25s).'],
      ['Open Decay', 'Open hi-hat decay time (0.1–2s).'],
      ['Open', 'Toggle between closed and open mode.'],
      ['Cutoff', 'High-pass filter cutoff (500–12000 Hz).'],
      ['Tone', 'High-pass filter Q. Higher values add metallic resonance.'],
      ['Drift', 'Thermal pitch drift of the oscillator bank. Adds organic ' +
                 'variation between hits.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'cymbal.analogue': {
    title: 'SYNTH (Cymbal Analog)',
    blurb: 'The Patina analogue cymbal. Six imperfect-square oscillators at ' +
           'tolerance-skewed inharmonic ratios, with a high-pass and bandpass ' +
           'filter pair and thermal drift.',
    items: [
      ['Tune', 'Base frequency of the oscillator bank (100–800 Hz).'],
      ['Tone', 'High-pass cutoff (200–8000 Hz).'],
      ['Body', 'Bandpass centre frequency (500–16000 Hz).'],
      ['Resonance', 'Bandpass Q. Higher = more pronounced metallic ring.'],
      ['Decay', 'Closed mode decay (0.05–0.5s).'],
      ['Mid Decay', 'Mid mode decay (0.1–2s).'],
      ['Open Decay', 'Open mode decay (0.5–8s).'],
      ['Mode', 'Closed / mid / open.'],
      ['Drift', 'Thermal pitch drift across the oscillator bank.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'tom.analogue': {
    title: 'SYNTH (Tom Analog)',
    blurb: 'The Patina analogue tom. A tunable imperfect-sine oscillator with ' +
           'a pitch sweep, drive, and thermal drift.',
    items: [
      ['Tune', 'Body frequency (60–400 Hz). Sets the pitch of the tom.'],
      ['Decay', 'Amplitude decay (0.1–1.5s).'],
      ['Sweep', 'Pitch sweep multiplier at hit start (1×–4×).'],
      ['Drive', 'Waveshaper saturation (1–4). Adds harmonics and makes the ' +
                 'tom sound more aggressive.'],
      ['Drift', 'Thermal pitch drift amount.'],
      ['Attack', 'Level of the attack transient on top of the body.'],
      ['Atk Decay', 'Fade time of the attack transient (5–50ms).'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'clapp.analogue': {
    title: 'SYNTH (Clapp Analog)',
    blurb: 'The Patina analogue clap. Layered pink-noise bursts through a ' +
           'bandpass filter, with a fixed per-instance inter-burst jitter for ' +
           'that slightly-off mechanical feel.',
    items: [
      ['Tone', 'Bandpass centre frequency (800–6000 Hz). Colour of the clap body.'],
      ['Snap', 'Bandpass Q. Higher = more pronounced resonant ring on the clap.'],
      ['Decay', 'Final layer decay time (0.05–1s).'],
      ['Spread', 'Time between burst layers in ms (0–30ms). Higher = more flam-like.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  // ── SAMPLER ────────────────────────────────────────────────────────────────

  sampler: {
    title: 'SYNTH (Sampler)',
    blurb: 'A single-buffer sample player. Load an audio file via the panel ' +
           'buttons, set the playback region and options, then use it as a ' +
           'melodic or percussive instrument on the track.',
    items: [
      ['Start / End', 'Normalised playback region within the loaded sample (0–1). ' +
                 'Start sets where playback begins; End sets where it stops. Use ' +
                 'these to trim a region from a longer file.'],
      ['Loop Strt', 'Normalised loop resume point (0–1). After the first pass ' +
                 'plays from Start, subsequent loops restart here — so you can ' +
                 'have a one-shot intro followed by a looped sustain section.'],
      ['Speed', 'Playback rate multiplier (0.125×–4×). 1 = original pitch/speed. ' +
                 '2 = one octave up; 0.5 = one octave down. Independent of the ' +
                 'MIDI note pitch-tracking if Pitch is off.'],
      ['Gain', 'Pre-amplifier gain (0–20×). Boosts quiet samples before the ' +
                 'main level control.'],
      ['Root', 'The MIDI note the sample is tuned to (0–127, default C4=60). ' +
                 'When Pitch is on, all other notes are transposed relative to this.'],
      ['Reverse', 'Play the sample region backwards.'],
      ['Loop', 'Loop playback between Start and (after the first pass) Loop Strt.'],
      ['Pitch', 'When on, keyboard notes transpose the playback rate relative to ' +
                 'Root. When off, the sample plays at the same pitch regardless of ' +
                 'the step note — drum/one-shot mode.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'wt-sampler': {
    title: 'SYNTH (WT Sampler)',
    blurb: 'A two-sample wavetable morphing machine. Loads two audio buffers (A ' +
           'and B) and smoothly crossfades between them via the Morph knob. ' +
           'A built-in Sweep LFO can automate the morph continuously.',
    items: [
      ['Morph', 'Crossfade position between sample A (0) and sample B (1). ' +
                 'At 0.5 both samples are blended equally. This is the primary ' +
                 'modulation target for evolving texture.'],
      ['Sweep Depth', 'Depth of the built-in morph sweep LFO (0–1). At 0 the ' +
                 'LFO is silent and Morph stays fixed. At 1 the LFO swings the ' +
                 'full morph range.'],
      ['Sweep Speed', 'Speed of the built-in morph sweep LFO in Hz (0.05–20 Hz). ' +
                 'Slow rates give gradual textural evolution; faster rates create ' +
                 'rhythmic or tremolo-like effects. Double-click the knob centre to ' +
                 'toggle HZ↔BPM; in BPM mode the rate locks to the tempo and snaps ' +
                 'to musical divisions. P-lockable in either mode.'],
      ['Start A–B / End A–B', 'Normalised playback region for each sample ' +
                 '(0–1). Trim each sample to a specific region independently.'],
      ['Gain A–B', 'Pre-amp level for each sample. Balance the two buffers so ' +
                 'the morph sweep sounds smooth rather than jumping in level.'],
      ['Root A–B', 'MIDI root note each sample is tuned to. The machine ' +
                 'transposes each sample relative to its root when Pitch is on.'],
      ['Speed', 'Playback rate multiplier for both samples (0.125×–4×).'],
      ['Pitch', 'When on, notes transpose playback relative to Root A/B. ' +
                 'When off, pitch-independent (drum mode).'],
      ['Loop', 'Loop playback of both samples.'],
      ['Reverse', 'Play both sample regions backwards.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },

  'sample-swarm': {
    title: 'SYNTH (Smp Swarm)',
    blurb: 'A sample-playback version of the Swarm machine. Seven voices play ' +
           'the loaded sample in a detuned cluster — one root voice at nominal ' +
           'pitch plus six swarm voices spread symmetrically above and below. ' +
           'Creates a dense, rich pad or ensemble texture from a single sample.',
    items: [
      ['Start / End', 'Normalised playback region (0–1).'],
      ['Speed', 'Playback rate multiplier (0.125×–4×).'],
      ['Gain', 'Pre-amp gain (0–4×).'],
      ['Root', 'MIDI root note the sample is tuned to.'],
      ['Spread', 'Detune spacing between swarm voices in cents (0–100¢).'],
      ['Height', 'Level of the 6 swarm voices relative to the root voice (0–1).'],
      ['Slope', 'Per-slot gain taper: 0=flat, negative=outer voices quieter, ' +
                 'positive=outer voices louder.'],
      ['Noise Amt', 'Random pitch drift depth in cents (0–50¢). Adds organic ' +
                 'wavering to the swarm voices.'],
      ['Noise Rate', 'Drift rate (0–1): how frequently the random drift updates.'],
      ['Reverse', 'Play the sample region backwards across all voices.'],
      ['Loop', 'Loop playback across all voices.'],
      ['Pitch', 'When on, notes transpose all voices relative to Root. ' +
                 'When off, pitch-independent drum mode.'],
      ['Level', 'Master output level for this machine (0–100%).'],
    ],
  },
};

/**
 * Overlay that renders one tab's manual section centered over the UI.
 * One instance, reused; `.show(tabKey)` swaps content and reveals it.
 */
export class ManualOverlay {
  constructor() {
    this._el = null;
    this._onKey = (e) => { if (e.key === 'Escape') this.hide(); };
  }

  _build() {
    const overlay = document.createElement('div');
    overlay.className = 'manual-overlay';
    overlay.addEventListener('pointerdown', (e) => {
      // Click outside the box closes; clicks inside it don't.
      if (e.target === overlay) this.hide();
    });

    const box = document.createElement('div');
    box.className = 'manual-box';
    overlay.appendChild(box);
    this._box = box;

    this._el = overlay;
    document.body.appendChild(overlay);
  }

  /**
   * @param {string} tabKey       — active tab name
   * @param {string} [machineType] — for the SYNTH tab, the loaded machine's
   *   type; selects a per-machine section if one exists in MACHINE_MANUAL.
   * @param {string} [fxType]      — for the FX tab, the selected block's type
   *   (delay/crush/.../phaser/normalizer); shows that effect's own entry.
   */
  show(tabKey, machineType, fxType) {
    if (!this._el) this._build();
    this._render(tabKey, machineType, fxType);
    this._el.style.display = 'flex';
    document.addEventListener('keydown', this._onKey);
  }

  hide() {
    if (!this._el) return;
    this._el.style.display = 'none';
    document.removeEventListener('keydown', this._onKey);
  }

  isOpen() { return !!this._el && this._el.style.display === 'flex'; }

  _render(tabKey, machineType, fxType) {
    const box = this._box;
    box.innerHTML = '';

    // FX tab with a block selected → that effect's own entry. Otherwise:
    // SYNTH tab prefers a per-machine section, else the generic tab entry.
    const onFxTab = tabKey === 'fx';
    const content = (onFxTab && fxType && MANUAL_CONTENT[fxType])
      ? MANUAL_CONTENT[fxType]
      : (tabKey === 'synth' && machineType && MACHINE_MANUAL[machineType])
        ? MACHINE_MANUAL[machineType]
        : MANUAL_CONTENT[tabKey];

    // Header row: title + close button.
    const head = document.createElement('div');
    head.className = 'manual-head';
    const h = document.createElement('div');
    h.className = 'manual-title';
    h.textContent = content ? content.title : (tabKey || '').toUpperCase();
    head.appendChild(h);

    const close = document.createElement('button');
    close.className = 'manual-close';
    close.textContent = '✕';
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.hide());
    head.appendChild(close);
    box.appendChild(head);

    // On the FX tab, a tip explaining the select/deselect → per-card manual flow.
    if (onFxTab) {
      const tip = document.createElement('p');
      tip.className = 'manual-tip';
      tip.textContent = fxType
        ? 'Showing the manual for the selected effect. Click its tile again to ' +
          'deselect, then reopen the manual for the FX-pipeline overview.'
        : 'Showing the FX-pipeline overview. Select an effect tile, then reopen ' +
          'the manual to read that effect\'s own page.';
      box.appendChild(tip);
    }

    if (!content) {
      const empty = document.createElement('p');
      empty.className = 'manual-empty';
      empty.textContent = 'This section isn\'t documented yet.';
      box.appendChild(empty);
      return;
    }

    const blurb = document.createElement('p');
    blurb.className = 'manual-blurb';
    blurb.textContent = content.blurb;
    box.appendChild(blurb);

    if (content.items && content.items.length) {
      const list = document.createElement('dl');
      list.className = 'manual-list';
      content.items.forEach(([name, desc]) => {
        const dt = document.createElement('dt');
        dt.textContent = name;
        const dd = document.createElement('dd');
        dd.textContent = desc;
        list.appendChild(dt);
        list.appendChild(dd);
      });
      box.appendChild(list);
    }
  }

  destroy() {
    document.removeEventListener('keydown', this._onKey);
    this._el?.remove();
    this._el = null;
  }
}
