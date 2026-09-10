import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn() } }))
import { resetAllProviderHealth, recordRateLimited } from './provider-health'
import {
  evaluateCircuit,
  honestError,
  resolveHardTimeoutMs,
  runFallbackChain,
  timeoutMessage,
  wrapEnterpriseStream
} from './enterprise-client'
import type { StreamHandle, StreamOptions } from './shared'
import type { AskStart } from '@shared/ipc'

const req = (prompt = 'What is 17 times 4?'): AskStart =>
  ({ id: 't', mode: 'answer', prompt, history: [] }) as AskStart

function opts(over: Partial<StreamOptions> = {}): StreamOptions {
  return {
    providerId: 'openai',
    kind: 'openai',
    apiKey: 'sk-test-not-a-real-key-0123456789abcdef',
    model: 'gpt',
    temperature: 0,
    system: 'sys',
    req: req(),
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    ...over
  }
}

describe('resolveHardTimeoutMs', () => {
  it('doubles idle and stays inside the 180s ceiling', () => {
    expect(resolveHardTimeoutMs(15_000)).toBe(30_000)
    expect(resolveHardTimeoutMs(120_000)).toBe(180_000)
    expect(resolveHardTimeoutMs(45_000, 8_000)).toBe(8_000)
  })
})

describe('honestError', () => {
  it('redacts secrets and refuses a generic something-went-wrong', () => {
    expect(honestError('Something went wrong', 'OpenAI timed out.')).toBe('OpenAI timed out.')
    expect(honestError('bad key sk-test-not-a-real-key-0123456789abcdef', 'fallback')).not.toMatch(/sk-test/)
  })
})

describe('timeout / cancel', () => {
  it('times out a hung strategy and aborts it', async () => {
    const abort = vi.fn()
    const o = opts()
    wrapEnterpriseStream(
      () => ({ abort }),
      o,
      { hardTimeoutMs: 20 }
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(abort).toHaveBeenCalled()
    expect(o.handlers.onError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i))
    expect(timeoutMessage('openai', 20)).toMatch(/openai timed out/i)
  })

  it('cancel aborts the inner handle and does not call onError', () => {
    const abort = vi.fn()
    const o = opts()
    const h = wrapEnterpriseStream(() => ({ abort }), o, { hardTimeoutMs: 5_000 })
    h.abort()
    expect(abort).toHaveBeenCalled()
    expect(o.handlers.onError).not.toHaveBeenCalled()
  })
})

describe('answer-first post-filter on the stream', () => {
  it('strips a Sure opener before the renderer sees it', () => {
    let innerHandlers: StreamOptions['handlers'] | null = null
    const o = opts()
    wrapEnterpriseStream((next) => {
      innerHandlers = next.handlers
      return { abort: () => {} }
    }, o)
    innerHandlers!.onDelta('Sure, 68')
    innerHandlers!.onDone({})
    expect(o.handlers.onDelta).toHaveBeenCalledWith('68')
  })
})

describe('provider completion metadata', () => {
  it('preserves an incomplete terminal reason through the enterprise wrapper', () => {
    let innerHandlers: StreamOptions['handlers'] | null = null
    const o = opts()
    wrapEnterpriseStream((next) => {
      innerHandlers = next.handlers
      return { abort: () => {} }
    }, o)

    innerHandlers!.onDelta('partial')
    innerHandlers!.onDone({}, { status: 'incomplete', reason: 'length' })

    expect(o.handlers.onDone).toHaveBeenCalledWith({}, { status: 'incomplete', reason: 'length' })
  })
})

describe('TTFT / TTA metrics', () => {
  it('records time-to-first-token and time-to-answer', () => {
    let t = 1_000
    const metrics = vi.fn()
    let innerHandlers: StreamOptions['handlers'] | null = null
    wrapEnterpriseStream(
      (next) => {
        innerHandlers = next.handlers
        return { abort: () => {} }
      },
      opts(),
      { now: () => t, onMetrics: metrics, hardTimeoutMs: 5_000 }
    )
    t = 1_120
    innerHandlers!.onDelta('68.')
    t = 1_400
    innerHandlers!.onDone({})
    expect(metrics).toHaveBeenCalledWith(
      expect.objectContaining({ ttftMs: 120, ttaMs: 400, cancelled: false, timedOut: false })
    )
  })
})

describe('circuit snapshot', () => {
  it('reports an open circuit without inventing a lockout', () => {
    resetAllProviderHealth()
    recordRateLimited('openai', 60_000, 0)
    const snap = evaluateCircuit('openai', 1_000)
    expect(snap.open).toBe(true)
    expect(evaluateCircuit('anthropic', 1_000).open).toBe(false)
    resetAllProviderHealth()
  })
})

describe('fallback chain', () => {
  it('falls over to the next provider after a permanent failure', async () => {
    const seen: string[] = []
    const result = await runFallbackChain([
      {
        id: 'dead',
        run: async () => {
          seen.push('dead')
          throw new Error('400 bad request')
        }
      },
      {
        id: 'live',
        run: async () => {
          seen.push('live')
          return 'ok'
        }
      }
    ])
    expect(result).toBe('ok')
    expect(seen).toEqual(['dead', 'live'])
  })

  it('retries a transient failure on the same provider before falling over', async () => {
    let n = 0
    const result = await runFallbackChain(
      [
        {
          id: 'flaky',
          run: async () => {
            n += 1
            if (n === 1) throw new Error('503 Service Unavailable')
            return 'recovered'
          }
        }
      ],
      { maxRetriesPerProvider: 1, sleep: async () => {}, rand: () => 0 }
    )
    expect(result).toBe('recovered')
    expect(n).toBe(2)
  })

  it('cancel fails closed without walking the rest of the chain', async () => {
    const c = new AbortController()
    c.abort()
    await expect(
      runFallbackChain(
        [
          { id: 'a', run: async () => 'nope' },
          { id: 'b', run: async () => 'nope' }
        ],
        { signal: c.signal }
      )
    ).rejects.toThrow(/cancelled/i)
  })
})

describe('wrapEnterpriseStream still returns a StreamHandle', () => {
  it('forwards abort to the dispatched strategy', () => {
    const abort = vi.fn()
    const h: StreamHandle = wrapEnterpriseStream(() => ({ abort }), opts(), { hardTimeoutMs: 5_000 })
    h.abort()
    expect(abort).toHaveBeenCalled()
  })
})
