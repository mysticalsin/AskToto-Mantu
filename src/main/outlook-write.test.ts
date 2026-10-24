import { afterEach, describe, expect, it, vi } from 'vitest'

const { getGraphToken, getGraphTokenOutcome, auditLog } = vi.hoisted(() => ({
  getGraphToken: vi.fn(),
  getGraphTokenOutcome: vi.fn(),
  auditLog: vi.fn()
}))
vi.mock('./auth', () => ({ getGraphToken, getGraphTokenOutcome }))
vi.mock('./logger', () => ({ auditLog }))

import {
  createOutlookDraft,
  createOutlookDraftForConnector,
  createOutlookEvent,
  createOutlookEventForConnector,
  outlookWriteStatus
} from './outlook-write'

afterEach(() => {
  getGraphToken.mockReset()
  getGraphTokenOutcome.mockReset()
  auditLog.mockReset()
  vi.unstubAllGlobals()
})

describe('outlookWriteStatus', () => {
  it('is honest when nobody is signed in', async () => {
    getGraphToken.mockResolvedValue(null)
    await expect(outlookWriteStatus()).resolves.toEqual({
      signedIn: false,
      canDraft: false,
      canEvent: false
    })
  })

  it('reports signed in without inventing write consent', async () => {
    getGraphToken.mockImplementation(async (scopes: string[]) => (scopes.includes('User.Read') ? 'read' : null))
    await expect(outlookWriteStatus()).resolves.toEqual({
      signedIn: true,
      canDraft: false,
      canEvent: false
    })
  })
})

describe('createOutlookDraft — never send', () => {
  it('returns an explicit consent health signal only when token acquisition reports no token', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: false, reason: 'interaction_required' })
    await expect(createOutlookDraftForConnector({ subject: 'Hi', body: 'Next steps' })).resolves.toMatchObject({
      ok: false,
      needsConsent: true,
      healthSignal: 'consent_required'
    })
  })

  it('reports a transient token outage without asking the owner to grant consent', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: false, reason: 'transient' })

    const result = await createOutlookDraftForConnector({ subject: 'Hi', body: 'Next steps' })

    expect(result).toMatchObject({ ok: false, healthSignal: 'transient_failure' })
    expect(result).not.toHaveProperty('needsConsent')
    expect(result.error).not.toMatch(/provider detail/i)
  })

  it('reports transport failures as transient health signals', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('provider detail')
      })
    )
    await expect(createOutlookDraftForConnector({ subject: 'Hi', body: 'Next steps' })).resolves.toMatchObject({
      ok: false,
      healthSignal: 'transient_failure'
    })
  })

  it('reports real provider authorization responses as consent health signals', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }))
    )
    await expect(createOutlookDraftForConnector({ subject: 'Hi', body: 'Next steps' })).resolves.toMatchObject({
      ok: false,
      needsConsent: true,
      healthSignal: 'consent_required'
    })
  })

  it('refuses when write consent is missing', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: false, reason: 'interaction_required' })
    const r = await createOutlookDraft({ subject: 'Hi', body: 'Next steps' })
    expect(r.ok).toBe(false)
    expect(r.needsConsent).toBe(true)
    expect(r.error).toMatch(/will not send/i)
  })

  it('POSTs /me/messages and never /send', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/me\/messages$/)
      expect(url).not.toMatch(/send/i)
      expect(init.method).toBe('POST')
      const body = JSON.parse(String(init.body))
      expect(body.subject).toBe('Follow-up')
      return { ok: true, status: 201, json: async () => ({ id: 'draft-1' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Do the thing' })
    expect(r).toEqual({ ok: true, id: 'draft-1' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(auditLog).toHaveBeenCalledWith('outlook.draft', { ok: true, kind: 'mail' })
  })

  it.each([
    [
      'malformed JSON',
      async () => {
        throw new SyntaxError('provider response body')
      }
    ],
    ['null JSON', async () => null],
    ['a missing id', async () => ({ subject: 'accepted?' })],
    ['an empty id', async () => ({ id: '   ' })],
    ['a non-string id', async () => ({ id: 42 })]
  ])('does not report or audit success for a 2xx response with %s', async (_label, json) => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 201, json }))
    )

    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })

    expect(r.ok).toBe(false)
    expect(r.id).toBeUndefined()
    expect(r.error).toMatch(/check drafts before trying again/i)
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('turns token acquisition rejection into fixed safe guidance', async () => {
    getGraphTokenOutcome.mockRejectedValue(new Error('network timeout with provider detail'))

    await expect(createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })).resolves.toEqual({
      ok: false,
      error: 'Métis could not access Outlook right now. Try again. Nothing was sent.'
    })
  })

  it('treats a fetch rejection as ambiguous without leaking dependency details', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    const fetchMock = vi.fn(async () => {
      throw new Error('secret-token and provider body')
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not confirm whether the draft was created/i)
    expect(r.error).toMatch(/check drafts before trying again/i)
    expect(r.error).not.toMatch(/secret-token|provider body/i)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('treats a 5xx response as ambiguous because the POST may already have committed', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    )

    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not confirm whether the draft was created/i)
    expect(r.error).toMatch(/check drafts before trying again/i)
    expect(auditLog).not.toHaveBeenCalled()
  })
})

describe('createOutlookEvent — no attendees, no invites, readback before success', () => {
  const input = {
    subject: 'Next steps',
    body: 'Review the recap',
    startIso: '2026-09-01T09:00:00.000Z',
    endIso: '2026-09-01T09:30:00.000Z'
  }
  const readbackBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'ev-1',
    subject: 'Next steps',
    start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-01T09:30:00.0000000', timeZone: 'UTC' },
    isCancelled: false,
    ...over
  })
  const stub = (readback: () => unknown): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        expect(JSON.parse(String(init.body)).attendees).toEqual([])
        return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) }
      }
      expect(url).toMatch(/\/me\/events\/ev-1\?/)
      expect((init.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"')
      return readback()
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const posts = (m: ReturnType<typeof vi.fn>): number =>
    m.mock.calls.filter((c) => (c[1] as RequestInit).method === 'POST').length

  it('event create ok only after matching GET readback', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    const m = stub(() => ({ ok: true, status: 200, json: async () => readbackBody() }))
    const r = await createOutlookEvent(input)
    expect(r.ok).toBe(true)
    expect(r.id).toBe('ev-1')
    expect(m).toHaveBeenCalledTimes(2)
    expect(auditLog).toHaveBeenCalledWith('outlook.draft', { ok: true, kind: 'event' })
  })

  it('404 readback → uncertain, no second POST', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    const m = stub(() => ({ ok: false, status: 404, json: async () => ({}) }))
    const r = await createOutlookEventForConnector(input)
    expect(r).toMatchObject({ ok: false, uncertain: true })
    expect(r.error).toMatch(/could not confirm/i)
    expect(posts(m)).toBe(1)
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('mismatched readback → uncertain', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    stub(() => ({
      ok: true,
      status: 200,
      json: async () => readbackBody({ start: { dateTime: '2026-09-01T11:00:00.0000000', timeZone: 'UTC' } })
    }))
    await expect(createOutlookEventForConnector(input)).resolves.toMatchObject({ ok: false, uncertain: true })
  })

  it('thrown readback → uncertain', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
    stub(() => {
      throw new Error('provider detail')
    })
    const r = await createOutlookEventForConnector(input)
    expect(r).toMatchObject({ ok: false, uncertain: true })
    expect(r.error).not.toMatch(/provider detail/)
  })
})
