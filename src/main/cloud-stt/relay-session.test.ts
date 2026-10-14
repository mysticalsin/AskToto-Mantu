import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SpeechBrokerClient } from './broker-client'
import { RelaySpeechSession } from './relay-session'

const fixture = JSON.parse(readFileSync('scripts/qa/fixtures/speech-relay-protocol-v1.json', 'utf8')) as {
  create: { request: Record<string, unknown>; responseTemplate: Record<string, unknown> }
}
const sessionId = '00000000-0000-4000-8000-000000000101'

class MockRelaySocket extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static instances: MockRelaySocket[] = []
  readyState = MockRelaySocket.CONNECTING
  bufferedAmount = 0
  sent: unknown[] = []
  onFinish?: () => void
  private sentFrames = 0

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
    if (data instanceof Uint8Array) this.sentFrames += 1
    if (data === '{"type":"finish"}') this.onFinish?.()
    callback?.()
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  terminate(): void {
    this.close()
  }

  emitTerminal(): void {
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
          lastSequence: this.sentFrames,
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
  const request = fixture.create.request as Record<string, unknown>
  const oneTrackRequest = {
    ...request,
    tracks: ['microphone'],
    consent: { ...(request.consent as Record<string, unknown>), tracks: ['microphone'] }
  }
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
  it('orders admitted PCM before the finish marker and waits for confirmed terminal closure', async () => {
    MockRelaySocket.instances = []
    const client = makeClient()
    const started = await RelaySpeechSession.create({
      client,
      createRequest: {
        ...(fixture.create.request as Record<string, unknown>),
        tracks: ['microphone'],
        consent: {
          ...((fixture.create.request as Record<string, unknown>).consent as Record<string, unknown>),
          tracks: ['microphone']
        }
      }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(
      started.value.pushFrame('microphone', { sequence: 1, sampleOffset: 0, pcm16le: new Uint8Array(3_200) })
    ).toEqual({
      ok: true
    })

    const stopped = await started.value.finish(500)
    expect(stopped.complete).toBe(true)
    expect(stopped.tracks).toMatchObject([
      { track: 'microphone', streamEpoch: 11, closeConfirmed: true, tail: 'complete', lastSequence: 1 }
    ])
    expect(MockRelaySocket.instances[0].sent[0]).toBeInstanceOf(Uint8Array)
    expect(MockRelaySocket.instances[0].sent[1]).toBe('{"type":"finish"}')
  })

  it('reports incomplete when a socket closes without a terminal event', async () => {
    MockRelaySocket.instances = []
    const started = await RelaySpeechSession.create({
      client: makeClient(),
      createRequest: {
        ...(fixture.create.request as Record<string, unknown>),
        tracks: ['microphone'],
        consent: {
          ...((fixture.create.request as Record<string, unknown>).consent as Record<string, unknown>),
          tracks: ['microphone']
        }
      }
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    MockRelaySocket.instances[0].onFinish = undefined
    const stopped = await started.value.finish(50)
    expect(stopped.complete).toBe(false)
    expect(stopped.tracks[0]).toMatchObject({ closeConfirmed: false, tail: 'incomplete' })
  })
})
