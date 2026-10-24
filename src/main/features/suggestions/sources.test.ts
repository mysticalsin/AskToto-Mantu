import { describe, expect, it, vi } from 'vitest'
import type { AccountRef, ConnectorResult } from '@shared/connector-catalog'
import type { UserMemoryList } from '@shared/user-memory'
import type { Evidence } from './model'
import { calendarSource, memorySource } from './sources'
import { HOUR, NOW } from './__fixtures__/suggestions-harness'

const ACCOUNT = 'acct_one' as AccountRef
const provenance = {
  connectorKind: 'outlook',
  accountRef: ACCOUNT,
  opId: 'outlook.calendar.today',
  revision: 1
} as const
const ctx = { signal: new AbortController().signal, now: NOW }

function calendar(result: ConnectorResult, account: AccountRef | null = ACCOUNT) {
  const read = vi.fn(async () => result)
  const ready = vi.fn(() => true)
  const source = calendarSource({ port: { read }, accounts: { current: async () => account, ready }, tz: 'UTC' })
  return { read, ready, source }
}

describe('calendar source (G67)', () => {
  it("turns today's events into anchors with eventAt apart from retrievedAt", async () => {
    const start = new Date(NOW + 2 * HOUR).toISOString()
    const { read, source } = calendar({
      ok: true,
      provenance,
      output: {
        events: [
          { subject: 'Budget review with finance', start },
          { subject: 'x', start: 'not a date' }
        ]
      }
    })
    const out = await source.gather(ctx)
    expect(read).toHaveBeenCalledWith('outlook.calendar.today', { tz: 'UTC' }, ACCOUNT)
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({
      role: 'anchor',
      evidence: {
        sourceKind: 'calendar',
        label: 'Budget review with finance',
        terms: ['budget', 'review', 'with', 'finance'],
        eventAt: NOW + 2 * HOUR,
        retrievedAt: NOW,
        ref: { accountRef: ACCOUNT }
      }
    })
  })

  it('is skipped, not failed, when there is no account or the account is not ready', async () => {
    expect((await calendar({ ok: true, provenance, output: { events: [] } }, null).source.gather(ctx)).status).toBe(
      'skipped'
    )
    const refused = calendar({ ok: false, reason: 'account_not_ready', message: 'm' })
    expect((await refused.source.gather(ctx)).status).toBe('skipped')
  })

  it('fails on a handler error so the run can report a connector failure', async () => {
    const { source } = calendar({ ok: false, reason: 'handler_failed', message: 'm' })
    await expect(source.gather(ctx)).rejects.toThrow()
  })

  it('re-checks account readiness for read at accept time', async () => {
    const { ready, source } = calendar({ ok: true, provenance, output: { events: [] } })
    const evidence: Evidence = {
      sourceKind: 'calendar',
      ref: { accountRef: ACCOUNT, eventKey: 'abcdef01' },
      label: 'l',
      terms: [],
      eventAt: NOW,
      retrievedAt: NOW
    }
    expect(await source.stillValid(evidence)).toBe(true)
    expect(ready).toHaveBeenCalledWith('outlook', ACCOUNT)
    ready.mockReturnValue(false)
    expect(await source.stillValid(evidence)).toBe(false)
  })
})

const item = (id: string, text: string, at: number, expiresAt: number | null = null) => ({
  id,
  kind: 'preference' as const,
  text,
  source: 'owner-typed' as const,
  at,
  turnId: null,
  revision: 1,
  expiresAt,
  conversation: null
})
const ID1 = '1'.repeat(32)

function memory(list: UserMemoryList | null) {
  const current = { list }
  const source = memorySource({
    memory: () => (current.list ? { list: async () => current.list as UserMemoryList } : null),
    now: () => NOW
  })
  return { current, source }
}

describe('memory source (G67)', () => {
  it('turns remembered items into support evidence and stores terms, not the text', async () => {
    const { source } = memory({
      status: 'ok',
      tombstones: 0,
      items: [item(ID1, 'Prefers forecast numbers first', NOW - 5 * HOUR)]
    })
    const out = await source.gather(ctx)
    if (out.status !== 'ok') throw new Error('skipped')
    expect(out.items[0]).toMatchObject({
      role: 'support',
      evidence: {
        sourceKind: 'memory',
        ref: { memoryId: ID1, sourceId: 'preference' },
        eventAt: NOW - 5 * HOUR,
        retrievedAt: NOW
      }
    })
    expect(out.items[0]!.evidence.terms).toEqual(['prefers', 'forecast', 'numbers', 'first'])
  })

  it('is skipped when there is no memory or it is unavailable', async () => {
    expect((await memory(null).source.gather(ctx)).status).toBe('skipped')
    expect((await memory({ status: 'unavailable', tombstones: 0, items: [] }).source.gather(ctx)).status).toBe(
      'skipped'
    )
  })

  it('is no longer valid once the item is deleted or has lapsed', async () => {
    const m = memory({ status: 'ok', tombstones: 0, items: [item(ID1, 'Prefers forecast numbers first', NOW)] })
    const evidence: Evidence = {
      sourceKind: 'memory',
      ref: { memoryId: ID1, sourceId: 'preference' },
      label: 'l',
      terms: [],
      eventAt: NOW,
      retrievedAt: NOW
    }
    expect(await m.source.stillValid(evidence)).toBe(true)
    m.current.list = { status: 'ok', tombstones: 1, items: [] }
    expect(await m.source.stillValid(evidence)).toBe(false)
    m.current.list = { status: 'ok', tombstones: 0, items: [item(ID1, 'Prefers forecast numbers first', NOW, NOW - 1)] }
    expect(await m.source.stillValid(evidence)).toBe(false)
    m.current.list = { status: 'unavailable', tombstones: 0, items: [] }
    expect(await m.source.stillValid(evidence)).toBe(false)
  })
})
