import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AskStart } from '@shared/ipc'
import { streamDust, resetDustConversation } from './dust'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../auth', () => ({ authStatus: () => ({ email: null, name: null }) }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

const calls = { create: 0, post: 0, get: 0 }
let convCounter = 0

function ok<T>(value: T): { isErr: () => false; value: T } {
  return { isErr: () => false, value }
}

vi.mock('@dust-tt/client', () => {
  class DustAPI {
    async createConversation(): Promise<ReturnType<typeof ok>> {
      calls.create++
      convCounter++
      const sId = `conv-${convCounter}`
      return ok({ conversation: { sId }, message: { sId: `msg-create-${convCounter}` } })
    }
    async postUserMessage(args: { conversationId: string }): Promise<ReturnType<typeof ok>> {
      calls.post++
      return ok({ sId: `msg-post-${calls.post}`, conversationId: args.conversationId })
    }
    async getConversation(args: { conversationId: string }): Promise<ReturnType<typeof ok>> {
      calls.get++
      return ok({ sId: args.conversationId })
    }
    async streamAgentAnswerEvents(): Promise<ReturnType<typeof ok>> {
      return ok({
        eventStream: (async function* (): AsyncGenerator<{ type: string }> {
          yield { type: 'agent_message_success' }
        })()
      })
    }
  }
  return { DustAPI }
})

function baseOpts(overrides: Partial<Parameters<typeof streamDust>[0]> = {}): Parameters<typeof streamDust>[0] {
  const req = { mode: 'answer', prompt: 'hello' } as AskStart
  return {
    providerId: 'dust',
    kind: 'dust',
    apiKey: 'key-123',
    workspaceId: 'ws-1',
    model: 'agent-1',
    temperature: 0.5,
    system: '',
    req,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    ...overrides
  } as Parameters<typeof streamDust>[0]
}

/** Drain microtasks until the stream settles — avoids real/fake-timer polling since the mock API never
 *  uses a real timer, only chained Promises. */
async function waitDone(handlers: {
  onDone: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
}): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (handlers.onDone.mock.calls.length) return
    if (handlers.onError.mock.calls.length) throw new Error(String(handlers.onError.mock.calls[0][0]))
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for Dust stream to settle — calls=${JSON.stringify(calls)}`)
}

describe('Dust conversation continuity (one conversation per meeting)', () => {
  beforeEach(() => {
    resetDustConversation()
    calls.create = 0
    calls.post = 0
    calls.get = 0
    convCounter = 0
  })

  it('reuses the same conversation for a second sequential message in the same meeting', async () => {
    const opts1 = baseOpts()
    streamDust(opts1)
    await waitDone(opts1.handlers)
    expect(calls.create).toBe(1)

    const opts2 = baseOpts()
    streamDust(opts2)
    await waitDone(opts2.handlers)
    expect(calls.create).toBe(1)
    expect(calls.post).toBe(1)
  })

  it('serializes two concurrent first messages into ONE created conversation, not two', async () => {
    // Simulates the real race the audit found: an auto-recap and a manual "Generate follow-up" click
    // firing at nearly the same instant, both targeting the same (workspace, agent) with no cached
    // conversation yet.
    const opts1 = baseOpts()
    streamDust(opts1)
    // Let opts1's OWN dynamic `import('@dust-tt/client')` settle before firing opts2. This keeps the test
    // focused on the actual behavior under test — the creationInFlight gate — without also exercising two
    // simultaneous FIRST-EVER dynamic imports of the same mocked specifier, which is a Vitest/Node ESM-loader
    // race in the test harness itself (confirmed via debug tracing: one of the two cold imports can
    // non-deterministically resolve to the real, unmocked @dust-tt/client instead of vi.mock's version).
    // Real production code never hits this: the app's very first Dust request resolves the import once,
    // and every later import of an already-loaded module — concurrent or not — reuses that same resolved
    // reference. opts2 still fires while opts1's createConversation call is genuinely in flight (before
    // activeConversation is set), so the creationInFlight gate itself is still exercised for real.
    for (let i = 0; i < 200 && calls.create === 0; i++) await Promise.resolve()
    expect(calls.create).toBe(1) // opts1's import resolved and it started creating — now fire opts2

    const opts2 = baseOpts()
    streamDust(opts2)
    await Promise.all([waitDone(opts1.handlers), waitDone(opts2.handlers)])

    expect(calls.create).toBe(1) // only one conversation created for the pair, not two forked ones
    expect(calls.post).toBe(1) // the second request joins it via postUserMessage instead
  })

  it('resetDustConversation forces a new conversation for the next meeting', async () => {
    const opts1 = baseOpts()
    streamDust(opts1)
    await waitDone(opts1.handlers)
    expect(calls.create).toBe(1)

    resetDustConversation()

    const opts2 = baseOpts()
    streamDust(opts2)
    await waitDone(opts2.handlers)
    expect(calls.create).toBe(2)
  })

  it('does not reuse a conversation across different Dust agents', async () => {
    const opts1 = baseOpts({ model: 'agent-1' })
    streamDust(opts1)
    await waitDone(opts1.handlers)

    const opts2 = baseOpts({ model: 'agent-2' })
    streamDust(opts2)
    await waitDone(opts2.handlers)

    expect(calls.create).toBe(2)
  })

  it('starts a fresh conversation once the cached one goes stale past the TTL', async () => {
    const realNow = Date.now
    try {
      const opts1 = baseOpts()
      streamDust(opts1)
      await waitDone(opts1.handlers)
      expect(calls.create).toBe(1)

      const future = realNow() + 3 * 60 * 60 * 1000 // +3h, past the 2h TTL
      Date.now = () => future

      const opts2 = baseOpts()
      streamDust(opts2)
      await waitDone(opts2.handlers)
      expect(calls.create).toBe(2)
    } finally {
      Date.now = realNow
    }
  })
})
