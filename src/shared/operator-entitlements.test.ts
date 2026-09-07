import { describe, expect, it } from 'vitest'
import {
  OPERATOR_ENTITLEMENT_GRACE_MS,
  askOnlyOperatorEntitlements,
  effectiveOperatorEntitlements,
  emptyOperatorEntitlements,
  operatorGate,
  operatorGateReason,
  parseOperatorEntitlements,
  parseOperatorHeartbeatEntitlements,
  parseOperatorIntegrationsResponse,
  parseOperatorIntegrationsVersion,
  parseOperatorTier
} from './operator-entitlements'

describe('parseOperatorTier', () => {
  it('accepts exactly the two known tiers', () => {
    expect(parseOperatorTier('metis')).toBe('metis')
    expect(parseOperatorTier('metis-light')).toBe('metis-light')
  })
  it('fails closed on anything else', () => {
    expect(parseOperatorTier('pro')).toBeNull()
    expect(parseOperatorTier('')).toBeNull()
    expect(parseOperatorTier(null)).toBeNull()
    expect(parseOperatorTier(undefined)).toBeNull()
    expect(parseOperatorTier(1)).toBeNull()
  })
})

describe('parseOperatorEntitlements', () => {
  it('reads true booleans and defaults every other key to false', () => {
    const parsed = parseOperatorEntitlements({ ask: true, listen: true, crm_push: false })
    expect(parsed).toEqual({
      ask: true,
      listen: true,
      recap: false,
      crm_push: false,
      operator_keys: false,
      intelligence: false,
      integrations: false
    })
  })
  it('fails closed to all-false on malformed input', () => {
    expect(parseOperatorEntitlements(null)).toEqual(emptyOperatorEntitlements())
    expect(parseOperatorEntitlements('yes')).toEqual(emptyOperatorEntitlements())
    expect(parseOperatorEntitlements(42)).toEqual(emptyOperatorEntitlements())
  })
  it('never trusts a truthy non-boolean', () => {
    const parsed = parseOperatorEntitlements({ ask: 'true', listen: 1 })
    expect(parsed.ask).toBe(false)
    expect(parsed.listen).toBe(false)
  })
})

describe('parseOperatorIntegrationsVersion', () => {
  it('accepts non-negative finite numbers', () => {
    expect(parseOperatorIntegrationsVersion(0)).toBe(0)
    expect(parseOperatorIntegrationsVersion(7)).toBe(7)
    expect(parseOperatorIntegrationsVersion(3.9)).toBe(3)
  })
  it('fails closed to 0', () => {
    expect(parseOperatorIntegrationsVersion(-1)).toBe(0)
    expect(parseOperatorIntegrationsVersion(NaN)).toBe(0)
    expect(parseOperatorIntegrationsVersion('3')).toBe(0)
    expect(parseOperatorIntegrationsVersion(null)).toBe(0)
  })
})

describe('parseOperatorHeartbeatEntitlements', () => {
  it('parses a well-formed heartbeat body', () => {
    const parsed = parseOperatorHeartbeatEntitlements({
      tier: 'metis-light',
      entitlements: { ask: true, intelligence: true },
      integrationsVersion: 4
    })
    expect(parsed.tier).toBe('metis-light')
    expect(parsed.entitlements.ask).toBe(true)
    expect(parsed.entitlements.intelligence).toBe(true)
    expect(parsed.entitlements.listen).toBe(false)
    expect(parsed.integrationsVersion).toBe(4)
  })
  it('fails closed on a non-object body', () => {
    const parsed = parseOperatorHeartbeatEntitlements(null)
    expect(parsed.tier).toBeNull()
    expect(parsed.entitlements).toEqual(emptyOperatorEntitlements())
    expect(parsed.integrationsVersion).toBe(0)
  })
})

describe('effectiveOperatorEntitlements (grace window)', () => {
  const now = 1_700_000_000_000

  it('returns ask-only when there is no snapshot yet', () => {
    expect(effectiveOperatorEntitlements(null, now)).toEqual(askOnlyOperatorEntitlements())
  })
  it('returns ask-only when the snapshot has never had a successful heartbeat (at <= 0)', () => {
    expect(effectiveOperatorEntitlements({ tier: 'metis', entitlements: emptyOperatorEntitlements(), at: 0 }, now)).toEqual(
      askOnlyOperatorEntitlements()
    )
  })
  it('honours the last known entitlements inside the grace window', () => {
    const entitlements = { ...emptyOperatorEntitlements(), ask: true, listen: true }
    const snapshot = { tier: 'metis' as const, entitlements, at: now - OPERATOR_ENTITLEMENT_GRACE_MS + 1000 }
    expect(effectiveOperatorEntitlements(snapshot, now)).toEqual(entitlements)
  })
  it('fails closed to ask-only once the grace window has elapsed', () => {
    const entitlements = { ...emptyOperatorEntitlements(), ask: true, listen: true, crm_push: true }
    const snapshot = { tier: 'metis' as const, entitlements, at: now - OPERATOR_ENTITLEMENT_GRACE_MS - 1 }
    expect(effectiveOperatorEntitlements(snapshot, now)).toEqual(askOnlyOperatorEntitlements())
  })
  it('is exactly at the boundary: grace window elapsed to the millisecond still counts as expired', () => {
    const entitlements = { ...emptyOperatorEntitlements(), ask: true, listen: true }
    const snapshot = { tier: 'metis' as const, entitlements, at: now - OPERATOR_ENTITLEMENT_GRACE_MS }
    expect(effectiveOperatorEntitlements(snapshot, now)).toEqual(entitlements)
  })
})

