import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { utcMidnight } from '../meters'
import { memoryStore } from '../store'
import { looksLikeSecret } from '../redact'
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_EMAILS,
  TEST_INGEST_SECRET,
  TEST_OWNER_EMAIL,
  TEST_PROMPT_KEY
} from '../test-fixtures'
import { putAsk, sqliteD1, usageDb } from '../usage-test-kit'

const NOW = 1_800_000_000_000
const DAY = utcMidnight(NOW)
const DEVICE = 'meters-route-device-0001'

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OWNER_EMAILS: TEST_OWNER_EMAIL,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    ...overrides
  }
}
const adminAccess = { getIdentity: async () => ({ email: TEST_ADMIN_EMAIL }) }
const post = (path: string, body: unknown) =>
  new Request(`https://operator.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('admin meters routes (G81)', () => {
  it('GET meters.json lists reconciled rows with limit', async () => {
    const raw = usageDb()
    putAsk(raw, {
      id: 'm1',
      device_id: DEVICE,
      ts: DAY + 5,
      input_tokens: 30,
      output_tokens: 12,
      path_tag: 'portal-cf'
    })
    const db = sqliteD1(raw)
    const store = memoryStore()
    await store.putSetting('dailyTokenBudgetPerSeat', '1000', 'owner', NOW)
    const rec = await handleRequest(
      post('/v1/admin/meters/reconcile', { day: DAY }),
      { ...env(), DB: db },
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(rec.status).toBe(200)
    const res = await handleRequest(
      new Request(`https://operator.test/v1/admin/meters.json?day=${DAY}`),
      { ...env(), DB: db },
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      day: number
      limit: number | null
      rows: Array<Record<string, unknown>>
    }
    expect(body).toMatchObject({ ok: true, day: DAY, limit: 1000 })
    expect(body.rows).toEqual([
      {
        device_id: DEVICE,
        day: DAY,
        meter_id: 'managed_tokens',
        used: 42,
        asks: 1,
        unknown_asks: 0,
        reconciled_at: NOW
      }
    ])
  })

  it('GET defaults to today and rejects an invalid day with 400', async () => {
    const db = sqliteD1(usageDb())
    const call = (q: string) =>
      handleRequest(
        new Request(`https://operator.test/v1/admin/meters.json${q}`),
        { ...env(), DB: db },
        { access: adminAccess },
        { store: memoryStore(), now: NOW }
      )
    expect(((await (await call('')).json()) as { day: number }).day).toBe(DAY)
    expect((await call('?day=abc')).status).toBe(400)
    expect((await call(`?day=${DAY + 1}`)).status).toBe(400)
  })

  it('POST reconcile writes an audit row with drift and no content', async () => {
    const raw = usageDb()
    putAsk(raw, {
      id: 'm1',
      device_id: DEVICE,
      ts: DAY + 5,
      input_tokens: 30,
      output_tokens: 12,
      path_tag: 'portal-cf',
      preview: 'SECRET MEETING CONTENT about the merger'
    })
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/meters/reconcile', { day: DAY }),
      { ...env(), DB: sqliteD1(raw) },
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(await res.json()).toMatchObject({ ok: true, day: DAY, seats: 1, drift: 42 })
    const audits = await store.listAudit(20, { action: 'meters.reconcile' })
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe(TEST_ADMIN_EMAIL)
    expect(audits[0].detail).toContain('drift 42')
    expect(audits[0].detail).not.toContain('MERGER'.toLowerCase())
    expect(audits[0].detail).not.toContain('SECRET MEETING')
    expect(looksLikeSecret(audits[0].detail ?? '')).toBe(false)
  })

  it('POST reconcile rejects an invalid day with 400 and audits nothing', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/meters/reconcile', { day: DAY + 7 }),
      { ...env(), DB: sqliteD1(usageDb()) },
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
    expect(await store.listAudit(20, { action: 'meters.reconcile' })).toHaveLength(0)
  })

  it('503 when DB unbound, and 503 not migrated before the migration is applied', async () => {
    const store = memoryStore()
    const unbound = await handleRequest(
      post('/v1/admin/meters/reconcile', { day: DAY }),
      env(),
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(unbound.status).toBe(503)
    const unmigrated = await handleRequest(
      post('/v1/admin/meters/reconcile', { day: DAY }),
      { ...env(), DB: sqliteD1(usageDb({ withUsage: false })) },
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(unmigrated.status).toBe(503)
    expect(await unmigrated.json()).toMatchObject({ ok: false, error: 'not migrated' })
    const read = await handleRequest(
      new Request('https://operator.test/v1/admin/meters.json'),
      env(),
      { access: adminAccess },
      { store, now: NOW }
    )
    expect(read.status).toBe(503)
  })
})
