import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('./auth', () => ({ getGraphToken: vi.fn(async () => 'graph-token') }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { fetchTeamsTranscriptForMeeting } from './graph-transcript'

// MQA-189 — the Teams-transcript chain makes four SEQUENTIAL Graph calls, and backfillSpeakerNames
// (index.ts) awaits the whole chain for a user-invoked "backfill speakers" action in Review. Unbounded,
// a proxy that black-holes established sockets holds that click for 4 x undici's 300 s default. One
// budget for the whole chain — not one per hop, which would still stack to 4x.
describe('fetchTeamsTranscriptForMeeting — bounded Graph chain (MQA-189)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('MQA-189 bounds the whole four-call chain with one deadline and degrades to null when it fires', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const stall = new AbortController()
    timeoutSpy.mockReturnValue(stall.signal)

    const json = (value: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } => ({
      ok: true,
      status: 200,
      json: async () => value
    })
    const fetchMock = vi.fn((url: string, init: { signal?: AbortSignal }) => {
      if (url.includes('/content')) {
        // The hop that black-holes: only the signal can end it.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          )
        })
      }
      if (url.includes('/transcripts')) {
        return Promise.resolve(json({ value: [{ id: 'tr-1', createdDateTime: '2026-08-19T10:00:00Z' }] }))
      }
      if (url.includes('/onlineMeetings')) return Promise.resolve(json({ value: [{ id: 'mtg-1' }] }))
      return Promise.resolve(
        json({ value: [{ onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } }] })
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const startedAt = Date.parse('2026-08-19T09:00:00Z')
    const pending = fetchTeamsTranscriptForMeeting({ startedAt, endedAt: startedAt + 30 * 60_000 })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    const signals = fetchMock.mock.calls.map(
      (c) => (c as unknown as [string, { signal?: AbortSignal }])[1].signal
    )
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal)
    // One deadline for the chain, not one per hop: every call carries the same signal instance.
    expect(new Set(signals).size).toBe(1)
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).toHaveBeenCalledWith(15_000) // the house bound for an outbound Graph/OAuth exchange

    stall.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    // Speaker enrichment is best-effort: a dead network must degrade to "nothing to add", never a hang.
    await expect(pending).resolves.toBeNull()
  })
})
