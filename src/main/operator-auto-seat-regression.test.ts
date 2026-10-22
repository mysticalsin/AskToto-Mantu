/**
 * REGRESSION GUARD for zero-config Operator reporting (O08).
 *
 * An auto-enrolled seat holds a reporting-tier licence. It must report usage and health and do NOTHING else:
 * listen, recap, speech, funded asks, model policy, skills and integrations behave exactly as they do on today's
 * unconfigured install. If any assertion here fails, every user could lose listen, recap or cloud speech.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_ENTITLEMENT_KEYS, emptyOperatorEntitlements } from '@shared/operator-entitlements'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '2.12.0-test', on: () => {}, removeListener: () => {} },
  net: { isOnline: () => true },
  powerMonitor: { on: () => {}, removeListener: () => {} }
}))
vi.mock('./license', () => ({
  getMachineId: () => 'machine-test-regression',
  getDurableMachineId: () => 'machine-test-regression'
}))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} },
  setAuditActor: () => {},
  auditLog: () => {}
}))
const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, writes: 0 }))
vi.mock('./store', () => ({
  getSettings: () => store.settings,
  setSettings: (patch: Record<string, unknown>) => {
    store.writes += 1
    store.settings = { ...store.settings, ...patch }
  }
}))
vi.mock('./auth', () => ({ authStatus: () => ({ signedIn: false }) }))
vi.mock('./brain/intelligence-index', () => ({ lastIndexedAt: () => 1_700_000_000_000 }))

import {
  operatorAskTransport,
  operatorFundedProviders,
  operatorHeartbeat,
  recordOperatorAsk,
  setOperatorFetchForTests,
  setOperatorFundedProvidersForTests,
  setOperatorQueueDirForTests
} from './operator-ingest'
import {
  operatorGate,
  recordOperatorHeartbeatResult,
  resetOperatorEntitlementsState
} from './operator-entitlements-state'
import {
  refreshModelPolicyChecked,
  setModelPolicyDirForTests,
  setModelPolicyFetchForTests
} from './model-policy-client'
import { pullOperatorSkillManifest, setOperatorOverlayFetchForTests } from './operator-overlay'
import { fetchOperatorIntegrations } from './operator-integrations'
import { speechPolicyIsConfigured } from './speech-policy-authority'
import { configureOperatorReportingPolicy } from './operator-reporting-policy'
import { loadQueueState } from './operator-queue'
import { operatorManaged } from './operator-seat'

const URL_BASE = 'https://operator.test'
const NOW = Date.now()
const SECONDS = Math.floor(NOW / 1000)
const LICENSE = `METIS-OP-1.0123456789abcdef.${SECONDS - 60}.${SECONDS + 86_400}.AAAAAAAAAAAAAAAAAAAA`

/** The persisted state of a device that auto-enrolled: reporting licence in its own slot, tier `reporting`. */
const AUTO_SEAT = {
  operatorUrl: URL_BASE,
  operatorLicenseToken: '',
  operatorIngestSecret: '',
  operatorReportingToken: LICENSE,
  operatorReportingJti: '0123456789abcdef',
  operatorReportingLast4: 'AAAA',
  operatorLicenseOrigin: 'sso' as const,
  operatorEnrollState: 'enrolled',
  operatorTier: 'reporting',
  operatorEntitlements: emptyOperatorEntitlements(),
  operatorEntitlementsAt: NOW,
  operatorIntegrationsVersion: 0
}
const UNCONFIGURED = {
  operatorUrl: URL_BASE,
  operatorLicenseToken: '',
  operatorIngestSecret: '',
  operatorTier: null,
  operatorEntitlements: null,
  operatorEntitlementsAt: 0,
  operatorIntegrationsVersion: 0
}
const ADMIN_SEAT = {
  ...UNCONFIGURED,
  operatorLicenseToken: LICENSE,
  operatorLicenseOrigin: 'admin' as const,
  operatorTier: 'metis-light',
  operatorEntitlements: { ...emptyOperatorEntitlements(), ask: true },
  operatorEntitlementsAt: NOW
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operator-auto-seat-'))
  setOperatorQueueDirForTests(dir)
  setModelPolicyDirForTests(dir)
  resetOperatorEntitlementsState()
  setOperatorFundedProvidersForTests([])
  configureOperatorReportingPolicy(null)
  store.settings = { ...AUTO_SEAT }
})
afterEach(() => {
  setOperatorQueueDirForTests(null)
  setModelPolicyDirForTests(null)
  setOperatorFetchForTests(null)
  setModelPolicyFetchForTests(null)
  setOperatorOverlayFetchForTests(null)
  configureOperatorReportingPolicy(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('an auto-enrolled seat is not a managed seat', () => {
  it('classifies the three seat kinds', () => {
    expect(operatorManaged(AUTO_SEAT)).toBe(false)
    expect(operatorManaged(UNCONFIGURED)).toBe(false)
    expect(operatorManaged(ADMIN_SEAT)).toBe(true)
  })
})

describe('entitlement gates', () => {
  it.each(
    OPERATOR_ENTITLEMENT_KEYS
  )('%s is allowed for an auto seat, exactly as for an unconfigured install', (key) => {
    store.settings = { ...UNCONFIGURED }
    const unconfigured = operatorGate(key)
    store.settings = { ...AUTO_SEAT }
    expect(operatorGate(key)).toEqual(unconfigured)
    expect(operatorGate(key).allowed).toBe(true)
  })

  it('stays open with a stale or empty snapshot (no 24 hour "Waiting for Operator" lockout)', () => {
    store.settings = { ...AUTO_SEAT, operatorEntitlementsAt: NOW - 3 * 24 * 60 * 60 * 1000 }
    expect(operatorGate('listen', NOW).allowed).toBe(true)
    expect(operatorGate('recap', NOW).allowed).toBe(true)
    store.settings = { ...AUTO_SEAT, operatorEntitlementsAt: 0, operatorEntitlements: null, operatorTier: null }
    expect(operatorGate('listen', NOW).allowed).toBe(true)
  })

  it('control: an admin licence without listen is still gated', () => {
    store.settings = { ...ADMIN_SEAT }
    expect(operatorGate('listen', NOW).allowed).toBe(false)
  })

  it('a reporting heartbeat result does not turn enforcement on', () => {
    recordOperatorHeartbeatResult(true, { ok: true, approved: true, tier: 'reporting', entitlements: {} })
    expect(operatorGate('listen').allowed).toBe(true)
    expect(operatorGate('operator_keys').allowed).toBe(true)
  })
})

describe('funded asks', () => {
  it('has no funded providers and no ask transport, even if a heartbeat listed some', async () => {
    setOperatorFundedProvidersForTests(['openai', 'cloudflare'])
    expect(operatorFundedProviders()).toEqual([])
    expect(operatorAskTransport(store.settings)).toBeNull()
    setOperatorFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            approved: true,
            tier: 'reporting',
            entitlements: {},
            fundedProviders: ['openai']
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )) as typeof fetch
    )
    expect((await operatorHeartbeat(store.settings)).ok).toBe(true)
    expect(operatorFundedProviders()).toEqual([])
  })

  it('control: an admin seat keeps its transport and funded providers', () => {
    store.settings = { ...ADMIN_SEAT, operatorEntitlements: { ...emptyOperatorEntitlements(), operator_keys: true } }
    setOperatorFundedProvidersForTests(['openai'])
    expect(operatorAskTransport(store.settings)).toEqual({ url: URL_BASE, secret: LICENSE })
    expect(operatorFundedProviders()).toEqual(['openai'])
  })
})

