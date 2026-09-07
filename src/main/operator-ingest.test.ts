import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  operatorFundedProviders,
  operatorHeartbeat,
  recordOperatorAsk,
  recordOperatorCrmSend,
  recordOperatorRating,
  resolveQuestionType,
  setOperatorFetchForTests,
  setOperatorFundedProvidersForTests,
  setOperatorQueueDirForTests
} from './operator-ingest'
import { loadQueueState } from './operator-queue'
import { resetOperatorIntegrationsStateForTests, setOperatorIntegrationsFetchForTests } from './operator-integrations'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({
  getMachineId: () => 'machine-test-0001'
}))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} },
  // auth.ts registers an audit actor at module load — a real seatMeta() now imports it for ssoEmail.
  setAuditActor: () => {},
  auditLog: () => {}
}))
// operator-entitlements-state.ts talks to the REAL settings store (getSettings/setSettings), which this
// file deliberately does not mock (safeLastIndexAt's existing use of getStoreSettings relies on the real
// store's safe defaults). Mocking just this module keeps operatorFundedProviders' operator_keys gate
// testable without a real store round trip — recordOperatorHeartbeatResult itself is exercised directly
// in operator-entitlements-state.test.ts.
let operatorKeysEntitled = true
vi.mock('./operator-entitlements-state', () => ({
  recordOperatorHeartbeatResult: () => {},
  operatorEntitled: (feature: string) => (feature === 'operator_keys' ? operatorKeysEntitled : true)
}))

const SETTINGS = {
  operatorUrl: 'https://operator.test',
  operatorIngestSecret: 'shared-secret-for-tests'
}

function captureFetch(): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  return { calls }
}

// Every test in this file runs against an isolated temp queue dir, never the mocked '/tmp' Electron
// userData path — recordOperatorAsk/CrmSend/Rating now durably enqueue on failure, and a shared literal
// '/tmp/operator-queue.json' would leak state across test files and runs.
let queueDir: string
beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), 'operator-ingest-test-'))
  setOperatorQueueDirForTests(queueDir)
  // A heartbeat's success path fires a fire-and-forget integrations refresh (maybeRefreshOperatorIntegrations)
  // — stub its transport so tests never make a real network call, and reset its module-level cache/registry
  // so one test's fetched integrations can't leak into the next.
  setOperatorIntegrationsFetchForTests((async () =>
    new Response('{"ok":true,"version":0,"integrations":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch)
  resetOperatorIntegrationsStateForTests()
  operatorKeysEntitled = true // matches today's ungated behavior unless a test says otherwise
})
afterEach(() => {
  setOperatorFetchForTests(null)
  setOperatorQueueDirForTests(null)
  setOperatorIntegrationsFetchForTests(null)
  resetOperatorIntegrationsStateForTests()
  rmSync(queueDir, { recursive: true, force: true })
})

describe('resolveQuestionType', () => {
  it('prefers the caller label, falls back to local classification, never free-form', () => {
    expect(resolveQuestionType({ questionType: 'how-to', question: 'what is x' })).toBe('how-to')
    expect(resolveQuestionType({ question: 'what is the capital of belgium' })).toBe('factual')
    expect(resolveQuestionType({ question: 'anything', vision: true })).toBe('screen')
    expect(resolveQuestionType({ questionType: 'evil' as never, question: undefined })).toBe('unknown')
    expect(resolveQuestionType({})).toBe('unknown')
  })
})

describe('recordOperatorAsk question type', () => {
  it('ships the type as a metric with Ask text ON and OFF; text only when ON', async () => {
    const on = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: true },
      { id: 'ask-on', question: 'How do I rotate the ingest secret?', provider: 'anthropic' }
    )
    expect(on.calls).toHaveLength(1)
    expect(on.calls[0].url).toBe('https://operator.test/v1/ingest')
    expect(on.calls[0].body.questionType).toBe('how-to')
    expect(on.calls[0].body.question).toBe('How do I rotate the ingest secret?')

    const off = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: false },
      { id: 'ask-off', question: 'How do I rotate the ingest secret?', provider: 'anthropic' }
    )
    expect(off.calls).toHaveLength(1)
    expect(off.calls[0].body.questionType).toBe('how-to')
    expect(off.calls[0].body.question).toBeUndefined()
    expect(JSON.stringify(off.calls[0].body)).not.toContain('rotate the ingest secret')
  })

  it('a vision Ask is typed screen and a blank prompt is unknown, never a guess', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'v', vision: true, question: 'what is the capital of belgium' })
    await recordOperatorAsk(SETTINGS, { id: 'blank', question: '' })
    expect(f.calls[0].body.questionType).toBe('screen')
    expect(f.calls[1].body.questionType).toBe('unknown')
  })

  it('does nothing without an https URL and a secret', async () => {
    const f = captureFetch()
    await recordOperatorAsk({ operatorUrl: 'http://plain.test', operatorIngestSecret: 'x' }, { id: 'a', question: 'why' })
    await recordOperatorAsk({ operatorUrl: 'https://operator.test' }, { id: 'b', question: 'why' })
    expect(f.calls).toHaveLength(0)
  })

  it('a fetch failure is swallowed so an Ask never fails because Operator is down', async () => {
    setOperatorFetchForTests((async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    await expect(recordOperatorAsk(SETTINGS, { id: 'down', question: 'why' })).resolves.toBeUndefined()
  })

  it('a thrown network failure durably enqueues the ask for retry', async () => {
    setOperatorFetchForTests((async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    await recordOperatorAsk(SETTINGS, { id: 'down-2', ts: 99, question: 'why' })
    const q = loadQueueState(queueDir)
    expect(q.items).toHaveLength(1)
    expect(q.items[0].path).toBe('/v1/ingest')
    expect(q.items[0].body).toMatchObject({ id: 'down-2', ts: 99 })
  })

  it('an error outcome carries a short error class, never assumed answered', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'err-1', outcome: 'error', error: 'transient', question: 'q' })
    expect(f.calls[0].body.outcome).toBe('error')
    expect(f.calls[0].body.error).toBe('transient')
  })
})

