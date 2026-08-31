import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type AskStart, DUST_SPOTLIGHT_REF_AGENT_ID } from '@shared/ipc'
import { streamDust, resetDustConversation } from './dust'
import type { StreamHandlers } from './shared'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../auth', () => ({ authStatus: () => ({ email: null, name: null }) }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

type ManagedDustChatResult =
  | { ok: true; text: string }
  | { ok: false; kind: string; error: string }

const managedDustChat = vi.hoisted(() =>
  vi.fn<(opts: unknown) => Promise<ManagedDustChatResult>>(async () => ({
    ok: true,
    text: 'Data and AI, AI wiki'
  }))
)
vi.mock('../dust-cli-chat', () => ({
  runManagedDustChat: (opts: unknown) => managedDustChat(opts),
  projectNameForDataAndAiAsk: () => undefined
}))
vi.mock('../dust-projects', () => ({
  fetchDustProjects: async () => ({ ok: false, error: 'test' }),
  matchDataAndAiProjects: () => []
}))

const calls = { create: 0, post: 0, get: 0 }
const postedTo: string[] = [] // which conversation each follow-up message joined, in order
let convCounter = 0
let throwOnNextCreate = false // one-shot: simulates createConversation rejecting instead of returning Result.Err
let streamErrOnce: string | null = null // one-shot: streamAgentAnswerEvents returns Result.Err with this message

function ok<T>(value: T): { isErr: () => false; value: T } {
  return { isErr: () => false, value }
}

function err(message: string): { isErr: () => true; error: Error } {
  return { isErr: () => true, error: new Error(message) }
}

