/**
 * Deterministic synthetic waveforms for the desk-tap DSP tests.
 *
 * Physics being imitated (all first-principles, no recorded data): a desk tap is a near-impulsive
 * strike exciting a few plate bending modes that ring briefly and decay fast (τ ≈ 20–40 ms), with
 * energy concentrated low (100–1000 Hz) because the structure-borne path low-passes; a laptop key
 * click is airborne, short (τ < 10 ms) and HF-heavy (2–6 kHz); speech is a slowly-amplitude-modulated
 * harmonic complex; a door slam is loud LF with a long reverberant tail. Every generator takes a seed
 * so failures reproduce exactly.
 */

/** mulberry32 — tiny seeded PRNG, deterministic across runs/platforms. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ms = (m: number, sr: number): number => Math.round((m / 1000) * sr)

export interface SynthOpts {
  sampleRate?: number
  gain?: number
  seed?: number
}

/** Damped-mode strike: 2–3 ms noise transient + summed decaying sinusoids. The canonical desk tap. */
export function synthTap(
  { sampleRate = 48000, gain = 0.5, seed = 1 }: SynthOpts = {},
  modes: number[] = [180, 320, 950],
  tauMs = 30
): Float32Array {
  const rng = makeRng(seed)
  const n = ms(90, sampleRate)
  const out = new Float32Array(n)
  // Draw ALL mode parameters up front, with a FIXED number of rng calls — so the same seed produces
  // the same physical strike at any sample rate (the cross-rate feature test depends on this).
  const params = modes.map((f0) => ({ f: f0 * (1 + (rng() - 0.5) * 0.02), phase: rng() * 2 * Math.PI }))
  const attack = ms(2, sampleRate)
  // Strike transient: short noise burst with a fast linear attack (per-sample noise may differ across
  // rates — it's 3 ms of broadband fill, irrelevant next to the modes that carry the band energies).
  for (let i = 0; i < attack * 2 && i < n; i++) {
    const env = i < attack ? i / attack : 1 - (i - attack) / attack
    out[i] += (rng() * 2 - 1) * env * 0.6
  }
  // Ringing modes, each slightly detuned by the seed so two fixtures never alias to identical spectra.
  for (const { f, phase } of params) {
    const tau = (tauMs / 1000) * sampleRate
    for (let i = 0; i < n; i++) {
      out[i] += Math.exp(-i / tau) * Math.sin((2 * Math.PI * f * i) / sampleRate + phase) * (1 / modes.length)
    }
  }
  // Normalize peak to `gain`.
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * gain
  return out
}

/** A second zone's tap: lower modes, longer ring — a contrasting (farther/softer-surface) strike. */
export function synthTapB(opts: SynthOpts = {}): Float32Array {
  return synthTap({ seed: 2, ...opts }, [140, 260, 700], 40)
}

/** Laptop key click: HF-bandpassed micro-burst, very fast decay. The classic false positive. */
export function synthKeyClick({ sampleRate = 48000, gain = 0.25, seed = 3 }: SynthOpts = {}): Float32Array {
  const rng = makeRng(seed)
  const n = ms(90, sampleRate)
  const out = new Float32Array(n)
  const tau = (8 / 1000) * sampleRate
  // Noise burst ring-modulated up into the 2–6 kHz band (carrier 4 kHz).
  for (let i = 0; i < n; i++) {
    out[i] = (rng() * 2 - 1) * Math.exp(-i / tau) * Math.sin((2 * Math.PI * 4000 * i) / sampleRate)
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * gain
  return out
}

/** Voiced-speech surrogate: harmonic complex on a 120 Hz fundamental with syllabic AM. 300 ms. */
export function synthSpeech({ sampleRate = 48000, gain = 0.2, seed = 4 }: SynthOpts = {}): Float32Array {
  const rng = makeRng(seed)
  const n = ms(300, sampleRate)
  const out = new Float32Array(n)
  const f0 = 120
  for (let h = 1; h <= 8; h++) {
    const amp = 1 / h
    const phase = rng() * 2 * Math.PI
    for (let i = 0; i < n; i++) {
      out[i] += amp * Math.sin((2 * Math.PI * f0 * h * i) / sampleRate + phase)
    }
  }
  // ~4 Hz syllabic envelope with a SLOW (~60 ms) rise — nothing like a tap's 2 ms attack.
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    out[i] *= 0.5 * (1 - Math.cos(2 * Math.PI * 4 * t)) * Math.min(1, t / 0.06)
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * gain
  return out
}

/** Door slam: near-clipping LF thump + long decaying-noise reverb tail (400 ms). */
export function synthSlam({ sampleRate = 48000, gain = 0.98, seed = 5 }: SynthOpts = {}): Float32Array {
  const rng = makeRng(seed)
  const n = ms(400, sampleRate)
  const out = new Float32Array(n)
  const tauThump = (25 / 1000) * sampleRate
  const tauTail = (180 / 1000) * sampleRate
  for (let i = 0; i < n; i++) {
    out[i] =
      Math.exp(-i / tauThump) * Math.sin((2 * Math.PI * 70 * i) / sampleRate) * 0.9 +
      (rng() * 2 - 1) * Math.exp(-i / tauTail) * 0.35
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * gain
  return out
}

/** Mug set-down: two mid-band clunks ~30 ms apart — the honest hard case (double-hit + tap-like). */
export function synthMugDouble({ sampleRate = 48000, gain = 0.4, seed = 6 }: SynthOpts = {}): Float32Array {
  const a = synthTap({ sampleRate, gain: 1, seed }, [420, 800], 15)
  const n = ms(90, sampleRate)
  const out = new Float32Array(n)
  const off = ms(30, sampleRate)
  for (let i = 0; i < a.length && i < n; i++) out[i] += a[i]
  for (let i = 0; i < a.length && i + off < n; i++) out[i + off] += a[i] * 0.8
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * gain
  return out
}

/**
 * Place `signal` into a longer noise-floor bed at `atMs`, returning the composite. Mirrors what the
 * worklet capture hands the gates: PRE_MS of ambience, the event, POST_MS of aftermath.
 */
export function embed(
  signal: Float32Array,
  { sampleRate = 48000, noiseRms = 0.001, totalMs = 180, atMs = 45, seed = 7 } = {}
): Float32Array {
  const rng = makeRng(seed)
  const n = ms(totalMs, sampleRate)
  const out = new Float32Array(n)
  // Gaussian-ish ambience via central limit of 4 uniforms.
  for (let i = 0; i < n; i++) {
    out[i] = (rng() + rng() + rng() + rng() - 2) * noiseRms * 1.7
  }
  const at = ms(atMs, sampleRate)
  for (let i = 0; i < signal.length && at + i < n; i++) out[at + i] += signal[i]
  return out
}

/** RMS helper shared by tests. */
export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  const n = Math.max(1, to - from)
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / n)
}
