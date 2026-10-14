import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertV4MiniflareOptions, Miniflare, type WebSocket as WorkerdWebSocket } from 'miniflare'
import { describe, expect, it } from 'vitest'
import { d1Store } from '../d1'
import { hmacHex } from '../hmac'
import { OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER, ingestCanonical } from '../../../src/shared/operator-hmac'
import { generateOperatorLicense } from '../../../src/shared/operator-license'
import { sha256Hex } from '../crypto'

// The existing repository bundle checker is the canonical deploy-equivalent esbuild path.
import { bundleEntry } from '../../scripts/check-worker-bundle.mjs'

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
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_fixture/state') {
      return Response.json({ inferenceCalls, observedPath, observedAuthorization, observedGatewayAuthorization });
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
          server.send(${JSON.stringify(FINAL_PROVIDER_FRAME)});
          server.send(JSON.stringify({ type: 'Metadata', request_id: 'fixture-request' }));
          server.close(1000, 'fixture complete');
        }
        return;
      }
      server.send(${JSON.stringify(PARTIAL_PROVIDER_FRAME)});
    });
    return new Response(null, { status: 101, webSocket: client });
  }
};
`

async function makeRuntime(routeId: 'deepgram-via-gateway' | 'workers-ai-nova3' = 'deepgram-via-gateway') {
  const route = routeId === 'deepgram-via-gateway' ? ROUTE_A : ROUTE_B
  const modelId = route.modelId
  const operatorBundle = await bundleEntry()
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
  const database = (await runtime.getD1Database('DB')) as unknown as {
    exec(sql: string): Promise<unknown>
    prepare(query: string): {
      bind(...values: unknown[]): { run(): Promise<unknown> }
    }
  }
  const directory = dirname(fileURLToPath(import.meta.url))
  await database.exec(readFileSync(join(directory, '../../schema.sql'), 'utf8'))
  const store = d1Store(database as never)
  const now = Date.now()
  await store.putTier({
    id: 'metis',
    label: 'Métis',
    entitlements_json: JSON.stringify(['listen', 'operator_keys']),
    updated_at: now
  })
  const license = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 7, now, jti: LICENSE_JTI })
  await store.putIssuedLicense({
    ...license.claims,
    last4: license.last4,
    key_hash: await sha256Hex(license.token),
    days: 7,
    revoked: 0,
    created_at: now,
    created_by: 'fixture-reviewer',
    tier: 'metis',
    activated_device: DEVICE,
    activated_at: now
  })
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
  }
  const refs = ['gateway-readback', 'provider-retention', 'synthetic-sink-test', 'relay-runtime-test'].map((kind) => ({
    kind,
    reference: `fixture:${kind}`,
    digest: `sha256:${'a'.repeat(64)}`,
    outcome: 'passed'
  }))
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
  return { runtime, database, now, license: license.token, routeId, modelId }
}

async function signedRequest(input: {
  license: string
  now: number
  path: string
  method: 'POST' | 'GET'
  body?: string
  additionalHeaders?: Record<string, string>
}): Promise<Request> {
  const bodyText = input.body ?? ''
  const timestamp = String(input.now)
  const nonce = crypto.randomUUID()
  const signature = await hmacHex(input.license, ingestCanonical(timestamp, nonce, DEVICE, await sha256Hex(bodyText)))
  return new Request(`https://operator.fixture${input.path}`, {
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
  })
}

