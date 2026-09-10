import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_HMAC_HEADERS } from '@shared/operator-hmac'
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
import { enqueueOperatorItem, loadQueueState, saveQueueState } from './operator-queue'
import { signOperatorIngest } from './operator-hmac-sign'
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

const metadata = vi.hoisted(() => {
  const settings = {
    operatorUrl: '', operatorIngestSecret: '', operatorTier: 'none', operatorEntitlements: null,
    operatorEntitlementsAt: 0, operatorIntegrationsVersion: 0,
    meetingsFolder: '/private/tmp/metis-operator-ingest-metadata-never-read'
  }
  return {
    settings,
    getSettings: vi.fn(() => settings),
    setSettings: vi.fn(),
    authStatus: vi.fn(() => ({ signedIn: false })),
    lastIndexedAt: vi.fn(() => 1_700_000_000_333)
  }
})
vi.mock('./store', () => ({ getSettings: metadata.getSettings, setSettings: metadata.setSettings }))
vi.mock('./auth', () => ({ authStatus: metadata.authStatus }))
vi.mock('./brain/intelligence-index', () => ({ lastIndexedAt: metadata.lastIndexedAt }))
// Keep operatorFundedProviders' operator_keys gate focused here; recordOperatorHeartbeatResult's real
// settings persistence is exercised directly in operator-entitlements-state.test.ts. The store mock
// above exists only to isolate seat metadata from host profile files.
let operatorKeysEntitled = true
vi.mock('./operator-entitlements-state', () => ({
  recordOperatorHeartbeatResult: () => {},
  operatorEntitled: (feature: string) => (feature === 'operator_keys' ? operatorKeysEntitled : true)
}))

const SETTINGS = {
  operatorUrl: 'https://operator.test',
  operatorIngestSecret: 'shared-secret-for-tests'
}

type CapturedCall = { url: string; body: Record<string, unknown>; rawBody: string; headers: Headers }

function captureFetch(): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const rawBody = String(init?.body ?? '{}')
    calls.push({
      url: String(input),
      body: JSON.parse(rawBody) as Record<string, unknown>,
      rawBody,
      headers: new Headers(init?.headers)
    })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  return { calls }
}

