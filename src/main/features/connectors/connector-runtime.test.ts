import { beforeEach, describe, expect, it, vi } from 'vitest'

const getGraphToken = vi.fn<(scopes: string[]) => Promise<string | null>>()
vi.mock('../../auth', () => ({ getGraphToken: (s: string[]) => getGraphToken(s) }))
vi.mock('../../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { CONNECTOR_CATALOG_REVISION } from '@shared/connector-catalog'
import { OUTLOOK_DRAFT_CONSENT_COPY } from '../../outlook-write'
import { connectorCatalog, runConnectorWrite, runConnectorWriteDetailed } from './connector-runtime'

beforeEach(() => {
  getGraphToken.mockReset()
  vi.unstubAllGlobals()
})

describe('runConnectorWrite (Outlook IPC consumer)', () => {
  it('creates a draft through the executor and keeps the legacy result shape', async () => {
    getGraphToken.mockResolvedValue('token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk1' }), { status: 201 }))
    )
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' })
    expect(r).toMatchObject({ ok: true, id: 'AAMk1' })
    expect(r.result).toMatchObject({
      ok: true,
      provenance: { connectorKind: 'outlook', opId: 'outlook.draft.create', revision: CONNECTOR_CATALOG_REVISION },
      receipt: { observation: expect.stringContaining('AAMk1') }
    })
    expect(await runConnectorWrite('outlook.draft.create', { subject: 'Hi' })).toEqual({ ok: true, id: 'AAMk1' })
  })

  it('refuses a stale grant with the existing consent copy and never calls Graph', async () => {
    getGraphToken.mockResolvedValue(null)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWrite('outlook.draft.create', { subject: 'Hi' })
    expect(r).toEqual({ ok: false, needsConsent: true, error: OUTLOOK_DRAFT_CONSENT_COPY })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses an op the catalog does not list', async () => {
    const r = await runConnectorWriteDetailed('outlook.mail.send', { subject: 'Hi' })
    expect(r.ok).toBe(false)
    expect(r.result).toMatchObject({ ok: false, reason: 'op_unknown' })
  })

  it('exposes the published revision to main consumers', () => {
    expect(connectorCatalog.current().revision).toBe(CONNECTOR_CATALOG_REVISION)
  })
})
