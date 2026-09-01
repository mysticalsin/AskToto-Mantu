import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASR_ENGINE,
  resolveAsrEngine,
  resolveLeftoverAsrEngine
} from './asr-engine-policy'

describe('ASR engine policy — Whisper default when Parakeet weights are absent', () => {
  it('defaults to Whisper when the high-accuracy Parakeet files are missing', () => {
    expect(DEFAULT_ASR_ENGINE).toBe('whisper')
    expect(resolveAsrEngine({ requested: undefined, parakeetReady: false })).toBe('whisper')
    expect(resolveAsrEngine({ requested: 'whisper', parakeetReady: false })).toBe('whisper')
    expect(resolveAsrEngine({ requested: 'parakeet', parakeetReady: false })).toBe('whisper')
    expect(resolveAsrEngine({ requested: 'garbage', parakeetReady: false })).toBe('whisper')
  })

  it('uses installed high-accuracy Parakeet even when the schema default is Whisper', () => {
    expect(resolveAsrEngine({ requested: 'whisper', parakeetReady: true })).toBe('parakeet')
    expect(resolveAsrEngine({ requested: undefined, parakeetReady: true })).toBe('parakeet')
    expect(resolveAsrEngine({ requested: 'parakeet', parakeetReady: true })).toBe('parakeet')
  })

  it('keeps an explicit Apple Speech opt-in', () => {
    expect(resolveAsrEngine({ requested: 'apple', parakeetReady: true })).toBe('apple')
    expect(resolveAsrEngine({ requested: 'apple', parakeetReady: false })).toBe('apple')
  })
})

describe('leftover queue — a failed first Parakeet decode does not flip remaining jobs to Whisper', () => {
  it('keeps leftover jobs on Parakeet while the high-accuracy model is installed', () => {
    expect(
      resolveLeftoverAsrEngine({
        requested: 'whisper',
        parakeetReady: true,
        lastParakeetDecodeFailed: true
      })
    ).toBe('parakeet')
    expect(
      resolveLeftoverAsrEngine({
        requested: 'parakeet',
        parakeetReady: true,
        lastParakeetDecodeFailed: true
      })
    ).toBe('parakeet')
  })

  it('still uses Whisper for leftover jobs when the high-accuracy model is absent', () => {
    expect(
      resolveLeftoverAsrEngine({
        requested: 'parakeet',
        parakeetReady: false,
        lastParakeetDecodeFailed: true
      })
    ).toBe('whisper')
  })

  it('does not grow a leftover Whisper-only latch in this module', () => {
    const src = readFileSync(join(__dirname, 'asr-engine-policy.ts'), 'utf8')
    expect(src).not.toMatch(/whisperOnly|forceWhisper|useWhisperOnly|leftoverEngine\s*=/)
    expect(src).toMatch(/lastParakeetDecodeFailed/)
    expect(src).toMatch(/void input\.lastParakeetDecodeFailed/)
  })
})
