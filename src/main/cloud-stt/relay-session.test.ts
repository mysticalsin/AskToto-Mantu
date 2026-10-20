import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SpeechBrokerClient, type SpeechCreateRequest, type SpeechTrack } from './broker-client'
import { RelaySpeechSession } from './relay-session'

const fixture = JSON.parse(readFileSync('scripts/qa/fixtures/speech-relay-protocol-v1.json', 'utf8')) as {
  create: { request: Record<string, unknown>; responseTemplate: Record<string, unknown> }
}
const sessionId = '00000000-0000-4000-8000-000000000101'
const expectedCapability = { configVersion: 'fixture-config-a-v1', policyVersion: 'fixture-policy-a-v1' }

function createRequestForTracks(tracks: SpeechTrack[]): SpeechCreateRequest {
  const request = fixture.create.request as unknown as SpeechCreateRequest
  return {
    ...request,
    tracks,
    consent: { ...request.consent, tracks }
  }
}

function singleTrackCreateRequest(): SpeechCreateRequest {
  return createRequestForTracks(['microphone'])
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
    const open = (): void => {
      this.readyState = MockRelaySocket.OPEN
      this.emit('open')
    }
    if (url.includes('/tracks/system')) setTimeout(open, 50)
    else queueMicrotask(open)
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
    const pathParts = new URL(this.url).pathname.split('/')
    const descriptorText = (this.options as { headers?: Record<string, string> }).headers?.['x-metis-speech-descriptor']
    const descriptor = descriptorText ? (JSON.parse(descriptorText) as Record<string, unknown>) : {}
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'terminal',
          protocolVersion: 1,
          sessionId: pathParts[4] ?? sessionId,
          captureGeneration: descriptor.captureGeneration ?? 7,
          track: descriptor.track ?? 'microphone',
          streamEpoch: descriptor.streamEpoch ?? 11,
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

function makeClient(
  afterCreate?: () => void,
  tracks: SpeechTrack[] = ['microphone'],
  versions: { configVersion?: string; policyVersion?: string } = {},
  advanceEpochOnSuccessor = false,
  echoLanguage = false
): SpeechBrokerClient {
  const response = {
    ...fixture.create.responseTemplate,
    ...versions,
    grants: tracks.map((track, index) => ({ track, streamEpoch: 11 + index, token: 'B'.repeat(43) }))
  }
  let createCount = 0
  const fetchImpl = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
    afterCreate?.()
    let result: Record<string, unknown> = response
    try {
      const request = JSON.parse(String(init?.body)) as { operation?: string; language?: string }
      if (request.operation === 'create-session') {
        createCount += 1
        if (advanceEpochOnSuccessor && createCount > 1) {
          result = {
            ...response,
            sessionId: '00000000-0000-4000-8000-000000000102',
            grants: tracks.map((track, index) => ({ track, streamEpoch: 16 + index, token: 'B'.repeat(43) }))
          }
        }
        if (echoLanguage && request.language) result = { ...result, language: request.language }
      }
    } catch {
      /* non-create operation keeps the safe fixed response fixture */
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  })
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
    now: () => 1_893_456_000_100
  })
}

