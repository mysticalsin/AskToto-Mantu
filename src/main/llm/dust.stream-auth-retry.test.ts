// Regression: a stream-start Dust auth retry must not post the already-created user message twice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AskStart } from '@shared/ipc'
import { streamDust, resetDustConversation } from './dust'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../auth', () => ({ authStatus: () => ({ email: null, name: null }) }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

const calls = {
  create: 0,
  post: 0,
  stream: 0,
  createdContents: [] as string[],
  postedContents: [] as string[],
  postedConvIds: [] as string[],
  apiKeys: [] as string[],
  streamApiKeys: [] as string[]
}
let failFirstStream = false

function ok<T>(value: T): { isErr: () => false; value: T } {
  return { isErr: () => false, value }
}
function err<E>(error: E): { isErr: () => true; error: E } {
  return { isErr: () => true, error }
}

vi.mock('@dust-tt/client', () => {
  class DustAPI {
    private apiKey: string
    constructor(_url: unknown, creds: { apiKey: string }) {
      this.apiKey = creds.apiKey
    }
    async createConversation(args: { message: { content: string } }): Promise<unknown> {
      calls.create++
      calls.createdContents.push(args.message.content)
      calls.apiKeys.push(`create:${this.apiKey}`)
      return ok({ conversation: { sId: `conv-${calls.create}` }, message: { sId: `msg-create-${calls.create}` } })
    }
    async postUserMessage(args: { conversationId: string; message: { content: string } }): Promise<unknown> {
      calls.post++
      calls.postedContents.push(args.message.content)
      calls.postedConvIds.push(args.conversationId)
      calls.apiKeys.push(`post:${this.apiKey}`)
      return ok({ sId: `msg-post-${calls.post}`, conversationId: args.conversationId })
    }
    async getConversation(args: { conversationId: string }): Promise<unknown> {
      return ok({ sId: args.conversationId })
    }
    async streamAgentAnswerEvents(): Promise<unknown> {
      calls.stream++
      calls.streamApiKeys.push(this.apiKey)
      if (failFirstStream && calls.stream === 1) {
        // Exact wording that reached a user on 2026-07-06 — matched ONLY by the broadened isDustAuthError.
        return err({ message: 'The user request does not have a valid authenticated credential.' })
      }
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
    apiKey: 'stale-key',
    workspaceId: 'ws-1',
    model: 'agent-1',
    temperature: 0.5,
    system: 'SYSTEM PREAMBLE',
    req,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    refreshDustAuth: async () => ({ apiKey: 'fresh-key', workspaceId: 'ws-1' }),
    ...overrides
  } as Parameters<typeof streamDust>[0]
}

async function waitDone(handlers: {
  onDone: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
}): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (handlers.onDone.mock.calls.length) return
    if (handlers.onError.mock.calls.length) throw new Error(String(handlers.onError.mock.calls[0][0]))
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out — calls=${JSON.stringify(calls)}`)
}

describe('Dust auth retry after stream-start 401', () => {
  beforeEach(() => {
    resetDustConversation()
    calls.create = 0
    calls.post = 0
    calls.stream = 0
    calls.createdContents = []
    calls.postedContents = []
    calls.postedConvIds = []
    calls.apiKeys = []
    calls.streamApiKeys = []
    failFirstStream = false
  })

  it('reuses the created message without a duplicate post, and retries the stream attach with FRESH credentials', async () => {
    failFirstStream = true
    const opts = baseOpts()
    streamDust(opts)
    await waitDone(opts.handlers)

    expect(calls.create).toBe(1)
    expect(calls.post).toBe(0)
    expect(calls.createdContents).toHaveLength(1)

    // The first stream attach used the stale key and 401'd; the retry must use the refreshed one —
    // not silently replay the same stale credential (which would just 401 again).
    expect(calls.stream).toBe(2)
    expect(calls.streamApiKeys).toEqual(['stale-key', 'fresh-key'])
  })
})