describe('operatorGate', () => {
  const now = 1_700_000_000_000
  const snapshotMetisLight = {
    tier: 'metis-light' as const,
    entitlements: { ...emptyOperatorEntitlements(), ask: true, intelligence: true },
    at: now - 1000
  }

  it('allows everything when Operator is not configured, regardless of any stale snapshot', () => {
    expect(operatorGate('listen', false, null, now)).toEqual({ allowed: true })
    expect(operatorGate('crm_push', false, snapshotMetisLight, now)).toEqual({ allowed: true })
  })
  it('allows an entitled feature when configured', () => {
    expect(operatorGate('ask', true, snapshotMetisLight, now)).toEqual({ allowed: true })
    expect(operatorGate('intelligence', true, snapshotMetisLight, now)).toEqual({ allowed: true })
  })
  it('refuses a feature the tier does not include, with a reason', () => {
    const result = operatorGate('listen', true, snapshotMetisLight, now)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('Your Métis Light license does not include Listen.')
  })
  it('refuses with a waiting-for-Operator reason when no heartbeat has confirmed the seat yet', () => {
    const result = operatorGate('listen', true, null, now)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/Waiting for Operator/)
  })
  it('refuses with a stale-heartbeat reason once the grace window has elapsed', () => {
    const stale = { ...snapshotMetisLight, at: now - OPERATOR_ENTITLEMENT_GRACE_MS - 1 }
    const result = operatorGate('ask', true, stale, now)
    // ask-only survives the grace fallback, so 'ask' itself stays allowed even once stale.
    expect(result).toEqual({ allowed: true })
    const listenResult = operatorGate('listen', true, stale, now)
    expect(listenResult.allowed).toBe(false)
    expect(listenResult.reason).toMatch(/not been reachable in over 24 hours/)
  })
  it('never contains an em dash in any reason copy', () => {
    const reasons = [
      operatorGateReason('listen', null, now),
      operatorGateReason('listen', { ...snapshotMetisLight, at: now - OPERATOR_ENTITLEMENT_GRACE_MS - 1 }, now),
      operatorGateReason('listen', snapshotMetisLight, now)
    ]
    for (const r of reasons) expect(r).not.toMatch(/—/)
  })
})

describe('parseOperatorIntegrationsResponse', () => {
  it('parses a well-formed response', () => {
    const parsed = parseOperatorIntegrationsResponse({
      ok: true,
      version: 3,
      integrations: [
        { id: 'i1', kind: 'hubspot', label: 'HubSpot', baseUrl: 'https://a.example', credential: 'sk', scopes: ['crm'] },
        { id: 'i2', kind: 'custom-mcp', label: 'Internal MCP', baseUrl: 'https://b.example/mcp', credential: 'tok', scopes: [] }
      ]
    })
    expect(parsed?.ok).toBe(true)
    expect(parsed?.version).toBe(3)
    expect(parsed?.integrations).toHaveLength(2)
    expect(parsed?.integrations[0].kind).toBe('hubspot')
  })
  it('drops a malformed entry but keeps the rest', () => {
    const parsed = parseOperatorIntegrationsResponse({
      ok: true,
      version: 1,
      integrations: [
        { id: 'good', kind: 'notion', label: 'Notion', baseUrl: null, credential: null, scopes: [] },
        { id: 'bad', kind: 'not-a-real-kind', label: 'x' },
        'not even an object'
      ]
    })
    expect(parsed?.integrations).toHaveLength(1)
    expect(parsed?.integrations[0].id).toBe('good')
  })
  it('fails closed on the not-entitled error shape', () => {
    expect(parseOperatorIntegrationsResponse({ ok: false, error: 'seat not entitled', code: 'not-entitled' })).toBeNull()
  })
  it('fails closed on a non-object, missing version, or non-array integrations', () => {
    expect(parseOperatorIntegrationsResponse(null)).toBeNull()
    expect(parseOperatorIntegrationsResponse({ ok: true, integrations: [] })).toBeNull()
    expect(parseOperatorIntegrationsResponse({ ok: true, version: -1, integrations: [] })).toBeNull()
    expect(parseOperatorIntegrationsResponse({ ok: true, version: 1, integrations: 'nope' })).toBeNull()
  })
})
