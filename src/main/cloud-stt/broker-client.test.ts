import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SpeechBrokerClient, normalizeSpeechOperatorOrigin, type SpeechCreateRequest } from './broker-client'

const fixture = JSON.parse(readFileSync('scripts/qa/fixtures/speech-relay-protocol-v1.json', 'utf8')) as {
  capability: { readyResponse: unknown }
  create: { request: unknown; responseTemplate: Record<string, unknown> }
  upgrade: { descriptorTemplate: Record<string, unknown> }
}

const settings = {
  operatorUrl: 'https://operator.example',
  operatorLicenseToken: 'METIS-OP-1.0123456789abcdef.1893455000.1893457000.AAAAAAAAAAAAAAAAAAAA',
  deviceIdHash: '0123456789abcdef0123456789abcdef'
}

class MockWebSocket extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  readyState = MockWebSocket.CONNECTING
  static instances: Array<{ url: string; options: unknown }> = []

  constructor(url: string, options: unknown) {
    super()
    MockWebSocket.instances.push({ url, options })
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.emit('open')
    })
  }
}

describe('speech broker client', () => {
  it('pins only a clean HTTPS Operator origin', () => {
    expect(normalizeSpeechOperatorOrigin('https://operator.example/')).toBe('https://operator.example')
    expect(normalizeSpeechOperatorOrigin('http://operator.example')).toBeNull()
    expect(normalizeSpeechOperatorOrigin('https://user:pass@operator.example')).toBeNull()
    expect(normalizeSpeechOperatorOrigin('https://operator.example/v1')).toBeNull()
    expect(normalizeSpeechOperatorOrigin('https://operator.example/?route=a')).toBeNull()
  })

  it('signs the exact capability body and validates the closed response schema', async () => {
    const fetchImpl = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ operation: 'speech-capability' }))
      expect(new Headers(init?.headers).get('x-metis-license')).toBe(settings.operatorLicenseToken)
      return new Response(JSON.stringify(fixture.capability.readyResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_893_456_000_000
    })

    const result = await client.capability()
    expect(result).toMatchObject({
      ok: true,
      value: {
        ready: true,
        protocolVersion: 1,
        configVersion: 'fixture-config-a-v1',
        policyVersion: 'fixture-policy-a-v1'
      }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requires bounded route configuration and policy versions in a ready capability', async () => {
    const ready = fixture.capability.readyResponse as Record<string, unknown>
    const responses: Record<string, unknown>[] = []
    for (const field of ['configVersion', 'policyVersion']) {
      const response = { ...ready }
      delete response[field]
      responses.push(response)
    }
    responses.push({ ...ready, configVersion: 'invalid version' }, { ...ready, policyVersion: '' })

    for (const response of responses) {
      const client = new SpeechBrokerClient({
        ...settings,
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify(response), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
        ) as typeof fetch,
        now: () => 1_893_456_000_000
      })

      expect(await client.capability()).toEqual({ ok: false, code: 'SCHEMA' })
    }
  })

  it('does not retry an ambiguous create and rejects unbounded redirect/HTML responses', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('private transport detail')
    })
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_893_456_000_000
    })
    expect(await client.createSession(fixture.create.request)).toMatchObject({ ok: false, code: 'TRANSPORT' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const redirect = new SpeechBrokerClient({
      ...settings,
      fetchImpl: vi.fn(
        async () => new Response('must not follow', { status: 302, headers: { location: 'https://elsewhere.example' } })
      ) as typeof fetch,
      now: () => 1_893_456_000_000
    })
    expect(await redirect.capability()).toMatchObject({ ok: false, code: 'RESPONSE' })
  })

  it('propagates the owner signal and absolute deadline to create without starting an already-expired allocation', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | null = null
    const fetchImpl = vi.fn((_input: Request | URL | string, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_893_456_000_000,
      monotonicNow: () => 1_000
    })
    const pending = client.createSession(fixture.create.request, { signal: controller.signal, deadlineAt: 2_000 })
    expect(observedSignal).toBeDefined()
    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, code: 'CANCELLED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const expiredFetch = vi.fn()
    const expired = new SpeechBrokerClient({
      ...settings,
      fetchImpl: expiredFetch as typeof fetch,
      now: () => 1_893_456_000_000,
      monotonicNow: () => 2_000
    })
    await expect(expired.createSession(fixture.create.request, { deadlineAt: 2_000 })).resolves.toEqual({
      ok: false,
      code: 'TIMEOUT'
    })
    expect(expiredFetch).not.toHaveBeenCalled()
  })

  it('aborts and terminates a pending WebSocket open at the owner deadline', async () => {
    const response = {
      ...fixture.create.responseTemplate,
      grants: [{ track: 'microphone', streamEpoch: 11, token: 'A'.repeat(43) }]
    }
    const sockets: Array<MockWebSocket> = []
    class PendingWebSocket extends EventEmitter {
      static OPEN = 1
      static CONNECTING = 0
      readyState = PendingWebSocket.CONNECTING
      constructor(_url: string, _options: unknown) {
        super()
        sockets.push(this as unknown as MockWebSocket)
      }
      terminate(): void {
        this.readyState = 3
      }
    }
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
      ) as typeof fetch,
      WebSocketImpl: PendingWebSocket as unknown as typeof WebSocket,
      now: () => 1_893_456_000_000,
      monotonicNow: () => 1_000
    })
    const created = await client.createSession({
      ...(fixture.create.request as Record<string, unknown>),
      tracks: ['microphone'],
      consent: {
        ...((fixture.create.request as Record<string, unknown>).consent as Record<string, unknown>),
        tracks: ['microphone']
      }
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const controller = new AbortController()
    const opened = client.openTrack(created.value, 'microphone', undefined, {
      signal: controller.signal,
      deadlineAt: 2_000
    })
    controller.abort()
    await expect(opened).resolves.toEqual({ ok: false, code: 'CANCELLED' })
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.readyState).toBe(3)
  })

  it('keeps owner-scoped status available when the seat token has expired', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    )
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_900_000_000_000
    })
    await client.status('00000000-0000-4000-8000-000000000101')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await client.capability()).toMatchObject({ ok: false, code: 'CONFIG' })
  })

  it('keeps the opaque grant out of the WebSocket URL and signs the canonical descriptor', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000101'
    const response = {
      ...fixture.create.responseTemplate,
      grants: [{ track: 'microphone', streamEpoch: 11, token: 'A'.repeat(43) }]
    }
    const client = new SpeechBrokerClient({
      ...settings,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
      ) as typeof fetch,
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      now: () => 1_893_456_000_000
    })
    const createRequest = fixture.create.request as SpeechCreateRequest
    const singleTrackRequest = {
      ...createRequest,
      tracks: ['microphone'],
      consent: { ...createRequest.consent, tracks: ['microphone'] }
    }
    const created = await client.createSession(singleTrackRequest)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.sessionId).toBe(sessionId)

    let listenersInstalledBeforeOpenResolved = false
    const opened = await client.openTrack(created.value, 'microphone', (socket) => {
      listenersInstalledBeforeOpenResolved = socket.listenerCount('error') > 0
      socket.on('message', () => undefined)
    })
    expect(opened.ok).toBe(true)
    expect(listenersInstalledBeforeOpenResolved).toBe(true)
    const socket = MockWebSocket.instances.at(-1)!
    const url = new URL(socket.url)
    const options = socket.options as { headers: Record<string, string>; followRedirects: boolean; maxPayload: number }
    const grantDigest = createHash('sha256').update('A'.repeat(43), 'utf8').digest('hex')
    const expectedDescriptor = JSON.stringify({
      ...fixture.upgrade.descriptorTemplate,
      grantDigest
    })
    expect(url.protocol).toBe('wss:')
    expect(url.search).toBe('')
    expect(socket.url).not.toContain('A'.repeat(43))
    expect(options.headers['x-metis-speech-grant']).toBe('A'.repeat(43))
    expect(options.headers['x-metis-speech-descriptor']).toBe(expectedDescriptor)
    expect(options.headers['x-metis-speech-grant']).not.toBe(url.searchParams.get('grant'))
    expect(options.followRedirects).toBe(false)
    expect(options.maxPayload).toBe(65_536)
  })
})
