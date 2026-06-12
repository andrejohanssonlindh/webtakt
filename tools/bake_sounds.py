#!/usr/bin/env python3
"""
bake_sounds.py
--------------
One-time / regeneratable bake of the factory sound presets into individual
JSON files under sounds/, plus a sounds/index.json manifest.

This is a faithful port of the mk()/patina() seed builders that used to live in
js/state/SoundLibrary.js _seed(). The arithmetic (ladderResToQ, envAmtFromHz,
patinaFX, moogMachine) is plain IEEE-754 double math, reproduced here so the
emitted files are field-for-field identical to what the old in-app seeding
produced — same ids, same numbers.

Factory files intentionally OMIT `createdAt` (the JS used Date.now()); the
loader defaults it, keeping rebuilds byte-stable.

Run from the repo root:  python3 tools/bake_sounds.py
"""

import json
import os
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(ROOT, "sounds")


# ── Default FX / filter / env blocks (ports of the _def* helpers) ──────────
def def_filter():
    return {"params": {"filter.type": "lowpass", "filter.cutoff": 8000, "filter.resonance": 1.0,
                       "filter.gain": 0, "filter.envAmount": 0.3, "base.lpf": 20000, "base.hpf": 20}}

def def_env():
    return {"params": {"env.attack": 0.01, "env.decay": 0.1, "env.sustain": 0.7, "env.release": 0.3,
                       "fenv.attack": 0.01, "fenv.decay": 0.2, "fenv.sustain": 0.0, "fenv.release": 0.3}}

def def_delay():
    return {"params": {"delay.time": 0.25, "delay.feedback": 0.3, "delay.wet": 0}, "enabled": False}

def def_crush():
    return {"params": {"crush.bits": 16, "crush.rate": 1.0, "crush.wet": 0}, "enabled": False}

def def_reverb():
    return {"params": {"reverb.decay": 1.5, "reverb.predelay": 0.02, "reverb.damp": 8000, "reverb.wet": 0}, "enabled": False}

def no_fx():
    return {"delayFX": def_delay(), "bitcrushFX": def_crush(), "reverbFX": def_reverb()}


# ── mk(): build a seed sound object ────────────────────────────────────────
def mk(name, tags, machine, filt=None, envelope=None, fx=None, opts=None):
    opts = opts or {}
    seed_id = "seed_" + "_".join(name.split()).lower()
    s = OrderedDict()
    s["id"] = seed_id
    s["name"] = name
    s["tags"] = ["AI"] + tags
    s["machine"] = machine
    s["filter"] = filt if filt is not None else def_filter()
    s["envelope"] = envelope if envelope is not None else def_env()
    # ...fx spread: delayFX, bitcrushFX, chorusFX?, reverbFX (order as in source)
    fx = fx or no_fx()
    for k in ("delayFX", "bitcrushFX", "chorusFX", "reverbFX"):
        if k in fx:
            s[k] = fx[k]
    s["analogue"] = opts.get("analogue", False)
    s["lfos"] = [{"params": {"lfo.waveform": "sine", "lfo.speed": 0.1, "lfo.speedMult": 1, "lfo.depth": 30}, "destPath": ""}]
    s["pan"] = 0
    s["trigTone"] = 0
    return s


# ── Patina → Webtakt mapping (ports of the closures in _seed) ──────────────
def ladder_res_to_q(r):
    return 0.1 + (min(max(r, 0), 1.15) / 1.15) * (20 - 0.1)

def env_amt_from_hz(amount_hz, cutoff):
    if amount_hz <= 0:
        return 0
    return min(1, amount_hz / max(1, 20000 - cutoff))

