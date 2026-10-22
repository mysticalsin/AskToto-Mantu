import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertV4MiniflareOptions, Miniflare, type WebSocket as WorkerdWebSocket } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1Store } from '../d1'
import { hmacHex } from '../hmac'
import { OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER, ingestCanonical } from '../../../src/shared/operator-hmac'
import { generateOperatorLicense } from '../../../src/shared/operator-license'
import { sha256Hex } from '../crypto'

// The existing repository bundle checker is the canonical deploy-equivalent esbuild path.
import { bundleEntry } from '../../scripts/check-worker-bundle.mjs'
import { parseStatements } from '../../scripts/migrate.mjs'

interface RelayProtocolFixture {
  runtimeOnlySlots: {
    grantToken: { wireLength: number; valueIncluded: false }
    grantDigest: { wireLength: number; valueIncluded: false }
  }
  routes: {
    routeA: {
      routeId: 'deepgram-via-gateway'
      modelId: 'nova-3'
      policyVersion: string
      configVersion: string
      language: string
    }
    routeB: {
      routeId: 'workers-ai-nova3'
      modelId: '@cf/deepgram/nova-3'
      policyVersion: string
      configVersion: string
      language: string
    }
  }
  limits: Record<string, number>
  capability: {
    request: Record<string, unknown>
    readyResponse: Record<string, unknown>
  }
  create: {
    request: {
      operation: 'create-session'
      captureGeneration: number
      tracks: Array<'microphone' | 'system'>
      language: string
      consent: {
        accepted: true
        captureGeneration: number
        tracks: Array<'microphone' | 'system'>
        issuedAt: number
        expiresAt: number
      }
    }
    responseTemplate: {
      captureGeneration: number
      grants: Array<{ track: 'microphone' | 'system'; streamEpoch: number }>
      limits: Record<string, number>
    }
  }
  upgrade: { descriptorTemplate: Record<string, unknown> }
  status: { request: Record<string, unknown> }
  cancel: { request: Record<string, unknown> }
  events: {
    partial: Record<string, unknown>
    final: Record<string, unknown>
    terminal: Record<string, unknown>
  }
  epochProgression: { sessions: Array<{ streamEpoch: number }> }
}

const PROTOCOL_FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/qa/fixtures/speech-relay-protocol-v1.json'),
    'utf8'
  )
) as RelayProtocolFixture
const ROUTE_A = PROTOCOL_FIXTURE.routes.routeA
const ROUTE_B = PROTOCOL_FIXTURE.routes.routeB
const PARTIAL_PROVIDER_FRAME = JSON.stringify({
  type: 'Results',
  start: 0,
  duration: 0.45,
  is_final: false,
  channel: {
    alternatives: [
      {
        transcript: 'Hello',
        words: [{ word: 'Hello', start: 0, end: 0.45, language: 'en', speaker: 0 }]
      }
    ]
  },
  languages: ['en']
})
const FINAL_PROVIDER_FRAME = JSON.stringify({
  type: 'Results',
  start: 0,
  duration: 0.9,
  is_final: true,
  channel: {
    alternatives: [
      {
        transcript: 'Hello, world.',
        words: [
          { word: 'Hello,', start: 0, end: 0.45, language: 'en', speaker: 0 },
          { word: 'bonjour.', start: 0.5, end: 0.9, language: 'fr', speaker: 0 }
        ]
      }
    ]
  },
  languages: ['en', 'fr']
})

const TEST_INGEST_SECRET = 'fixture-only-operator-ingest-secret'
const TEST_MANAGEMENT_TOKEN = 'fixture-only-management-token'
const TEST_GATEWAY_TOKEN = 'fixture-only-gateway-run-token'
const TEST_DEEPGRAM_KEY = 'fixture-only-provider-key'
const DEVICE = 'runtime-device-001'
const LICENSE_JTI = 'f1a2b3c4d5e6a7b8'
const TENANT = 'metis-test-tenant'
const AUDIENCE = 'metis-test-audience'
const ACCOUNT = 'account-test-001'
const GATEWAY = 'speech-gateway-test'
const DEPLOYMENT = 'staging-synthetic'
const IMPLEMENTATION_REVISION = 'runtime-fixture-revision'

const providerWorker = `
let inferenceCalls = 0;
let observedPath = '';
let observedAuthorization = '';
let observedGatewayAuthorization = '';
let binaryFramesReceived = 0;
let closeStreamControlsReceived = 0;
let finalResultsSent = 0;
let metadataSent = 0;
let closeRequested = 0;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_fixture/state') {
      return Response.json({ inferenceCalls, observedPath, observedAuthorization, observedGatewayAuthorization,
        binaryFramesReceived, closeStreamControlsReceived, finalResultsSent, metadataSent, closeRequested });
    }
    if (url.pathname.endsWith('/ai-gateway/gateways/' + ${JSON.stringify(GATEWAY)})) {
      return Response.json({ success: true, result: {
        id: ${JSON.stringify(GATEWAY)}, collect_logs: false, cache_ttl: 0, logpush: false, otel: [], log_classification: false
      }});
    }
    inferenceCalls += 1;
    observedPath = url.pathname + url.search;
    observedAuthorization = request.headers.get('authorization') || '';
    observedGatewayAuthorization = request.headers.get('cf-aig-authorization') || '';
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('refused', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        if (event.data === '{"type":"CloseStream"}') {
          closeStreamControlsReceived += 1;
          finalResultsSent += 1;
          server.send(${JSON.stringify(FINAL_PROVIDER_FRAME)});
          metadataSent += 1;
          server.send(JSON.stringify({ type: 'Metadata', request_id: 'fixture-request' }));
          closeRequested += 1;
          server.close(1000, 'fixture complete');
        }
        return;
      }
      binaryFramesReceived += 1;
      server.send(${JSON.stringify(PARTIAL_PROVIDER_FRAME)});
    });
    return new Response(null, { status: 101, webSocket: client });
  }
};
`

