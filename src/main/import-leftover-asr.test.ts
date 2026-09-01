/**
 * Leftover import queue: a failed first Parakeet decode must not flip remaining jobs to Whisper
 * while the high-accuracy model is installed.
 *
 * The real selector is resolveLeftoverAsrEngine — index.ts calls it on every leftover transcribe
 * (no process-wide Whisper latch). This suite drives that function the way recover() + transcribe
 * would: first job fails, remaining jobs re-resolve from disk.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLeftoverAsrEngine, type AsrEngineId } from './asr-engine-policy'

function leftoverQueueEngines(input: {
  jobs: string[]
  parakeetReady: boolean
  requested?: AsrEngineId
  failFirst?: boolean
}): { engines: AsrEngineId[]; failed: string[] } {
  const engines: AsrEngineId[] = []
  const failed: string[] = []
  let lastParakeetDecodeFailed = false
  for (const job of input.jobs) {
    const engine = resolveLeftoverAsrEngine({
      requested: input.requested ?? 'whisper',
      parakeetReady: input.parakeetReady,
      lastParakeetDecodeFailed
    })
    engines.push(engine)
    if (input.failFirst && failed.length === 0 && engine === 'parakeet') {
      failed.push(job)
      lastParakeetDecodeFailed = true
    }
  }
  return { engines, failed }
}

describe('leftover import queue keeps Parakeet after a failed first decode', () => {
  it('re-resolves every leftover job from disk — first fail does not latch Whisper', () => {
    const { engines, failed } = leftoverQueueEngines({
      jobs: ['monday.m4a', 'tuesday.m4a', 'wednesday.m4a'],
      parakeetReady: true,
      requested: 'whisper',
      failFirst: true
    })
    expect(failed).toEqual(['monday.m4a'])
    expect(engines).toEqual(['parakeet', 'parakeet', 'parakeet'])
  })

  it('uses Whisper for leftover jobs only when the high-accuracy files are absent', () => {
    const { engines } = leftoverQueueEngines({
      jobs: ['monday.m4a', 'tuesday.m4a'],
      parakeetReady: false,
      requested: 'parakeet',
      failFirst: true
    })
    expect(engines).toEqual(['whisper', 'whisper'])
  })

  it('index.ts leftover transcribe re-resolves and does not write a Whisper-only latch', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/resolveLeftoverAsrEngine/)
    expect(src).toMatch(/parakeetReady: parakeetModelReady\(\)/)
    expect(src).toMatch(/A failed first Parakeet decode must not flip/)
    expect(src).not.toMatch(/asrEngine:\s*'whisper'/)
    expect(src).not.toMatch(/useWhisperOnly|whisperOnlyLeftover|forceWhisperQueue/)
  })
})
