# python3 sound.py <out.wav> (needs numpy). One piece: C major pad and pluck at 100 bpm; effects in key, through the same reverb, under the music.
import numpy as np, sys, wave
SR, DUR = 44100, 21.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)
music = np.zeros((N, 2)); fx = np.zeros((N, 2))
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
BEAT = 0.6

def add(buf, start, sig, gain=1.0, pan=0.0):
    i = int(start * SR); sig = sig[: max(0, N - i)].copy()
    k = min(len(sig) // 2, int(0.006 * SR)); sig[:k] *= np.linspace(0, 1, k); sig[-k:] *= np.linspace(1, 0, k)
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:i + len(sig), 0] += sig * gain * l; buf[i:i + len(sig), 1] += sig * gain * r

def env(n, a, r):
    e = np.ones(n); ai = int(a * SR); ri = int(r * SR)
    e[:ai] = np.linspace(0, 1, ai); e[-ri:] *= np.linspace(1, 0, ri) ** 2; return e

def tone(f, d, harm=(1, .35, .12), detune=0.0):
    x = np.arange(int(d * SR)) / SR
    return sum(a * (np.sin(2 * np.pi * f * (k + 1) * x) + np.sin(2 * np.pi * f * (k + 1) * (1 + detune) * x)) / 2 for k, a in enumerate(harm))

def pluck(f, d=0.9, bright=1.0):
    x = np.arange(int(d * SR)) / SR
    return (np.sin(2 * np.pi * f * x) + 0.3 * bright * np.sin(4 * np.pi * f * x) * np.exp(-x * 9)) * np.exp(-x * 5.5)

def bell(f, d=2.6):
    x = np.arange(int(d * SR)) / SR
    return sum(a * np.sin(2 * np.pi * f * m * x) * np.exp(-x * dk) for m, a, dk in ((1, 1, 1.6), (2.0, .35, 2.4), (3.01, .18, 3.5), (4.2, .08, 5)))

CHORDS = [(48, [60, 64, 67, 71]), (45, [57, 60, 64, 67]), (41, [57, 60, 64, 65]), (43, [55, 59, 62, 67])]
# Pad: one chord every four beats, swelling in from the start.
for b in range(0, 35, 4):
    root, notes = CHORDS[(b // 4) % 4]
    start = b * BEAT; d = 4 * BEAT + 0.5
    level = 0.55 + 0.45 * min(1, start / 4.3)
    for m in notes:
        add(music, start, tone(hz(m), d, detune=0.003) * env(int(d * SR), 0.5, 0.6), 0.032 * level, pan=(m % 7 - 3) / 6)
    add(music, start, tone(hz(root), d, harm=(1, .2)) * env(int(d * SR), 0.2, 0.5), 0.06 * level)
# Pluck arpeggio and a soft pulse while the session plays.
for k in range(int((17.0 - 4.2) / (BEAT / 2))):
    s = 4.2 + k * BEAT / 2
    _, notes = CHORDS[int(s / (4 * BEAT)) % 4]
    m = notes[[0, 2, 1, 3, 2, 1, 3, 0][k % 8]] + 12
    add(music, s, pluck(hz(m), 0.7), 0.05 * (0.8 if k % 2 else 1), pan=0.35 if k % 2 else -0.35)
    if k % 2 == 0:
        x = np.arange(int(0.25 * SR)) / SR
        kick = np.sin(2 * np.pi * (48 * x + 70 / 18 * (1 - np.exp(-x * 18)))) * np.exp(-x * 16)
        add(music, s, kick, 0.11)
# Typing: small filtered ticks, every other character.
for i in range(0, 68, 2):
    s = 0.3 + i * 2.1 / 68 + rng.uniform(-0.008, 0.008)
    n = rng.standard_normal(int(0.018 * SR)) * np.exp(-np.arange(int(0.018 * SR)) / SR * 260)
    n = np.convolve(n, np.hanning(24) / 12, 'same')
    add(fx, s, n, 0.035 * rng.uniform(0.6, 1), pan=rng.uniform(-0.2, 0.2))
# The hook leaves: a soft swell.
x = np.arange(int(0.7 * SR)) / SR
sw = np.convolve(rng.standard_normal(len(x)), np.hanning(160) / 80, 'same') * np.sin(np.pi * x / 0.7) ** 2
add(fx, 3.75, sw, 0.05)
# One note in key per chat line.
APPEAR = [5.0, 5.9, 7.0, 7.6, 8.4, 9.5, 10.1, 10.8, 13.8, 15.6]
for i, s in enumerate(APPEAR):
    add(fx, s, pluck(hz([76, 79, 81, 84][i % 4]), 0.6, 0.5), 0.045, pan=-0.2)
# The million, and the million again after the reload.
for s in (10.9, 15.3):
    for m, g in ((84, 1), (91, .55), (79, .5)):
        add(fx, s, bell(hz(m)), 0.05 * g)
# Reload: a falling filtered sweep.
x = np.arange(int(0.6 * SR)) / SR
add(fx, 14.45, np.sin(2 * np.pi * (660 * x - 400 * x * x)) * np.sin(np.pi * x / 0.6) ** 2, 0.025)
# Outro: the tonic held out.
for m, g in ((48, .05), (60, .03), (64, .024), (67, .024), (72, .018), (76, .014)):
    add(music, 17.4, tone(hz(m), 3.6) * env(int(3.6 * SR), 0.05, 2.8), g)
add(fx, 17.45, bell(hz(84), 3.5), 0.028)

# One shared room.
ir_n = int(1.6 * SR); ir = rng.standard_normal((ir_n, 2)) * np.exp(-np.arange(ir_n) / SR * 3.2)[:, None]
ir = np.apply_along_axis(lambda c: np.convolve(c, np.ones(8) / 8, 'same'), 0, ir)
def room(x):
    L = 1 << int(np.ceil(np.log2(N + ir_n)))
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, c], L) * np.fft.rfft(ir[:, c], L), L)[:N] for c in range(2)], 1)
mix = music + fx * 0.85
wet = room(mix); wet *= np.abs(mix).max() / np.abs(wet).max()
out = mix + 0.35 * wet
fade = np.ones(N); fo = int(1.6 * SR); fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
out = np.tanh(out * fade[:, None] * 1.4) ; out *= 0.89 / np.abs(out).max()
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((out * 32767).astype('<i2').tobytes())
print('peak', np.abs(out).max(), 'rms', np.sqrt((out ** 2).mean()))
