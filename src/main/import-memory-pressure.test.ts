import { describe, expect, it } from 'vitest'
import { allowsSpeculativeLocalWork } from './import-memory-pressure'

describe('allowsSpeculativeLocalWork', () => {
  it.each([
    ['no import memory reservation', false, false, true],
    ['whole-recording VAD PCM is admitted', true, false, false],
    ['the high-memory Whisper import tier is reserved', false, true, false],
    ['both import reservations are present', true, true, false]
  ] as const)('returns %s for %s', (_label, vadPcmOwned, highMemoryWhisperReserved, expected) => {
    expect(allowsSpeculativeLocalWork(vadPcmOwned, highMemoryWhisperReserved)).toBe(expected)
  })
})
