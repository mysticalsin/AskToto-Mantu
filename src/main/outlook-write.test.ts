import { afterEach, describe, expect, it, vi } from 'vitest'

const { getGraphToken } = vi.hoisted(() => ({ getGraphToken: vi.fn() }))
vi.mock('./auth', () => ({ getGraphToken }))
vi.mock('./logger', () => ({ auditLog: vi.fn() }))

import { createOutlookDraft, createOutlookEvent, outlookWriteStatus } from './outlook-write'

afterEach(() => {
  getGraphToken.mockReset()
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
