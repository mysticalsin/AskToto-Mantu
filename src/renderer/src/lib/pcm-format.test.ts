import { describe, expect, it } from 'vitest'
import { Pcm16kResampler } from './pcm-format'

describe('Pcm16kResampler', () => {
  it('passes a 16 kHz mono frame through without changing its samples', () => {
    const input = Float32Array.from([0.1, -0.2, 0.3])
    const output = new Float32Array(input.length)

    expect(new Pcm16kResampler(16000).write(input, output)).toBe(input.length)
    expect(Array.from(output)).toEqual(Array.from(input))
  })

  it('converts a 48 kHz mono frame to one valid 16 kHz sample per three source samples', () => {
    const output = new Float32Array(2)
    const written = new Pcm16kResampler(48000).write(Float32Array.from([0, 0.3, 0.6, 0.6, 0.3, 0]), output)

    expect(written).toBe(2)
    expect(Array.from(output)).toEqual([expect.closeTo(0.3), expect.closeTo(0.3)])
  })

  it('converts a 44.1 kHz frame with exact cumulative duration', () => {
    const input = new Float32Array(441).fill(0.25)
    const output = new Float32Array(160)

    expect(new Pcm16kResampler(44100).write(input, output)).toBe(160)
    expect(Array.from(output).every((sample) => sample === 0.25)).toBe(true)
  })

  it('fails safely for invalid source formats or malformed PCM', () => {
    const output = new Float32Array(8)
    expect(new Pcm16kResampler(0).write(Float32Array.from([0.1]), output)).toBe(0)
    expect(new Pcm16kResampler(8000).write(Float32Array.from([0.1]), output)).toBe(0)
    expect(new Pcm16kResampler(48000).write(Float32Array.from([Number.NaN]), output)).toBe(0)
  })
})