describe('RelaySpeechSession', () => {
  it('cancels a create allocation before opening when capability selection changed', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3', language: 'en' },
      expectedCapability
    })
    expect(started).toEqual({ ok: false, code: 'SCHEMA' })
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('cancels a create allocation before opening when capability versions changed', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone'], { configVersion: 'fixture-config-a-v2' })
    const cancel = vi.spyOn(client, 'cancel')
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started).toEqual({ ok: false, code: 'SCHEMA' })
    expect(cancel).toHaveBeenCalledWith(sessionId, 1_000)
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('cancels a create allocation before opening when the speech policy version changed', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone'], { policyVersion: 'fixture-policy-a-v2' })
    const cancel = vi.spyOn(client, 'cancel')
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started).toEqual({ ok: false, code: 'SCHEMA' })
    expect(cancel).toHaveBeenCalledWith(sessionId, 1_000)
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('cancels an allocation that no longer belongs to the active capture owner', async () => {
    MockRelaySocket.instances = []
    let allocatedSessionId: string | null = null
    let current = true
    const started = await RelaySpeechSession.create({
      client: makeClient(() => {
        current = false
      }),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability,
      isCurrent: () => current,
      onAllocated: (id) => {
        allocatedSessionId = id
      }
    })
    expect(started).toEqual({ ok: false, code: 'CANCELLED' })
    expect(allocatedSessionId).toBe(sessionId)
    expect(MockRelaySocket.instances).toHaveLength(0)
  })

  it('terminates a late second track when the first socket closes during startup', async () => {
    MockRelaySocket.instances = []
    const starting = RelaySpeechSession.create({
      client: makeClient(undefined, ['microphone', 'system']),
      createRequest: createRequestForTracks(['microphone', 'system']),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(MockRelaySocket.instances).toHaveLength(2)
    MockRelaySocket.instances[0].close()
    const started = await starting
    expect(started).toEqual({ ok: false, code: 'TRACK_OPEN' })
    expect(MockRelaySocket.instances[1].readyState).toBe(3)
    expect(MockRelaySocket.instances[1].terminated).toBe(true)
  })

  it('orders admitted PCM before the finish marker and waits for confirmed terminal closure', async () => {
    MockRelaySocket.instances = []
    const client = makeClient()
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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
    const client = makeClient(undefined, ['microphone'], {}, true)
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const request = singleTrackCreateRequest()
    request.consent.issuedAt += 10
    request.consent.expiresAt += 10
    const first = started.value.renew(request)
    const second = started.value.renew(request)
    expect(second).toBe(first)
    const renewed = await first
    expect(renewed.ok).toBe(true)
    expect(MockRelaySocket.instances[0]?.sent).toContain('{"type":"finish"}')
    expect(MockRelaySocket.instances).toHaveLength(2)
    if (renewed.ok) await renewed.value.cancel()
  })

  it('renews into a new language when the broker allocates that language', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone'], {}, true, true)
    const started = await RelaySpeechSession.create({
      client,
      createRequest: { ...singleTrackCreateRequest(), language: 'multi' },
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.identity.language).toBe('multi')
    const request = { ...singleTrackCreateRequest(), language: 'fr' }
    request.consent = {
      ...request.consent,
      issuedAt: request.consent.issuedAt + 10,
      expiresAt: request.consent.expiresAt + 10
    }
    const renewed = await started.value.renew(request)
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    expect(renewed.value.identity.language).toBe('fr')
    expect(MockRelaySocket.instances[0]?.sent).toContain('{"type":"finish"}')
    await renewed.value.cancel()
  })

  it('refuses a language renewal the broker did not honor', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone'], {}, true, false)
    const started = await RelaySpeechSession.create({
      client,
      createRequest: { ...singleTrackCreateRequest(), language: 'multi' },
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const request = { ...singleTrackCreateRequest(), language: 'fr' }
    request.consent = {
      ...request.consent,
      issuedAt: request.consent.issuedAt + 10,
      expiresAt: request.consent.expiresAt + 10
    }
    const renewed = await started.value.renew(request)
    expect(renewed.ok).toBe(false)
  })

  it('rejects a renewal with stale consent before finishing or allocating', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone'], {}, true)
    const createSession = vi.spyOn(client, 'createSession')
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await expect(started.value.renew(singleTrackCreateRequest())).resolves.toEqual({ ok: false, code: 'SCHEMA' })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(MockRelaySocket.instances[0]?.sent).toEqual([])
    await started.value.cancel()
  })

  it('uses one absolute owner deadline for all tracks and accepts only a higher server-issued successor epoch', async () => {
    MockRelaySocket.instances = []
    const client = makeClient(undefined, ['microphone', 'system'], {}, true)
    const createSession = vi.spyOn(client, 'createSession')
    const openTrack = vi.spyOn(client, 'openTrack')
    const operation = { signal: new AbortController().signal, deadlineAt: performance.now() + 1_800 }
    const started = await RelaySpeechSession.create({
      client,
      createRequest: createRequestForTracks(['microphone', 'system']),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability,
      operation
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(createSession.mock.calls[0]?.[1]).toBe(operation)
    expect(openTrack).toHaveBeenCalledTimes(2)
    expect(openTrack.mock.calls.map((call) => call[3])).toEqual([operation, operation])

    const original = createRequestForTracks(['microphone', 'system'])
    const renewedRequest: SpeechCreateRequest = {
      ...original,
      consent: {
        ...original.consent,
        issuedAt: original.consent.issuedAt + 10,
        expiresAt: original.consent.expiresAt + 10
      }
    }
    const nextOperation = { signal: new AbortController().signal, deadlineAt: performance.now() + 1_800 }
    const renewed = await started.value.renew(renewedRequest, nextOperation)
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    expect(renewed.value.identity.tracks).toEqual([
      { track: 'microphone', streamEpoch: 16 },
      { track: 'system', streamEpoch: 17 }
    ])
    expect(createSession.mock.calls[1]?.[0]).toEqual(renewedRequest)
    expect(createSession.mock.calls[1]?.[1]).toBe(nextOperation)
    expect(openTrack.mock.calls.slice(2).map((call) => call[3])).toEqual([nextOperation, nextOperation])
    await renewed.value.cancel()
  })

  it('does not allocate a successor when predecessor close is unconfirmed before the owner deadline', async () => {
    MockRelaySocket.instances = []
    const client = makeClient()
    const createSession = vi.spyOn(client, 'createSession')
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const socket = MockRelaySocket.instances[0]!
    socket.onFinish = undefined
    const original = singleTrackCreateRequest()
    const renewedRequest: SpeechCreateRequest = {
      ...original,
      consent: {
        ...original.consent,
        issuedAt: original.consent.issuedAt + 10,
        expiresAt: original.consent.expiresAt + 10
      }
    }
    expect(globalThis.performance).toBe(performance)
    let monotonicAt = 1_000
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicAt)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const owned: Promise<unknown>[] = []
    try {
      const operation = { signal: new AbortController().signal, deadlineAt: monotonicAt + 40 }
      const before = Date.now()
      const renewing = started.value.renew(renewedRequest, operation)
      const finishing = started.value.finish()
      owned.push(renewing, finishing)
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.sent).toContain('{"type":"finish"}')
      expect(createSession).toHaveBeenCalledTimes(1)
      monotonicAt += 20
      await vi.advanceTimersByTimeAsync(20)
      expect(Date.now() - before).toBe(20)
      expect(operation.deadlineAt - performance.now()).toBe(20)
      // Transport closure without a relay terminal cannot confirm predecessor closure.
      socket.close()
      await expect(renewing).resolves.toEqual({ ok: false, code: 'CLOSURE_UNCONFIRMED' })
      await expect(finishing).resolves.toMatchObject({
        complete: false,
        tracks: [{ closeConfirmed: false, tail: 'incomplete' }]
      })
      expect(createSession).toHaveBeenCalledTimes(1)
      expect(MockRelaySocket.instances).toHaveLength(1)
    } finally {
      try {
        await started.value.cancel()
        await Promise.all(owned)
      } finally {
        vi.useRealTimers()
        monotonicNow.mockRestore()
      }
    }
  })

  it('keeps close confirmation but reports an incomplete tail when a segment never becomes final', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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

  it('retains a valid terminal received before finish but reports an incomplete tail', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    MockRelaySocket.instances[0].emitTerminal()
    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(false)
    expect(stopped.tracks[0]).toMatchObject({ closeConfirmed: true, tail: 'incomplete', lastSequence: 0 })
  })

  it('keeps close confirmation but reports incomplete when transcript delivery throws', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability,
      onTranscript: () => {
        throw new Error('synthetic consumer failure')
      }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    started.value.pushFrame('microphone', { sequence: 1, sampleOffset: 0, pcm16le: new Uint8Array(3_200) })
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
              text: 'final',
              startMs: 0,
              endMs: 100,
              final: true
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
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
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

  it('rejects a frame that would overflow the capture sample frontier without sending it', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability,
      initialFrontiers: {
        microphone: { sequence: 1, sampleOffset: Number.MAX_SAFE_INTEGER - 1_000 }
      }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(
      started.value.pushFrame('microphone', {
        sequence: 1,
        sampleOffset: Number.MAX_SAFE_INTEGER - 1_000,
        pcm16le: new Uint8Array(3_200)
      })
    ).toEqual({ ok: false, code: 'ORDER' })
    expect(MockRelaySocket.instances[0].sent).toHaveLength(0)
    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(true)
  })

  it('stops admission immediately when its owner predicate becomes stale', async () => {
    MockRelaySocket.instances = []
    let current = true
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability,
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

  it('bounds renewal by the owner deadline when an earlier long finish is already in progress', async () => {
    MockRelaySocket.instances = []
    const client = makeClient()
    const createSession = vi.spyOn(client, 'createSession')
    const started = await RelaySpeechSession.create({
      client,
      createRequest: singleTrackCreateRequest(),
      expectedSelection: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      expectedCapability
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const socket = MockRelaySocket.instances[0]!
    socket.onFinish = undefined
    expect(globalThis.performance).toBe(performance)
    let monotonicAt = 1_000
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicAt)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const owned: Promise<unknown>[] = []
    try {
      let earlierFinished = false
      const earlierFinish = started.value.finish(5_000).then((result) => {
        earlierFinished = true
        return result
      })
      owned.push(earlierFinish)
      const request = singleTrackCreateRequest()
      request.consent.issuedAt += 10
      request.consent.expiresAt += 10
      const operation = { signal: new AbortController().signal, deadlineAt: monotonicAt + 40 }
      const before = Date.now()
      const renewing = started.value.renew(request, operation)
      owned.push(renewing)
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.sent).toContain('{"type":"finish"}')
      expect(earlierFinished).toBe(false)
      monotonicAt += 40
      await vi.advanceTimersByTimeAsync(40)
      expect(Date.now() - before).toBe(40)
      expect(performance.now()).toBe(operation.deadlineAt)
      await expect(renewing).resolves.toEqual({ ok: false, code: 'TIMEOUT' })
      expect(Date.now() - before).toBeLessThan(500)
      expect(earlierFinished).toBe(false)
      expect(createSession).toHaveBeenCalledTimes(1)
      expect(MockRelaySocket.instances).toHaveLength(1)
    } finally {
      try {
        await started.value.cancel()
        await Promise.all(owned)
      } finally {
        vi.useRealTimers()
        monotonicNow.mockRestore()
      }
    }
  })
})