describe('speech relay on pinned hosted workerd', () => {
  it('runs licensed create, actual Upgrade, binary forwarding, final drain and status without provider calls', async () => {
    const { runtime, now, license } = await makeRuntime()
    try {
      const unauthenticated = await runtime.dispatchFetch('https://operator.fixture/v1/speech/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'create-session' })
      })
      expect(unauthenticated.status).toBe(401)
      const gateway = (await runtime.getWorker('metis-synthetic-gateway')) as unknown as {
        fetch(input: string): Promise<Response>
      }
      expect(await (await gateway.fetch('https://gateway.fixture/_fixture/state')).json()).toMatchObject({
        inferenceCalls: 0
      })

      const capabilityBody = JSON.stringify(PROTOCOL_FIXTURE.capability.request)
      const capability = await runtime.dispatchFetch(
        (await signedRequest({
          license,
          now,
          path: '/v1/speech/capability',
          method: 'POST',
          body: capabilityBody
        })) as never
      )
      expect(capability.status).toBe(200)
      const capabilityResponse = (await capability.json()) as Record<string, unknown>
      expect(capabilityResponse).toMatchObject({
        ...PROTOCOL_FIXTURE.capability.readyResponse,
        validUntil: expect.any(Number)
      })
      expect(Number(capabilityResponse.validUntil)).toBeGreaterThan(now)

      const captureGeneration = PROTOCOL_FIXTURE.create.request.captureGeneration
      const createTemplate = PROTOCOL_FIXTURE.create.request
      const createBody = JSON.stringify({
        ...createTemplate,
        tracks: ['microphone'],
        consent: {
          ...createTemplate.consent,
          tracks: ['microphone'],
          issuedAt: now,
          expiresAt: now + 60_000
        }
      })
      const createdResponse = await runtime.dispatchFetch(
        (await signedRequest({ license, now, path: '/v1/speech/sessions', method: 'POST', body: createBody })) as never
      )
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
        limits: Record<string, number>
        grants: Array<{ track: 'microphone' | 'system'; token: string; streamEpoch: number }>
      }
      expect(created.protocolVersion).toBe(1)
      expect(created).toMatchObject({
        routeId: ROUTE_A.routeId,
        model: ROUTE_A.modelId,
        configVersion: ROUTE_A.configVersion,
        policyVersion: ROUTE_A.policyVersion,
        language: ROUTE_A.language,
        captureGeneration,
        limits: PROTOCOL_FIXTURE.limits
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
      const opened = await runtime.dispatchFetch(
        (await signedRequest({
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
        })) as never
      )
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
      expect(providerState).toMatchObject({
        inferenceCalls: 1,
        observedPath:
          '/v1/account-test-001/speech-gateway-test/deepgram/v1/listen?model=nova-3&language=multi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&mip_opt_out=true',
        observedAuthorization: `Token ${TEST_DEEPGRAM_KEY}`,
        observedGatewayAuthorization: `Bearer ${TEST_GATEWAY_TOKEN}`
      })
      const statusBody = JSON.stringify({ ...PROTOCOL_FIXTURE.status.request, sessionId: created.sessionId })
      const status = await runtime.dispatchFetch(
        (await signedRequest({
          license,
          now: Date.now(),
          path: `/v1/speech/sessions/${created.sessionId}/status`,
          method: 'POST',
          body: statusBody
        })) as never
      )
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
      const nextResponse = await runtime.dispatchFetch(
        (await signedRequest({
          license,
          now: nextNow,
          path: '/v1/speech/sessions',
          method: 'POST',
          body: secondRequest
        })) as never
      )
      expect(nextResponse.status).toBe(200)
      const nextSession = (await nextResponse.json()) as {
        sessionId: string
        grants: Array<{ track: 'microphone'; streamEpoch: number }>
      }
      expect(nextSession.grants[0]?.streamEpoch).toBe(PROTOCOL_FIXTURE.epochProgression.sessions[1]?.streamEpoch)
      const cancelBody = JSON.stringify({ ...PROTOCOL_FIXTURE.cancel.request, sessionId: nextSession.sessionId })
      const cancelled = await runtime.dispatchFetch(
        (await signedRequest({
          license,
          now: Date.now(),
          path: `/v1/speech/sessions/${nextSession.sessionId}/cancel`,
          method: 'POST',
          body: cancelBody
        })) as never
      )
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({
        protocolVersion: 1,
        sessionId: nextSession.sessionId,
        cancelled: true,
        cancellationRequested: false
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('uses the distinct documented Workers AI Route B URL without Deepgram credentials', async () => {
    const { runtime, now, license } = await makeRuntime('workers-ai-nova3')
    try {
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
      const createdResponse = await runtime.dispatchFetch(
        (await signedRequest({ license, now, path: '/v1/speech/sessions', method: 'POST', body: createBody })) as never
      )
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
      const opened = await runtime.dispatchFetch(
        (await signedRequest({
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
        })) as never
      )
      expect(opened.status).toBe(101)
      const socket = (opened as unknown as Response & { webSocket?: WorkerdWebSocket }).webSocket
      expect(socket).toBeDefined()
      if (!socket) throw new Error('workerd did not return the Route B WebSocket')
      const terminal = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Route B terminal timed out')), 10_000)
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return
          const value = JSON.parse(event.data) as { type?: string; tail?: string }
          if (value.type === 'terminal') {
            clearTimeout(timeout)
            expect(value.tail).toBe('complete')
            resolve()
          }
        })
      })
      socket.accept()
      socket.send(new Uint8Array([0, 0]).buffer)
      socket.send('{"type":"finish"}')
      await terminal
      const gateway = (await runtime.getWorker('metis-synthetic-gateway')) as unknown as {
        fetch(input: string): Promise<Response>
      }
      const providerState = (await (await gateway.fetch('https://gateway.fixture/_fixture/state')).json()) as {
        inferenceCalls: number
        observedPath: string
        observedAuthorization: string
        observedGatewayAuthorization: string
      }
      expect(providerState.inferenceCalls).toBe(1)
      expect(providerState.observedPath).toMatch(
        /^\/v1\/account-test-001\/speech-gateway-test\/workers-ai\?model=%40cf%2Fdeepgram%2Fnova-3&language=en&encoding=linear16&sample_rate=16000&interim_results=true$/
      )
      expect(providerState.observedAuthorization).toBe('')
      expect(providerState.observedGatewayAuthorization).toBe(`Bearer ${TEST_GATEWAY_TOKEN}`)
    } finally {
      await runtime.dispose()
    }
  })
})
