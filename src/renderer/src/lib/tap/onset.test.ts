import { describe, expect, it } from 'vitest'
import { makeTapOnset } from './onset'

const SR = 48000
const QUANTUM = 128

/** Drive the detector with a sequence of per-quantum RMS values; return the trigger indices. */
function drive(onset: ReturnType<typeof makeTapOnset>, rmsSeq: number[]): number[] {
  const fired: number[] = []
  rmsSeq.forEach((r, i) => {
    if (onset.step(r, QUANTUM)) fired.push(i)
  })
  return fired
}

describe('makeTapOnset', () => {
  it('fires once on a sharp jump over a quiet floor', () => {
    const o = makeTapOnset(SR)
    const seq = [...Array(100).fill(0.001), 0.2, 0.1, 0.05, ...Array(100).fill(0.001)]
    const fired = drive(o, seq)
    expect(fired).toEqual([100])
  })

  it('does not fire on a slow swell (floor tracks up under it)', () => {
    const o = makeTapOnset(SR)
    // Ramp from 0.001 to 0.05 over 400 quanta (~1s) — gradual enough for the floor to follow.
    const seq = [...Array(50).fill(0.001), ...Array(400).fill(0).map((_, i) => 0.001 + (i / 400) * 0.05)]
    expect(drive(o, seq)).toEqual([])
  })

  it('respects the refractory period, then re-arms', () => {
    const o = makeTapOnset(SR)
    const quiet = Array(200).fill(0.001)
    const refractoryQuanta = Math.ceil((0.25 * SR) / QUANTUM) // 94
    const seq = [
      ...quiet,
      0.2, // fires
      ...Array(20).fill(0.001),
      0.2, // inside refractory — must NOT fire
      ...Array(refractoryQuanta).fill(0.001),
      0.2 // well past refractory — fires again
    ]
    const fired = drive(o, seq)
    expect(fired.length).toBe(2)
    expect(fired[0]).toBe(200)
    expect(fired[1]).toBe(seq.length - 1)
  })

  it('absolute minimum stops a silent room from firing on a whisper', () => {
    const o = makeTapOnset(SR)
    // Floor decays toward ~0.0000x; a 0.004 blip is a huge RATIO jump but below TRIGGER_MIN_RMS.
    const seq = [...Array(300).fill(0.0001), 0.004]
    expect(drive(o, seq)).toEqual([])
  })

  it('sensitivity slider widens/narrows the required jump', () => {
    const insensitive = makeTapOnset(SR)
    insensitive.setSensitivity(0) // needs 16×
    const sensitive = makeTapOnset(SR)
    sensitive.setSensitivity(1) // needs 4×
    const seq = [...Array(100).fill(0.002), 0.012] // a 6× jump
    expect(drive(insensitive, seq)).toEqual([])
    expect(drive(sensitive, seq)).toEqual([100])
  })

  it('floor keeps tracking through holdoff and reset clears state', () => {
    const o = makeTapOnset(SR)
    drive(o, [...Array(100).fill(0.001), 0.3])
    expect(o.floor()).toBeGreaterThan(0)
    o.reset()
    expect(o.floor()).toBeCloseTo(0.002, 5)
  })
})
