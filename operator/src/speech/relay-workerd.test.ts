import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Miniflare, type WebSocket as WorkerdWebSocket } from 'miniflare'
import { describe, expect, it } from 'vitest'
import { d1Store } from '../d1'
import { hmacHex } from '../hmac'
import { OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER, ingestCanonical } from '../../../src/shared/operator-hmac'
import { generateOperatorLicense } from '../../../src/shared/operator-license'
import { sha256Hex } from '../crypto'

// The existing repository bundle checker is the canonical deploy-equivalent esbuild path.
import { bundleEntry } from '../../scripts/check-worker-bundle.mjs'

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
const POLICY_VERSION = 'runtime-policy-v1'
const CONFIG_VERSION = 'runtime-config-v1'
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
          server.send(JSON.stringify({ type: 'Metadata', request_id: 'fixture-request' }));
          server.close(1000, 'fixture complete');
        }
        return;
      }
      server.send(JSON.stringify({ type: 'Results', start: 0, duration: 0.1, is_final: true,
        channel: { alternatives: [{ transcript: 'fixture transcript', words: [
          { word: 'fixture', start: 0, end: 0.05, speaker: 0 }
        ] }] }, languages: ['en'] }));
    });
    return new Response(null, { status: 101, webSocket: client });
  }
};
`

async function makeRuntime(routeId: 'deepgram-via-gateway' | 'workers-ai-nova3' = 'deepgram-via-gateway') {
  const modelId = routeId === 'deepgram-via-gateway' ? 'nova-3' : '@cf/deepgram/nova-3'
  const operatorBundle = await bundleEntry()
  const runtime = new Miniflare({
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
          SPEECH_POLICY_VERSION: POLICY_VERSION,
          SPEECH_ROUTE_ID: routeId,
          SPEECH_MODEL_ID: modelId,
          SPEECH_CONFIG_VERSION: CONFIG_VERSION,
          SPEECH_ALLOWED_LANGUAGES: 'multi,en,fr',
          SPEECH_MAX_CONCURRENT_SESSIONS: '2',
          SPEECH_MAX_CONCURRENT_TRACKS: '4',
          SPEECH_BUDGET_WINDOW_MS: '60000',
          SPEECH_BUDGET_MAX_MS: '60000',
          SPEECH_MAX_SESSION_MS: '30000',
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
      CONFIG_VERSION,
      POLICY_VERSION,
      IMPLEMENTATION_REVISION,
      'reviewer@example.invalid',
      'reviewer@example.invalid',
      JSON.stringify(refs),
      now + 60_000,
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

      const createBody = JSON.stringify({
        operation: 'create-session',
        captureGeneration: 3,
        tracks: ['microphone'],
        language: 'multi',
        consent: {
          accepted: true,
          captureGeneration: 3,
          tracks: ['microphone'],
          issuedAt: now,
          expiresAt: now + 30_000
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
        grants: Array<{ track: 'microphone' | 'system'; token: string; streamEpoch: number }>
      }
      expect(created.protocolVersion).toBe(1)
      expect(created.captureGeneration).toBe(3)
      expect(created.grants).toHaveLength(1)
      const grant = created.grants[0]
      expect(grant).toBeDefined()
      if (!grant) throw new Error('fixture expected one grant')

      const descriptor = JSON.stringify({
        operation: 'open-track',
        sessionId: created.sessionId,
        track: grant.track,
        captureGeneration: created.captureGeneration,
        streamEpoch: grant.streamEpoch,
        grantDigest: await sha256Hex(grant.token)
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
          expect.objectContaining({
            type: 'transcript',
            protocolVersion: 1,
            sessionId: created.sessionId,
            captureGeneration: 3,
            track: 'microphone',
            streamEpoch: grant.streamEpoch,
            sequence: 1,
            text: 'fixture transcript',
            languages: ['en']
          }),
          expect.objectContaining({
            type: 'terminal',
            protocolVersion: 1,
            sessionId: created.sessionId,
            closeConfirmed: true,
            tail: 'complete',
            lastSequence: 1
          })
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
      const statusBody = JSON.stringify({ operation: 'session-status', sessionId: created.sessionId })
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
        tracks: [
          expect.objectContaining({
            track: 'microphone',
            streamEpoch: grant.streamEpoch,
            phase: 'closed',
            closeConfirmed: true,
            tail: 'complete',
            lastSequence: 1
          })
        ]
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('uses the distinct documented Workers AI Route B URL without Deepgram credentials', async () => {
    const { runtime, now, license } = await makeRuntime('workers-ai-nova3')
    try {
      const createBody = JSON.stringify({
        operation: 'create-session',
        captureGeneration: 4,
        tracks: ['microphone'],
        language: 'en',
        consent: {
          accepted: true,
          captureGeneration: 4,
          tracks: ['microphone'],
          issuedAt: now,
          expiresAt: now + 30_000
        }
      })
      const createdResponse = await runtime.dispatchFetch(
        (await signedRequest({ license, now, path: '/v1/speech/sessions', method: 'POST', body: createBody })) as never
      )
      expect(createdResponse.status).toBe(200)
      const created = (await createdResponse.json()) as {
        sessionId: string
        captureGeneration: number
        grants: Array<{ track: 'microphone'; token: string; streamEpoch: number }>
      }
      const grant = created.grants[0]
      if (!grant) throw new Error('fixture expected one Route B grant')
      const descriptor = JSON.stringify({
        operation: 'open-track',
        sessionId: created.sessionId,
        track: grant.track,
        captureGeneration: created.captureGeneration,
        streamEpoch: grant.streamEpoch,
        grantDigest: await sha256Hex(grant.token)
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
