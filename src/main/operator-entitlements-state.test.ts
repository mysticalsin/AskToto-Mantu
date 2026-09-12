import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyOperatorEntitlements, OPERATOR_ENTITLEMENT_GRACE_MS } from '@shared/operator-entitlements'

// operator-entitlements-state.ts only touches getSettings/setSettings from './store' — mock the store
// with a controllable in-memory object instead of going through the real file-backed store.ts, which
// would write to the mocked Electron userData path and risk leaking state across test files (the same
// reason operator-ingest.test.ts gives its queue its own temp dir instead of sharing '/tmp').
let mockSettings: Record<string, unknown> = {}
vi.mock('./store', () => ({
  getSettings: () => mockSettings,
  setSettings: (patch: Record<string, unknown>) => {
    mockSettings = { ...mockSettings, ...patch }
  }
}))

async function importFresh(): Promise<typeof import('./operator-entitlements-state')> {
  vi.resetModules()
  return import('./operator-entitlements-state')
}

const BASE_SETTINGS = {
  operatorUrl: 'https://operator.test',
  operatorIngestSecret: 'shared-secret',
  operatorTier: null,
  operatorEntitlements: null,
  operatorIntegrationsVersion: 0,
  operatorEntitlementsAt: 0
}

beforeEach(() => {
  mockSettings = { ...BASE_SETTINGS }
})
afterEach(() => {
  vi.resetModules()
})

describe('operatorGate (unconfigured seat)', () => {
  it('allows everything when there is no Operator URL/secret at all', async () => {
    const mod = await importFresh()
    mockSettings = { ...BASE_SETTINGS, operatorUrl: '', operatorIngestSecret: '' }
    expect(mod.operatorGate('listen').allowed).toBe(true)
    expect(mod.operatorGate('crm_push').allowed).toBe(true)
  })
  it('allows everything when the URL is set but the secret is blank', async () => {
    const mod = await importFresh()
    mockSettings = { ...BASE_SETTINGS, operatorIngestSecret: '' }
    expect(mod.operatorGate('listen').allowed).toBe(true)
  })
})

describe('operatorGate (configured seat)', () => {
  it('MQA-294 does not restore an earlier in-memory grant after resetting a connection', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { operator_keys: true }, integrationsVersion: 0 })
    mockSettings = { ...BASE_SETTINGS }
    mod.resetOperatorEntitlementsState()
    expect(mod.operatorGate('operator_keys').allowed).toBe(false)
  })
  it('requires confirmed entitlements for a licence-only seat', async () => {
    const mod = await importFresh()
    mockSettings = { ...BASE_SETTINGS, operatorIngestSecret: '', operatorLicenseToken: 'METIS-OP-1.licensed-seat' }
    expect(mod.operatorGate('operator_keys').allowed).toBe(false)
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { operator_keys: true }, integrationsVersion: 0 })
    expect(mod.operatorGate('operator_keys').allowed).toBe(true)
  })

  it('does not carry a previous licence grant into a new licence', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { operator_keys: true }, integrationsVersion: 0 })
    mockSettings = { ...BASE_SETTINGS, operatorLicenseToken: 'METIS-OP-1.replacement' }
    expect(mod.operatorGate('operator_keys').allowed).toBe(false)
  })
  it('is ask-only before the first successful heartbeat', async () => {
    const mod = await importFresh()
    expect(mod.operatorGate('ask').allowed).toBe(true)
    const listen = mod.operatorGate('listen')
    expect(listen.allowed).toBe(false)
    expect(listen.reason).toMatch(/Waiting for Operator/)
  })

  it('recordOperatorHeartbeatResult(true, ...) grants the reported entitlements immediately', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, {
      tier: 'metis',
      entitlements: { ask: true, listen: true, recap: true, crm_push: true, operator_keys: true, intelligence: true, integrations: true },
      integrationsVersion: 2
    })
    expect(mod.operatorGate('listen')).toEqual({ allowed: true })
    expect(mod.operatorGate('crm_push')).toEqual({ allowed: true })
    expect(mod.operatorIntegrationsVersion()).toBe(2)
  })

  it('persists the snapshot to settings so it survives across module instances (cold start)', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis-light', entitlements: { ask: true, intelligence: true }, integrationsVersion: 1 })
    // Fresh module instance, same underlying mockSettings — simulates a relaunch reading the persisted copy.
    const mod2 = await importFresh()
    expect(mod2.operatorGate('intelligence')).toEqual({ allowed: true })
    expect(mod2.operatorGate('listen').allowed).toBe(false)
  })

  it('a failed heartbeat leaves the existing snapshot untouched (grace keeps counting from the last success)', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { ask: true, listen: true }, integrationsVersion: 1 })
    mod.recordOperatorHeartbeatResult(false, { tier: 'metis-light', entitlements: {}, integrationsVersion: 99 })
    expect(mod.operatorGate('listen')).toEqual({ allowed: true })
    expect(mod.operatorIntegrationsVersion()).toBe(1)
  })

  it('fails closed to ask-only once the grace window has elapsed since the last successful heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const mod = await importFresh()
      const t0 = Date.now()
      mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { ask: true, listen: true, crm_push: true }, integrationsVersion: 1 }, t0)
      vi.setSystemTime(t0 + OPERATOR_ENTITLEMENT_GRACE_MS + 1)
      expect(mod.operatorGate('ask').allowed).toBe(true)
      const gated = mod.operatorGate('listen')
      expect(gated.allowed).toBe(false)
      expect(gated.reason).toMatch(/not been reachable in over 24 hours/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a feature the reported tier does not include, naming the tier', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis-light', entitlements: { ask: true, intelligence: true }, integrationsVersion: 0 })
    const gated = mod.operatorGate('crm_push')
    expect(gated.allowed).toBe(false)
    expect(gated.reason).toBe('Your Métis Light license does not include CRM push.')
  })

  it('operatorEntitled is the boolean-only shorthand for operatorGate', async () => {
    const mod = await importFresh()
    mod.recordOperatorHeartbeatResult(true, { tier: 'metis', entitlements: { ask: true }, integrationsVersion: 0 })
    expect(mod.operatorEntitled('ask')).toBe(true)
    expect(mod.operatorEntitled('listen')).toBe(false)
  })
})

describe('setOperatorEntitlementsSnapshotForTests', () => {
  it('overrides the in-memory snapshot directly, without touching settings', async () => {
    const mod = await importFresh()
    mod.setOperatorEntitlementsSnapshotForTests({ tier: 'metis', entitlements: { ...emptyOperatorEntitlements(), ask: true, listen: true }, at: Date.now() })
    expect(mod.operatorGate('listen')).toEqual({ allowed: true })
  })
})