function scriptedFetch(statuses: number[]): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  let i = 0
  setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const status = statuses[Math.min(i, statuses.length - 1)]
    i++
    return new Response(JSON.stringify({ ok: status < 300 }), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch)
  return { calls }
}

describe('durable outbox: 5xx/429 enqueue, other rejections do not', () => {
  it('a 5xx enqueues the exact ask body (same id/ts) for the Worker to dedup later', async () => {
    const f = scriptedFetch([503])
    await recordOperatorAsk(SETTINGS, { id: 'ask-retry-1', ts: 555, question: 'why' })
    expect(f.calls).toHaveLength(1)
    const q = loadQueueState(queueDir)
    expect(q.items).toHaveLength(1)
    expect(q.items[0].path).toBe('/v1/ingest')
    expect(q.items[0].body).toMatchObject({ id: 'ask-retry-1', ts: 555 })
  })

  it('a 429 enqueues too', async () => {
    const f = scriptedFetch([429])
    await recordOperatorAsk(SETTINGS, { id: 'ask-429', question: 'why' })
    expect(f.calls).toHaveLength(1)
    expect(loadQueueState(queueDir).items).toHaveLength(1)
  })

  it('a non-retryable rejection (400) is logged and dropped, never queued', async () => {
    const f = scriptedFetch([400])
    await recordOperatorAsk(SETTINGS, { id: 'ask-bad', question: 'why' })
    expect(f.calls).toHaveLength(1)
    expect(loadQueueState(queueDir).items).toHaveLength(0)
  })
})

