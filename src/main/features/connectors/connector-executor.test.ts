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
import { singleAccountResolver } from './account-ref'

const READ: ConnectorOperation = {
  opId: 'outlook.calendar.today',
  kind: 'outlook',
  effect: 'read',
  summary: 'read',
  scopes: ['Calendars.Read'],
  input: z.object({ tz: z.string().default('UTC') }),
  output: z.object({ events: z.array(z.unknown()) })
}
const WRITE: ConnectorOperation = {
  opId: 'outlook.draft.create',
  kind: 'outlook',
  effect: 'create',
  summary: 'draft',
  scopes: ['Mail.ReadWrite'],
  input: z.object({ subject: z.string().default('') }),
  output: z.object({ id: z.string().min(1) })
}

function setup(over: { grant?: 'granted' | 'stale'; handler?: ConnectorHandler; revision?: number } = {}) {
  const publisher = createCatalogPublisher({ revision: over.revision ?? 3, operations: [READ, WRITE] })
  const write = vi.fn<ConnectorHandler>(over.handler ?? (async () => ({ ok: true, output: { id: 'draft-1' } })))
  const read = vi.fn<ConnectorHandler>(async () => ({ ok: true, output: { events: [] } }))
  const grants = { check: vi.fn(async () => over.grant ?? 'granted') }
  const audit = vi.fn()
  const executor = createConnectorExecutor({
    catalog: publisher,
    handlers: { 'outlook.calendar.today': read, 'outlook.draft.create': write },
    grants,
    accounts: singleAccountResolver,
    writeGate: createActionGuardWriteGate(),
    audit
  })
  return { publisher, executor, write, read, grants, audit }
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

  it('refuses a stale grant, honestly, with the required scopes checked', async () => {
    const { executor, grants, read } = setup({ grant: 'stale' })
    const r = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(r).toMatchObject({ ok: false, reason: 'grant_stale', needsConsent: true })
    expect(grants.check).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKind: 'outlook', opId: 'outlook.calendar.today', scopes: ['Calendars.Read'] })
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('returns provenance with every result, including refusals after resolution', async () => {
    const { executor } = setup()
    const ok = await executor.execute({ opId: 'outlook.calendar.today', revision: 3, input: {} })
    expect(ok).toMatchObject({
      ok: true,
      provenance: { connectorKind: 'outlook', opId: 'outlook.calendar.today', revision: 3 }
    })
    if (ok.ok) expect(ok.provenance.accountRef).toMatch(/^acct_[a-f0-9]{16}$/)
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
