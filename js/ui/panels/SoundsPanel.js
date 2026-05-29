/**
 * SoundsPanel.js
 * --------------
 * SOUNDS tab: wraps SoundLibraryPanel, wiring its load + preview callbacks.
 * Preview triggers a one-shot of the previewed sound on the track, then
 * restores the prior track state after the release tail. Extracted from
 * SynthPanel._renderSounds.
 *
 * Receives the standard panel context (see SynthPanel._makeTabContext):
 *   { container, state, library, openModal, renderContent }
 */

import { SoundLibraryPanel } from './SoundLibraryPanel.js';

export class SoundsPanel {
  render(ctx) {
    const { container, state, library, openModal, renderContent } = ctx;

    new SoundLibraryPanel(
      container,
      library,
      state,
      openModal,
      () => {
        // After loading a sound: re-render everything
        state.emit('trackSelected', {
          index: state.selectedTrackIndex,
          track: state.selectedTrack,
        });
        renderContent();
      },
      async (soundId) => {
        const track = state.selectedTrack;
        if (!track) return;
        const audio = state.project.audio;
        const ctxAudio = audio.context;

        // Snapshot current track state so we can restore after preview
        const snapshot = track.toJSON();

        // Load the preview sound onto the track
        library.load(soundId, track);

        // For samplers the buffer restore is async — wait for it before triggering.
        if (track.machine.type === 'sampler' && track.machine.sampleId) {
          const sampleStore = state.project.sampleStore;
          const buf = await sampleStore?.load(track.machine.sampleId, ctxAudio);
          if (buf) track.machine.setBuffer(buf, track.machine.sampleId, track.machine.sampleName);
        }
        if (track.machine.type === 'wt-sampler') {
          const sampleStore = state.project.sampleStore;
          if (track.machine.sampleIdA) {
            const buf = await sampleStore?.load(track.machine.sampleIdA, ctxAudio);
            if (buf) track.machine.setBufferA(buf, track.machine.sampleIdA, track.machine.sampleNameA);
          }
          if (track.machine.sampleIdB) {
            const buf = await sampleStore?.load(track.machine.sampleIdB, ctxAudio);
            if (buf) track.machine.setBufferB(buf, track.machine.sampleIdB, track.machine.sampleNameB);
          }
        }

        const time = ctxAudio.currentTime + 0.015;
        let restoreDelay;

        if (track.machine.type === 'sampler' && track.machine.hasBuffer) {
          const buf     = track.machine._buffer;
          const start   = track.machine.getParam('sample.start');
          const end     = track.machine.getParam('sample.end');
          const speed   = track.machine.getParam('sample.speed') || 1;
          const trimSec = Math.min((end - start) * buf.duration / speed, 8);
          restoreDelay  = (trimSec + 0.1) * 1000;

          // Hold amp envelope open — buffer source stops itself at end of region.
          track.envelope.noteOn(ctxAudio.currentTime);
          track.machine.noteOn(60, 100, time);
        } else {
          const offTime = time + 0.5;
          const release = track.envelope._params['env.release'] ?? 0.3;
          restoreDelay  = (offTime - ctxAudio.currentTime + release + 0.05) * 1000;

          track.machine.noteOn(60, 100, time);
          track.envelope.noteOn(time);
          track.machine.noteOff(offTime);
          track.envelope.noteOff(offTime);
        }

        setTimeout(() => {
          // Close the envelope and wait for the full release tail before
          // restoring — otherwise the new synth oscillator bleeds through.
          const release = track.envelope._params['env.release'] ?? 0.3;
          track.envelope.noteOff(ctxAudio.currentTime);
          setTimeout(() => track.fromJSON(snapshot), (release + 0.05) * 1000);
        }, restoreDelay);
      }
    );
  }
}
