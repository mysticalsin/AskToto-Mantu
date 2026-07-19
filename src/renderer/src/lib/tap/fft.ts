/**
 * Minimal radix-2 FFT for the desk-tap feature extractor.
 *
 * Written from scratch (standard Cooley–Tukey) because the renderer has no DSP dependency and an
 * AnalyserNode can't be driven deterministically from unit tests. Only what tap features need:
 * a real-input forward transform and its one-sided power spectrum. Size must be a power of two —
 * callers zero-pad; for 2048-point frames this costs ~0.05 ms, and it only ever runs on tap
 * *candidates* (a few per minute at most), never on the steady audio stream.
 */

/** In-place iterative radix-2 FFT over interleaved re/im pairs. `n` = complex length (power of 2). */
function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k
        const b = a + (len >> 1)
        const tr = re[b] * curR - im[b] * curI
        const ti = re[b] * curI + im[b] * curR
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nr
      }
    }
  }
}

/**
 * One-sided power spectrum of a real signal, zero-padded/truncated to `n` (power of 2).
 * Returns `n/2 + 1` bins of |X[k]|² — un-normalized, which is fine because every consumer either
 * ratios bins against each other or log-subtracts a mean (both normalization-invariant).
 */
export function powerSpectrum(signal: Float32Array, n: number): Float64Array {
  if ((n & (n - 1)) !== 0 || n < 2) throw new Error(`FFT size must be a power of two, got ${n}`)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const m = Math.min(signal.length, n)
  for (let i = 0; i < m; i++) re[i] = signal[i]
  fftComplex(re, im)
  const out = new Float64Array((n >> 1) + 1)
  for (let k = 0; k < out.length; k++) out[k] = re[k] * re[k] + im[k] * im[k]
  return out
}

/** Hann window applied in place (before powerSpectrum) — standard leakage control for the tap frames. */
export function hannWindow(frame: Float32Array): void {
  const n = frame.length
  if (n < 2) return
  for (let i = 0; i < n; i++) frame[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
}
