import { describe, expect, it } from 'vitest'
import { CRASH_KINDS, crashDetail } from './crash-taxonomy'

describe('crashDetail', () => {
  it('sets fatal true for exactly renderer death and previous-main early death', () => {
    const fatalKinds = CRASH_KINDS.filter((kind) => crashDetail(kind).fatal)
    expect(fatalKinds).toEqual(['render-process-gone', 'boot-early-death'])
  })

  it('sets fatal false for handled-in-place crash records', () => {
    for (const kind of ['uncaughtException', 'unhandledRejection', 'renderer-error-boundary', 'boot'] as const) {
      expect(crashDetail(kind).fatal).toBe(false)
    }
  })

  it('preserves facts but does not let facts override kind or fatal', () => {
    const detail = crashDetail('boot', {
      message: 'startup failed',
      reason: 'crashed',
      exitCode: 9,
      kind: 'render-process-gone',
      fatal: true
    } as Parameters<typeof crashDetail>[1])

    expect(detail).toEqual({
      message: 'startup failed',
      reason: 'crashed',
      exitCode: 9,
      kind: 'boot',
      fatal: false
    })
  })
})
