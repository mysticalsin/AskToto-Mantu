import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { actionDigest } from '../../action-guard'
import type { ConnectorOperation } from '@shared/connector-catalog'
import { createCatalogPublisher } from './catalog-publisher'
import {
  createConnectorExecutor,
  createActionGuardWriteGate,
  writeArgsHash,
  type ConnectorHandler
} from './connector-executor'
import type { AccountRef, ConnectorEffect } from '@shared/connector-catalog'
import type { AccountResolverCandidate } from './account-ref'

const READ: ConnectorOperation = {
  opId: 'outlook.calendar.today',
  kind: 'outlook',
  effect: 'read',
  effectClass: 'read',
  summary: 'read',
  scopes: ['Calendars.Read'],
  input: z.object({ tz: z.string().default('UTC') }),
  output: z.object({ events: z.array(z.unknown()) })
}
const WRITE: ConnectorOperation = {
  opId: 'outlook.draft.create',
  kind: 'outlook',
  effect: 'create',
  effectClass: 'reversible_write',
  summary: 'draft',
  scopes: ['Mail.ReadWrite'],
  input: z.object({ subject: z.string().default(''), to: z.array(z.string()).optional() }),
  output: z.object({ id: z.string().min(1) })
}
const SEND: ConnectorOperation = {
  opId: 'outlook.mail.send',
  kind: 'outlook',
  effect: 'send',
  effectClass: 'send',
  summary: 'send',
  scopes: ['Mail.Send'],
  input: z.object({ subject: z.string().default(''), to: z.array(z.string()).optional() }),
  output: z.object({ id: z.string().min(1) })
}

const ACCOUNT_REF = `acct_${'A'.repeat(43)}` as AccountRef
const OTHER_REF = `acct_${'B'.repeat(43)}` as AccountRef
const CANDIDATE: AccountResolverCandidate = { accountRef: ACCOUNT_REF, label: 'Work', health: 'healthy' }
const OTHER: AccountResolverCandidate = {
  accountRef: OTHER_REF,
  label: 'Personal',
  maskedHint: 'p***@example.test',
  health: 'healthy'
}

function setup(
  over: {
    grant?: 'granted' | 'stale' | 'transient'
    handler?: ConnectorHandler
    revision?: number
    ready?: boolean | ((effect: ConnectorEffect) => boolean)
    candidates?: AccountResolverCandidate[]
    executable?: AccountRef[]
  } = {}
) {
  const publisher = createCatalogPublisher({ revision: over.revision ?? 3, operations: [READ, WRITE] })
  const write = vi.fn<ConnectorHandler>(over.handler ?? (async () => ({ ok: true, output: { id: 'draft-1' } })))
  const read = vi.fn<ConnectorHandler>(async () => ({ ok: true, output: { events: [] } }))
  const grants = { check: vi.fn(async () => over.grant ?? 'granted') }
  const accounts = {
    candidates: vi.fn((_kind: 'outlook') => over.candidates ?? [CANDIDATE]),
    isReady: vi.fn((_kind: 'outlook', _ref: AccountRef, effect: ConnectorEffect) =>
      typeof over.ready === 'function' ? over.ready(effect) : (over.ready ?? over.grant !== 'stale')
    ),
    observe: vi.fn(async (_kind: 'outlook', _ref: AccountRef, _signal: string) => true)
  }
  const audit = vi.fn()
  const executor = createConnectorExecutor({
    catalog: publisher,
    handlers: { 'outlook.calendar.today': read, 'outlook.draft.create': write },
    grants,
    accounts,
    ...(over.executable ? { executableAccounts: async () => over.executable ?? [] } : {}),
    writeGate: createActionGuardWriteGate(),
    audit
  })
  return { publisher, executor, write, read, grants, accounts, audit }
}

const approval = (opId: string, revision: number, input: unknown) => ({
  proposalId: 'a'.repeat(32),
  argsHash: writeArgsHash(opId, revision, input)
})

