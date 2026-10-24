import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getGraphTokenOutcome =
  vi.fn<
    (
      scopes: string[]
    ) => Promise<
      | { ok: true; token: string }
      | { ok: false; reason: 'not_configured' | 'no_account' | 'interaction_required' | 'transient' }
    >
  >()
vi.mock('../../auth', () => ({
  getGraphToken: vi.fn(),
  getGraphTokenOutcome: (s: string[]) => getGraphTokenOutcome(s)
}))
const appendTimeSavedEvent = vi.fn()
vi.mock('../../time-saved-log', () => ({ appendTimeSavedEvent: (e: unknown) => appendTimeSavedEvent(e) }))
vi.mock('../../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
const eventKit = {
  status: vi.fn<() => Promise<string | null>>(),
  ask: vi.fn<() => Promise<string | null>>(),
  create: vi.fn<(input: unknown) => Promise<unknown>>(),
  read: vi.fn<(id: string) => Promise<unknown>>()
}
vi.mock('../../infra/process/eventkit-helper-host', () => ({ createEventKitHost: () => eventKit }))

import { CONNECTOR_CATALOG_REVISION } from '@shared/connector-catalog'
import { OUTLOOK_DRAFT_CONSENT_COPY } from '../../outlook-write'
import { createMemoryConnectorAccountStore } from './account-store'
import { createConnectorAccountRegistry } from './account-registry'
import type { AccountChoiceState } from '@shared/connector-account-choice'
import type { ConnectorConfirmCard } from '@shared/connector-confirm'
import {
  accountChoiceBroker,
  configureAccountChoiceDelivery,
  configureConnectorAccountRuntime,
  configureConnectorConfirmDelivery,
  connectorCatalog,
  connectorConfirmBroker,
  runConnectorWrite,
  runConnectorWriteDetailed
} from './connector-runtime'
import { writeArgsHash } from './connector-executor'
import { actionIdempotencyKey } from '../../action-guard'

const SCOPE = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
let runtimeRegistry: ReturnType<typeof createConnectorAccountRegistry>
const ASKED = { ownerWebContentsId: 5 }

/** The owner's window answers every confirm card after the 300 ms guard. Cards are recorded for assertions. */
function answerCards(confirm: boolean): ConnectorConfirmCard[] {
  const seen: ConnectorConfirmCard[] = []
  vi.useFakeTimers({ toFake: ['Date'] })
  configureConnectorConfirmDelivery((id, state) => {
    if (state.proposalId === null) return
    seen.push(state)
    vi.setSystemTime(Date.now() + 500)
    connectorConfirmBroker().decide({
      proposalId: state.proposalId,
      nonce: state.nonce,
      argsHash: state.argsHash,
      confirm,
      webContentsId: id
    })
  })
  return seen
}

beforeEach(() => {
  answerCards(true)
  getGraphTokenOutcome.mockReset()
  appendTimeSavedEvent.mockReset()
  getGraphTokenOutcome.mockResolvedValue({ ok: true, token: 'synthetic-token' })
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

afterEach(() => {
  accountChoiceBroker().revokeAll('test')
  connectorConfirmBroker().revokeAll('test')
  configureConnectorConfirmDelivery(null)
  configureAccountChoiceDelivery(null)
  configureConnectorAccountRuntime(null)
  vi.useRealTimers()
})

describe('runConnectorWrite (Outlook IPC consumer)', () => {
  it('creates a draft through the executor and keeps the legacy result shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk1' }), { status: 201 }))
    )
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' }, ASKED)
    expect(r).toMatchObject({ ok: true, id: 'AAMk1' })
    expect(r.result).toMatchObject({
      ok: true,
      provenance: { connectorKind: 'outlook', opId: 'outlook.draft.create', revision: CONNECTOR_CATALOG_REVISION },
      receipt: { observation: expect.stringContaining('AAMk1') }
    })
    expect(await runConnectorWrite('outlook.draft.create', { subject: 'Hi' }, ASKED)).toEqual({
      ok: true,
      id: 'AAMk1'
    })
  })

  it('refuses a stale grant with the existing consent copy and never calls Graph', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: false, reason: 'interaction_required' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWrite('outlook.draft.create', { subject: 'Hi' }, ASKED)
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk2' }), { status: 201 }))
    )
    const result = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' }, ASKED)
    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({ ok: true, provenance: { accountRef: expect.stringMatching(/^acct_/) } })
  })

  it('acts only as the signed-in account when another is connected and the consumer supplied no selection', async () => {
    await runtimeRegistry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'other-owner@example.test',
      label: 'Other'
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' }, ASKED)
    expect(result.result).not.toMatchObject({ reason: 'account_ambiguous' })
    expect(result.result).toMatchObject({ provenance: { accountRule: 'only_executable_account' } })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('fails a write closed on transient token acquisition without claiming missing consent', async () => {
    getGraphTokenOutcome.mockResolvedValue({ ok: false, reason: 'transient' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi' }, ASKED)

    expect(result.result).toMatchObject({ ok: false, reason: 'account_not_ready' })
    expect(result.result).not.toHaveProperty('needsConsent')
    expect(await runtimeRegistry.listViews()).toMatchObject([{ health: 'degraded', reason: 'token_refresh_transient' }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('connector writes wait for the confirm card (G64)', () => {
  const created = () => vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk-card' }), { status: 201 }))

  it("runs an outlook draft only after confirm, with the card's own proposal id as the approval", async () => {
    vi.useRealTimers()
    const seen = answerCards(true)
    vi.stubGlobal('fetch', created())
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi', body: 'x' }, ASKED)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ effectClass: 'reversible_write', connectorLabel: 'Outlook', subjectPreview: 'Hi' })
    expect(r.result).toMatchObject({ ok: true })
    // The idempotency key is derived from the card's proposal id and the args hash, so it proves which id approved.
    const receipt = (r.result as { receipt: { argsHash: string; idempotencyKey: string } }).receipt
    expect(receipt.argsHash).toBe(seen[0].argsHash)
    expect(receipt.idempotencyKey).toBe(actionIdempotencyKey(seen[0].proposalId, seen[0].argsHash))
  })

  it('a declined card returns confirm_declined and Graph is never called', async () => {
    vi.useRealTimers()
    answerCards(false)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi' }, ASKED)
    expect(r).toMatchObject({ ok: false, error: 'Cancelled. Nothing was changed.' })
    expect(r.result).toMatchObject({ ok: false, reason: 'confirm_declined' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('without a window to show the card in, nothing runs', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi' })
    expect(r.result).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sign-out while the card is open revokes it and nothing runs', async () => {
    configureConnectorConfirmDelivery(() => connectorConfirmBroker().revokeAll('sign-out'))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWriteDetailed('outlook.draft.create', { subject: 'Hi' }, ASKED)
    expect(r.result).toMatchObject({ ok: false, reason: 'confirm_declined' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('account choice and the identity a handler really uses (G62)', () => {
  const OWNER = 5
  const draftInput = { subject: 'Quarterly numbers', body: 'private body text' }
  const created = () => vi.fn(async () => new Response(JSON.stringify({ id: 'AAMk-chosen' }), { status: 201 }))

  async function twoAccounts() {
    const current = await runtimeRegistry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'synthetic-outlook-owner@example.test',
      label: 'Synthetic Outlook'
    })
    const other = await runtimeRegistry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'second-account@example.test',
      label: 'Second'
    })
    await runtimeRegistry.observe('outlook', current, 'token_refresh_succeeded')
    await runtimeRegistry.observe('outlook', other, 'token_refresh_succeeded')
    return { current, other }
  }
  const sentCards = () => {
    const sent: Array<{ id: number; state: AccountChoiceState }> = []
    configureAccountChoiceDelivery((id, state) => sent.push({ id, state }))
    return sent
  }

  it('with two healthy accounts it resolves to the signed-in one and shows no card (the other cannot execute)', async () => {
    const { current } = await twoAccounts()
    const sent = sentCards()
    const fetchSpy = created()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWriteDetailed('outlook.draft.create', draftInput, { ownerWebContentsId: OWNER })
    expect(r).toMatchObject({
      ok: true,
      id: 'AAMk-chosen',
      result: { provenance: { accountRef: current, accountRule: 'only_executable_account' } }
    })
    expect(sent).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('refuses a source-bound or chosen account that is not the signed-in identity, sending nothing', async () => {
    const { other } = await twoAccounts()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runConnectorWriteDetailed('outlook.draft.create', draftInput, {
      ownerWebContentsId: OWNER,
      sourceAccountRef: other
    })
    expect(r.result).toMatchObject({
      ok: false,
      reason: 'account_unavailable',
      provenance: { accountRule: 'source_item_account' }
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getGraphTokenOutcome).not.toHaveBeenCalled()
    expect(appendTimeSavedEvent).not.toHaveBeenCalled()
  })

  it('a card choice of an account the handler would not act as is refused at resume, nothing is sent', async () => {
    const { other } = await twoAccounts()
    const sent = sentCards()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const argsHash = 'a'.repeat(64)
    accountChoiceBroker().issue({
      ownerWebContentsId: OWNER,
      opId: 'outlook.draft.create',
      revision: connectorCatalog.current().revision,
      argsHash,
      input: { subject: 'x', body: '' },
      options: [
        { accountRef: other, label: 'Second', health: 'healthy', selectable: true },
        { accountRef: `acct_${'Z'.repeat(43)}` as never, label: 'Other', health: 'healthy', selectable: true }
      ]
    })
    const card = sent[0].state
    if (card.choiceId === null) throw new Error('expected card')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 500)
    const r = await accountChoiceBroker().decide({
      webContentsId: OWNER,
      choiceId: card.choiceId,
      nonce: card.nonce,
      argsHash,
      accountRef: other
    })
    expect(r).toEqual({
      ok: true,
      result: { ok: false, error: 'No connected account is available for this operation.' }
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(appendTimeSavedEvent).not.toHaveBeenCalled()
  })

  it('a write resumed from the card runs the same success side effect as the direct path', async () => {
    const { current } = await twoAccounts()
    const sent = sentCards()
    vi.stubGlobal('fetch', created())
    const input = { subject: 'x', body: '' }
    const argsHash = writeArgsHash('outlook.draft.create', connectorCatalog.current().revision, input)
    accountChoiceBroker().issue({
      ownerWebContentsId: OWNER,
      opId: 'outlook.draft.create',
      revision: connectorCatalog.current().revision,
      argsHash,
      input,
      options: [
        { accountRef: current, label: 'Synthetic Outlook', health: 'healthy', selectable: true },
        { accountRef: `acct_${'Z'.repeat(43)}` as never, label: 'Other', health: 'healthy', selectable: true }
      ]
    })
    const card = sent[0].state
    if (card.choiceId === null) throw new Error('expected card')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 500)
    const r = await accountChoiceBroker().decide({
      webContentsId: OWNER,
      choiceId: card.choiceId,
      nonce: card.nonce,
      argsHash,
      accountRef: current
    })
    expect(r).toEqual({ ok: true, result: { ok: true, id: 'AAMk-chosen' } })
    expect(appendTimeSavedEvent).toHaveBeenCalledOnce()
    expect(appendTimeSavedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mcp-push', connector: 'outlook', ids: { draft: 'AAMk-chosen' } })
    )
    appendTimeSavedEvent.mockClear()
    vi.useRealTimers()
    await runConnectorWriteDetailed('outlook.draft.create', input, ASKED)
    expect(appendTimeSavedEvent).toHaveBeenCalledOnce()
  })
})

describe('Apple Calendar create waits for the confirm card (G65c)', () => {
  const EVENT = { subject: 'Follow-up', body: '', startIso: '2026-10-25T10:00:00Z', endIso: '2026-10-25T10:30:00Z' }
  const readback = {
    kind: 'found',
    subject: 'Follow-up',
    startIso: EVENT.startIso,
    endIso: EVENT.endIso,
    cancelled: false
  }

  beforeEach(() => {
    for (const fn of Object.values(eventKit)) fn.mockReset()
    eventKit.status.mockResolvedValue('fullAccess')
    eventKit.create.mockResolvedValue({ kind: 'created', id: 'ek-1' })
    eventKit.read.mockResolvedValue(readback)
  })

  it("creates only after confirm, with the card's proposal id as the approval", async () => {
    vi.useRealTimers()
    const seen = answerCards(true)
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT, ASKED)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      effectClass: 'reversible_write',
      connectorLabel: 'Apple Calendar',
      subjectPreview: 'Follow-up'
    })
    expect(r.result).toMatchObject({ ok: true, output: { id: 'ek-1', verified: true } })
    const receipt = (r.result as { receipt: { argsHash: string; idempotencyKey: string } }).receipt
    expect(receipt.idempotencyKey).toBe(actionIdempotencyKey(seen[0].proposalId, seen[0].argsHash))
    expect(appendTimeSavedEvent).not.toHaveBeenCalled()
  })

  it('a declined card never reaches EventKit', async () => {
    vi.useRealTimers()
    answerCards(false)
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT, ASKED)
    expect(r.result).toMatchObject({ ok: false, reason: 'confirm_declined' })
    expect(eventKit.status).not.toHaveBeenCalled()
    expect(eventKit.create).not.toHaveBeenCalled()
  })

  it('without a window to show the card in, nothing runs', async () => {
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT)
    expect(r.result).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(eventKit.create).not.toHaveBeenCalled()
  })

  it('a denied permission is the typed refusal and nothing is created or asked', async () => {
    vi.useRealTimers()
    answerCards(true)
    eventKit.status.mockResolvedValue('denied')
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT, ASKED)
    expect(r.result).toMatchObject({ ok: false, reason: 'os_permission_missing', permission: 'denied' })
    expect(eventKit.ask).not.toHaveBeenCalled()
    expect(eventKit.create).not.toHaveBeenCalled()
  })

  it('refuses account_unavailable when signed out', async () => {
    configureConnectorAccountRuntime({ registry: runtimeRegistry, ensureCurrentAccount: async () => null })
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT, ASKED)
    expect(r.result).toMatchObject({ ok: false, reason: 'account_unavailable' })
    expect(eventKit.create).not.toHaveBeenCalled()
  })

  it('a readback that does not match is effect_uncertain', async () => {
    vi.useRealTimers()
    answerCards(true)
    eventKit.read.mockResolvedValue({ ...readback, subject: 'Other' })
    const r = await runConnectorWriteDetailed('apple.calendar.event.create', EVENT, ASKED)
    expect(r.result).toMatchObject({ ok: false, reason: 'effect_uncertain' })
    expect(r).toMatchObject({ ok: false, uncertain: true })
  })
})
