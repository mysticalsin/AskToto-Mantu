import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SpeechBrokerClient, type SpeechCreateRequest } from './broker-client'
import { RelaySpeechSession } from './relay-session'

const fixture = JSON.parse(readFileSync('scripts/qa/fixtures/speech-relay-protocol-v1.json', 'utf8')) as {
  create: { request: Record<string, unknown>; responseTemplate: Record<string, unknown> }
}
const sessionId = '00000000-0000-4000-8000-000000000101'

function singleTrackCreateRequest(): SpeechCreateRequest {
  const request = fixture.create.request as unknown as SpeechCreateRequest
  return {
    ...request,
    tracks: ['microphone'],
    consent: { ...request.consent, tracks: ['microphone'] }
  }
}

class MockRelaySocket extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static instances: MockRelaySocket[] = []
  readyState = MockRelaySocket.CONNECTING
  bufferedAmount = 0
  sent: unknown[] = []
  onFinish?: () => void
  holdBinarySend = false
  failFinishSend = false
  terminated = false

  constructor(url: string, options: unknown, onFinish?: () => void) {
    super()
    this.url = url
    this.options = options
    this.onFinish = onFinish
    MockRelaySocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = MockRelaySocket.OPEN
      this.emit('open')
    })
  }

  url: string
  options: unknown

  send(data: unknown, _options: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data)
    if (data instanceof Uint8Array && this.holdBinarySend) return
    if (data === '{"type":"finish"}' && this.failFinishSend) {
      callback?.(new Error('synthetic finish send failure'))
      return
    }
    if (data === '{"type":"finish"}') this.onFinish?.()
    callback?.()
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  terminate(): void {
    this.terminated = true
    this.close()
  }

  emitTerminal(lastSequence = 0): void {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'terminal',
          protocolVersion: 1,
          sessionId,
          captureGeneration: 7,
          track: 'microphone',
          streamEpoch: 11,
          lastSequence,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        })
      ),
      false
    )
  }
}

function makeClient(): SpeechBrokerClient {
  const response = {
    ...fixture.create.responseTemplate,
    grants: [{ track: 'microphone', streamEpoch: 11, token: 'B'.repeat(43) }]
  }
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  )
  const WebSocketImpl = class extends MockRelaySocket {
    constructor(url: string, options: unknown) {
      super(url, options, () => queueMicrotask(() => this.emitTerminal()))
    }
  }
  return new SpeechBrokerClient({
    operatorUrl: 'https://operator.example',
    operatorLicenseToken: 'METIS-OP-1.0123456789abcdef.1893455000.1893457000.AAAAAAAAAAAAAAAAAAAA',
    deviceIdHash: '0123456789abcdef0123456789abcdef',
    fetchImpl: fetchImpl as typeof fetch,
    WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
    now: () => 1_893_456_000_000
  })
}

