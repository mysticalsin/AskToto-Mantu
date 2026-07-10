// Regression: mid-meeting Dust 401 retries in the existing conversation with fresh credentials.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AskStart } from '@shared/ipc'
import { streamDust, resetDustConversation } from './dust'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../auth', () => ({ authStatus: () => ({ email: null, name: null }) }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

const calls = { create: 0, post: 0, get: 0 }
const postConvIds: string[] = []
const apiKeysUsed: string[] = []
let convCounter = 0
let failNextPostWith401 = false // one-shot: simulates the expired-token 401 on postUserMessage

function ok<T>(value: T): { isErr: () => false; value: T } {
  return { isErr: () => false, value }
}
function err(e: unknown): { isErr: () => true; error: unknown } {
  return { isErr: () => true, error: e }
}

let lastCtorApiKey = ''
vi.mock('@dust-tt/client', () => {
  class DustAPI {
    constructor(_url: unknown, creds: { apiKey: string }) {
      lastCtorApiKey = creds.apiKey
    }
    async createConversation(): Promise<unknown> {
      calls.create++
      apiKeysUsed.push(`create:${lastCtorApiKey}`)
      convCounter++
      const sId = `conv-${convCounter}`
      return ok({ conversation: { sId }, message: { sId: `msg-create-${convCounter}` } })
    }
    async postUserMessage(args: { conversationId: string }): Promise<unknown> {
      calls.post++
      postConvIds.push(args.conversationId)
      apiKeysUsed.push(`post:${lastCtorApiKey}:${args.conversationId}`)
      if (failNextPostWith401) {
        failNextPostWith401 = false
        // Exact wording that reached a user on 2026-07-06, now matched by the broadened isDustAuthError:
        return err({ message: 'The user request does not have a valid authenticated credential.' })
      }
      return ok({ sId: `msg-post-${calls.post}`, conversationId: args.conversationId })
    }
    async getConversation(args: { conversationId: string }): Promise<unknown> {
      calls.get++
      return ok({ sId: args.conversationId })
    }
    async streamAgentAnswerEvents(): Promise<unknown> {
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
  const req = { mode: 'answer', prompt: 'fact-check this' } as AskStart
  return {
    providerId: 'dust',
    kind: 'dust',
    apiKey: 'stale-key',
    workspaceId: 'ws-1',
    model: 'agent-1',
    temperature: 0.5,
    system: '',
    req,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    ...overrides
  } as Parameters<typeof streamDust>[0]
}

async function waitDone(handlers: { onDone: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> }): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (handlers.onDone.mock.calls.length) return
    if (handlers.onError.mock.calls.length) throw new Error(String(handlers.onError.mock.calls[0][0]))
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out — calls=${JSON.stringify(calls)}`)
}

describe('Dust 401 self-heal on the conversation-reuse path', () => {
  beforeEach(() => {
    resetDustConversation()
    calls.create = 0
    calls.post = 0
    calls.get = 0
    convCounter = 0
    postConvIds.length = 0
    apiKeysUsed.length = 0
    failNextPostWith401 = false
  })

  it('preserves the cached conversation when refresh succeeds', async () => {
    // 1. First ask of the meeting — creates + caches conv-1.
    const opts1 = baseOpts()
    streamDust(opts1)
    await waitDone(opts1.handlers)
    expect(calls.create).toBe(1)

    // 2. Token expires mid-meeting. Next ask hits the reuse path and gets the 401.
    failNextPostWith401 = true
    const refreshDustAuth = vi
      .fn()
      .mockResolvedValue({ apiKey: 'fresh-key', workspaceId: 'ws-1' })
    const opts2 = baseOpts({ refreshDustAuth })
    streamDust(opts2)
    await waitDone(opts2.handlers)

    // The refresh DID fire (self-heal engaged):
    expect(refreshDustAuth).toHaveBeenCalledTimes(1)

    expect(calls.create).toBe(1)
    expect(postConvIds).toEqual(['conv-1', 'conv-1'])
    expect(apiKeysUsed).toContain('post:fresh-key:conv-1')

    // The next ask continues in the same meeting conversation, not a replacement conversation.
    const opts3 = baseOpts({ apiKey: 'fresh-key' })
    streamDust(opts3)
    await waitDone(opts3.handlers)
    expect(postConvIds[postConvIds.length - 1]).toBe('conv-1')
  })
})