def patina_fx(fx=None):
    fx = fx or {}
    ch = fx.get("chorus", {})
    rv = fx.get("reverb", {})
    ch_mix = ch.get("mix", 0)
    rv_mix = rv.get("mix", 0)
    return {
        "delayFX": def_delay(),
        "bitcrushFX": def_crush(),
        "chorusFX": {
            "params": {"chorus.mix": ch_mix, "chorus.rate": ch.get("rate", 0.55), "chorus.depth": ch.get("depth", 0.5)},
            "enabled": ch_mix > 0,
        },
        "reverbFX": {
            "params": {
                "reverb.decay": rv.get("size", 1.5),
                "reverb.predelay": 0.02,
                "reverb.damp": 2000 + rv.get("tone", 0.4) * 14000,
                "reverb.wet": rv_mix,
            },
            "enabled": rv_mix > 0,
        },
    }

def moog_machine(oscs, sub=None, noise_level=0, character=None):
    sub = sub or {}
    character = character or {}
    p = OrderedDict()
    for i in range(3):
        osc = oscs[i] if i < len(oscs) else {"type": "saw", "octave": 0, "detune": 0, "level": 0}
        p[f"osc{i+1}.waveform"] = osc.get("type", "saw")
        p[f"osc{i+1}.octave"] = osc.get("octave", 0)
        p[f"osc{i+1}.detune"] = osc.get("detune", 0)
        p[f"osc{i+1}.level"] = (osc.get("level", 0.45) if i < len(oscs) else 0)
    p["sub.level"] = sub.get("level", 0)
    p["noise.level"] = noise_level
    p["drift"] = character.get("drift", 0.5)
    p["hum"] = character.get("hum", 0.15)
    p["humFreq"] = character.get("humFreq", 50)
    p["output.level"] = 0.8
    return {"type": "moogish", "params": p}

def patina(name, tags, P):
    f = P.get("filter", {})
    e = P.get("envelope", {})
    fe = P.get("filterEnvelope", {})
    cutoff = f.get("cutoff", 1400)
    machine = moog_machine(P.get("oscillators", []), P.get("sub"),
                           P.get("character", {}).get("noiseFloor", 0), P.get("character", {}))
    filt = {"params": {
        "filter.engine": "analogue",
        "filter.type": "lowpass",
        "filter.cutoff": cutoff,
        "filter.resonance": ladder_res_to_q(f.get("resonance", 0.25)),
        "filter.gain": 0,
        "filter.envAmount": env_amt_from_hz(fe.get("amount", 0), cutoff),
        "filter.drive": f.get("drive", 1.6),
        "filter.drift": 0.01,
        "filter.keytrack": f.get("keytrack", 0.4),
        "base.lpf": 20000,
        "base.hpf": 20,
    }}
    envelope = {"params": {
        "env.attack": e.get("attack", 0.01),
        "env.decay": e.get("decay", 0.25),
        "env.sustain": e.get("sustain", 0.7),
        "env.release": e.get("release", 0.35),
        "fenv.attack": fe.get("attack", 0.01),
        "fenv.decay": fe.get("decay", 0.3),
        "fenv.sustain": fe.get("sustain", 0.25),
        "fenv.release": fe.get("release", 0.3),
        "env.velSens": P.get("velocitySensitivity", 0.6),
    }}
    return mk(name, ["patina", "analogue"] + tags, machine, filt, envelope,
              patina_fx(P.get("fx")), {"analogue": True})


