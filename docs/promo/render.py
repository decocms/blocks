"""Compose the mobile capture, title cards, captions, and an original soundtrack."""
from pathlib import Path
import json
import math
import os
import subprocess
import wave

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
timeline = json.loads((OUT / 'timeline.json').read_text())
W, H = 1080, 1920
INTRO, OUTRO = 2.0, 3.0
duration = INTRO + timeline['duration'] + OUTRO
FOREST, LIME, WHITE = '#092e1a', '#d0ff5f', '#f6f5ef'

def font(size, bold=False):
    candidates = [os.environ.get('PROMO_FONT', ''), '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    raise RuntimeError('Set PROMO_FONT to a TrueType font path.')

def background():
    image = Image.new('RGB', (W, H), FOREST)
    draw = ImageDraw.Draw(image)
    for y in range(-100, H, 180):
        for x in range(-100, W, 180):
            draw.arc((x, y, x + 150, y + 150), 0, 270, fill='#12482a', width=2)
    return image

def card(filename, label, lines, footer):
    image = background()
    draw = ImageDraw.Draw(image)
    draw.text((84, 160), 'DECO', font=font(56, True), fill=LIME)
    draw.text((84, 280), label, font=font(26), fill='#b6cdbb')
    y = 640
    for i, line in enumerate(lines):
        draw.text((80, y), line, font=font(112, True), fill=LIME if i == len(lines) - 1 else WHITE)
        y += 138
    draw.line((84, 1380, 996, 1380), fill='#386048', width=2)
    for i, line in enumerate(footer):
        draw.text((84, 1440 + i * 64), line, font=font(34), fill=WHITE)
    draw.text((84, 1750), 'NEXT-MAJOR PREVIEW', font=font(25), fill='#b6cdbb')
    image.save(OUT / filename)

card('intro.png', 'THE NEXT CHAPTER', ['Headless.', 'Editable.', 'AI-native.'], ['One content model.', 'For developers, humans, and AI.'])
card('outro.png', 'START BUILDING', ['Build with', 'Deco.'], ['Explore the next-major docs', '/next/', 'npm install @decocms/blocks'])

base = background()
draw = ImageDraw.Draw(base)
draw.text((60, 58), 'DECO', font=font(34, True), fill=LIME)
draw.text((740, 63), 'NEXT / PREVIEW', font=font(22), fill='#b6cdbb')
draw.text((60, 1866), 'ONE MODEL. EVERY MAKER.', font=font(22), fill='#b6cdbb')
base.save(OUT / 'background.png')
for i, caption in enumerate(timeline['captions']):
    image = Image.new('RGBA', (W, 210), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.text((60, 18), caption['label'], font=font(24), fill=LIME)
    words = caption['title'].split()
    lines, line = [], ''
    for word in words:
        trial = (line + ' ' + word).strip()
        if draw.textlength(trial, font=font(49, True)) > 960:
            lines.append(line)
            line = word
        else:
            line = trial
    lines.append(line)
    for j, line in enumerate(lines):
        draw.text((60, 60 + 58 * j), line, font=font(49, True), fill=WHITE)
    image.save(OUT / f'caption-{i}.png')

# Original 108 BPM instrumental: soft pads, a plucked arpeggio, bass, and drums.
# Every sample is synthesized here; no third-party recordings are used.
SR, BPM = 48000, 108
beat = 60 / BPM
audio = np.zeros((math.ceil(duration * SR), 2), dtype=np.float64)
rng = np.random.default_rng(17)
def add(at, samples, gain=1, pan=0):
    start = round(at * SR)
    stop = min(len(audio), start + len(samples))
    if stop <= start:
        return
    samples = samples[:stop-start] * gain
    audio[start:stop, 0] += samples * math.sqrt((1-pan)/2)
    audio[start:stop, 1] += samples * math.sqrt((1+pan)/2)

def tone(midi, seconds, kind):
    t = np.arange(round(seconds * SR)) / SR
    frequency = 440 * 2 ** ((midi - 69) / 12)
    if kind == 'pad':
        envelope = np.minimum(t / .3, 1) * np.minimum((seconds - t) / .5, 1)
        return envelope * (np.sin(2*np.pi*frequency*t) + .24*np.sin(2*np.pi*frequency*1.003*t))
    return np.exp(-t * (6 if kind == 'pluck' else 3)) * np.minimum(t/.008, 1) * (np.sin(2*np.pi*frequency*t) + .12*np.sin(4*np.pi*frequency*t))

chords = [[60,64,67,71], [57,60,64,67], [53,57,60,64], [55,59,62,64]]
for bar in range(math.ceil(duration / (4 * beat))):
    notes = chords[bar % 4]
    at = bar * 4 * beat
    for i, note in enumerate(notes):
        add(at, tone(note, 4*beat+.2, 'pad'), .028, -.6 + i*.4)
    for step in range(8):
        add(at + step*beat/2, tone(notes[step % 4]+12, .65, 'pluck'), .045, -.4 if step%2 else .4)
    for step in range(4):
        add(at + step*beat, tone(notes[0]-24, .5, 'bass'), .13)
        t = np.arange(round(.22*SR)) / SR
        kick = np.sin(2*np.pi*(48*t + 55*.025*(1-np.exp(-t/.025)))) * np.exp(-t*22)
        add(at+step*beat, kick, .17)
        if step % 2:
            t = np.arange(round(.12*SR)) / SR
            noise = rng.normal(size=len(t)); noise = np.diff(noise, prepend=0)
            add(at+step*beat, noise*np.exp(-t*45), .024, .15)
    for step in range(8):
        t = np.arange(round(.055*SR)) / SR
        noise = rng.normal(size=len(t)); noise = np.diff(noise, prepend=0)
        add(at+step*beat/2, noise*np.exp(-t*90), .01, -.3)

for click in timeline['clicks']:
    t = np.arange(round(.055*SR)) / SR
    sound = (.7*np.sin(2*np.pi*1600*t) + .3*rng.normal(size=len(t))) * np.exp(-t*125)
    add(INTRO + click, sound, .32)

t = np.arange(len(audio)) / SR
envelope = np.minimum(t/.45, 1) * np.minimum((duration-t)/1.1, 1)
audio *= envelope[:, None]
audio = np.tanh(audio * 1.5)
audio *= .87 / max(1, np.max(np.abs(audio)))
with wave.open(str(OUT / 'soundtrack.wav'), 'wb') as wav:
    wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(SR)
    wav.writeframes((audio * 32767).astype('<i2').tobytes())

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
inputs = ['-loop', '1', '-i', str(OUT/'background.png'), '-i', str(OUT/'capture.webm')]
for filename in ['intro.png', 'outro.png'] + [f'caption-{i}.png' for i in range(len(timeline['captions']))]:
    inputs += ['-loop', '1', '-i', str(OUT/filename)]
audio_index = 4 + len(timeline['captions'])
inputs += ['-i', str(OUT/'soundtrack.wav')]
filters = [f'[0:v]fps=30,format=yuv420p,trim=duration={timeline["duration"]},setpts=PTS-STARTPTS[bg]',
           f'[1:v]trim=start={timeline["trimStart"]}:duration={timeline["duration"]},setpts=PTS-STARTPTS,scale=1080:1520,fps=30[screen]',
           '[bg][screen]overlay=0:320:shortest=1[shot0]']
for i, caption in enumerate(timeline['captions']):
    end = timeline['captions'][i+1]['at'] if i+1 < len(timeline['captions']) else timeline['duration']
    filters += [f'[{4+i}:v]format=rgba,fade=t=in:st={caption["at"]:.3f}:d=0.18:alpha=1[cap{i}]',
                f'[shot{i}][cap{i}]overlay=0:110:enable=\'between(t,{caption["at"]:.3f},{end:.3f})\'[shot{i+1}]']
filters += [f'[2:v]fps=30,format=yuv420p,trim=duration={INTRO},setpts=PTS-STARTPTS[intro]',
            f'[3:v]fps=30,format=yuv420p,trim=duration={OUTRO},setpts=PTS-STARTPTS[outro]',
            f'[intro][shot{len(timeline["captions"])}][outro]concat=n=3:v=1:a=0[video]']
command = [ffmpeg, '-y', *inputs, '-filter_complex', ';'.join(filters), '-map', '[video]', '-map', f'{audio_index}:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', str(duration), str(OUT/'deco-next-vertical.mp4')]
subprocess.run(command, check=True)
print(f'Rendered {OUT / "deco-next-vertical.mp4"} ({duration:.1f}s, 1080×1920)')