// Every test in this file runs against an isolated temp queue dir, never the mocked '/tmp' Electron
// userData path — recordOperatorAsk/CrmSend/Rating now durably enqueue on failure, and a shared literal
// '/tmp/operator-queue.json' would leak state across test files and runs.
let queueDir: string
beforeEach(() => {
  metadata.getSettings.mockClear()
  metadata.authStatus.mockClear()
  metadata.lastIndexedAt.mockClear()
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
  it('ships only the type metric with Ask text ON and OFF, including a persisted legacy opt-in', async () => {
    const on = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: true },
      { id: 'ask-on', question: 'How do I rotate the ingest secret?', provider: 'anthropic' }
    )
    expect(on.calls).toHaveLength(1)
    expect(on.calls[0].url).toBe('https://operator.test/v1/ingest')
    expect(on.calls[0].body.questionType).toBe('how-to')
    expect(on.calls[0].body.question).toBeUndefined()
    expect(JSON.stringify(on.calls[0].body)).not.toContain('rotate the ingest secret')

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
    expect(q.items[0].body.question).toBeUndefined()
  })

  it('an error outcome carries a short error class, never assumed answered', async () => {
    const f = captureFetch()
    await recordOperatorAsk(SETTINGS, { id: 'err-1', outcome: 'error', error: 'transient', question: 'q' })
    expect(f.calls[0].body.outcome).toBe('error')
    expect(f.calls[0].body.error).toBe('transient')
  })

  it('signs the exact projected metadata body sent on the wire', async () => {
    const f = captureFetch()
    await recordOperatorAsk(
      { ...SETTINGS, sendAskText: true },
      { id: 'signed-ask', question: 'private words', outcome: 'answered', questionType: 'factual' }
    )
    const call = f.calls[0]
    const ts = call.headers.get(OPERATOR_HMAC_HEADERS.ts) ?? ''
    const nonce = call.headers.get(OPERATOR_HMAC_HEADERS.nonce) ?? ''
    const device = call.headers.get(OPERATOR_HMAC_HEADERS.device) ?? ''
    expect(call.headers.get(OPERATOR_HMAC_HEADERS.sig)).toBe(
      signOperatorIngest(SETTINGS.operatorIngestSecret, ts, nonce, device, call.rawBody)
    )
    expect(call.rawBody).not.toContain('private words')
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
    expect(body.lastIndexAt).toBe(1_700_000_000_333)
    expect(typeof body.hostname).toBe('string')
    expect((body.hostname as string).length).toBeGreaterThan(0)
    expect(body.queued).toBe(0)
    expect(body.dropped).toBe(0)
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|secret|password/i)
    expect(metadata.lastIndexedAt).toHaveBeenCalledWith(metadata.settings)
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

  it('projects legacy queued poison again at signed send and drains unsupported shapes without transmitting them', async () => {
    enqueueOperatorItem(
      queueDir,
      {
        path: '/v1/ingest',
        body: {
          id: 'legacy-ask',
          ts: 7,
          outcome: 'error',
          questionType: 'factual',
          error: '401 for private customer URL https://private.example/acme',
          question: 'private acquisition plan',
          transcript: 'private meeting words',
          body: { messages: [{ content: 'nested private poison' }] }
        }
      },
      { retryAfterMs: 0 },
      1
    )
    enqueueOperatorItem(
      queueDir,
      { path: '/v1/ingest', body: { event: 'future-event', id: 'unsupported-1', payload: 'private poison' } },
      { retryAfterMs: 0 },
      2
    )

    const f = captureFetch()
    const beat = await operatorHeartbeat(SETTINGS)

    expect(beat.ok).toBe(true)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0]).toMatchObject({
      url: 'https://operator.test/v1/ingest',
      body: { id: 'legacy-ask', ts: 7, outcome: 'error', questionType: 'factual', error: 'auth' }
    })
    expect(JSON.stringify(f.calls[0].body)).not.toContain('private')
    expect(f.calls[1].url).toBe('https://operator.test/v1/heartbeat')
    expect(f.calls[1].body.queued).toBe(0)
    expect(loadQueueState(queueDir).items).toHaveLength(0)
  })

  it('consumes legacy non-ingest paths without a network call or permanent queue poison', async () => {
    saveQueueState(queueDir, {
      items: [
        {
          id: 'legacy-ask-path',
          path: '/v1/ask',
          body: { messages: [{ content: 'private ask words' }] },
          enqueuedAt: 1,
          attempts: 0,
          nextAttemptAt: 1
        },
        {
          id: 'legacy-use-path',
          path: '/v1/use',
          body: { prompt: 'private use words' },
          enqueuedAt: 2,
          attempts: 0,
          nextAttemptAt: 1
        }
      ],
      droppedSinceReport: 0
    })

    const f = captureFetch()
    const beat = await operatorHeartbeat(SETTINGS)

    expect(beat.ok).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://operator.test/v1/heartbeat')
    expect(f.calls[0].body.queued).toBe(0)
    expect(loadQueueState(queueDir).items).toHaveLength(0)
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

  it('never transmits the CRM title, action, meeting/remote references, or raw error text', async () => {
    const f = captureFetch()
    await recordOperatorCrmSend(SETTINGS, {
      id: 'crm-private-1',
      status: 'failed',
      connector: 'plane',
      title: 'Customer Alpha renewal',
      meetingHash: 'abcdef0123456789',
      action: 'create Customer Alpha opportunity',
      remoteId: 'record-42',
      remoteUrl: 'https://crm.example/record/42',
      error: 'timeout posting Customer Alpha to https://crm.example/record/42',
      attempt: 3,
      latencyMs: 90
    })
    expect(f.calls[0].body).toMatchObject({
      event: 'crm',
      id: 'crm-private-1',
      status: 'failed',
      connector: 'plane',
      attempt: 3,
      latencyMs: 90,
      error: 'transient'
    })
    expect(f.calls[0].body).not.toHaveProperty('title')
    expect(f.calls[0].body).not.toHaveProperty('meetingHash')
    expect(f.calls[0].body).not.toHaveProperty('action')
    expect(f.calls[0].body).not.toHaveProperty('remoteId')
    expect(f.calls[0].body).not.toHaveProperty('remoteUrl')
    expect(JSON.stringify(f.calls[0].body)).not.toContain('Customer Alpha')
  })

  it('persists only projected CRM metadata when a retryable send fails', async () => {
    setOperatorFetchForTests((async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    await recordOperatorCrmSend(SETTINGS, {
      id: 'crm-queued-private',
      status: 'failed',
      connector: 'plane',
      title: 'Customer Alpha renewal',
      remoteId: 'record-42',
      remoteUrl: 'https://crm.example/record/42',
      error: 'Customer Alpha could not be written',
      attempt: 2
    })

    const queued = loadQueueState(queueDir).items[0].body
    expect(queued).toMatchObject({ event: 'crm', id: 'crm-queued-private', status: 'failed', attempt: 2, error: 'unknown' })
    expect(queued).not.toHaveProperty('title')
    expect(queued).not.toHaveProperty('remoteId')
    expect(queued).not.toHaveProperty('remoteUrl')
    expect(JSON.stringify(queued)).not.toContain('Customer Alpha')
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