async function fixturePhase<T>(phase: 'bundle' | 'runtime' | 'schema' | 'seeds', action: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await action()
  } finally {
    console.info('[relay-fixture-phase]', { phase, durationMs: Math.round(performance.now() - started) })
  }
}

function createFixtureOwner(signal?: AbortSignal) {
  let runtime: Miniflare | undefined
  let disposal: Promise<void> | undefined
  let closed = false
  const dispose = () => {
    closed = true
    if (!runtime) return Promise.resolve()
    const owned = runtime
    disposal ??= Promise.resolve().then(async () => {
      const started = performance.now()
      let outcome: 'passed' | 'failed' = 'failed'
      try {
        await owned.dispose()
        outcome = 'passed'
      } finally {
        console.info('[relay-fixture-lifecycle]', {
          phase: 'dispose',
          outcome,
          durationMs: Math.round(performance.now() - started)
        })
      }
    })
    return disposal
  }
  const abort = () => {
    void dispose().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  return {
    check() {
      signal?.throwIfAborted()
      if (closed) throw new Error('Fixture initialization owner is closed')
    },
    own(value: Miniflare) {
      runtime = value
      if (closed || signal?.aborted) abort()
    },
    dispose,
    async settle(pending: Promise<unknown>, body?: Promise<unknown>) {
      const started = performance.now()
      const [cleanup, initialization, callback] = await Promise.allSettled([dispose(), pending, body])
      signal?.removeEventListener('abort', abort)
      console.info('[relay-fixture-lifecycle]', {
        phase: 'settlement',
        disposal: cleanup.status,
        initialization: initialization.status,
        body: body ? callback.status : 'not-started',
        durationMs: Math.round(performance.now() - started)
      })
      if (cleanup.status === 'rejected') throw cleanup.reason
    }
  }
}

async function makeRuntime(
  routeId: 'deepgram-via-gateway' | 'workers-ai-nova3' = 'deepgram-via-gateway',
  owner = createFixtureOwner()
) {
  const phase = <T>(name: Parameters<typeof fixturePhase>[0], action: () => Promise<T>) =>
    fixturePhase(name, async () => {
      owner.check()
      try {
        const value = await action()
        owner.check()
        return value
      } catch (error) {
        owner.check()
        throw error
      }
    })
  const route = routeId === 'deepgram-via-gateway' ? ROUTE_A : ROUTE_B
  const modelId = route.modelId
  const operatorBundle = await phase('bundle', () => bundleEntry())
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'metis-operator-fixture',
          script: operatorBundle,
          modules: true,
          compatibilityDate: '2026-08-31',
          d1Databases: { DB: 'metis-speech-relay-fixture' },
          durableObjects: {
            SPEECH_SESSION_DO: { className: 'SpeechSessionDurableObject', useSQLite: true }
          },
          bindings: {
            OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
            OPERATOR_PROMPT_KEY: 'fixture-only-prompt-key',
            OPERATOR_SKILL_PRIVATE_KEY: 'fixture-only-skill-key',
            SPEECH_TENANT_ID: TENANT,
            SPEECH_AUDIENCE: AUDIENCE,
            SPEECH_POLICY_VERSION: route.policyVersion,
            SPEECH_ROUTE_ID: routeId,
            SPEECH_MODEL_ID: modelId,
            SPEECH_CONFIG_VERSION: route.configVersion,
            SPEECH_ALLOWED_LANGUAGES:
              routeId === 'deepgram-via-gateway'
                ? (PROTOCOL_FIXTURE.capability.readyResponse.languages as string[]).join(',')
                : route.language,
            SPEECH_MAX_CONCURRENT_SESSIONS: '2',
            SPEECH_MAX_CONCURRENT_TRACKS: '4',
            SPEECH_BUDGET_WINDOW_MS: '120000',
            SPEECH_BUDGET_MAX_MS: '120000',
            SPEECH_MAX_SESSION_MS: '60000',
            SPEECH_DEPLOYMENT_ID: DEPLOYMENT,
            SPEECH_GATEWAY_ID: GATEWAY,
            SPEECH_IMPLEMENTATION_REVISION: IMPLEMENTATION_REVISION,
            SPEECH_GATEWAY_MANAGEMENT_TOKEN: TEST_MANAGEMENT_TOKEN,
            SPEECH_GATEWAY_RUN_TOKEN: TEST_GATEWAY_TOKEN,
            ...(routeId === 'deepgram-via-gateway' ? { SPEECH_DEEPGRAM_API_KEY: TEST_DEEPGRAM_KEY } : {}),
            CF_ACCOUNT_ID: ACCOUNT
          },
          outboundService: 'metis-synthetic-gateway'
        },
        {
          name: 'metis-synthetic-gateway',
          script: providerWorker,
          modules: true,
          compatibilityDate: '2026-08-31'
        }
      ]
    })
  )
  owner.own(runtime)
  try {
    const database = (await phase('runtime', () => runtime.getD1Database('DB'))) as unknown as {
      prepare(query: string): {
        run(): Promise<unknown>
        first<T>(): Promise<T | null>
        bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> }
      }
      batch(statements: unknown[]): Promise<Array<{ success: boolean }>>
    }
    const directory = dirname(fileURLToPath(import.meta.url))
    await phase('schema', async () => {
      // Preserve the production migration parser and statement order, with one real D1 bridge call.
      const statements = parseStatements(readFileSync(join(directory, '../../schema.sql'), 'utf8')).map(
        (statement: string) => database.prepare(statement)
      )
      const results = await database.batch(statements)
      if (results.length !== statements.length || results.some((result) => result.success !== true)) {
        throw new Error('Fixture schema initialization did not complete')
      }
    })
    const seeded = await phase('seeds', async () => {
      const store = d1Store(database as never)
      const now = Date.now()
      await store.putTier({
        id: 'metis',
        label: 'Métis',
        entitlements_json: JSON.stringify(['listen', 'operator_keys']),
        updated_at: now
      })
      owner.check()
      const license = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 7, now, jti: LICENSE_JTI })
      owner.check()
      const keyHash = await sha256Hex(license.token)
      owner.check()
      await store.putIssuedLicense({
        ...license.claims,
        last4: license.last4,
        key_hash: keyHash,
        days: 7,
        revoked: 0,
        created_at: now,
        created_by: 'fixture-reviewer',
        tier: 'metis',
        activated_device: DEVICE,
        activated_at: now
      })
      owner.check()
      await store.upsertSeat({
        device_id: DEVICE,
        seat_hash: 'synthetic-seat-hash',
        os: 'linux',
        app_version: 'fixture',
        first_seen: now,
        last_seen: now,
        country: null,
        city: null,
        region: null,
        lat: null,
        lon: null,
        last_index_at: null,
        hostname: null,
        sso_email: null,
        license: 'licensed',
        approval: 'approved',
        license_jti: LICENSE_JTI
      })
      owner.check()
      for (const track of ['microphone', 'system'] as const) {
        await database
          .prepare(`INSERT INTO speech_capture_epochs (
            tenant_id, audience, license_jti, device_id, capture_generation, track, last_epoch, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            TENANT,
            AUDIENCE,
            LICENSE_JTI,
            DEVICE,
            PROTOCOL_FIXTURE.create.request.captureGeneration,
            track,
            10,
            now + 300_000,
            now
          )
          .run()
        owner.check()
      }
      const refs = ['gateway-readback', 'provider-retention', 'synthetic-sink-test', 'relay-runtime-test'].map(
        (kind) => ({
          kind,
          reference: `fixture:${kind}`,
          digest: `sha256:${'a'.repeat(64)}`,
          outcome: 'passed'
        })
      )
      await database
        .prepare(`INSERT INTO speech_route_evidence (
          id, evidence_key, tenant_id, audience, deployment_id, account_id, gateway_id, route_id, model_id,
          config_version, policy_version, implementation_revision, reviewer_email, imported_by, evidence_refs_json,
          expires_at, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          'fixture-evidence',
          'fixture-evidence-key',
          TENANT,
          AUDIENCE,
          DEPLOYMENT,
          ACCOUNT,
          GATEWAY,
          routeId,
          modelId,
          route.configVersion,
          route.policyVersion,
          IMPLEMENTATION_REVISION,
          'reviewer@example.invalid',
          'reviewer@example.invalid',
          JSON.stringify(refs),
          now + 300_000,
          1,
          now
        )
        .run()
      return { now, license: license.token }
    })
    return { runtime, database, ...seeded, routeId, modelId }
  } catch (error) {
    try {
      await owner.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture initialization and owned disposal failed')
    }
    throw error
  }
}

