/**
 * sync-osc-processor.js
 * ---------------------
 * Hard-sync oscillator — a "slave" saw whose phase is reset every time a "master"
 * oscillator completes a cycle. Web Audio's native OscillatorNode has no
 * phase-reset, so the classic metallic hard-sync sweep needs a custom worklet.
 *
 * Used by MoogishMachine when `osc2.sync` is on: osc2's native oscillator is
 * detached and this node drives osc2's mix gain instead, synced to osc1's pitch.
 * Loaded once at app boot by AudioEngine (addModule) so construction is
 * synchronous; MoogishMachine self-heals if it switches before the load resolves
 * (mirrors Filter.js's analogue-ladder pattern).
 *
 * The audible pitch is the MASTER's; the SLAVE's frequency sets the timbre (how
 * far through its waveform it gets before being reset → the sync formant). A
 * PolyBLEP correction band-limits the saw's discontinuities (its own reset edge
 * and the master-forced reset) to keep the sweep musical rather than fizzy.
 *
 * AudioParams:
 *   masterFreq — Hz, a-rate (the played pitch; LFO/env on osc1 ride this)
 *   slaveFreq  — Hz, a-rate (the sync timbre; this is what you sweep)
 *
 * Messages:
 *   'kill' — stop processing (lets VoicePool drop the node cleanly)
 */

class SyncOsc extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'masterFreq', defaultValue: 261.63, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'slaveFreq',  defaultValue: 261.63, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this._master = 0;   // master phase, 0..1
    this._slave  = 0;   // slave phase, 0..1
    this.alive   = true;
    this.port.onmessage = (e) => { if (e.data === 'kill') this.alive = false; };
  }

  // PolyBLEP residual at normalised phase t with per-sample increment dt.
  // Smooths the 1-sample step at a saw discontinuity (t≈0 and t≈1).
  static _blep(t, dt) {
    if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
    if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
    return 0;
  }

  process(inputs, outputs, p) {
    if (!this.alive) return false;
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const ch0 = out[0];
    const n   = ch0.length;
    const sr  = sampleRate;

    const mf = p.masterFreq;
    const sf = p.slaveFreq;
    const mARate = mf.length > 1;
    const sARate = sf.length > 1;

    let master = this._master;
    let slave  = this._slave;

    for (let i = 0; i < n; i++) {
      const mInc = Math.max(0, (mARate ? mf[i] : mf[0])) / sr;
      const sInc = Math.max(0, (sARate ? sf[i] : sf[0])) / sr;

      // Slave saw: phase 0..1 → −1..+1, PolyBLEP-corrected at its own wrap.
      let y = 2 * slave - 1;
      y -= SyncOsc._blep(slave, sInc || 1e-9);

      ch0[i] = y;

      // Advance slave; wrap at 1.
      slave += sInc;
      if (slave >= 1) slave -= 1;

      // Advance master; when it wraps, HARD-SYNC: reset the slave phase. The
      // forced reset is the edge that creates the sync timbre.
      master += mInc;
      if (master >= 1) {
        master -= 1;
        // Reset slave proportionally to how far past the boundary the master is,
        // so the reset is sample-accurate rather than quantised to the block.
        slave = mInc > 0 ? (master / mInc) * sInc : 0;
        if (slave >= 1) slave -= 1;
      }
    }

    // Fan to any extra channels (mono source).
    for (let ch = 1; ch < out.length; ch++) out[ch].set(ch0);

    this._master = master;
    this._slave  = slave;
    return true;
  }
}

registerProcessor('sync-osc', SyncOsc);
