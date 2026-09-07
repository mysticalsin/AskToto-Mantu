import { describe, expect, it } from 'vitest'
import { mintOperatorLicense } from './generate'
import { memoryStore } from '../store'
import { verifyOperatorLicense } from '../../../src/shared/operator-license'
import { TEST_INGEST_SECRET } from '../test-fixtures'
import type { AdminCtx, Env } from '../routes/admin-ctx'

const NOW = 1_725_000_000_000

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: 'unused',
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    ...overrides
  }
}

function ctx(overrides: Partial<AdminCtx> = {}): AdminCtx {
  return {
    request: new Request('https://operator.test/v1/admin/licenses/generate', { method: 'POST' }),
    url: new URL('https://operator.test/v1/admin/licenses/generate'),
    env: env(),
    store: memoryStore(),
    email: 'tony.walteur@gmail.com',
    now: NOW,
    opts: {},
    ...overrides
  }
}

describe('mintOperatorLicense', () => {
  it('mints a valid, verifiable token and stores last4/hash only, never the token', async () => {
    const c = ctx()
    const result = await mintOperatorLicense(c, { days: 30, actor: c.email })
    if (!result.ok) throw new Error('expected ok')
    expect(result.token.startsWith('METIS-OP-1.')).toBe(true)
    expect(result.days).toBe(30)

    const stored = await c.store.getIssuedLicense(result.jti)
    expect(stored?.last4).toBe(result.last4)
    expect(JSON.stringify(stored)).not.toContain(result.token)

    const verified = await verifyOperatorLicense(TEST_INGEST_SECRET, result.token, NOW)
    expect(verified.ok).toBe(true)
  })

  it('writes one audit row with the default action generate-license', async () => {
    const c = ctx()
    await mintOperatorLicense(c, { days: 7, actor: c.email })
    const audit = await c.store.listAudit(10)
    expect(audit).toHaveLength(1)
    expect(audit[0].action).toBe('generate-license')
    expect(audit[0].actor).toBe(c.email)
    expect(audit[0].detail).toContain('7d')
  })

  it('carries group, tier and member through to the issued license row and a custom audit action', async () => {
    const c = ctx()
    const result = await mintOperatorLicense(c, {
      days: 90,
      groupId: 'amaris-ab12',
      tier: 'metis-light',
      member: 'a@amaris.com',
      actor: c.email,
      action: 'group-license-generate'
    })
    if (!result.ok) throw new Error('expected ok')
    expect(result.groupId).toBe('amaris-ab12')
    expect(result.tier).toBe('metis-light')
    expect(result.member).toBe('a@amaris.com')

    const stored = await c.store.getIssuedLicense(result.jti)
    expect(stored?.group_id).toBe('amaris-ab12')
    expect(stored?.tier).toBe('metis-light')
    expect(stored?.member).toBe('a@amaris.com')

    const audit = await c.store.listAudit(10)
    expect(audit[0].action).toBe('group-license-generate')
    expect(audit[0].detail).toContain('amaris-ab12')
    expect(audit[0].detail).toContain('metis-light')
  })

  it('rejects an out-of-range days value without touching the store', async () => {
    const c = ctx()
    const result = await mintOperatorLicense(c, { days: 999, actor: c.email })
    expect(result).toEqual({ ok: false, error: 'days must be 1-365', status: 400 })
    expect(await c.store.listIssuedLicenses()).toHaveLength(0)
    expect(await c.store.listAudit(10)).toHaveLength(0)
  })

  it('rejects when the Operator ingest secret is missing', async () => {
    const c = ctx({ env: env({ OPERATOR_INGEST_SECRET: '' }) })
    const result = await mintOperatorLicense(c, { days: 30, actor: c.email })
    expect(result).toEqual({ ok: false, error: 'Operator ingest secret missing', status: 503 })
  })
})