function useRuntime(routeId: Parameters<typeof makeRuntime>[0], observe?: () => () => void) {
  let owner: ReturnType<typeof createFixtureOwner> | undefined
  let pending: ReturnType<typeof makeRuntime> | undefined
  let fixture: Awaited<ReturnType<typeof makeRuntime>> | undefined
  let body: Promise<void> | undefined
  let restore: (() => void) | undefined
  // The existing Vitest 10s hook deadline owns real per-case setup; protocol bodies retain 5s.
  beforeEach(async ({ signal }) => {
    body = undefined
    restore = observe?.()
    owner = createFixtureOwner(signal)
    pending = makeRuntime(routeId, owner)
    fixture = await pending
  })
  afterEach(async () => {
    try {
      if (owner && pending) await owner.settle(pending, body)
    } finally {
      restore?.()
      fixture = undefined
    }
  })
  return {
    get() {
      owner?.check()
      if (!fixture) throw new Error('Fixture setup did not publish an owned runtime')
      return fixture
    },
    dispatch(runtime: Miniflare, input: Parameters<typeof signedRequest>[0]) {
      if (!owner) throw new Error('Fixture setup has no request owner')
      return dispatchOwnedRequest(owner, runtime, input)
    },
    check() {
      owner?.check()
    },
    run(action: () => Promise<void>) {
      return () => {
        body = action()
        return body
      }
    }
  }
}

