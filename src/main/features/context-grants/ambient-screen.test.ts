import { describe, expect, it } from 'vitest'
import { applyAmbientScreenContext } from './ambient-screen'

const base = { redact: false, log: () => undefined }

describe('ambient screen context (the foreground reader cache, moved out of index.ts)', () => {
  it('fills screenContext from the fresh description with the recent tail', () => {
    const req = {
      mode: 'answer',
      wantsScreenContext: true,
      transcript: 'they said hi',
      screenContext: undefined as string | undefined
    }
    const grounded = applyAmbientScreenContext(req, {
      ...base,
      fresh: () => ({ description: 'an editor', capturedAt: 1 })
    })
    expect(grounded).toBe(true)
    expect(req.screenContext).toBe('an editor\n\nRecent conversation (most recent speech):\nthey said hi')
  })

  it('does nothing without the intent flag and reports undefined', () => {
    const req = {
      mode: 'answer',
      wantsScreenContext: undefined,
      transcript: undefined,
      screenContext: undefined as string | undefined
    }
    expect(
      applyAmbientScreenContext(req, { ...base, fresh: () => ({ description: 'x', capturedAt: 1 }) })
    ).toBeUndefined()
    expect(req.screenContext).toBeUndefined()
  })

  it('reports false when nothing is fresh and redacts when asked', () => {
    const req = {
      mode: 'answer',
      wantsScreenContext: true,
      transcript: undefined,
      screenContext: undefined as string | undefined
    }
    expect(applyAmbientScreenContext(req, { ...base, fresh: () => null })).toBe(false)
    applyAmbientScreenContext(req, {
      redact: true,
      log: () => undefined,
      fresh: () => ({ description: 'key sk-abcdefghijklmnopqrstuvwx', capturedAt: 1 })
    })
    expect(req.screenContext).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  it('contains a failing reader', () => {
    const req = {
      mode: 'answer',
      wantsScreenContext: true,
      transcript: undefined,
      screenContext: undefined as string | undefined
    }
    const logged: string[] = []
    const grounded = applyAmbientScreenContext(req, {
      redact: false,
      log: (m) => logged.push(m),
      fresh: () => {
        throw new Error('boom')
      }
    })
    expect(grounded).toBe(false)
    expect(logged[0]).toContain('boom')
  })
})
