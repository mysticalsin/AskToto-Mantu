import { describe, expect, it } from 'vitest'
import { hannWindow, powerSpectrum } from './fft'

describe('tap fft', () => {
  it('puts a pure sinusoid in its exact bin', () => {
    const n = 2048
    const sr = 48000
    const bin = 100 // 100 * 48000/2048 = 2343.75 Hz — exactly on-bin, no leakage
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * bin * i) / n)
    const spec = powerSpectrum(x, n)
    let peak = 0
    let peakAt = -1
    for (let k = 0; k < spec.length; k++) {
      if (spec[k] > peak) {
        peak = spec[k]
        peakAt = k
      }
    }
    expect(peakAt).toBe(bin)
    // Everything off-bin is numerically zero relative to the peak.
    for (let k = 0; k < spec.length; k++) {
      if (Math.abs(k - bin) > 1) expect(spec[k] / peak).toBeLessThan(1e-9)
    }
    void sr
  })

  it('satisfies Parseval (energy preserved through the transform)', () => {
    const n = 1024
    const x = new Float32Array(n)
    // Deterministic pseudo-random signal.
    let a = 12345
    for (let i = 0; i < n; i++) {
      a = (a * 1103515245 + 12345) & 0x7fffffff
      x[i] = (a / 0x7fffffff) * 2 - 1
    }
    let timeEnergy = 0
    for (let i = 0; i < n; i++) timeEnergy += x[i] * x[i]
    const spec = powerSpectrum(x, n)
    // One-sided: double the interior bins, DC and Nyquist counted once.
    let freqEnergy = spec[0] + spec[spec.length - 1]
    for (let k = 1; k < spec.length - 1; k++) freqEnergy += 2 * spec[k]
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 6)
  })

  it('rejects non-power-of-two sizes', () => {
    expect(() => powerSpectrum(new Float32Array(100), 100)).toThrow(/power of two/)
  })

  it('zero-pads short input rather than reading past it', () => {
    const short = new Float32Array(100).fill(0.5)
    expect(() => powerSpectrum(short, 2048)).not.toThrow()
  })

  it('hann window zeroes the edges and preserves the middle', () => {
    const f = new Float32Array(101).fill(1)
    hannWindow(f)
    expect(f[0]).toBeCloseTo(0, 10)
    expect(f[100]).toBeCloseTo(0, 10)
    expect(f[50]).toBeCloseTo(1, 10)
  })
})