describe('connector executor', () => {
  it('refuses an unknown op before touching a handler', async () => {
    const { executor, read, write } = setup()
    const r = await executor.execute({ opId: 'outlook.mail.send', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'op_unknown' })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses a call planned against another revision as catalog_changed', async () => {
    const { executor, read } = setup()
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 2, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'catalog_changed' })
    expect(read).not.toHaveBeenCalled()
  })

  it('revalidates against a newly published revision', async () => {
    const { executor, publisher, read } = setup()
    const planned = executor.plan('outlook.calendar.today', {})
    expect(planned.ok && planned.revision).toBe(3)
    publisher.publish({ revision: 4, operations: [READ, WRITE] })
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'catalog_changed' })
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a removed op as op_unknown after republication', async () => {
    const { executor, publisher } = setup()
    publisher.publish({ revision: 4, operations: [READ] })
    const r = await executor.execute({ opId: 'outlook.draft.create', revision: 4, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'op_unknown' })
  })

  it('refuses input that does not match the schema', async () => {
    const { executor, read } = setup()
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: { tz: 7 } })
    expect(r).toMatchObject({ ok: false, reason: 'input_invalid' })
    expect(read).not.toHaveBeenCalled()
  })

  it('marks a stale grant as not ready, with the required scopes checked', async () => {
    const { executor, grants, read } = setup({ grant: 'stale' })
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'account_not_ready', needsConsent: true })
    expect(grants.check).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKind: 'outlook', opId: 'outlook.calendar.today', scopes: ['Calendars.Read'] })
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('records a transient grant as degraded without asking for consent on a blocked write', async () => {
    const { executor, accounts, write } = setup({ grant: 'transient', ready: false })
    const input = { subject: 'x' }

    const result = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })

    expect(accounts.observe).toHaveBeenCalledWith('outlook', ACCOUNT_REF, 'token_refresh_transient')
    expect(result).toMatchObject({ ok: false, reason: 'account_not_ready' })
    expect(result).not.toHaveProperty('needsConsent')
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses operations with account_not_ready after a real grant result if health is not ready', async () => {
    const { executor, read } = setup({ ready: false })
    const result = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(result).toMatchObject({ ok: false, reason: 'account_not_ready' })
    expect(read).not.toHaveBeenCalled()
  })

  it('allows reads but refuses writes while the resolved account is degraded', async () => {
    const { executor, read, write, accounts } = setup({ ready: (effect) => effect === 'read' })
    const readResult = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    const writeResult = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: { subject: 'x' },
      approval: approval('outlook.draft.create', 3, { subject: 'x' })
    })
    expect(readResult.ok).toBe(true)
    expect(writeResult).toMatchObject({ ok: false, reason: 'account_not_ready' })
    expect(read).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(accounts.isReady).toHaveBeenCalledWith('outlook', ACCOUNT_REF, 'create')
  })

  it('an explicit owner choice names the account; no other account stands in for it', async () => {
    const { executor, accounts, read } = setup({ candidates: [CANDIDATE, OTHER] })
    const ok = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {}, accountRef: OTHER_REF })
    expect(ok).toMatchObject({ ok: true, provenance: { accountRef: OTHER_REF, accountRule: 'explicit_owner_choice' } })
    expect(accounts.isReady).toHaveBeenCalledWith('outlook', OTHER_REF, 'read')
    read.mockClear()
    const missing = `acct_${'Z'.repeat(43)}` as AccountRef
    const refused = await executor.execute({
      opId: 'outlook.calendar.today',
      revision: 3,
      input: {},
      accountRef: missing
    })
    expect(refused).toMatchObject({ ok: false, reason: 'account_unavailable' })
    expect(read).not.toHaveBeenCalled()
  })

  it('uses the account bound to the source item and records that rule', async () => {
    const { executor, audit } = setup({ candidates: [CANDIDATE, OTHER] })
    const r = await executor.execute({
      opId: 'outlook.calendar.today',
      revision: 3,
      input: {},
      sourceAccountRef: OTHER_REF
    })
    expect(r).toMatchObject({ ok: true, provenance: { accountRef: OTHER_REF, accountRule: 'source_item_account' } })
    expect(audit).toHaveBeenCalledWith(
      'connector.executed',
      expect.objectContaining({ accountRule: 'source_item_account' })
    )
  })

  it('records which rule chose a lone account, in the result and in a closed audit record', async () => {
    const { executor, audit } = setup()
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: true, provenance: { accountRule: 'only_account' } })
    const [, metadata] = audit.mock.calls.find(([event]) => event === 'connector.executed') ?? []
    expect(metadata).toEqual({
      opId: 'outlook.calendar.today',
      revision: 3,
      effect: 'read',
      accountRule: 'only_account'
    })
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/acct_|example\.test|Work|Personal/)
  })

  it('does not run an ambiguous operation: it returns renderer-safe choices and touches nothing', async () => {
    const stale = {
      ...OTHER,
      accountRef: `acct_${'C'.repeat(43)}` as AccountRef,
      label: 'Old',
      health: 'needs_reauth' as const
    }
    const { executor, write, grants, accounts, audit } = setup({ candidates: [CANDIDATE, OTHER, stale] })
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: { subject: 'x' },
      approval: approval('outlook.draft.create', 3, { subject: 'x' })
    })
    expect(r).toMatchObject({ ok: false, reason: 'account_ambiguous' })
    expect(!r.ok && r.choices).toEqual([
      { accountRef: ACCOUNT_REF, label: 'Work', health: 'healthy', selectable: true },
      {
        accountRef: OTHER_REF,
        label: 'Personal',
        maskedHint: 'p***@example.test',
        health: 'healthy',
        selectable: true
      },
      {
        accountRef: stale.accountRef,
        label: 'Old',
        maskedHint: 'p***@example.test',
        health: 'needs_reauth',
        selectable: false
      }
    ])
    expect(write).not.toHaveBeenCalled()
    expect(grants.check).not.toHaveBeenCalled()
    expect(accounts.observe).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(
      'connector.refused',
      expect.objectContaining({ reason: 'account_ambiguous', candidateCount: 3 })
    )
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/acct_|example\.test/)
  })

  it('refuses a resolved account that is not the identity the handler acts as; nothing runs', async () => {
    const { executor, write, grants, audit } = setup({ candidates: [CANDIDATE, OTHER], executable: [ACCOUNT_REF] })
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: { subject: 'x' },
      accountRef: OTHER_REF,
      approval: approval('outlook.draft.create', 3, { subject: 'x' })
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'account_unavailable',
      provenance: { accountRule: 'explicit_owner_choice' }
    })
    expect(write).not.toHaveBeenCalled()
    expect(grants.check).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(
      'connector.refused',
      expect.objectContaining({ reason: 'account_unavailable', accountRule: 'explicit_owner_choice' })
    )
  })

  it('resolves to the one executable account instead of asking, and refuses when nobody is signed in', async () => {
    const both = setup({ candidates: [CANDIDATE, OTHER], executable: [OTHER_REF] })
    const r = await both.executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: true, provenance: { accountRef: OTHER_REF, accountRule: 'only_executable_account' } })
    const signedOut = setup({ candidates: [CANDIDATE, OTHER], executable: [] })
    expect(await signedOut.executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })).toMatchObject({
      ok: false,
      reason: 'account_unavailable'
    })
    expect(signedOut.read).not.toHaveBeenCalled()
  })

  it('a card lists non-executable accounts as not selectable with a sign-in reason', async () => {
    const third = { ...OTHER, accountRef: `acct_${'D'.repeat(43)}` as AccountRef, label: 'Third' }
    const fourth = { ...OTHER, accountRef: `acct_${'E'.repeat(43)}` as AccountRef, label: 'Fourth' }
    const { executor, write } = setup({
      candidates: [CANDIDATE, OTHER, third, fourth],
      executable: [ACCOUNT_REF, OTHER_REF, third.accountRef]
    })
    const r = await executor.execute({ opId: 'outlook.draft.create', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'account_ambiguous' })
    const byLabel = Object.fromEntries((!r.ok && r.choices ? r.choices : []).map((c) => [c.label, c]))
    expect(byLabel.Work).toMatchObject({ selectable: true })
    expect(byLabel.Work).not.toHaveProperty('reason')
    expect(byLabel.Fourth).toMatchObject({ selectable: false, reason: 'sign_in' })
    expect(write).not.toHaveBeenCalled()
  })

  it('excludes an unhealthy account from the automatic pick when exactly one healthy account remains', async () => {
    const sick = { ...OTHER, health: 'needs_reauth' as const }
    const { executor } = setup({ candidates: [sick, CANDIDATE] })
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({
      ok: true,
      provenance: { accountRef: ACCOUNT_REF, accountRule: 'single_healthy_account' }
    })
  })

  it('returns provenance with every result, including refusals after resolution', async () => {
    const { executor } = setup()
    const ok = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(ok).toMatchObject({
      ok: true,
      provenance: { connectorKind: 'outlook', opId: 'outlook.calendar.today', revision: 3 }
    })
    if (ok.ok) expect(ok.provenance.accountRef).toMatch(/^acct_[A-Za-z0-9_-]{43}$/)
    const stale = setup({ grant: 'stale' })
    const refused = await stale.executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(!refused.ok && refused.provenance?.opId).toBe('outlook.calendar.today')
  })

  it('never lets a write run without a bound ActionGuard approval', async () => {
    const { executor, write } = setup()
    const none = await executor.execute({ opId: 'outlook.draft.create', revision: 3, input: { subject: 'x' } })
    expect(none).toMatchObject({ ok: false, reason: 'not_approved' })
    const wrong = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: { subject: 'x' },
      approval: approval('outlook.draft.create', 3, { subject: 'different' })
    })
    expect(wrong).toMatchObject({ ok: false, reason: 'not_approved' })
    const malformed = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: { subject: 'x' },
      approval: { proposalId: 'nope', argsHash: 'zz' }
    })
    expect(malformed).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(write).not.toHaveBeenCalled()
  })

  it('runs an approved write, passes the idempotency key and returns an observed receipt', async () => {
    const { executor, write } = setup()
    const input = { subject: 'x' }
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })
    expect(r).toMatchObject({ ok: true, output: { id: 'draft-1' } })
    const argsHash = writeArgsHash('outlook.draft.create', 3, input)
    if (r.ok) {
      expect(r.receipt?.argsHash).toBe(argsHash)
      expect(r.receipt?.observation).toContain('draft-1')
      expect(r.receipt?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(write.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[a-f0-9]{64}$/)
    expect(actionDigest(['x'])).toMatch(/^[a-f0-9]{64}$/)
  })

  it('binds the approval to the schema-parsed input, so defaults cannot be swapped in', async () => {
    const { executor, write } = setup()
    // approval minted for the parsed input {subject: ''}; the call sends {} which parses to the same thing
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input: {},
      approval: approval('outlook.draft.create', 3, { subject: '' })
    })
    expect(r.ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('os_permission_missing is typed and does not degrade health', async () => {
    const { executor, accounts } = setup({
      handler: async () => ({ ok: false, refusal: 'os_permission_missing', permission: 'denied' })
    })
    const input = { subject: 'x' }
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })
    expect(r).toMatchObject({ ok: false, reason: 'os_permission_missing', permission: 'denied' })
    if (!r.ok) expect(r.provenance?.accountRef).toBe(ACCOUNT_REF)
    expect(accounts.observe.mock.calls.map((c) => c[2])).not.toContain('transient_failure')
    expect(accounts.observe.mock.calls.map((c) => c[2])).not.toContain('operation_succeeded')
  })

  it('effect_uncertain carries provenance, no receipt', async () => {
    const { executor, audit } = setup({
      handler: async () => ({ ok: false, refusal: 'effect_uncertain', error: 'Could not confirm.' })
    })
    const input = { subject: 'x' }
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })
    expect(r).toMatchObject({ ok: false, reason: 'effect_uncertain', error: 'Could not confirm.' })
    expect(r).not.toHaveProperty('receipt')
    if (!r.ok) expect(r.provenance).toMatchObject({ opId: 'outlook.draft.create', accountRef: ACCOUNT_REF })
    expect(audit).not.toHaveBeenCalledWith('connector.executed', expect.anything())
  })

  it('reports a handler failure and a handler output that breaks the contract', async () => {
    const failing = setup({ handler: async () => ({ ok: false, error: 'boom', needsConsent: true }) })
    const input = { subject: 'x' }
    const call = {
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    }
    expect(await failing.executor.execute(call)).toMatchObject({
      ok: false,
      reason: 'handler_failed',
      needsConsent: true,
      error: 'boom'
    })
    const bad = setup({ handler: async () => ({ ok: true, output: { id: '' } }) })
    expect(await bad.executor.execute(call)).toMatchObject({ ok: false, reason: 'output_invalid' })
    const thrown = setup({
      handler: async () => {
        throw new Error('secret detail')
      }
    })
    const t = await thrown.executor.execute(call)
    expect(t).toMatchObject({ ok: false, reason: 'handler_failed' })
    expect(JSON.stringify(t)).not.toContain('secret detail')
  })

  it('audits metadata only (no input content)', async () => {
    const { executor, audit } = setup()
    await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: { tz: 'Europe/Paris' } })
    expect(audit).toHaveBeenCalled()
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Europe/Paris')
  })
})