describe('workerd fixture initialization', () => {
  const directory = dirname(fileURLToPath(import.meta.url))
  const statements = parseStatements(readFileSync(join(directory, '../../schema.sql'), 'utf8')) as string[]
  const getDatabase = Miniflare.prototype.getD1Database
  let preparedQueries: WeakMap<object, string>
  let preparedBeforeBatchSettled: string[]
  let batches: string[][]
  let batchSettled: boolean
  let batchResults: Array<{ success: boolean }>
  const currentFixture = useRuntime('deepgram-via-gateway', () => {
    preparedQueries = new WeakMap<object, string>()
    preparedBeforeBatchSettled = []
    batches = []
    batchSettled = false
    batchResults = []
    const databaseSpy = vi.spyOn(Miniflare.prototype, 'getD1Database').mockImplementation(async function (
      this: Miniflare,
      ...args
    ) {
      const database = await getDatabase.apply(this, args)
      return new Proxy(database, {
        get(target, property) {
          const value = Reflect.get(target, property, target)
          if (property === 'prepare') {
            return new Proxy(value, {
              apply(method, _receiver, argumentsList) {
                const query = argumentsList[0] as string
                const statement = Reflect.apply(method, target, argumentsList)
                if (statement === null || typeof statement !== 'object') {
                  throw new Error('Actual D1 prepare did not return a statement object')
                }
                preparedQueries.set(statement, query)
                if (!batchSettled) preparedBeforeBatchSettled.push(query)
                return statement
              }
            })
          }
          if (property === 'batch') {
            return new Proxy(value, {
              async apply(method, _receiver, argumentsList) {
                batches.push(
                  (argumentsList[0] as object[]).map((statement) => preparedQueries.get(statement) ?? 'unknown')
                )
                const results = await Reflect.apply(method, target, argumentsList)
                if (!Array.isArray(results)) throw new Error('Actual D1 batch did not return a result array')
                batchResults = results.map((result: unknown) => {
                  if (
                    result === null ||
                    typeof result !== 'object' ||
                    !('success' in result) ||
                    typeof result.success !== 'boolean'
                  ) {
                    throw new Error('Actual D1 batch returned a result without a boolean success field')
                  }
                  return { success: result.success }
                })
                batchSettled = true
                return results
              }
            })
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    })
    return () => databaseSpy.mockRestore()
  })
  it(
    'initializes every real schema object in one ordered D1 batch before seeding',
    currentFixture.run(async () => {
      const fixture = currentFixture.get()
      expect(statements).toHaveLength(60)
      expect(batches).toEqual([statements])
      expect(preparedBeforeBatchSettled).toEqual(statements)
      expect(batchResults).toHaveLength(statements.length)
      expect(batchResults.every((result) => result.success)).toBe(true)
      const database = await getDatabase.call(fixture.runtime, 'DB')
      const objects = await database
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
      const expectedObjects = statements
        .map((statement) => {
          const match = /^CREATE (TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(statement)
          if (!match) throw new Error('Unexpected fixture schema statement')
          return { type: match[1].toLowerCase(), name: match[2] }
        })
        .sort((left, right) => left.name.localeCompare(right.name))
      // D1 may also own internal metadata tables; every real fixture object must still exist.
      expect(objects.results).toEqual(expect.arrayContaining(expectedObjects))
      expect(await database.prepare("SELECT id FROM tiers WHERE id = 'metis'").first()).toEqual({ id: 'metis' })
      expect(await database.prepare('SELECT approval FROM seats WHERE device_id = ?').bind(DEVICE).first()).toEqual({
        approval: 'approved'
      })
    })
  )
})

describe('workerd fixture initialization', () => {
  it('stops a canceled initialization before schema or seeds and joins its owned disposal', async () => {
    const controller = new AbortController()
    const refusal = new Error('Synthetic fixture setup cancellation')
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    let disposed = false
    let owned: Miniflare | undefined
    const dispose = Miniflare.prototype.dispose
    const disposeSpy = vi.spyOn(Miniflare.prototype, 'dispose').mockImplementation(async function (this: Miniflare) {
      await dispose.call(this)
      disposed = true
    })
    const databaseSpy = vi.spyOn(Miniflare.prototype, 'getD1Database').mockImplementation(async function (
      this: Miniflare
    ) {
      owned = this
      entered()
      await held
      throw refusal
    })
    const phases = vi.spyOn(console, 'info').mockImplementation(() => {})
    const owner = createFixtureOwner(controller.signal)
    const pending = makeRuntime('deepgram-via-gateway', owner)
    let releaseBody!: () => void
    const body = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    let restoreDispatch: (() => void) | undefined
    try {
      await reached
      controller.abort(refusal)
      release()
      await expect(pending).rejects.toBe(refusal)
      let settled = false
      const settlement = owner.settle(pending, body).then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(disposeSpy).toHaveBeenCalledOnce()
      expect(disposed).toBe(true)
      expect(settled).toBe(false)
      expect(() => owner.check()).toThrow(refusal)
      if (!owned) throw new Error('Expected the canceled fixture to own its real runtime')
      const dispatchSpy = vi.spyOn(owned, 'dispatchFetch')
      restoreDispatch = () => {
        dispatchSpy.mockRestore()
      }
      await expect(
        dispatchOwnedRequest(owner, owned, {
          license: 'not-used',
          now: Date.now(),
          path: '/v1/speech/capability',
          method: 'POST'
        })
      ).rejects.toBe(refusal)
      expect(dispatchSpy).not.toHaveBeenCalled()
      releaseBody()
      await settlement
      expect(settled).toBe(true)
      expect(
        phases.mock.calls.filter(([label]) => label === '[relay-fixture-phase]').map(([, value]) => value.phase)
      ).toEqual(['bundle', 'runtime'])
    } finally {
      release()
      releaseBody()
      try {
        await owner.settle(pending, body)
      } finally {
        restoreDispatch?.()
        phases.mockRestore()
        databaseSpy.mockRestore()
        disposeSpy.mockRestore()
      }
    }
  })

  it('reports owned cleanup refusal alongside the original initialization refusal', async () => {
    const refusal = new Error('Synthetic fixture initialization refusal')
    const cleanupRefusal = new Error('Synthetic fixture disposal refusal')
    const dispose = Miniflare.prototype.dispose
    const disposeSpy = vi.spyOn(Miniflare.prototype, 'dispose').mockImplementation(async function (this: Miniflare) {
      await dispose.call(this)
      throw cleanupRefusal
    })
    const databaseSpy = vi.spyOn(Miniflare.prototype, 'getD1Database').mockRejectedValue(refusal)
    const owner = createFixtureOwner()
    const pending = makeRuntime('deepgram-via-gateway', owner)
    try {
      await expect(pending).rejects.toMatchObject({ errors: [refusal, cleanupRefusal] })
      const combined = await pending.catch((error) => error)
      expect(combined.errors[0]).toBe(refusal)
      expect(combined.errors[1]).toBe(cleanupRefusal)
      await expect(owner.settle(pending)).rejects.toBe(cleanupRefusal)
      expect(disposeSpy).toHaveBeenCalledOnce()
    } finally {
      await owner.settle(pending).catch(() => {})
      databaseSpy.mockRestore()
      disposeSpy.mockRestore()
    }
  })

  it('awaits owned runtime disposal before preserving an initialization rejection', async () => {
    const refusal = new Error('Synthetic fixture database initialization refusal')
    let owned: Miniflare | undefined
    let disposed = false
    const dispose = Miniflare.prototype.dispose
    const disposeSpy = vi.spyOn(Miniflare.prototype, 'dispose').mockImplementation(async function (this: Miniflare) {
      await dispose.call(this)
      disposed = true
    })
    const databaseSpy = vi.spyOn(Miniflare.prototype, 'getD1Database').mockImplementation(async function (
      this: Miniflare
    ) {
      owned = this
      throw refusal
    })
    try {
      await expect(makeRuntime()).rejects.toBe(refusal)
      expect(disposeSpy).toHaveBeenCalledOnce()
      expect(disposeSpy.mock.instances[0]).toBe(owned)
      expect(disposed).toBe(true)
    } finally {
      databaseSpy.mockRestore()
      disposeSpy.mockRestore()
      // The pre-repair factory leaks on setup rejection; keep its tests-first failure owned.
      if (owned && !disposed) await dispose.call(owned)
    }
  })
})

async function signedRequest(input: {
  license: string
  now: number
  path: string
  method: 'POST' | 'GET'
  body?: string
  additionalHeaders?: Record<string, string>
}): Promise<{ url: string; init: { method: 'POST' | 'GET'; headers: Record<string, string>; body?: string } }> {
  const bodyText = input.body ?? ''
  const timestamp = String(input.now)
  const nonce = crypto.randomUUID()
  const signature = await hmacHex(input.license, ingestCanonical(timestamp, nonce, DEVICE, await sha256Hex(bodyText)))
  return {
    url: `https://operator.fixture${input.path}`,
    init: {
      method: input.method,
      headers: {
        'content-type': 'application/json',
        [OPERATOR_LICENSE_HEADER]: input.license,
        [OPERATOR_HMAC_HEADERS.device]: DEVICE,
        [OPERATOR_HMAC_HEADERS.ts]: timestamp,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.sig]: signature,
        ...input.additionalHeaders
      },
      ...(input.method === 'POST' ? { body: bodyText } : {})
    }
  }
}

async function dispatchOwnedRequest(
  owner: ReturnType<typeof createFixtureOwner>,
  runtime: Miniflare,
  input: Parameters<typeof signedRequest>[0]
): Promise<Response> {
  owner.check()
  const signed = await signedRequest(input)
  owner.check()
  const response = (await runtime.dispatchFetch(signed.url, signed.init)) as unknown as Response
  owner.check()
  return response
}

type RelayLifecycleDb = {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> }
  }
}

function boundedLifecycleDiagnostic(
  terminal: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  session: Record<string, unknown> | null,
  stream: Record<string, unknown> | null,
  provider: Record<string, unknown>
): Record<string, unknown> {
  const enumValue = (value: unknown, values: readonly string[]) =>
    typeof value === 'string' && values.includes(value) ? value : 'unknown'
  const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)
  const present = (value: unknown) => value !== null && value !== undefined
  return {
    terminal: {
      type: enumValue(terminal.type, ['terminal']),
      reason: enumValue(terminal.reason, [
        'normal',
        'cancelled',
        'lease-expired',
        'upstream-error',
        'client-disconnected',
        'limit',
        'revoked',
        'unknown'
      ]),
      tail: enumValue(terminal.tail, ['complete', 'incomplete']),
      closeConfirmed: terminal.closeConfirmed === true,
      lastSequence: count(terminal.lastSequence),
      captureGeneration: count(terminal.captureGeneration),
      track: enumValue(terminal.track, ['microphone', 'system']),
      streamEpoch: count(terminal.streamEpoch)
    },
    events: events.slice(0, 8).map((event) => ({
      type: enumValue(event.type, ['transcript', 'terminal']),
      sequence: count(event.sequence),
      segmentIndex: count(event.segmentIndex),
      revision: count(event.revision),
      final: event.final === true
    })),
    session: {
      status: enumValue(session?.status, ['active', 'cancelled', 'expired']),
      terminalAtPresent: present(session?.terminal_at),
      terminalReason: enumValue(session?.terminal_reason, [
        'normal',
        'cancelled',
        'lease-expired',
        'upstream-error',
        'client-disconnected',
        'limit',
        'revoked',
        'unknown'
      ])
    },
    stream: {
      transportAttempted: present(stream?.transport_attempted_at),
      opened: present(stream?.opened_at),
      finishRequested: present(stream?.finish_requested_at),
      providerComplete: present(stream?.provider_complete_at),
      closeConfirmed: present(stream?.close_confirmed_at),
      stopRequested: present(stream?.stop_requested_at),
      settled: present(stream?.settled_at),
      terminalReason: enumValue(stream?.terminal_reason, [
        'normal',
        'cancelled',
        'lease-expired',
        'upstream-error',
        'client-disconnected',
        'limit',
        'revoked',
        'unknown'
      ]),
      tail: enumValue(stream?.tail_status, ['complete', 'incomplete']),
      inputBytes: count(stream?.input_bytes),
      inputMessages: count(stream?.input_messages),
      outputBytes: count(stream?.output_bytes),
      outputMessages: count(stream?.output_messages),
      lastSequence: count(stream?.last_sequence)
    },
    provider: {
      binaryFramesReceived: count(provider.binaryFramesReceived),
      closeStreamControlsReceived: count(provider.closeStreamControlsReceived),
      finalResultsSent: count(provider.finalResultsSent),
      metadataSent: count(provider.metadataSent),
      closeRequested: count(provider.closeRequested)
    }
  }
}

async function readRouteBLifecycleDiagnostic(
  database: RelayLifecycleDb,
  sessionId: string,
  terminal: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  provider: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const session = await database
    .prepare('SELECT status, terminal_at, terminal_reason FROM speech_sessions WHERE id = ?')
    .bind(sessionId)
    .first<Record<string, unknown>>()
  const stream = await database
    .prepare(`SELECT transport_attempted_at, opened_at, stop_requested_at, finish_requested_at,
      provider_complete_at, close_confirmed_at, settled_at, input_bytes, input_messages, output_bytes,
      output_messages, last_sequence, tail_status, terminal_reason
      FROM speech_streams WHERE session_id = ? AND track = 'microphone' ORDER BY stream_epoch DESC LIMIT 1`)
    .bind(sessionId)
    .first<Record<string, unknown>>()
  return boundedLifecycleDiagnostic(terminal, events, session, stream, provider)
}

describe('speech relay on pinned hosted workerd', () => {
  const currentFixture = useRuntime('deepgram-via-gateway')
  it(
    'runs licensed create, actual Upgrade, binary forwarding, final drain and status without provider calls',
    currentFixture.run(async () => {
      const { runtime, database, now, license } = currentFixture.get()
      const dispatchSignedRequest = currentFixture.dispatch
      const unauthenticated = await runtime.dispatchFetch('https://operator.fixture/v1/speech/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'create-session' })
      })
      currentFixture.check()
      expect(unauthenticated.status).toBe(401)
      const gateway = (await runtime.getWorker('metis-synthetic-gateway')) as unknown as {
        fetch(input: string): Promise<Response>
      }
      expect(await (await gateway.fetch('https://gateway.fixture/_fixture/state')).json()).toMatchObject({
        inferenceCalls: 0
      })

      const capabilityBody = JSON.stringify(PROTOCOL_FIXTURE.capability.request)
      const capability = await dispatchSignedRequest(runtime, {
        license,
        now,
        path: '/v1/speech/capability',
        method: 'POST',
        body: capabilityBody
      })
      expect(capability.status).toBe(200)
      const capabilityResponse = (await capability.json()) as Record<string, unknown>
      expect(capabilityResponse).toMatchObject({
        ...PROTOCOL_FIXTURE.capability.readyResponse,
        validUntil: expect.any(Number)
      })
      expect(Number(capabilityResponse.validUntil)).toBeGreaterThan(now)

      const captureGeneration = PROTOCOL_FIXTURE.create.request.captureGeneration
      const createTemplate = PROTOCOL_FIXTURE.create.request
      const consentExpiresAt = now + 60_000
      const createBody = JSON.stringify({
        ...createTemplate,
        tracks: ['microphone'],
        consent: {
          ...createTemplate.consent,
          tracks: ['microphone'],
          issuedAt: now,
          expiresAt: consentExpiresAt
        }
      })
      const createdResponse = await dispatchSignedRequest(runtime, {
        license,
        now,
        path: '/v1/speech/sessions',
        method: 'POST',
        body: createBody
      })
      expect(createdResponse.status).toBe(200)
      const created = (await createdResponse.json()) as {
        protocolVersion: number
        sessionId: string
        captureGeneration: number
        routeId: string
        model: string
        configVersion: string
        policyVersion: string
        language: string
        grantExpiresAt: number
        leaseExpiresAt: number
        limits: Record<string, number>
        grants: Array<{ track: 'microphone' | 'system'; token: string; streamEpoch: number }>
      }
      expect(created.protocolVersion).toBe(1)
      const sessionAuthority = await database
        .prepare(`SELECT created_at, consent_expires_at, evidence_expires_at, license_expires_at,
          lease_expires_at, grant_expires_at, reserved_ms FROM speech_sessions WHERE id = ?`)
        .bind(created.sessionId)
        .first<Record<string, number>>()
      expect(sessionAuthority).not.toBeNull()
      if (!sessionAuthority) throw new Error('fixture session authority row missing')
      const expectedMaxStreamMs = consentExpiresAt - sessionAuthority.created_at
      expect(Number.isSafeInteger(expectedMaxStreamMs) && expectedMaxStreamMs > 0).toBe(true)
      expect(sessionAuthority.consent_expires_at).toBe(consentExpiresAt)
      expect(sessionAuthority.evidence_expires_at).toBeGreaterThan(consentExpiresAt)
      expect(sessionAuthority.license_expires_at).toBeGreaterThan(consentExpiresAt)
      expect(sessionAuthority.lease_expires_at).toBe(consentExpiresAt)
      expect(sessionAuthority.grant_expires_at).toBe(consentExpiresAt)
      expect(sessionAuthority.reserved_ms).toBe(expectedMaxStreamMs)
      expect(created.leaseExpiresAt).toBe(consentExpiresAt)
      expect(created.grantExpiresAt).toBe(sessionAuthority.grant_expires_at)
      expect(created.limits).toEqual({
        ...PROTOCOL_FIXTURE.limits,
        maxStreamMs: expectedMaxStreamMs,
        audioDeadlineAt: consentExpiresAt - PROTOCOL_FIXTURE.limits.drainWindowMs
      })
      expect(created.limits.maxStreamMs).toBe(expectedMaxStreamMs)
      expect(created.limits.maxStreamMs).toBeLessThanOrEqual(PROTOCOL_FIXTURE.limits.maxStreamMs)
      expect(created.limits.audioDeadlineAt).toBe(consentExpiresAt - PROTOCOL_FIXTURE.limits.drainWindowMs)
      expect(created).toMatchObject({
        routeId: ROUTE_A.routeId,
        model: ROUTE_A.modelId,
        configVersion: ROUTE_A.configVersion,
        policyVersion: ROUTE_A.policyVersion,
        language: ROUTE_A.language,
        captureGeneration
      })
      expect(created.captureGeneration).toBe(captureGeneration)
      expect(created.grants).toHaveLength(1)
      const grant = created.grants[0]
      expect(grant).toBeDefined()
      if (!grant) throw new Error('fixture expected one grant')
      expect(grant.streamEpoch).toBe(PROTOCOL_FIXTURE.create.responseTemplate.grants[0]?.streamEpoch)
      expect(grant.token).toMatch(
        new RegExp(`^[A-Za-z0-9_-]{${PROTOCOL_FIXTURE.runtimeOnlySlots.grantToken.wireLength}}$`)
      )
      const grantDigest = await sha256Hex(grant.token)
      expect(grantDigest).toMatch(/^[a-f0-9]{64}$/)

      const descriptor = JSON.stringify({
        ...PROTOCOL_FIXTURE.upgrade.descriptorTemplate,
        sessionId: created.sessionId,
        track: grant.track,
        captureGeneration: created.captureGeneration,
        streamEpoch: grant.streamEpoch,
        grantDigest
      })
      const opened = await dispatchSignedRequest(runtime, {
        license,
        now,
        path: `/v1/speech/sessions/${created.sessionId}/tracks/microphone`,
        method: 'GET',
        body: descriptor,
        additionalHeaders: {
          upgrade: 'websocket',
          'x-metis-speech-descriptor': descriptor,
          'x-metis-speech-grant': grant.token
        }
      })
      expect(opened.status).toBe(101)
      const socket = (opened as unknown as Response & { webSocket?: WorkerdWebSocket }).webSocket
      expect(socket).toBeDefined()
      if (!socket) throw new Error('workerd did not return an accepted WebSocket')

      const events: Array<Record<string, unknown>> = []
      let resolveTerminal!: () => void
      const terminalReceived = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('relay terminal timed out')), 10_000)
        resolveTerminal = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        const value = JSON.parse(event.data) as Record<string, unknown>
        events.push(value)
        if (value.type === 'terminal') resolveTerminal()
      })
      socket.accept()
      socket.send(new Uint8Array([0, 0, 1, 0]).buffer)
      socket.send('{"type":"finish"}')
      await terminalReceived
      currentFixture.check()
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ...PROTOCOL_FIXTURE.events.partial, sessionId: created.sessionId }),
          expect.objectContaining({ ...PROTOCOL_FIXTURE.events.final, sessionId: created.sessionId }),
          expect.objectContaining({ ...PROTOCOL_FIXTURE.events.terminal, sessionId: created.sessionId })
        ])
      )
      const providerState = (await (await gateway.fetch('https://gateway.fixture/_fixture/state')).json()) as {
        inferenceCalls: number
        observedPath: string
        observedAuthorization: string
        observedGatewayAuthorization: string
      }
      expect(
        providerState.inferenceCalls === 1 &&
          providerState.observedPath ===
            '/v1/account-test-001/speech-gateway-test/deepgram/v1/listen?model=nova-3&language=multi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&mip_opt_out=true' &&
          providerState.observedAuthorization === `Token ${TEST_DEEPGRAM_KEY}` &&
          providerState.observedGatewayAuthorization === `Bearer ${TEST_GATEWAY_TOKEN}`
      ).toBe(true)
      const statusBody = JSON.stringify({ ...PROTOCOL_FIXTURE.status.request, sessionId: created.sessionId })
      const status = await dispatchSignedRequest(runtime, {
        license,
        now: Date.now(),
        path: `/v1/speech/sessions/${created.sessionId}/status`,
        method: 'POST',
        body: statusBody
      })
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        protocolVersion: 1,
        sessionId: created.sessionId,
        captureGeneration,
        tracks: [
          expect.objectContaining({
            track: 'microphone',
            streamEpoch: grant.streamEpoch,
            phase: 'closed',
            closeConfirmed: true,
            tail: 'complete',
            lastSequence: 2
          })
        ]
      })

      const nextNow = Date.now()
      const secondRequest = JSON.stringify({
        ...createTemplate,
        tracks: ['microphone'],
        consent: {
          ...createTemplate.consent,
          tracks: ['microphone'],
          issuedAt: nextNow,
          expiresAt: nextNow + 60_000
        }
      })
      const nextResponse = await dispatchSignedRequest(runtime, {
        license,
        now: nextNow,
        path: '/v1/speech/sessions',
        method: 'POST',
        body: secondRequest
      })
      expect(nextResponse.status).toBe(200)
      const nextSession = (await nextResponse.json()) as {
        sessionId: string
        grants: Array<{ track: 'microphone'; streamEpoch: number }>
      }
      expect(nextSession.grants[0]?.streamEpoch).toBe(PROTOCOL_FIXTURE.epochProgression.sessions[1]?.streamEpoch)
      const cancelBody = JSON.stringify({ ...PROTOCOL_FIXTURE.cancel.request, sessionId: nextSession.sessionId })
      const cancelled = await dispatchSignedRequest(runtime, {
        license,
        now: Date.now(),
        path: `/v1/speech/sessions/${nextSession.sessionId}/cancel`,
        method: 'POST',
        body: cancelBody
      })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({
        protocolVersion: 1,
        sessionId: nextSession.sessionId,
        cancelled: true,
        cancellationRequested: false
      })
    })
  )
})

