/**
 * openai-endpoint-guard.test.ts — the bring-your-own-endpoint providers must fail LOUDLY, never quietly.
 *
 * `new OpenAI({ apiKey })` with no baseURL defaults to api.openai.com. Two providers ship no endpoint of
 * their own — 'custom' (any OpenAI-compatible server the user runs) and 'cloudflare' (the operator's own
 * Worker, because Métis must never embed a Cloudflare account token) — so for those two a missing base URL
 * would mean sending the user's key, prompt and transcript to OpenAI's real backend. streamOpenAI refuses
 * instead, and this pins that refusal.
 */
import { describe, it, expect, vi } from 'vitest'
import type { AskStart } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { streamOpenAI } from './openai'
import type { StreamOptions } from './shared'

const req: AskStart = { id: 'guard-1', mode: 'answer', prompt: 'hello', history: [] } as AskStart

function optsFor(providerId: ProviderId, baseURL?: string): StreamOptions {
  return {
    providerId,
    kind: 'openai',
    apiKey: 'placeholder-not-a-real-key',
    baseURL,
    model: 'some-model',
    temperature: 0,
    system: 'you are a test',
    req,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  }
}

/** The guard fires from a queueMicrotask (so the caller has stored the handle first) — let it drain. */
const drain = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => resolve()))

describe('streamOpenAI missing-endpoint guard', () => {
  it('refuses a Cloudflare request with no Worker URL instead of falling back to api.openai.com', async () => {
    const opts = optsFor('cloudflare')
    const handle = streamOpenAI(opts)
    await drain()

    expect(opts.handlers.onError).toHaveBeenCalledTimes(1)
    const message = vi.mocked(opts.handlers.onError).mock.calls[0][0]
    // Names the provider the user actually picked, so the fix is obvious from the message alone.
    expect(message).toContain('Cloudflare')
    expect(message).toMatch(/no endpoint url set/i)
    // Nothing was streamed and nothing was sent.
    expect(opts.handlers.onDelta).not.toHaveBeenCalled()
    expect(opts.handlers.onDone).not.toHaveBeenCalled()
    expect(() => handle.abort()).not.toThrow()
  })

  it('still refuses the Custom provider the same way (the original case, unchanged)', async () => {
    const opts = optsFor('custom')
    streamOpenAI(opts)
    await drain()

    expect(opts.handlers.onError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(opts.handlers.onError).mock.calls[0][0]).toMatch(/no endpoint url set/i)
  })

  it('reports the error asynchronously so the caller has already stored the handle', () => {
    // A synchronous onError re-enters attempt()/failover in index.ts, whose streams.set would then be
    // clobbered by this dummy handle — leaving Cancel and quit unable to abort the real fallback stream.
    const opts = optsFor('cloudflare')
    streamOpenAI(opts)
    expect(opts.handlers.onError).not.toHaveBeenCalled()
  })

  // Which providers the guard covers is pinned in shared/providers.test.ts ("flags EVERY OpenAI-kind
  // provider that ships no endpoint") rather than here: proving the negative for a provider WITH an
  // endpoint would mean letting streamOpenAI open a real socket from a unit test.
})
