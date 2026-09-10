import { afterEach, describe, expect, it, vi } from 'vitest'

const { getGraphToken, auditLog } = vi.hoisted(() => ({ getGraphToken: vi.fn(), auditLog: vi.fn() }))
vi.mock('./auth', () => ({ getGraphToken }))
vi.mock('./logger', () => ({ auditLog }))

import { createOutlookDraft, createOutlookEvent, outlookWriteStatus } from './outlook-write'

afterEach(() => {
  getGraphToken.mockReset()
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
  it('refuses when write consent is missing', async () => {
    getGraphToken.mockResolvedValue(null)
    const r = await createOutlookDraft({ subject: 'Hi', body: 'Next steps' })
    expect(r.ok).toBe(false)
    expect(r.needsConsent).toBe(true)
    expect(r.error).toMatch(/will not send/i)
  })

  it('POSTs /me/messages and never /send', async () => {
    getGraphToken.mockResolvedValue('tok')
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
    ['malformed JSON', async () => { throw new SyntaxError('provider response body') }],
    ['null JSON', async () => null],
    ['a missing id', async () => ({ subject: 'accepted?' })],
    ['an empty id', async () => ({ id: '   ' })],
    ['a non-string id', async () => ({ id: 42 })]
  ])('does not report or audit success for a 2xx response with %s', async (_label, json) => {
    getGraphToken.mockResolvedValue('tok')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json })))

    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })

    expect(r.ok).toBe(false)
    expect(r.id).toBeUndefined()
    expect(r.error).toMatch(/check drafts before trying again/i)
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('turns token acquisition rejection into fixed safe guidance', async () => {
    getGraphToken.mockRejectedValue(new Error('secret-token-from-provider'))

    await expect(createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })).resolves.toEqual({
      ok: false,
      error: 'Métis could not access Outlook right now. Try again. Nothing was sent.'
    })
  })

  it('treats a fetch rejection as ambiguous without leaking dependency details', async () => {
    getGraphToken.mockResolvedValue('tok')
    const fetchMock = vi.fn(async () => { throw new Error('secret-token and provider body') })
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
    getGraphToken.mockResolvedValue('tok')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })))

    const r = await createOutlookDraft({ subject: 'Follow-up', body: 'Next steps' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not confirm whether the draft was created/i)
    expect(r.error).toMatch(/check drafts before trying again/i)
    expect(auditLog).not.toHaveBeenCalled()
  })
})

describe('createOutlookEvent — no attendees, no invites', () => {
  it('POSTs /me/events with an empty attendees list', async () => {
    getGraphToken.mockResolvedValue('tok')
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.attendees).toEqual([])
      return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await createOutlookEvent({
      subject: 'Next steps',
      body: 'Review the recap',
      startIso: '2026-09-01T09:00:00.000Z',
      endIso: '2026-09-01T09:30:00.000Z'
    })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('ev-1')
  })
})