describe('policy, skills, integrations and speech make no request for an auto seat', () => {
  it('heartbeat is the only call, and it carries no model-policy, skills or integrations follow-up', async () => {
    const urls: string[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(
        JSON.stringify({
          ok: true,
          approved: true,
          tier: 'reporting',
          entitlements: {},
          integrationsVersion: 9,
          modelPolicyVersion: 99
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch)
    const modelPolicy = vi.fn()
    setModelPolicyFetchForTests(modelPolicy as unknown as typeof fetch)
    const skills = vi.fn()
    setOperatorOverlayFetchForTests(skills as unknown as typeof fetch)

    const beat = await operatorHeartbeat(store.settings)
    expect(beat).toMatchObject({ ok: true, tier: 'reporting' })
    expect(urls).toEqual([`${URL_BASE}/v1/heartbeat`])

    expect(await refreshModelPolicyChecked(store.settings as never)).toEqual({ changed: false, ok: true })
    expect(await pullOperatorSkillManifest(store.settings as never)).toBe(0)
    expect(await fetchOperatorIntegrations(store.settings as never)).toBeNull()
    expect(modelPolicy).not.toHaveBeenCalled()
    expect(skills).not.toHaveBeenCalled()
  })

  it('speech authority reads the auto seat as unconfigured, so cloud speech never closes', () => {
    // Speech identity is built from the licence slot only; an auto seat has none.
    expect(speechPolicyIsConfigured({ operatorLicenseToken: '', operatorIngestSecret: '' })).toBe(false)
    expect(speechPolicyIsConfigured({ operatorLicenseToken: LICENSE })).toBe(true)
  })
})

describe('reporting still works for an auto seat', () => {
  it('does not rewrite the encrypted settings file on every steady heartbeat', async () => {
    setOperatorFetchForTests(
      (async () =>
        new Response('{"ok":true,"approved":true,"tier":"reporting","entitlements":{}}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch
    )
    store.writes = 0
    await operatorHeartbeat(store.settings)
    await operatorHeartbeat(store.settings)
    expect(store.writes).toBe(0)
  })

  it('heartbeat and ingest go out signed with the reporting licence', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return new Response('{"ok":true,"approved":true,"tier":"reporting","entitlements":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)
    await recordOperatorAsk(store.settings as never, { id: 'ask-1', mode: 'answer' })
    expect(seen.map((s) => s.url)).toEqual([`${URL_BASE}/v1/ingest`])
    expect(seen[0].headers['x-metis-license']).toBe(LICENSE)
  })
})

describe('pre-enrolment events drain on the first heartbeat after enrolment', () => {
  it('queues without a credential, then sends them signed with the new licence before the heartbeat', async () => {
    store.settings = { ...UNCONFIGURED }
    const urls: string[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('{"ok":true,"approved":true,"tier":"reporting","entitlements":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)
    await recordOperatorAsk(store.settings as never, { id: 'ask-early', mode: 'answer' })
    expect(urls).toEqual([])
    expect(loadQueueState(dir).items).toHaveLength(1)

    store.settings = { ...AUTO_SEAT }
    await operatorHeartbeat(store.settings)
    expect(urls).toEqual([`${URL_BASE}/v1/ingest`, `${URL_BASE}/v1/heartbeat`])
    expect(loadQueueState(dir).items).toHaveLength(0)
  })
})

describe('admin kill switch (O10)', () => {
  it('turns an admin seat back into an unconfigured install and stops all reporting', async () => {
    configureOperatorReportingPolicy({ readAdmin: () => '{"operatorReporting":false}' })
    store.settings = { ...ADMIN_SEAT }
    expect(operatorManaged(store.settings)).toBe(false)
    expect(operatorGate('listen').allowed).toBe(true)
    expect(operatorAskTransport(store.settings)).toBeNull()
    const fetcher = vi.fn()
    setOperatorFetchForTests(fetcher as unknown as typeof fetch)
    expect((await operatorHeartbeat(store.settings)).ok).toBe(false)
    await recordOperatorAsk(store.settings as never, { id: 'ask-off' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(loadQueueState(dir).items).toHaveLength(0)
    expect(speechPolicyIsConfigured({ operatorLicenseToken: LICENSE })).toBe(false)
  })

  it('does not queue events for a device the administrator removed', async () => {
    store.settings = { ...UNCONFIGURED, operatorEnrollState: 'revoked' }
    await recordOperatorAsk(store.settings as never, { id: 'ask-revoked' })
    expect(loadQueueState(dir).items).toHaveLength(0)
  })
})
