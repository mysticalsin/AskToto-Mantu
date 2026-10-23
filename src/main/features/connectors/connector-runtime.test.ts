import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getGraphToken = vi.fn<(scopes: string[]) => Promise<string | null>>()
vi.mock('../../auth', () => ({ getGraphToken: (s: string[]) => getGraphToken(s) }))
vi.mock('../../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { CONNECTOR_CATALOG_REVISION } from '@shared/connector-catalog'
import { OUTLOOK_DRAFT_CONSENT_COPY } from '../../outlook-write'
import { createMemoryConnectorAccountStore } from './account-store'
import { createConnectorAccountRegistry } from './account-registry'
import {
  configureConnectorAccountRuntime,
  connectorCatalog,
  runConnectorWrite,
  runConnectorWriteDetailed
} from './connector-runtime'

const SCOPE = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
let runtimeRegistry: ReturnType<typeof createConnectorAccountRegistry>

beforeEach(() => {
  getGraphToken.mockReset()
  vi.unstubAllGlobals()
  runtimeRegistry = createConnectorAccountRegistry({
    currentScope: () => SCOPE,
    store: createMemoryConnectorAccountStore()
  })
  configureConnectorAccountRuntime({
    registry: runtimeRegistry,
    ensureCurrentAccount: (kind) =>
      runtimeRegistry.ensureAccount({
        kind,
        providerAccountId: 'synthetic-outlook-owner@example.test',
        label: 'Synthetic Outlook'
      })
  })
})

afterEach(() => configureConnectorAccountRuntime(null))

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

  it('resolves the signed-in account through the owner-scoped registry before the Graph call', async () => {
    getGraphToken.mockResolvedValue('token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk2' }), { status: 201 })))
    const result = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' })
    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({ ok: true, provenance: { accountRef: expect.stringMatching(/^acct_/) } })
  })

  it('fails closed when more than one account is available and the consumer supplied no selection', async () => {
    await runtimeRegistry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'other-owner@example.test',
      label: 'Other'
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' })
    expect(result.result).toMatchObject({ ok: false, reason: 'account_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getGraphToken).not.toHaveBeenCalled()
  })
})