vi.mock('@dust-tt/client', () => {
  class DustAPI {
    async createConversation(): Promise<ReturnType<typeof ok>> {
      calls.create++
      if (throwOnNextCreate) {
        throwOnNextCreate = false
        throw new Error('simulated network exception (not a Result.Err)')
      }
      convCounter++
      const sId = `conv-${convCounter}`
      return ok({ conversation: { sId }, message: { sId: `msg-create-${convCounter}` } })
    }
    async postUserMessage(args: { conversationId: string }): Promise<ReturnType<typeof ok>> {
      calls.post++
      postedTo.push(args.conversationId)
      return ok({ sId: `msg-post-${calls.post}`, conversationId: args.conversationId })
    }
    async getConversation(args: { conversationId: string }): Promise<ReturnType<typeof ok>> {
      calls.get++
      return ok({ sId: args.conversationId })
    }
    async streamAgentAnswerEvents(): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
      if (streamErrOnce) {
        const m = streamErrOnce
        streamErrOnce = null
        return err(m)
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
/** A StreamHandlers callback is typed as a plain function; in these tests it is always a vi.fn(). Narrow
 *  at the point of use rather than loosening the production type, which is what the tests exist to pin. */
function mockOf(f: unknown): { mock: { calls: unknown[][] } } {
  return f as { mock: { calls: unknown[][] } }
}

async function waitDone(handlers: {
  // `ReturnType<typeof vi.fn>` is a Mock with NO call signature attached, so passing a real
  // StreamHandlers object here was a type error on all twenty call sites — the helper's parameter
  // described the stub rather than what every caller actually hands it. Accept the real shape and
  // narrow to the mock surface only where the mock surface is used.
  onDone: StreamHandlers['onDone']
  onError: StreamHandlers['onError']
}): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (mockOf(handlers.onDone).mock.calls.length) return
    if (mockOf(handlers.onError).mock.calls.length) throw new Error(String(mockOf(handlers.onError).mock.calls[0][0]))
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
    postedTo.length = 0
    convCounter = 0
    throwOnNextCreate = false
    streamErrOnce = null
    managedDustChat.mockReset()
    managedDustChat.mockResolvedValue({ ok: true, text: 'Data and AI, AI wiki' })
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

  it('MQA-039 / MQA-052: a Spotlight Ref ask is a managed CLI call and does not evict the base conversation', async () => {
    // Spotlight Ref is hard-pinned and now goes through the managed Dust CLI, not REST conversations.
    // A CLI ask must not destroy the base agent's meeting thread (dust.ts never replays req.history).
    const first = baseOpts({ model: 'agent-1' })
    streamDust(first)
    await waitDone(first.handlers)

    const spotlight = baseOpts({ model: DUST_SPOTLIGHT_REF_AGENT_ID })
    streamDust(spotlight)
    await waitDone(spotlight.handlers)

    expect(managedDustChat).toHaveBeenCalled()
    expect(calls.create).toBe(1) // CLI path — no REST conversation for Spotlight Ref

    const backToChat = baseOpts({ model: 'agent-1' })
    streamDust(backToChat)
    await waitDone(backToChat.handlers)

    expect(calls.create).toBe(1) // base agent thread survived the Spotlight CLI ask
    expect(postedTo).toEqual(['conv-1'])

    const spotlightAgain = baseOpts({ model: DUST_SPOTLIGHT_REF_AGENT_ID })
    streamDust(spotlightAgain)
    await waitDone(spotlightAgain.handlers)

    expect(managedDustChat).toHaveBeenCalledTimes(2)
    expect(calls.create).toBe(1)
    expect(postedTo).toEqual(['conv-1'])
  })

  it('MQA-052: resetDustConversation clears every agent slot, not just the last one used', async () => {
    const chat = baseOpts({ model: 'agent-1' })
    streamDust(chat)
    await waitDone(chat.handlers)

    const spotlight = baseOpts({ model: DUST_SPOTLIGHT_REF_AGENT_ID })
    streamDust(spotlight)
    await waitDone(spotlight.handlers)

    resetDustConversation() // new meeting starts

    const nextChat = baseOpts({ model: 'agent-1' })
    streamDust(nextChat)
    await waitDone(nextChat.handlers)

    const nextSpotlight = baseOpts({ model: DUST_SPOTLIGHT_REF_AGENT_ID })
    streamDust(nextSpotlight)
    await waitDone(nextSpotlight.handlers)

    expect(calls.create).toBe(2) // REST base-agent slot starts over; Spotlight Ref is CLI (no REST slot)
    expect(postedTo).toEqual([]) // nothing joined a previous meeting's thread
    expect(managedDustChat).toHaveBeenCalledTimes(2)
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

  it('releases the creation gate even when createConversation throws, so the next request does not deadlock', async () => {
    throwOnNextCreate = true
    const opts1 = baseOpts()
    streamDust(opts1)
    // The thrown exception surfaces as a stream error (fail()), not onDone — confirm it doesn't hang.
    await expect(waitDone(opts1.handlers)).rejects.toThrow()

    // If the gate leaked (the pre-fix bug), this second call would hang forever waiting on a promise
    // nothing ever resolves. It must complete normally instead.
    const opts2 = baseOpts()
    streamDust(opts2)
    await waitDone(opts2.handlers)
    expect(calls.create).toBe(2) // first attempt (threw) + second attempt (succeeded)
  })
})

describe('isDustAuthError — 401 phrasing drift across Dust API versions', async () => {
  const { isDustAuthError } = await import('./dust')

  it('recognizes every observed 401 wording so refresh-and-retry fires', () => {
    expect(isDustAuthError({ type: 'expired_oauth_token_error' })).toBe(true)
    expect(isDustAuthError({ message: 'The request does not have valid authentication credentials.' })).toBe(true)
    // The wording that reached a user on 2026-07-06 (Spotlight Ref failure) — previously unmatched:
    expect(isDustAuthError({ message: 'The user request does not have a valid authenticated credential.' })).toBe(true)
    expect(isDustAuthError({ message: 'Unauthorized' })).toBe(true)
    expect(isDustAuthError({ message: 'Invalid API token' })).toBe(true)
    expect(isDustAuthError({ status: 401, message: 'anything' })).toBe(true)
  })

  it('does not classify ordinary failures as auth errors', () => {
    expect(isDustAuthError(null)).toBe(false)
    expect(isDustAuthError({ message: 'agent not found' })).toBe(false)
    expect(isDustAuthError({ message: 'rate limited, retry later' })).toBe(false)
    expect(isDustAuthError({ status: 500, message: 'internal error' })).toBe(false)
  })
})

describe('isDustAgentUnavailableError — stale/removed agent sId (distinct from auth)', async () => {
  const { isDustAgentUnavailableError } = await import('./dust')

  it('recognizes the SDK empty-reply error and the API agent-not-found wordings', () => {
    // @dust-tt/client returns "Failed to retrieve agent message" when Dust accepts the user message but
    // creates no agent reply — the signature of a mentioned agent sId gone from the connected workspace.
    expect(isDustAgentUnavailableError({ message: 'Failed to retrieve agent message' })).toBe(true)
    expect(isDustAgentUnavailableError({ message: 'agent not found' })).toBe(true)
    expect(isDustAgentUnavailableError({ message: 'Agent configuration not found' })).toBe(true)
    expect(isDustAgentUnavailableError({ message: 'No such agent' })).toBe(true)
  })

  it('does NOT swallow auth errors (own refresh-and-retry self-heal) or generic failures', () => {
    expect(isDustAgentUnavailableError(null)).toBe(false)
    expect(isDustAgentUnavailableError({ message: 'The user request does not have a valid authenticated credential.' })).toBe(false)
    expect(isDustAgentUnavailableError({ status: 401, message: 'Unauthorized' })).toBe(false)
    expect(isDustAgentUnavailableError({ message: 'rate limited, retry later' })).toBe(false)
  })
})

describe('streamDust surfaces a stale-agent error as an actionable re-pick message', () => {
  it('maps "Failed to retrieve agent message" to a Settings → AI hint, not the raw SDK string', async () => {
    resetDustConversation()
    streamErrOnce = 'Failed to retrieve agent message'
    const opts = baseOpts()
    streamDust(opts)
    for (let i = 0; i < 500 && !mockOf(opts.handlers.onError).mock.calls.length; i++) {
      await new Promise((r) => setImmediate(r))
    }
    expect(opts.handlers.onError).toHaveBeenCalledTimes(1)
    const msg = String(mockOf(opts.handlers.onError).mock.calls[0][0])
    expect(msg).toContain('Settings')
    expect(msg).not.toContain('Failed to retrieve agent message')
  })

  it('maps a stale SPOTLIGHT agent to a Spotlight-specific remedy, not the base picker hint', async () => {
    // Spotlight Ref is a managed CLI call. When that agent is gone from the CLI session, fail loud
    // with "not in this workspace" — never reconnect-workspace or "pick one in Settings".
    resetDustConversation()
    managedDustChat.mockResolvedValue({
      ok: false,
      kind: 'missing-agent',
      error: 'The Spotlight Ref agent is not in this workspace.'
    })
    const opts = baseOpts({ model: DUST_SPOTLIGHT_REF_AGENT_ID })
    streamDust(opts)
    for (let i = 0; i < 500 && !mockOf(opts.handlers.onError).mock.calls.length; i++) {
      await new Promise((r) => setImmediate(r))
    }
    expect(opts.handlers.onError).toHaveBeenCalledTimes(1)
    const msg = String(mockOf(opts.handlers.onError).mock.calls[0][0])
    expect(msg).toContain('Spotlight Ref')
    expect(msg.toLowerCase()).toContain('not in this workspace')
    expect(msg.toLowerCase()).not.toContain('reconnect')
    expect(msg).not.toContain('Failed to retrieve agent message')
  })
})
