/**
 * MultiSamplerMachine.js
 * ----------------------
 * Multi-zone sampler. Holds up to MAX_ZONES sample buffers, each mapped to a
 * velocity range (and pitched relative to its own root). On noteOn the machine
 * picks zones by the chosen `mode`:
 *   - 'velocity' : play every zone whose [loVel, hiVel] range contains the hit
 *                  velocity (layering quiet/loud samples for dynamics, like a
 *                  multisampled drum or velocity-switched instrument).
 *   - 'round'    : round-robin — each noteOn advances to the next loaded zone
 *                  (sample rotation for natural repeated hits / machine-gun fix).
 *
 * Each zone is a one-shot AudioBufferSourceNode (per noteOn), self-enveloping
 * like SamplerMachine; noteOff is a no-op. Per-zone trim (start/end) keeps the
 * "all sample machines can trim" guarantee.
 *
 * MULTI-buffer machine — it does NOT implement the single-buffer protocol
 * (no plain setBuffer/getBuffer). Instead it carries an array of zone sampleIds
 * in toJSON and exposes setBufferAt(i,…)/getBufferAt(i) + the per-zone reload
 * helper loadZoneBuffers(store, ctx). Track.fromJSON / SoundLibrary detect it by
 * `typeof machine.loadZoneBuffers === 'function'` and call that to reload.
 * Cross-type carry-over does not apply (the source is plural); syncFrom copies
 * all zone buffers to sibling voice slots.
 *
 * Audio graph (per zone hit):
 *   AudioBufferSourceNode → zone level → outputGain → [Filter]
 */

import { Machine } from './Machine.js';

export const MAX_ZONES = 4;

export class MultiSamplerMachine extends Machine {
  constructor(context) {
    super(context);
    this.type  = 'multi-sampler';
    this.label = 'Multi Sampler';

    // Flat params (one block per zone) so the existing param/p-lock/JSON
    // plumbing works unchanged. zoneN.* keys, plus the global mode + level.
    this._params = {
      'mode':         'velocity',  // 'velocity' | 'round'
      'sample.speed': 1,
      'output.level': 0.85,
    };
    for (let i = 0; i < MAX_ZONES; i++) {
      this._params[`zone${i}.loVel`]  = 0;
      this._params[`zone${i}.hiVel`]  = 127;
      this._params[`zone${i}.root`]   = 60;
      this._params[`zone${i}.level`]  = 1;
      this._params[`zone${i}.start`]  = 0;
      this._params[`zone${i}.end`]    = 1;
      this._params[`zone${i}.pitch`]  = true;   // track MIDI note
    }

    // Per-zone buffer state (parallel arrays, length MAX_ZONES).
    this._buffers     = new Array(MAX_ZONES).fill(null);
    this.zoneSampleIds   = new Array(MAX_ZONES).fill(null);
    this.zoneSampleNames = new Array(MAX_ZONES).fill('');
    // Remote source URL per zone (archive.org / curated). Persisted so a zone
    // re-fetches when its localStorage copy is missing — see loadZoneBuffers.
    this.zoneSampleUrls  = new Array(MAX_ZONES).fill(null);

    this._roundIdx = 0;        // round-robin cursor (authoritative on canonical slot-0)
    this._forcedRoundIdx = null; // set by syncFrom on a firing slot for one hit
    this._sources  = [];       // active sources for cleanup

    this.outputGain = context.createGain();
    this.outputGain.gain.value = this._params['output.level'];
  }

  // ── Multi-buffer management ─────────────────────────────────────────────────

  setBufferAt(i, buffer, id, name, url = undefined) {
    if (i < 0 || i >= MAX_ZONES) return;
    this._buffers[i]        = buffer;
    this.zoneSampleIds[i]   = id;
    this.zoneSampleNames[i] = name;
    // Only overwrite the url when one is passed (reloads from store don't carry
    // it and must not wipe the persisted source).
    if (url !== undefined) this.zoneSampleUrls[i] = url;
  }

  getBufferAt(i) { return this._buffers[i] ?? null; }
  hasBufferAt(i) { return this._buffers[i] != null; }
  get hasAnyBuffer() { return this._buffers.some(b => b != null); }

  clearBufferAt(i) {
    if (i < 0 || i >= MAX_ZONES) return;
    this._buffers[i]        = null;
    this.zoneSampleIds[i]   = null;
    this.zoneSampleNames[i] = '';
    this.zoneSampleUrls[i]  = null;
  }

  /** RESET helper: drop every zone buffer. */
  clearAllBuffers() {
    this._stopSources();
    for (let i = 0; i < MAX_ZONES; i++) this.clearBufferAt(i);
    this._roundIdx = 0;
  }

