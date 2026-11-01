// Makes the new-order sound, public/media/new-order.mp3: a short cash-register "ka-ching" of our
// own, synthesized here (a drawer click, then a bright bell), so there is no outside recording to
// license. The same file plays in the app and can be set as the phone's notification sound.
//
//   node scripts/make-order-sound.mjs            (needs ffmpeg for the MP3; a WAV is written either way)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RATE = 44100
const SECONDS = 1.25
const out = new Float64Array(Math.round(RATE * SECONDS))

// Repeatable noise, so the file only changes when this script does.
function prng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = prng(1051)

/** RBJ band-pass filter over a buffer. */
function bandpass(input, freq, q) {
  const w = (2 * Math.PI * freq) / RATE
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0
  const y = new Float64Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const v = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = v; y[i] = v
  }
  return y
}

/** A filtered noise burst starting at `at` seconds. */
function noise(at, length, freq, q, tau, gain) {
  const n = Math.round(length * RATE)
  const raw = new Float64Array(n)
  for (let i = 0; i < n; i++) raw[i] = (random() * 2 - 1) * Math.exp(-i / RATE / tau)
  const shaped = bandpass(raw, freq, q)
  const start = Math.round(at * RATE)
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] += shaped[i] * gain
}

/** A decaying sine starting at `at` seconds, with a 2 ms attack. */
function partial(at, freq, gain, tau) {
  const start = Math.round(at * RATE)
  const attack = 0.002 * RATE
  for (let i = 0; start + i < out.length; i++) {
    const t = i / RATE
    const env = Math.min(1, i / attack) * Math.exp(-t / tau)
    if (env < 1e-5 && i > attack) break
    out[start + i] += Math.sin(2 * Math.PI * freq * t) * gain * env
  }
}

// "ka": the drawer, a dry click with a little body under it.
noise(0, 0.04, 3200, 1.6, 0.008, 3.6)
partial(0, 150, 0.5, 0.02)
noise(0.03, 0.03, 2400, 2.2, 0.007, 2.4)

// "ching": a bright bell; two close fundamentals beat against each other for the shimmer.
const BELL = 0.085
const F = 2093 // C7
noise(BELL, 0.03, 7000, 1.2, 0.006, 0.9)
partial(BELL, F, 0.6, 0.45)
partial(BELL, F * 1.0024, 0.16, 0.42)
partial(BELL, F * 1.5, 0.22, 0.3)
partial(BELL, F * 2, 0.17, 0.22)
partial(BELL, F * 2.76, 0.1, 0.13)
partial(BELL, F * 4.07, 0.05, 0.07)

// Normalize to -1 dBFS and fade the tail out.
let peak = 0
for (const v of out) peak = Math.max(peak, Math.abs(v))
const scale = 0.89 / peak
const fade = Math.round(0.04 * RATE)
const pcm = Buffer.alloc(44 + out.length * 2)
for (let i = 0; i < out.length; i++) {
  const tail = Math.min(1, (out.length - i) / fade)
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * scale * tail * 32767))), 44 + i * 2)
}
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + out.length * 2, 4); pcm.write('WAVE', 8)
pcm.write('fmt ', 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34)
pcm.write('data', 36); pcm.writeUInt32LE(out.length * 2, 40)

const dir = mkdtempSync(join(tmpdir(), 'order-sound-'))
const wav = join(dir, 'new-order.wav')
writeFileSync(wav, pcm)
const mp3 = resolve(import.meta.dirname, '../public/media/new-order.mp3')
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-map_metadata', '-1', '-id3v2_version', '0', mp3])
  console.log(`wrote ${mp3}`)
} catch (error) {
  console.error(`ffmpeg failed (${error.message}); the WAV is at ${wav}`)
  process.exit(1)
}
unlinkSync(wav)
rmdirSync(dir)