# ── The seeds (1:1 transcription of the array in _seed) ─────────────────────
def build_seeds():
    seeds = []
    seeds.append(mk("Dark Sub Bass", ["bass", "dark", "mono"],
        {"type": "synth", "params": {"osc.waveform": "sawtooth", "osc.detune": 0, "sub.level": 0.85, "sub.waveform": "sine", "output.level": 0.9}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 420, "filter.resonance": 2.2, "filter.gain": 0, "filter.envAmount": 0.18, "base.lpf": 20000, "base.hpf": 28}},
        {"params": {"env.attack": 0.02, "env.decay": 0.25, "env.sustain": 0.85, "env.release": 0.4, "fenv.attack": 0.01, "fenv.decay": 0.18, "fenv.sustain": 0.0, "fenv.release": 0.2}},
        no_fx()))

    seeds.append(mk("Acid Lead", ["lead", "acid", "bright"],
        {"type": "synth", "params": {"osc.waveform": "sawtooth", "osc.detune": 0, "sub.level": 0.1, "sub.waveform": "square", "output.level": 0.8}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 700, "filter.resonance": 14, "filter.gain": 0, "filter.envAmount": 0.7, "base.lpf": 20000, "base.hpf": 40}},
        {"params": {"env.attack": 0.005, "env.decay": 0.15, "env.sustain": 0.5, "env.release": 0.18, "fenv.attack": 0.001, "fenv.decay": 0.12, "fenv.sustain": 0.0, "fenv.release": 0.1}},
        no_fx()))

    seeds.append(mk("Pad Wide", ["pad", "ambient", "lush"],
        {"type": "synth", "params": {"osc.waveform": "sawtooth", "osc.detune": 14, "sub.level": 0.4, "sub.waveform": "sine", "output.level": 0.75}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 2800, "filter.resonance": 1.2, "filter.gain": 0, "filter.envAmount": 0.08, "base.lpf": 20000, "base.hpf": 60}},
        {"params": {"env.attack": 0.55, "env.decay": 0.3, "env.sustain": 0.9, "env.release": 1.6, "fenv.attack": 0.4, "fenv.decay": 0.5, "fenv.sustain": 0.0, "fenv.release": 0.8}},
        {"delayFX": {"params": {"delay.time": 0.375, "delay.feedback": 0.45, "delay.wet": 0.35}, "enabled": True}, "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 3.5, "reverb.predelay": 0.02, "reverb.damp": 8000, "reverb.wet": 0.4}, "enabled": True}}))

    seeds.append(mk("Pluck", ["pluck", "bright", "percussive"],
        {"type": "synth", "params": {"osc.waveform": "triangle", "osc.detune": 0, "sub.level": 0.15, "sub.waveform": "sine", "output.level": 0.85}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 3500, "filter.resonance": 1.8, "filter.gain": 0, "filter.envAmount": 0.6, "base.lpf": 18000, "base.hpf": 30}},
        {"params": {"env.attack": 0.001, "env.decay": 0.28, "env.sustain": 0.0, "env.release": 0.35, "fenv.attack": 0.001, "fenv.decay": 0.2, "fenv.sustain": 0.0, "fenv.release": 0.15}},
        {"delayFX": {"params": {"delay.time": 0.25, "delay.feedback": 0.3, "delay.wet": 0.22}, "enabled": True}, "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 1.2, "reverb.predelay": 0.01, "reverb.damp": 12000, "reverb.wet": 0.18}, "enabled": True}}))

    seeds.append(mk("Warm Keys", ["keys", "warm", "melodic"],
        {"type": "synth", "params": {"osc.waveform": "square", "osc.detune": 0, "sub.level": 0.3, "sub.waveform": "sine", "output.level": 0.78}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 1800, "filter.resonance": 1.0, "filter.gain": 0, "filter.envAmount": 0.3, "base.lpf": 20000, "base.hpf": 20}},
        {"params": {"env.attack": 0.008, "env.decay": 0.35, "env.sustain": 0.55, "env.release": 0.6, "fenv.attack": 0.005, "fenv.decay": 0.3, "fenv.sustain": 0.0, "fenv.release": 0.4}},
        no_fx()))

    seeds.append(mk("Bell FM", ["fm", "bell", "melodic", "bright"],
        {"type": "fm", "params": {
            "op1.ratio": 1.0, "op1.level": 0.9, "op1.detune": 0, "op1.env.a": 0.001, "op1.env.d": 0.8, "op1.env.s": 0.0, "op1.env.r": 1.2,
            "op2.ratio": 3.5, "op2.level": 0.55, "op2.feedback": 0.0, "op2.detune": 0, "op2.env.a": 0.001, "op2.env.d": 0.3, "op2.env.s": 0.0, "op2.env.r": 0.4,
            "op3.ratio": 7.0, "op3.level": 0.22, "op3.detune": 0, "op3.env.a": 0.001, "op3.env.d": 0.12, "op3.env.s": 0.0, "op3.env.r": 0.1,
            "op4.ratio": 14.0, "op4.level": 0.08, "op4.detune": 0, "op4.env.a": 0.001, "op4.env.d": 0.06, "op4.env.s": 0.0, "op4.env.r": 0.05,
            "output.level": 0.8}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 12000, "filter.resonance": 1.0, "filter.gain": 0, "filter.envAmount": 0, "base.lpf": 20000, "base.hpf": 20}},
        {"params": {"env.attack": 0.001, "env.decay": 1.2, "env.sustain": 0.0, "env.release": 1.5, "fenv.attack": 0.001, "fenv.decay": 0.2, "fenv.sustain": 0.0, "fenv.release": 0.3}},
        {"delayFX": def_delay(), "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 2.0, "reverb.predelay": 0.01, "reverb.damp": 14000, "reverb.wet": 0.3}, "enabled": True}}))

    seeds.append(mk("FM Bass", ["fm", "bass", "punchy"],
        {"type": "fm", "params": {
            "op1.ratio": 1.0, "op1.level": 1.0, "op1.detune": 0, "op1.env.a": 0.001, "op1.env.d": 0.4, "op1.env.s": 0.6, "op1.env.r": 0.2,
            "op2.ratio": 1.0, "op2.level": 0.8, "op2.feedback": 0.25, "op2.detune": 0, "op2.env.a": 0.001, "op2.env.d": 0.08, "op2.env.s": 0.0, "op2.env.r": 0.05,
            "op3.ratio": 2.0, "op3.level": 0.3, "op3.detune": 0, "op3.env.a": 0.001, "op3.env.d": 0.05, "op3.env.s": 0.0, "op3.env.r": 0.05,
            "op4.ratio": 3.0, "op4.level": 0.12, "op4.detune": 0, "op4.env.a": 0.001, "op4.env.d": 0.04, "op4.env.s": 0.0, "op4.env.r": 0.04,
            "output.level": 0.85}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 900, "filter.resonance": 2.0, "filter.gain": 0, "filter.envAmount": 0.35, "base.lpf": 20000, "base.hpf": 35}},
        {"params": {"env.attack": 0.002, "env.decay": 0.35, "env.sustain": 0.65, "env.release": 0.25, "fenv.attack": 0.001, "fenv.decay": 0.18, "fenv.sustain": 0.0, "fenv.release": 0.1}},
        no_fx()))

    seeds.append(mk("Kalimba FM", ["fm", "melodic", "percussive", "world"],
        {"type": "fm", "params": {
            "op1.ratio": 1.0, "op1.level": 0.85, "op1.detune": 0, "op1.env.a": 0.001, "op1.env.d": 0.7, "op1.env.s": 0.0, "op1.env.r": 0.9,
            "op2.ratio": 2.756, "op2.level": 0.4, "op2.feedback": 0.0, "op2.detune": 8, "op2.env.a": 0.001, "op2.env.d": 0.25, "op2.env.s": 0.0, "op2.env.r": 0.2,
            "op3.ratio": 5.0, "op3.level": 0.12, "op3.detune": -5, "op3.env.a": 0.001, "op3.env.d": 0.1, "op3.env.s": 0.0, "op3.env.r": 0.1,
            "op4.ratio": 8.0, "op4.level": 0.05, "op4.detune": 0, "op4.env.a": 0.001, "op4.env.d": 0.06, "op4.env.s": 0.0, "op4.env.r": 0.05,
            "output.level": 0.8}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 10000, "filter.resonance": 1.0, "filter.gain": 0, "filter.envAmount": 0, "base.lpf": 20000, "base.hpf": 20}},
        {"params": {"env.attack": 0.001, "env.decay": 0.9, "env.sustain": 0.0, "env.release": 1.0, "fenv.attack": 0.001, "fenv.decay": 0.2, "fenv.sustain": 0.0, "fenv.release": 0.3}},
        {"delayFX": def_delay(), "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 1.8, "reverb.predelay": 0.01, "reverb.damp": 16000, "reverb.wet": 0.25}, "enabled": True}}))

    seeds.append(mk("Marble Machine", ["fm", "melodic", "percussive", "metallic"],
        {"type": "fm", "params": {
            "op1.ratio": 1.0, "op1.level": 0.9, "op1.detune": 0, "op1.env.a": 0.001, "op1.env.d": 0.55, "op1.env.s": 0.0, "op1.env.r": 0.8,
            "op2.ratio": 3.502, "op2.level": 0.62, "op2.feedback": 0.05, "op2.detune": 12, "op2.env.a": 0.001, "op2.env.d": 0.18, "op2.env.s": 0.0, "op2.env.r": 0.12,
            "op3.ratio": 8.1, "op3.level": 0.22, "op3.detune": -7, "op3.env.a": 0.001, "op3.env.d": 0.09, "op3.env.s": 0.0, "op3.env.r": 0.06,
            "op4.ratio": 14.3, "op4.level": 0.08, "op4.detune": 5, "op4.env.a": 0.001, "op4.env.d": 0.04, "op4.env.s": 0.0, "op4.env.r": 0.03,
            "output.level": 0.82}},
        {"params": {"filter.type": "lowpass", "filter.cutoff": 14000, "filter.resonance": 1.0, "filter.gain": 0, "filter.envAmount": 0, "base.lpf": 20000, "base.hpf": 30}},
        {"params": {"env.attack": 0.001, "env.decay": 0.6, "env.sustain": 0.0, "env.release": 0.9, "fenv.attack": 0.001, "fenv.decay": 0.15, "fenv.sustain": 0.0, "fenv.release": 0.2}},
        {"delayFX": def_delay(), "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 1.4, "reverb.predelay": 0.01, "reverb.damp": 15000, "reverb.wet": 0.22}, "enabled": True}}))

    seeds.append(mk("Silk Kick", ["kick", "drum", "round"],
        {"type": "kick.silk", "params": {"tune": 55, "decay": 0.5, "sweep": 5.5, "punch": 0.8, "punch.decay": 0.022, "output.level": 0.95}},
        def_filter(), def_env(), no_fx()))

    seeds.append(mk("Room Snare", ["snare", "drum", "punchy"],
        {"type": "snare", "params": {"tune": 220, "decay": 0.22, "snap": 0.9, "tone": 0.45, "noise.cutoff": 2400, "output.level": 0.88}},
        {"params": {"filter.type": "highpass", "filter.cutoff": 120, "filter.resonance": 1.0, "filter.gain": 0, "filter.envAmount": 0, "base.lpf": 20000, "base.hpf": 80}},
        def_env(),
        {"delayFX": def_delay(), "bitcrushFX": def_crush(), "reverbFX": {"params": {"reverb.decay": 0.8, "reverb.predelay": 0.005, "reverb.damp": 6000, "reverb.wet": 0.28}, "enabled": True}}))

    # ── Patina presets ──
    seeds.append(patina("Patina Init", ["init"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -6, "level": 0.5}, {"type": "saw", "octave": 0, "detune": 7, "level": 0.5}],
        "filter": {"cutoff": 1400, "resonance": 0.25, "drive": 1.6, "keytrack": 0.4},
        "envelope": {"attack": 0.01, "decay": 0.25, "sustain": 0.7, "release": 0.35},
        "filterEnvelope": {"attack": 0.01, "decay": 0.30, "sustain": 0.25, "release": 0.30, "amount": 2200},
        "character": {"drift": 0.5, "noiseFloor": 0.35, "hum": 0.15, "humFreq": 50}}))

    seeds.append(patina("Patina Warm Pad", ["pad", "lush"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -9, "level": 0.42}, {"type": "saw", "octave": 0, "detune": 8, "level": 0.42}, {"type": "triangle", "octave": -1, "detune": 2, "level": 0.35}],
        "filter": {"cutoff": 900, "resonance": 0.18, "drive": 1.8, "keytrack": 0.3},
        "envelope": {"attack": 0.9, "decay": 1.2, "sustain": 0.8, "release": 1.8},
        "filterEnvelope": {"attack": 1.4, "decay": 1.6, "sustain": 0.5, "release": 1.6, "amount": 1100},
        "character": {"drift": 0.7, "noiseFloor": 0.45, "hum": 0.2},
        "fx": {"chorus": {"mix": 0.55, "rate": 0.5, "depth": 0.6}, "reverb": {"mix": 0.3, "size": 3.2, "tone": 0.35}}}))

    seeds.append(patina("Patina Fat Bass", ["bass", "mono"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -4, "level": 0.55}, {"type": "square", "octave": 0, "detune": 5, "level": 0.4}],
        "sub": {"level": 0.55},
        "filter": {"cutoff": 420, "resonance": 0.35, "drive": 3.2, "keytrack": 0.5},
        "envelope": {"attack": 0.004, "decay": 0.3, "sustain": 0.55, "release": 0.12},
        "filterEnvelope": {"attack": 0.004, "decay": 0.22, "sustain": 0.15, "release": 0.1, "amount": 2600},
        "character": {"drift": 0.4, "noiseFloor": 0.25, "hum": 0.1},
        "fx": {"chorus": {"mix": 0}, "reverb": {"mix": 0}}}))

    seeds.append(patina("Patina Screaming Lead", ["lead", "mono"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -3, "level": 0.55}, {"type": "saw", "octave": 1, "detune": 4, "level": 0.35}],
        "filter": {"cutoff": 2400, "resonance": 0.55, "drive": 4.0, "keytrack": 0.6},
        "envelope": {"attack": 0.01, "decay": 0.2, "sustain": 0.85, "release": 0.2},
        "filterEnvelope": {"attack": 0.01, "decay": 0.35, "sustain": 0.4, "release": 0.2, "amount": 3200},
        "character": {"drift": 0.6, "noiseFloor": 0.3, "hum": 0.15},
        "fx": {"chorus": {"mix": 0.2, "rate": 0.7, "depth": 0.4}, "reverb": {"mix": 0.18, "size": 1.8, "tone": 0.5}}}))

    seeds.append(patina("Patina String Machine", ["strings", "lush"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -11, "level": 0.4}, {"type": "saw", "octave": 0, "detune": 10, "level": 0.4}, {"type": "saw", "octave": 1, "detune": -5, "level": 0.22}],
        "filter": {"cutoff": 2600, "resonance": 0.08, "drive": 1.3, "keytrack": 0.4},
        "envelope": {"attack": 0.35, "decay": 0.5, "sustain": 0.85, "release": 0.9},
        "filterEnvelope": {"attack": 0.4, "decay": 0.5, "sustain": 0.6, "release": 0.8, "amount": 500},
        "character": {"drift": 0.8, "noiseFloor": 0.5, "hum": 0.25},
        "fx": {"chorus": {"mix": 0.85, "rate": 0.65, "depth": 0.8}, "reverb": {"mix": 0.25, "size": 2.6, "tone": 0.4}}}))

    seeds.append(patina("Patina EP Keys", ["keys", "ep"], {
        "oscillators": [{"type": "sine", "octave": 0, "detune": -2, "level": 0.6}, {"type": "triangle", "octave": 1, "detune": 3, "level": 0.18}],
        "sub": {"level": 0.2},
        "filter": {"cutoff": 1900, "resonance": 0.12, "drive": 2.2, "keytrack": 0.7},
        "envelope": {"attack": 0.003, "decay": 1.6, "sustain": 0.25, "release": 0.5},
        "filterEnvelope": {"attack": 0.002, "decay": 0.7, "sustain": 0.1, "release": 0.4, "amount": 1500},
        "velocitySensitivity": 0.85,
        "character": {"drift": 0.35, "noiseFloor": 0.3, "hum": 0.2},
        "fx": {"chorus": {"mix": 0.4, "rate": 0.8, "depth": 0.5}, "reverb": {"mix": 0.22, "size": 2.0, "tone": 0.45}}}))

    seeds.append(patina("Patina Acid 303", ["acid", "mono"], {
        "oscillators": [{"type": "square", "octave": 0, "detune": 0, "level": 0.7}],
        "filter": {"cutoff": 320, "resonance": 0.92, "drive": 2.6, "keytrack": 0.4},
        "envelope": {"attack": 0.003, "decay": 0.18, "sustain": 0.0, "release": 0.08},
        "filterEnvelope": {"attack": 0.003, "decay": 0.22, "sustain": 0.0, "release": 0.1, "amount": 3400},
        "character": {"drift": 0.45, "noiseFloor": 0.2, "hum": 0.1},
        "fx": {"chorus": {"mix": 0}, "reverb": {"mix": 0.1, "size": 1.2, "tone": 0.5}}}))

    seeds.append(patina("Patina Poly Brass", ["brass"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": -7, "level": 0.5}, {"type": "saw", "octave": 0, "detune": 6, "level": 0.5}],
        "filter": {"cutoff": 700, "resonance": 0.3, "drive": 2.4, "keytrack": 0.5},
        "envelope": {"attack": 0.06, "decay": 0.25, "sustain": 0.85, "release": 0.25},
        "filterEnvelope": {"attack": 0.09, "decay": 0.4, "sustain": 0.45, "release": 0.25, "amount": 2800},
        "character": {"drift": 0.6, "noiseFloor": 0.35, "hum": 0.2},
        "fx": {"chorus": {"mix": 0.25, "rate": 0.6, "depth": 0.4}, "reverb": {"mix": 0.15, "size": 1.8, "tone": 0.5}}}))

    seeds.append(patina("Patina Haunted Organ", ["organ", "dark"], {
        "oscillators": [{"type": "pulse", "octave": 0, "detune": -5, "level": 0.4}, {"type": "pulse", "octave": 0, "detune": 6, "level": 0.4}, {"type": "sine", "octave": 1, "detune": 0, "level": 0.2}],
        "sub": {"level": 0.3},
        "filter": {"cutoff": 1500, "resonance": 0.2, "drive": 1.8, "keytrack": 0.3},
        "envelope": {"attack": 0.05, "decay": 0.1, "sustain": 1.0, "release": 0.4},
        "filterEnvelope": {"attack": 0.05, "decay": 0.2, "sustain": 0.8, "release": 0.4, "amount": 300},
        "character": {"drift": 0.9, "noiseFloor": 0.6, "hum": 0.4},
        "fx": {"chorus": {"mix": 0.5, "rate": 0.4, "depth": 0.7}, "reverb": {"mix": 0.45, "size": 3.6, "tone": 0.3}}}))

    seeds.append(patina("Patina Whistle", ["whistle", "mono", "self-osc"], {
        "oscillators": [{"type": "saw", "octave": 0, "detune": 0, "level": 0.0}],
        "filter": {"cutoff": 800, "resonance": 1.08, "drive": 1.2, "keytrack": 1.0},
        "envelope": {"attack": 0.05, "decay": 0.3, "sustain": 0.8, "release": 0.6},
        "filterEnvelope": {"attack": 0.05, "decay": 0.3, "sustain": 1.0, "release": 0.6, "amount": 0},
        "character": {"drift": 0.8, "noiseFloor": 0.4, "hum": 0.1},
        "fx": {"chorus": {"mix": 0.3, "rate": 0.5, "depth": 0.5}, "reverb": {"mix": 0.4, "size": 3.0, "tone": 0.35}}}))

    return seeds


def filename_for(seed_id):
    # seed_dark_sub_bass -> dark-sub-bass.json
    return seed_id[len("seed_"):].replace("_", "-") + ".json"


def main():
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    seeds = build_seeds()
    manifest = []
    for s in seeds:
        fn = filename_for(s["id"])
        manifest.append(fn)
        with open(os.path.join(SOUNDS_DIR, fn), "w") as f:
            json.dump(s, f, indent=2)
            f.write("\n")
    with open(os.path.join(SOUNDS_DIR, "index.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"Baked {len(seeds)} sounds + index.json into {SOUNDS_DIR}")
    for fn in manifest:
        print("  ", fn)


if __name__ == "__main__":
    main()
