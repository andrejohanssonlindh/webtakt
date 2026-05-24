# Audio Test Suite

Located in `tests/`. Runs entirely in the browser against `OfflineAudioContext` — no speakers required.

**Entry points:**
- `tests/index.html` — run all tests, results rendered in-page and written to `localStorage`
- `tests/results.html` — read last results from `localStorage` (used for post-run inspection)

**Architecture:**
- `tests/runner.js` — shared harness: `makeOfflineTrack(type, duration)` builds a full `Track` against an offline context using shims for `AudioEngine` and `Clock`; `renderSteps()` fires N steps via `sequencer._fireStep()` directly (bypassing the Clock loop); `rms()`, `spectralCentroid()`, `bandEnergy()` measure the rendered buffer
- `tests/tests/lfo.js` — LFO produces variation (depth=0 → flat centroid, depth=100 → varying centroid); TRG mode determinism
- `tests/tests/plocks.js` — p-lock values reach AudioParam; params restore after step gate; note pitch affects centroid
- `tests/tests/machines/*.js` — one file per machine; tests: produces sound (RMS > threshold) + spectral character (low/high energy distribution, centroid shifts with note)

**Machines covered:** synth, kick.silk, kick.hard, snare, hihat, fm, bass, karplus, noise, transient, cymbal, wood, wavetable, comb, chord, swarm

**Not tested:** wt-sampler (uses AudioWorklet, not supported in OfflineAudioContext); sampler (requires file/buffer loading)

**How the Clock shim works:** `Clock._secondsPerTick` is a pure calculation (`60 / bpm * 4`). The shim exposes this plus no-op `register/unregister`. Tests inject step times manually so the setTimeout loop is never started.