  /**
   * Reload every zone's buffer from a SampleStore (project / sound load).
   * Mirrors the single-buffer reload hooks but for the zone array. Detected by
   * Track.fromJSON / SoundLibrary via `typeof machine.loadZoneBuffers`.
   */
  loadZoneBuffers(store, ctx) {
    if (!store) return;
    for (let i = 0; i < MAX_ZONES; i++) {
      const id  = this.zoneSampleIds[i];
      const url = this.zoneSampleUrls[i];
      if (!id && !url) continue;
      store.load(id, ctx).then(async buf => {
        // Local copy missing (big samples don't fit localStorage) but we kept
        // the source URL — re-fetch + decode it (no store write).
        if (!buf && url) buf = await this._fetchUrlBuffer(url, ctx);
        if (buf) this.setBufferAt(i, buf, id, this.zoneSampleNames[i]);
      });
    }
  }

  /** Fetch + decode a remote zone sample URL. Returns null on any failure. */
  async _fetchUrlBuffer(url, ctx) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      return await ctx.decodeAudioData(bytes.slice(0));
    } catch (_) {
      return null;
    }
  }

  _stopSources() {
    for (const s of this._sources) {
      try { s.stop(); } catch (_) {}
      try { s.disconnect(); } catch (_) {}
    }
    this._sources = [];
  }

  // ── Machine protocol ───────────────────────────────────────────────────────

  /** Indices of zones that should sound for this hit. */
  _zonesForHit(velocity) {
    const loaded = [];
    for (let i = 0; i < MAX_ZONES; i++) if (this._buffers[i]) loaded.push(i);
    if (loaded.length === 0) return [];

    if (this._params['mode'] === 'round') {
      // Round-robin cursor. Each Track has 8 voice slots, each with its OWN
      // MultiSampler instance, and consecutive notes fire on DIFFERENT slots —
      // so a per-instance cursor never advances across hits. The authoritative
      // cursor therefore lives on the canonical slot-0 machine: nextVoice() calls
      // syncFrom(canonical) on the firing slot, which copies the canonical's
      // current index here (as `_forcedRoundIdx`) and advances the canonical's
      // cursor. So in round mode we honour a forced index when present; otherwise
      // (slot 0 fires directly, or single-machine use) we advance our own cursor.
      let pos;
      if (this._forcedRoundIdx != null) {
        pos = this._forcedRoundIdx;
        this._forcedRoundIdx = null;
      } else {
        pos = this._roundIdx;
        this._roundIdx = (this._roundIdx + 1) % loaded.length;
      }
      return [loaded[pos % loaded.length]];
    }
    // velocity layers: every loaded zone whose range contains the velocity.
    const hits = loaded.filter(i =>
      velocity >= this._params[`zone${i}.loVel`] &&
      velocity <= this._params[`zone${i}.hiVel`]);
    // If nothing matched (gappy ranges), fall back to the nearest loaded zone.
    return hits.length ? hits : [loaded[0]];
  }

  noteOn(midiNote, velocity, time) {
    if (!this.hasAnyBuffer) return;

    const zones = this._zonesForHit(velocity);
    const velScale = velocity / 127;
    const globalRate = this._params['sample.speed'] || 1;

    for (const i of zones) {
      const buf = this._buffers[i];
      if (!buf) continue;
      const dur   = buf.duration;
      const lo    = Math.min(this._params[`zone${i}.start`], this._params[`zone${i}.end`]);
      const hi    = Math.max(this._params[`zone${i}.start`], this._params[`zone${i}.end`]);
      const startSec = lo * dur;
      const lenSec   = Math.max(0.001, (hi - lo) * dur);

      const pitchRate = this._params[`zone${i}.pitch`]
        ? Math.pow(2, (midiNote - this._params[`zone${i}.root`]) / 12)
        : 1;

      const src  = this.context.createBufferSource();
      const gain = this.context.createGain();
      src.buffer = buf;
      src.playbackRate.value = globalRate * pitchRate;
      src.start(time, startSec, lenSec);

      const lvl = this._params['output.level'] * velScale * this._params[`zone${i}.level`];
      gain.gain.setValueAtTime(lvl, time);

      src.connect(gain);
      gain.connect(this.outputGain);
      this._sources.push(src);
      src.onended = () => {
        try { gain.disconnect(); } catch (_) {}
        this._sources = this._sources.filter(s => s !== src);
      };
    }
  }

  noteOff(_time) { /* self-enveloping */ }

  connect(destinationNode) { this.outputGain.connect(destinationNode); }

  disconnect() {
    this._stopSources();
    this.outputGain.disconnect();
  }

  setParam(path, value, time) {
    this._params[path] = value;
    if (path === 'output.level') {
      this.outputGain.gain.setTargetAtTime(value, time ?? this.context.currentTime, 0.01);
    }
  }

  getParam(path) { return this._params[path]; }

  resolveAudioParam(path) {
    if (path === 'output.level') return this.outputGain.gain;
    return null;
  }

  getParamList() {
    const list = [
      { path: 'mode',         label: 'Mode',  type: 'enum', options: ['velocity', 'round'], default: 'velocity', plockMode: 'js' },
      { path: 'sample.speed', label: 'Speed', type: 'number', min: 0.125, max: 4, default: 1, modulatable: false, plockMode: 'js' },
    ];
    for (let i = 0; i < MAX_ZONES; i++) {
      list.push(
        { path: `zone${i}.loVel`, label: `Z${i} LoV`,  type: 'number', min: 0, max: 127, default: 0,   modulatable: false, plockMode: 'js' },
        { path: `zone${i}.hiVel`, label: `Z${i} HiV`,  type: 'number', min: 0, max: 127, default: 127, modulatable: false, plockMode: 'js' },
        { path: `zone${i}.root`,  label: `Z${i} Root`, type: 'number', min: 0, max: 127, default: 60,  modulatable: false, plockMode: 'js' },
        { path: `zone${i}.level`, label: `Z${i} Lvl`,  type: 'number', min: 0, max: 4,   default: 1,   modulatable: false, plockMode: 'js' },
        { path: `zone${i}.start`, label: `Z${i} Strt`, type: 'number', min: 0, max: 1,   default: 0,   modulatable: false, plockMode: 'js' },
        { path: `zone${i}.end`,   label: `Z${i} End`,  type: 'number', min: 0, max: 1,   default: 1,   modulatable: false, plockMode: 'js' },
        { path: `zone${i}.pitch`, label: `Z${i} Pit`,  type: 'boolean', default: true,                 plockMode: 'js' },
      );
    }
    list.push(
      { path: 'output.level', label: 'Level', type: 'number', min: 0, max: 1, default: 0.85, modulatable: true, lfoMin: 0, lfoMax: 1, plockMode: 'audioParam' },
    );
    return list;
  }

  toJSON() {
    return {
      type:            this.type,
      zoneSampleIds:   [...this.zoneSampleIds],
      zoneSampleNames: [...this.zoneSampleNames],
      zoneSampleUrls:  [...this.zoneSampleUrls],  // remote sources; re-fetched if local copy is gone
      params:          { ...this._params },
    };
  }

  fromJSON(obj) {
    this.zoneSampleIds   = Array.isArray(obj.zoneSampleIds)
      ? obj.zoneSampleIds.slice(0, MAX_ZONES) : new Array(MAX_ZONES).fill(null);
    this.zoneSampleNames = Array.isArray(obj.zoneSampleNames)
      ? obj.zoneSampleNames.slice(0, MAX_ZONES) : new Array(MAX_ZONES).fill('');
    this.zoneSampleUrls  = Array.isArray(obj.zoneSampleUrls)
      ? obj.zoneSampleUrls.slice(0, MAX_ZONES) : new Array(MAX_ZONES).fill(null);
    // pad to MAX_ZONES
    while (this.zoneSampleIds.length   < MAX_ZONES) this.zoneSampleIds.push(null);
    while (this.zoneSampleNames.length < MAX_ZONES) this.zoneSampleNames.push('');
    while (this.zoneSampleUrls.length  < MAX_ZONES) this.zoneSampleUrls.push(null);
    Object.entries(obj.params ?? {}).forEach(([k, v]) => this.setParam(k, v));
  }

  /**
   * Copy all zone buffer references to a sibling voice slot (VoicePool sync),
   * called on the FIRING slot just before its noteOn. In round-robin mode this
   * is also where the shared cursor advances: we stamp this slot with the
   * canonical's current index (consumed once by the next noteOn) and advance the
   * canonical cursor, so rotation is correct no matter which slot plays.
   */
  syncFrom(other) {
    if (!(other instanceof MultiSamplerMachine)) return;
    for (let i = 0; i < MAX_ZONES; i++) {
      if (other._buffers[i] && other._buffers[i] !== this._buffers[i]) {
        this.setBufferAt(i, other._buffers[i], other.zoneSampleIds[i], other.zoneSampleNames[i]);
      }
    }
    if (other._params?.['mode'] === 'round') {
      const loadedCount = other._buffers.filter(b => b != null).length;
      if (loadedCount > 0) {
        this._forcedRoundIdx = other._roundIdx % loadedCount;
        other._roundIdx = (other._roundIdx + 1) % loadedCount;
      }
    }
  }
}
