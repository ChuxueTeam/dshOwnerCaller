"""Generate the built-in notification sounds shipped with dsh-caller.

Pure numpy + stdlib wave: additive bell partials with an exponential decay
envelope, normalized to -1.5 dBFS and written as 16-bit mono PCM.

Each sound ends with a short silence on purpose: the popup rings in a loop
until the owner closes it, and a gap makes the repeat sound like a bell
instead of one continuous drone. The spoken default is padded the same way
(its raw SAPI output is `voice-default-raw.wav`).
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

import numpy as np

SR = 44_100
ASSETS = Path(__file__).resolve().parent.parent / "assets"
TAIL_SECONDS = 0.6
VOICE_TAIL_SECONDS = 1.05


def bell(freq: float, dur: float, amp: float = 1.0, decay: float = 6.0, detune: float = 0.0) -> np.ndarray:
    """One struck-bell tone: fundamental + inharmonic partials, exponential decay."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.exp(-decay * t)
    # short 4 ms raised-cosine attack so the onset never clicks
    attack = int(SR * 0.004)
    if attack:
        env[:attack] *= 0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, attack))
    wave_ = np.zeros(n)
    for ratio, weight in ((1.0, 1.0), (2.0, 0.32), (2.76, 0.18), (5.4, 0.08)):
        f = freq * ratio * (1.0 + detune * (ratio - 1.0))
        wave_ += weight * np.sin(2.0 * math.pi * f * t)
    return amp * env * wave_


def mix(*layers: tuple[np.ndarray, float]) -> np.ndarray:
    total = max(len(part) for part, _ in layers)
    out = np.zeros(total)
    for part, gain in layers:
        out[: len(part)] += gain * part
    return out


def pad(signal: np.ndarray, dur: float) -> np.ndarray:
    n = int(SR * dur)
    if len(signal) >= n:
        return signal[:n]
    return np.concatenate([signal, np.zeros(n - len(signal))])


def write_wav(path: Path, signal: np.ndarray) -> None:
    peak = float(np.max(np.abs(signal))) or 1.0
    signal = signal / peak * (10 ** (-1.5 / 20.0))
    pcm = np.clip(signal * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        fh.writeframes(struct.pack("<%dh" % len(pcm), *pcm.tolist()))
    print(f"{path.name}: {len(pcm) / SR:.2f}s, {path.stat().st_size / 1024:.0f} KiB")


def pad_tail(path: Path, seconds: float) -> None:
    """Append silence so a looping playback has a gap between repeats."""
    with wave.open(str(path), "rb") as fh:
        params = fh.getparams()
        frames = fh.readframes(fh.getnframes())
    silence = int(params.framerate * params.sampwidth * params.nchannels * seconds)
    silence -= silence % max(1, params.sampwidth * params.nchannels)
    with wave.open(str(path), "wb") as fh:
        fh.setparams(params)
        fh.writeframes(frames + b"\x00" * silence)
    total = (len(frames) + silence) / (params.framerate * params.sampwidth * params.nchannels)
    print(f"  + {seconds:.2f}s 尾静音 → {path.name}: {total:.2f}s")


def build_voice_default() -> None:
    """Turn the raw SAPI output into the shipped default, with a tail."""
    raw = Path(__file__).resolve().parent / "voice-default-raw.wav"
    if not raw.exists():
        print("voice-default-raw.wav 不存在，跳过（先跑 tools/make_voice.ps1）")
        return
    target = ASSETS / "voice-default.wav"
    target.write_bytes(raw.read_bytes())
    print(f"{target.name}: 来自 {raw.name}")
    pad_tail(target, VOICE_TAIL_SECONDS)


def chime_clear() -> np.ndarray:
    """Bright two-note doorbell: C6 then G6, overlapping tails."""
    first = bell(1046.50, 1.10, 0.95, decay=5.2)
    second = pad(bell(1567.98, 1.40, 0.90, decay=4.2), 1.70)
    shifted = np.concatenate([np.zeros(int(SR * 0.20)), second])[: len(second)]
    return pad(mix((first, 1.0), (shifted, 0.95)), 1.75)


def chime_soft() -> np.ndarray:
    """Soft marimba-ish pair: E5 then A5, longer and gentler decay."""
    first = bell(659.26, 1.30, 1.0, decay=3.6)
    second = pad(bell(880.00, 1.60, 0.85, decay=3.0), 1.90)
    shifted = np.concatenate([np.zeros(int(SR * 0.26)), second])[: len(second)]
    return pad(mix((first, 0.9), (shifted, 0.85)), 2.00)


def chime_urgent() -> np.ndarray:
    """Three quick rising beeps for when the owner really must look up."""
    out = np.zeros(int(SR * 1.15))
    for index, (freq, decay) in enumerate(((880.0, 12.0), (1108.7, 12.0), (1318.5, 7.0))):
        tone = bell(freq, 0.30 if index < 2 else 0.48, 1.0, decay=decay)
        start = int(SR * 0.22 * index)
        out[start : start + len(tone)] += tone
    return pad(out, 1.15)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    for name, signal in (
        ("chime-clear.wav", chime_clear()),
        ("chime-soft.wav", chime_soft()),
        ("chime-urgent.wav", chime_urgent()),
    ):
        path = ASSETS / name
        write_wav(path, signal)
        pad_tail(path, TAIL_SECONDS)
    build_voice_default()


if __name__ == "__main__":
    main()