describe('operatorHeartbeat v2 seat fields + queue reporting', () => {
  it('carries a real hostname and reports queued/dropped as zero when the outbox is empty', async () => {
    const f = captureFetch()
    const beat = await operatorHeartbeat(SETTINGS)
    expect(beat.ok).toBe(true)
    expect(f.calls).toHaveLength(1)
    const body = f.calls[0].body
    expect(body.seatHash).toBeTruthy()
    expect(body.os).toBeTruthy()
    expect(body.appVersion).toBe('1.8.0-test')
    expect(typeof body.hostname).toBe('string')
    expect((body.hostname as string).length).toBeGreaterThan(0)
    expect(body.queued).toBe(0)
    expect(body.dropped).toBe(0)
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|secret|password/i)
  })

  it('drains queued asks in enqueue order on the tick, before the heartbeat itself, then reports empty', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const failing = scriptedFetch([503, 503])
      await recordOperatorAsk(SETTINGS, { id: 'first', ts: 1 })
      await recordOperatorAsk(SETTINGS, { id: 'second', ts: 2 })
      expect(failing.calls).toHaveLength(2)
      expect(loadQueueState(queueDir).items.map((i) => i.body.id)).toEqual(['first', 'second'])

      // Past the 1-minute backoff on the first attempt — both items are now due.
      vi.setSystemTime(1_000_000 + 61_000)
      const drained = scriptedFetch([200, 200, 200])
      const beat = await operatorHeartbeat(SETTINGS)
      expect(beat.ok).toBe(true)
      expect(drained.calls.map((c) => c.body.id)).toEqual(['first', 'second', undefined])
      expect(drained.calls[0].url).toContain('/v1/ingest')
      expect(drained.calls[1].url).toContain('/v1/ingest')
      expect(drained.calls[2].url).toContain('/v1/heartbeat')
      expect(drained.calls[2].body.queued).toBe(0)
      expect(drained.calls[2].body.dropped).toBe(0)
      expect(loadQueueState(queueDir).items).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ships licenseId/licenseLast4 once an Operator license is activated, omits them otherwise', async () => {
    const bare = captureFetch()
    await operatorHeartbeat(SETTINGS)
    expect(bare.calls[0].body.licenseId).toBeUndefined()
    expect(bare.calls[0].body.licenseLast4).toBeUndefined()

    const licensed = captureFetch()
    await operatorHeartbeat({ ...SETTINGS, operatorLicenseJti: 'abcdef0123456789', operatorLicenseLast4: 'Z9Z9' })
    expect(licensed.calls[0].body.licenseId).toBe('abcdef0123456789')
    expect(licensed.calls[0].body.licenseLast4).toBe('Z9Z9')
  })

  it('a heartbeat that reports fundedProviders still passes them through operatorFundedProviders when operator_keys is entitled', async () => {
    operatorKeysEntitled = true
    setOperatorFetchForTests((async () =>
      new Response(JSON.stringify({ ok: true, fundedProviders: ['groq'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch)
    const beat = await operatorHeartbeat(SETTINGS)
    expect(beat.ok).toBe(true)
    expect(operatorFundedProviders()).toEqual(['groq'])
  })
})

describe('operatorFundedProviders gating on the operator_keys entitlement', () => {
  it('passes through the last funded providers when operator_keys is entitled (or Operator is not configured)', () => {
    setOperatorFundedProvidersForTests(['groq'])
    operatorKeysEntitled = true
    expect(operatorFundedProviders()).toEqual(['groq'])
  })

  it('empties the list when operator_keys is not entitled (PLAN.md P2.2b #2: Métis Light has no funded asks)', () => {
    setOperatorFundedProvidersForTests(['groq'])
    operatorKeysEntitled = false
    expect(operatorFundedProviders()).toEqual([])
  })
})

describe('recordOperatorCrmSend credentialSource', () => {
  it('carries credentialSource through to the wire payload when the caller supplies one', async () => {
    const f = captureFetch()
    await recordOperatorCrmSend(SETTINGS, {
      id: 'crm-op-1',
      status: 'success',
      connector: 'plane',
      credentialSource: 'operator'
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].body.credentialSource).toBe('operator')
  })

  it('omits credentialSource entirely when the caller does not supply one', async () => {
    const f = captureFetch()
    await recordOperatorCrmSend(SETTINGS, { id: 'crm-local-1', status: 'success', connector: 'plane' })
    expect(f.calls[0].body.credentialSource).toBeUndefined()
  })
})

describe('recordOperatorRating explicit askId', () => {
  it('uses the explicit askId from the caller over the module-scope last-sent id', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'ask-A', question: 'q' })
    await recordOperatorRating(SETTINGS, 'up', 'ask-B')
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1].body.event).toBe('rating')
    expect(f.calls[1].body.id).toBe('ask-B')
  })

  it('falls back to the last-sent ask id only when the caller has none (back-compat)', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'ask-C', question: 'q' })
    await recordOperatorRating(SETTINGS, 'down')
    expect(f.calls[1].body.id).toBe('ask-C')
  })
})