describe('RelaySpeechSession', () => {
  it('cancels a create allocation before opening when capability selection changed', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3', language: 'en' }
    })
    expect(started).toEqual({ ok: false, code: 'SCHEMA' })
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('cancels an allocation that no longer belongs to the active capture owner', async () => {
    MockRelaySocket.instances = []
    let allocatedSessionId: string | null = null
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      isCurrent: () => false,
      onAllocated: (id) => {
        allocatedSessionId = id
      }
    })
    expect(started).toEqual({ ok: false, code: 'CANCELLED' })
    expect(allocatedSessionId).toBe(sessionId)
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('orders admitted PCM before the finish marker and waits for confirmed terminal closure', async () => {
    MockRelaySocket.instances = []
    const client = makeClient()
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.identity.limits).toMatchObject({
      maxStreamMs: 60_000,
      drainWindowMs: 5_000,
      maxInputBytesPerTrack: 1_920_000,
      maxClientFrameBytes: 3_200,
      maxOutputBytesPerTrack: 1_048_576
    })
    expect(
      started.value.pushFrame('microphone', { sequence: 1, sampleOffset: 0, pcm16le: new Uint8Array(3_200) })
    ).toEqual({
      ok: true
    })

    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(true)
    expect(stopped.tracks).toMatchObject([
      { track: 'microphone', streamEpoch: 11, closeConfirmed: true, tail: 'complete', lastSequence: 0 }
    ])
    expect(MockRelaySocket.instances[0].sent[0]).toBeInstanceOf(Uint8Array)
    expect(MockRelaySocket.instances[0].sent[1]).toBe('{"type":"finish"}')
  })

  it('reports incomplete when no terminal event arrives before the bounded finish deadline', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    MockRelaySocket.instances[0].onFinish = undefined
    const stopped = await started.value.finish(50)
    expect(stopped.complete).toBe(false)
    expect(stopped.tracks[0]).toMatchObject({ closeConfirmed: false, tail: 'incomplete' })
  })

  it('keeps the entire finish path within its deadline when a PCM send acknowledgement hangs', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    MockRelaySocket.instances[0].holdBinarySend = true
    started.value.pushFrame('microphone', { sequence: 1, sampleOffset: 0, pcm16le: new Uint8Array(3_200) })

    const start = Date.now()
    const stopped = await started.value.finish(50)
    expect(Date.now() - start).toBeLessThan(500)
    expect(stopped).toMatchObject({ complete: false, reason: 'incomplete' })
  })

  it('serializes renewals from one predecessor and preserves the exact frontier', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const request = singleTrackCreateRequest()
    const first = started.value.renew(request)
    const second = started.value.renew(request)
    expect(second).toBe(first)
    expect(await first).toEqual({ ok: false, code: 'SCHEMA' })
    expect(MockRelaySocket.instances).toHaveLength(1)
  })

  it('keeps close confirmation but reports an incomplete tail when a segment never becomes final', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const socket = MockRelaySocket.instances[0]
    socket.onFinish = () =>
      queueMicrotask(() => {
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'transcript',
              protocolVersion: 1,
              sessionId,
              captureGeneration: 7,
              track: 'microphone',
              streamEpoch: 11,
              sequence: 1,
              segmentIndex: 1,
              revision: 1,
              text: 'interim',
              startMs: 0,
              endMs: 100,
              final: false
            })
          ),
          false
        )
        socket.emitTerminal(1)
      })
    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(false)
    expect(stopped.tracks[0]).toMatchObject({ closeConfirmed: true, tail: 'incomplete', lastSequence: 1 })
  })

  it('terminates locally when the finish marker send fails and retains cancellation inventory', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    MockRelaySocket.instances[0].failFinishSend = true
    const stopped = await started.value.finish(500)
    expect(stopped).toMatchObject({ complete: false, tracks: [{ tail: 'incomplete' }] })
    expect(MockRelaySocket.instances[0].terminated).toBe(true)
  })

  it('accepts a nonzero first capture origin and rejects replay after transport rebasing', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(
      started.value.pushFrame('microphone', {
        sequence: 1,
        sampleOffset: 12_800,
        pcm16le: new Uint8Array(3_200)
      })
    ).toEqual({ ok: true })
    expect(
      started.value.pushFrame('microphone', {
        sequence: 1,
        sampleOffset: 0,
        pcm16le: new Uint8Array(3_200)
      })
    ).toEqual({ ok: false, code: 'ORDER' })
    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(true)
    expect(MockRelaySocket.instances[0].sent[0]).toBeInstanceOf(Uint8Array)
    expect(MockRelaySocket.instances[0].sent[1]).toBe('{"type":"finish"}')
  })

  it('stops admission immediately when its owner predicate becomes stale', async () => {
    MockRelaySocket.instances = []
    let current = true
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      isCurrent: () => current
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    current = false
    expect(
      started.value.pushFrame('microphone', { sequence: 1, sampleOffset: 2_400, pcm16le: new Uint8Array(3_200) })
    ).toEqual({ ok: false, code: 'CLOSED' })
    await started.value.cancel()
    const stopped = await started.value.finish()
    expect(stopped).toMatchObject({ complete: false, tracks: [{ closeConfirmed: false, tail: 'incomplete' }] })
    expect(MockRelaySocket.instances[0].sent).toHaveLength(0)
  })
})