describe('connector executor: prepare and recipient gate (G64)', () => {
  function withRecipients(trusted: string[], operations: ConnectorOperation[] = [READ, WRITE]) {
    const handler = vi.fn<ConnectorHandler>(async () => ({ ok: true, output: { id: 'draft-1' } }))
    const executor = createConnectorExecutor({
      catalog: createCatalogPublisher({ revision: 3, operations }),
      handlers: { 'outlook.draft.create': handler, 'outlook.mail.send': handler },
      grants: { check: async () => 'granted' as const },
      accounts: {
        candidates: () => [CANDIDATE],
        isReady: () => true,
        observe: async () => true
      },
      writeGate: createActionGuardWriteGate(),
      recipients: { addressesFor: async () => trusted.map((address) => ({ address, source: 'calendar-attendee' })) }
    })
    return { executor, handler }
  }

  it('prepare returns the same account the execute path uses, with the schema-parsed args hash', async () => {
    const { executor } = withRecipients([])
    const prepared = await executor.prepare({ opId: 'outlook.draft.create', revision: 3, input: { subject: 's' } })
    if (!('prepared' in prepared)) throw new Error('expected a prepared call')
    expect(prepared.accountRef).toBe(ACCOUNT_REF)
    expect(prepared.accountLabel).toBe('Work')
    expect(prepared.argsHash).toBe(writeArgsHash('outlook.draft.create', 3, prepared.parsed))
  })

  it('a write with recipient fields and an empty trusted set refuses recipient_unverified before the handler', async () => {
    const { executor, handler } = withRecipients([])
    const input = { subject: 's', to: ['eve@example.test'] }
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })
    expect(r).toMatchObject({ ok: false, reason: 'recipient_unverified' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('a write whose recipients are all trusted runs', async () => {
    const { executor, handler } = withRecipients(['ana@example.test'])
    const input = { subject: 's', to: ['ANA@example.test'] }
    const r = await executor.execute({
      opId: 'outlook.draft.create',
      revision: 3,
      input,
      approval: approval('outlook.draft.create', 3, input)
    })
    expect(r).toMatchObject({ ok: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a send op without verified recipients never calls the handler, even with no recipient fields', async () => {
    const { executor, handler } = withRecipients(['ana@example.test'], [SEND])
    const input = { subject: 's' }
    const r = await executor.execute({
      opId: 'outlook.mail.send',
      revision: 3,
      input,
      approval: approval('outlook.mail.send', 3, input)
    })
    expect(r).toMatchObject({ ok: false, reason: 'recipient_unverified' })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('catalog publisher', () => {
  it('publishes only increasing revisions and notifies subscribers', () => {
    const p = createCatalogPublisher({ revision: 2, operations: [READ] })
    const seen: number[] = []
    const off = p.subscribe((s) => seen.push(s.revision))
    expect(p.publish({ revision: 2, operations: [READ] })).toBe(false)
    expect(p.publish({ revision: 1, operations: [READ] })).toBe(false)
    expect(p.publish({ revision: 3, operations: [READ, WRITE] })).toBe(true)
    expect(p.current().revision).toBe(3)
    off()
    p.publish({ revision: 4, operations: [READ] })
    expect(seen).toEqual([3])
  })
})