describe('speech relay on pinned hosted workerd', () => {
  const currentFixture = useRuntime('workers-ai-nova3')
  it(
    'uses the distinct documented Workers AI Route B URL without Deepgram credentials',
    currentFixture.run(async () => {
      const { runtime, database, now, license } = currentFixture.get()
      const dispatchSignedRequest = currentFixture.dispatch
      const captureGeneration = PROTOCOL_FIXTURE.create.request.captureGeneration
      const createTemplate = PROTOCOL_FIXTURE.create.request
      const createBody = JSON.stringify({
        ...createTemplate,
        captureGeneration,
        tracks: ['microphone'],
        language: ROUTE_B.language,
        consent: {
          ...createTemplate.consent,
          captureGeneration,
          tracks: ['microphone'],
          issuedAt: now,
          expiresAt: now + 60_000
        }
      })
      const createdResponse = await dispatchSignedRequest(runtime, {
        license,
        now,
        path: '/v1/speech/sessions',
        method: 'POST',
        body: createBody
      })
      expect(createdResponse.status).toBe(200)
      const created = (await createdResponse.json()) as {
        sessionId: string
        captureGeneration: number
        routeId: string
        model: string
        configVersion: string
        policyVersion: string
        language: string
        grants: Array<{ track: 'microphone'; token: string; streamEpoch: number }>
      }
      expect(created).toMatchObject({
        routeId: ROUTE_B.routeId,
        model: ROUTE_B.modelId,
        configVersion: ROUTE_B.configVersion,
        policyVersion: ROUTE_B.policyVersion,
        language: ROUTE_B.language,
        captureGeneration
      })
      const grant = created.grants[0]
      if (!grant) throw new Error('fixture expected one Route B grant')
      expect(grant.streamEpoch).toBe(PROTOCOL_FIXTURE.create.responseTemplate.grants[0]?.streamEpoch)
      expect(grant.token).toMatch(
        new RegExp(`^[A-Za-z0-9_-]{${PROTOCOL_FIXTURE.runtimeOnlySlots.grantToken.wireLength}}$`)
      )
      const grantDigest = await sha256Hex(grant.token)
      expect(grantDigest).toMatch(/^[a-f0-9]{64}$/)
      const descriptor = JSON.stringify({
        ...PROTOCOL_FIXTURE.upgrade.descriptorTemplate,
        sessionId: created.sessionId,
        track: grant.track,
        captureGeneration: created.captureGeneration,
        streamEpoch: grant.streamEpoch,
        grantDigest
      })
      const opened = await dispatchSignedRequest(runtime, {
        license,
        now,
        path: `/v1/speech/sessions/${created.sessionId}/tracks/microphone`,
        method: 'GET',
        body: descriptor,
        additionalHeaders: {
          upgrade: 'websocket',
          'x-metis-speech-descriptor': descriptor,
          'x-metis-speech-grant': grant.token
        }
      })
      expect(opened.status).toBe(101)
      const socket = (opened as unknown as Response & { webSocket?: WorkerdWebSocket }).webSocket
      expect(socket).toBeDefined()
      if (!socket) throw new Error('workerd did not return the Route B WebSocket')
      const events: Array<Record<string, unknown>> = []
      let timeout: ReturnType<typeof setTimeout>
      let terminalListener: (event: Event) => void
      const terminal = new Promise<Record<string, unknown>>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Route B terminal timed out')), 10_000)
        terminalListener = (event) => {
          const message = event as MessageEvent
          if (typeof message.data !== 'string') return
          let value: Record<string, unknown>
          try {
            value = JSON.parse(message.data) as Record<string, unknown>
          } catch {
            reject(new Error('Route B emitted an invalid protocol message'))
            return
          }
          if (value.type === 'transcript' && events.length < 8) {
            events.push({
              type: value.type,
              sequence: value.sequence,
              segmentIndex: value.segmentIndex,
              revision: value.revision,
              final: value.final
            })
          }
          if (value.type === 'terminal') resolve(value)
        }
        socket.addEventListener('message', terminalListener)
      })
      socket.accept()
      socket.send(new Uint8Array([0, 0]).buffer)
      socket.send('{"type":"finish"}')
      let terminalValue: Record<string, unknown>
      try {
        terminalValue = await terminal
      } finally {
        clearTimeout(timeout!)
        socket.removeEventListener('message', terminalListener!)
      }
      currentFixture.check()
      const gateway = (await runtime.getWorker('metis-synthetic-gateway')) as unknown as {
        fetch(input: string): Promise<Response>
      }
      const providerState = (await (await gateway.fetch('https://gateway.fixture/_fixture/state')).json()) as {
        inferenceCalls: number
        observedPath: string
        observedAuthorization: string
        observedGatewayAuthorization: string
        binaryFramesReceived: number
        closeStreamControlsReceived: number
        finalResultsSent: number
        metadataSent: number
        closeRequested: number
      }
      const diagnostic = await readRouteBLifecycleDiagnostic(
        database,
        created.sessionId,
        terminalValue,
        events,
        providerState
      )
      const terminalSummary = {
        type: terminalValue.type,
        reason: terminalValue.reason,
        tail: terminalValue.tail,
        closeConfirmed: terminalValue.closeConfirmed,
        lastSequence: terminalValue.lastSequence,
        captureGeneration: terminalValue.captureGeneration,
        track: terminalValue.track,
        streamEpoch: terminalValue.streamEpoch,
        sessionIdMatches: terminalValue.sessionId === created.sessionId
      }
      expect(terminalSummary, `Route B bounded lifecycle diagnostic: ${JSON.stringify(diagnostic)}`).toEqual({
        type: 'terminal',
        reason: 'normal',
        tail: 'complete',
        closeConfirmed: true,
        lastSequence: 2,
        captureGeneration,
        track: 'microphone',
        streamEpoch: grant.streamEpoch,
        sessionIdMatches: true
      })
      const diagnosticMessage = `Route B bounded lifecycle diagnostic: ${JSON.stringify(diagnostic)}`
      expect(events, diagnosticMessage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'transcript', sequence: 1, segmentIndex: 1, revision: 1, final: false }),
          expect.objectContaining({ type: 'transcript', sequence: 2, segmentIndex: 1, revision: 2, final: true })
        ])
      )
      expect(providerState.inferenceCalls).toBe(1)
      expect(
        {
          binaryFramesReceived: providerState.binaryFramesReceived,
          closeStreamControlsReceived: providerState.closeStreamControlsReceived,
          finalResultsSent: providerState.finalResultsSent,
          metadataSent: providerState.metadataSent,
          closeRequested: providerState.closeRequested
        },
        diagnosticMessage
      ).toEqual({
        binaryFramesReceived: 1,
        closeStreamControlsReceived: 1,
        finalResultsSent: 1,
        metadataSent: 1,
        closeRequested: 1
      })
      expect(
        /^\/v1\/account-test-001\/speech-gateway-test\/workers-ai\?model=%40cf%2Fdeepgram%2Fnova-3&language=en&encoding=linear16&sample_rate=16000&interim_results=true$/.test(
          providerState.observedPath
        )
      ).toBe(true)
      expect(providerState.observedAuthorization.length === 0).toBe(true)
      expect(providerState.observedGatewayAuthorization === `Bearer ${TEST_GATEWAY_TOKEN}`).toBe(true)
      const status = await dispatchSignedRequest(runtime, {
        license,
        now: Date.now(),
        path: `/v1/speech/sessions/${created.sessionId}/status`,
        method: 'POST',
        body: JSON.stringify({ operation: 'session-status', sessionId: created.sessionId })
      })
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        protocolVersion: 1,
        sessionId: created.sessionId,
        captureGeneration,
        tracks: [
          expect.objectContaining({
            track: 'microphone',
            streamEpoch: grant.streamEpoch,
            phase: 'closed',
            closeConfirmed: true,
            tail: 'complete',
            lastSequence: 2
          })
        ],
        cancellationRequested: false
      })
    })
  )
})
