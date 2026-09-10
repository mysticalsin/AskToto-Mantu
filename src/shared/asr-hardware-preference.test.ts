import { describe, expect, it } from 'vitest'
import { preferredFreshAsrEngine } from './asr-hardware-preference'

const GIB = 1024 ** 3

describe('preferredFreshAsrEngine', () => {
  it.each([
    ['below 8 GiB', 4 * GIB, 'parakeet'],
    ['exactly 8 GiB', 8 * GIB, 'parakeet'],
    ['one byte above 8 GiB', 8 * GIB + 1, 'whisper'],
    ['16 GiB', 16 * GIB, 'whisper'],
    ['32 GiB', 32 * GIB, 'whisper']
  ] as const)('selects the fresh default for %s', (_label, totalMemoryBytes, expected) => {
    expect(preferredFreshAsrEngine(totalMemoryBytes)).toBe(expected)
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, 0, '16 GiB']) (
    'uses conservative Parakeet for invalid or unknown physical memory %s',
    (totalMemoryBytes) => {
      expect(preferredFreshAsrEngine(totalMemoryBytes)).toBe('parakeet')
    }
  )
})
