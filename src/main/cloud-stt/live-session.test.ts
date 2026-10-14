import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
  CloudSttLiveSession,
  getActiveCloudSttSession,
  pushCloudSttPcm,
  startCloudSttLive,
  stopCloudSttLive
} from './live-session'
import { CLOUD_STT_CREDENTIALS_MISSING } from './credentials'
import { mapCloudFinalsToLines } from '../../shared/cloud-stt-line-map'
import { normalizeNova3ResultsMessage } from './adapter'

class MockWs extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWs.CONNECTING
  bufferedAmount = 0
  terminateCalls = 0
  sent: unknown[] = []
  url: string
  opts: unknown
  constructor(url: string, opts?: unknown) {
    super()
    this.url = url
    this.opts = opts
    queueMicrotask(() => {
      this.readyState = MockWs.OPEN
      this.emit('open')
    })
  }
  send(data: unknown): void {
    this.sent.push(data)
    if (Buffer.isBuffer(data)) this.bufferedAmount += data.byteLength
  }
  close(): void {
    this.readyState = MockWs.CLOSED
    this.emit('close')
  }
  terminate(): void {
    this.terminateCalls += 1
    this.close()
  }
}

class TrackingMockWs extends MockWs {
  static instances: TrackingMockWs[] = []

  constructor(url: string, opts?: unknown) {
    super(url, opts)
    TrackingMockWs.instances.push(this)
  }

  static reset(): void {
    TrackingMockWs.instances = []
  }
}

class OneOpenOneHangingWs extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: OneOpenOneHangingWs[] = []
  readyState = OneOpenOneHangingWs.CONNECTING
  sent: unknown[] = []

  constructor(_url: string, _opts?: unknown) {
    super()
    OneOpenOneHangingWs.instances.push(this)
    if (OneOpenOneHangingWs.instances.length === 1) {
      queueMicrotask(() => {
        this.readyState = OneOpenOneHangingWs.OPEN
        this.emit('open')
      })
    }
  }

  static reset(): void {
    OneOpenOneHangingWs.instances = []
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = OneOpenOneHangingWs.CLOSED
    this.emit('close')
  }

  terminate(): void {
    this.close()
  }
}

/** A provider is allowed to synchronously signal its terminal message from send(). This guards the
 * close path against installing a stale timeout after that terminal signal has completed shutdown. */
class SynchronouslyFinishingSonioxWs extends MockWs {
  send(data: unknown): void {
    super.send(data)
    if (data === '') this.emit('message', Buffer.from(JSON.stringify({ tokens: [], finished: true })))
  }
}

class FailingCloseFrameWs extends MockWs {
  send(data: unknown): void {
    if (typeof data === 'string') throw new Error('synthetic close-frame failure')
    super.send(data)
  }
}

class ErrorOnTerminateWs extends MockWs {
  terminate(): void {
    this.terminateCalls += 1
    this.emit('error', new Error('synthetic termination error'))
    this.close()
  }
}

describe('CloudSttLiveSession', () => {
  it('returns honest CREDENTIALS error without opening sockets when Nova creds missing', async () => {
    const onFinal = vi.fn()
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: '',
        cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1',
        gatewayId: null,
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal }
    )
    const r = await session.start()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CREDENTIALS')
      expect(r.error).toBe(CLOUD_STT_CREDENTIALS_MISSING)
    }
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('opens Nova WS with the AI Gateway authorization header and streams PCM; maps finals to lines', async () => {
    const finals: unknown[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        asrLanguage: 'French',
        profile: { name: 'Tony' },
        cloudflareToken: 'tok',
        cloudflareBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1',
        gatewayId: 'gw1',
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: (l) => finals.push(l) }
    )
    const r = await session.start()
    expect(r).toEqual({ ok: true })

    // Simulate Nova Results on them track
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const them = tracks.get('them')!
    expect(them.ws.opts).toEqual({ headers: { 'cf-aig-authorization': 'Bearer tok' } })
    const novaMsg = {
      type: 'Results',
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: 'bonjour',
            words: [{ punctuated_word: 'Bonjour', start: 0.0, end: 0.4, speaker: 0, language: 'fr' }]
          }
        ]
      }
    }
    them.ws.emit('message', Buffer.from(JSON.stringify(novaMsg)))
    expect(finals).toEqual([
      expect.objectContaining({
        speaker: 'them',
        text: 'Bonjour',
        name: 'Speaker 1'
      })
    ])

    // Mic PCM push reaches you socket
    const you = tracks.get('you')!
    session.pushFloat32('you', new Float32Array([0.1, -0.1, 0.2]))
    expect(you.ws.sent.some((s) => Buffer.isBuffer(s))).toBe(true)
    session.close()
  })

  it.each([
    { label: 'just below the cap', bufferedDelta: -1, shouldSend: true },
    { label: 'exactly at the cap', bufferedDelta: 0, shouldSend: true },
    { label: 'over the cap', bufferedDelta: 1, shouldSend: false }
  ])('enforces the outbound PCM cap when the buffered amount is $label', async ({ bufferedDelta, shouldSend }) => {
    const errors: string[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: ErrorOnTerminateWs as unknown as typeof WebSocket
      },
      { onFinal: () => {}, onError: (message) => errors.push(message) }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: ErrorOnTerminateWs }> }).tracks
    const you = tracks.get('you')!.ws
    const them = tracks.get('them')!.ws
    const samples = new Float32Array(4)
    const prospectiveBytes = samples.byteLength / 2
    you.bufferedAmount = 1024 * 1024 - prospectiveBytes + bufferedDelta

    session.pushFloat32('you', samples)

    expect(you.sent.filter(Buffer.isBuffer)).toHaveLength(shouldSend ? 1 : 0)
    if (shouldSend) {
      expect(errors).toEqual([])
      session.close()
    } else {
      expect(errors).toEqual(['Cloud STT transcription stopped because the network send queue exceeded its limit.'])
      expect(you.terminateCalls).toBe(1)
      expect(them.terminateCalls).toBe(1)
      expect(you.readyState).toBe(MockWs.CLOSED)
      expect(them.readyState).toBe(MockWs.CLOSED)
    }
  })

  it.each([
    { label: 'non-finite', bufferedAmount: Number.NaN },
    { label: 'negative', bufferedAmount: -1 }
  ])('stops the session when the socket reports a $label buffered amount', async ({ bufferedAmount }) => {
    const errors: string[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: () => {}, onError: (message) => errors.push(message) }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const you = tracks.get('you')!.ws
    const them = tracks.get('them')!.ws
    you.bufferedAmount = bufferedAmount

    session.pushFloat32('you', new Float32Array([0.2]))

    expect(you.sent.filter(Buffer.isBuffer)).toHaveLength(0)
    expect(you.terminateCalls).toBe(1)
    expect(them.terminateCalls).toBe(1)
    expect(errors).toEqual(['Cloud STT transcription stopped because the network send queue exceeded its limit.'])
  })

  it('stops both tracks before overflow callbacks, emits one fixed error, and preserves finalized lines', async () => {
    const finals: unknown[] = []
    const errors: string[] = []
    let session!: CloudSttLiveSession
    session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: ErrorOnTerminateWs as unknown as typeof WebSocket
      },
      {
        onFinal: (line) => finals.push(line),
        onStatus: (status) => {
          if (status === 'closed') session.pushFloat32('them', new Float32Array([0.2]))
        },
        onError: (message) => {
          errors.push(message)
          session.pushFloat32('you', new Float32Array([0.2]))
          session.pushFloat32('them', new Float32Array([0.2]))
        }
      }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: ErrorOnTerminateWs }> }).tracks
    const you = tracks.get('you')!.ws
    const them = tracks.get('them')!.ws
    them.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: {
            alternatives: [
              { words: [{ punctuated_word: 'Already final.', start: 0, end: 0.2, speaker: 0, language: 'en' }] }
            ]
          }
        })
      )
    )
    expect(finals).toEqual([expect.objectContaining({ speaker: 'them', text: 'Already final.' })])

    const maxFrame = new Float32Array(16_000 * 30)
    session.pushFloat32('you', maxFrame)
    expect(you.bufferedAmount).toBe(960_000)
    expect(you.sent.filter(Buffer.isBuffer)).toHaveLength(1)
    expect(errors).toEqual([])
    const sentBeforeOverflow = [you.sent.length, them.sent.length]

    // A non-draining socket keeps the first maximum-size frame queued, so this second frame crosses 1 MiB.
    const nextFrame = new Float32Array(48_000)
    session.pushFloat32('you', nextFrame)

    expect(you.terminateCalls).toBe(1)
    expect(them.terminateCalls).toBe(1)
    expect(you.readyState).toBe(MockWs.CLOSED)
    expect(them.readyState).toBe(MockWs.CLOSED)
    expect([you.sent.length, them.sent.length]).toEqual(sentBeforeOverflow)
    expect(errors).toEqual(['Cloud STT transcription stopped because the network send queue exceeded its limit.'])
    expect(finals).toEqual([expect.objectContaining({ speaker: 'them', text: 'Already final.' })])

    them.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: {
            alternatives: [
              { words: [{ punctuated_word: 'Late final.', start: 1, end: 1.2, speaker: 0, language: 'en' }] }
            ]
          }
        })
      )
    )
    session.pushFloat32('you', new Float32Array([0.2]))
    session.pushFloat32('them', new Float32Array([0.2]))
    expect([you.sent.length, them.sent.length]).toEqual(sentBeforeOverflow)
    expect(errors).toHaveLength(1)
    expect(finals).toHaveLength(1)
    await expect(session.closeGracefully(100)).resolves.toEqual({ timedOut: true })
  })

  it('normalizer → line mapping (unit, no WS): mic profile + remote cluster', () => {
    const norm = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [
            {
              words: [{ punctuated_word: 'Salut', start: 0, end: 0.3, speaker: 1, language: 'fr' }]
            }
          ]
        }
      },
      { scope: { track: 'them' }, messageSequence: 1 }
    )
    const them = mapCloudFinalsToLines(norm.finals, 'them')
    expect(them[0]).toMatchObject({ speaker: 'them', text: 'Salut', name: 'Speaker 2' })
    const you = mapCloudFinalsToLines(norm.finals, 'you', { profile: { name: 'Ada' } })
    expect(you[0]).toMatchObject({ speaker: 'you', name: 'Ada', text: 'Salut' })
  })

  it('opens Nova WS using seated accountId when base URL is Worker proxy; gateway defaults', async () => {
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'tok',
        cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: null,
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )
    const r = await session.start()
    expect(r).toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const you = tracks.get('you')!
    expect(you.ws.url).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(you.ws.url).toContain('/default/')
    session.close()
  })

  it.each([
    {
      label: 'Cloudflare Nova-3',
      opts: {
        provider: 'cloudflare-nova3' as const,
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default'
      }
    },
    {
      label: 'Soniox',
      opts: {
        provider: 'soniox' as const,
        sonioxApiKey: 'test-key'
      }
    }
  ])('refuses $label WebSocket egress outside an explicit managed allowlist', async ({ opts }) => {
    TrackingMockWs.reset()
    const session = new CloudSttLiveSession(
      {
        ...opts,
        egressAllowlist: [],
        WebSocketImpl: TrackingMockWs as unknown as typeof WebSocket
      } as ConstructorParameters<typeof CloudSttLiveSession>[0],
      { onFinal: () => {} }
    )

    await expect(session.start()).resolves.toMatchObject({ ok: false, code: 'EGRESS' })
    expect(TrackingMockWs.instances).toHaveLength(0)
  })

  it('opens only a Cloudflare Nova-3 host explicitly allowed by managed egress policy', async () => {
    TrackingMockWs.reset()
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        egressAllowlist: ['gateway.ai.cloudflare.com'],
        WebSocketImpl: TrackingMockWs as unknown as typeof WebSocket
      } as ConstructorParameters<typeof CloudSttLiveSession>[0],
      { onFinal: () => {} }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    expect(TrackingMockWs.instances).toHaveLength(2)
    session.close()
  })

  it('waits for Soniox final messages after the empty end frame before closing both tracks', async () => {
    const finals: unknown[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'soniox',
        sonioxApiKey: 'test-key',
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: (line) => finals.push(line) }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const you = tracks.get('you')!.ws
    const them = tracks.get('them')!.ws
    const stopping = session.closeGracefully(1_000)

    expect(you.sent).toContain('')
    expect(them.sent).toContain('')
    expect(you.readyState).toBe(MockWs.OPEN)
    expect(them.readyState).toBe(MockWs.OPEN)

    them.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          tokens: [
            {
              text: 'Goodbye',
              is_final: true,
              start_ms: 0,
              end_ms: 400,
              speaker: '1',
              language: 'en'
            }
          ],
          finished: true
        })
      )
    )
    you.emit('message', Buffer.from(JSON.stringify({ tokens: [], finished: true })))

    await expect(stopping).resolves.toEqual({ timedOut: false })
    expect(finals).toEqual([expect.objectContaining({ speaker: 'them', name: 'Speaker 2', text: 'Goodbye' })])
    expect(you.readyState).toBe(MockWs.CLOSED)
    expect(them.readyState).toBe(MockWs.CLOSED)
  })

  it('does not leave a stale graceful-close timeout when both Soniox terminal messages arrive synchronously', async () => {
    const session = new CloudSttLiveSession(
      {
        provider: 'soniox',
        sonioxApiKey: 'test-key',
        WebSocketImpl: SynchronouslyFinishingSonioxWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    await expect(session.closeGracefully(1_000)).resolves.toEqual({ timedOut: false })
    expect((session as unknown as { gracefulCloseTimer: unknown }).gracefulCloseTimer).toBeNull()
  })

  it('reports incomplete when the provider end frame cannot be sent', async () => {
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: FailingCloseFrameWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    await expect(session.closeGracefully(1_000)).resolves.toEqual({ timedOut: true })
  })

  it('closes a partially-open pending session when Stop arrives before start resolves', async () => {
    OneOpenOneHangingWs.reset()
    const starting = startCloudSttLive(
      {
        provider: 'soniox',
        sonioxApiKey: 'test-key',
        WebSocketImpl: OneOpenOneHangingWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(OneOpenOneHangingWs.instances).toHaveLength(2)
    expect(OneOpenOneHangingWs.instances[0].readyState).toBe(OneOpenOneHangingWs.OPEN)
    expect(OneOpenOneHangingWs.instances[1].readyState).toBe(OneOpenOneHangingWs.CONNECTING)

    await expect(stopCloudSttLive()).resolves.toEqual({ timedOut: false })
    await expect(starting).resolves.toMatchObject({ ok: false })
    expect(OneOpenOneHangingWs.instances.map((ws) => ws.readyState)).toEqual([
      OneOpenOneHangingWs.CLOSED,
      OneOpenOneHangingWs.CLOSED
    ])
  })

  it('keeps only the newer session active when it replaces a pending start', async () => {
    OneOpenOneHangingWs.reset()
    TrackingMockWs.reset()
    const first = startCloudSttLive(
      {
        provider: 'soniox',
        sonioxApiKey: 'test-key',
        WebSocketImpl: OneOpenOneHangingWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )
    await Promise.resolve()
    await Promise.resolve()

    const finals: unknown[] = []
    const second = startCloudSttLive(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: TrackingMockWs as unknown as typeof WebSocket
      },
      { onFinal: (line) => finals.push(line) }
    )

    await expect(second).resolves.toEqual({ ok: true })
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(OneOpenOneHangingWs.instances.map((ws) => ws.readyState)).toEqual([
      OneOpenOneHangingWs.CLOSED,
      OneOpenOneHangingWs.CLOSED
    ])
    expect(getActiveCloudSttSession()).not.toBeNull()

    pushCloudSttPcm('you', new Float32Array([0.1, -0.1]))
    expect(TrackingMockWs.instances[0].sent.some((entry) => Buffer.isBuffer(entry))).toBe(true)
    TrackingMockWs.instances[1].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: {
            alternatives: [
              {
                transcript: 'new session',
                words: [{ punctuated_word: 'New session', start: 0, end: 0.4, speaker: 0, language: 'en' }]
              }
            ]
          }
        })
      )
    )
    expect(finals).toEqual([expect.objectContaining({ speaker: 'them', text: 'New session' })])

    await expect(stopCloudSttLive()).resolves.toEqual({ timedOut: false })
  })

  it('waits for Nova final delivery and socket close after CloseStream', async () => {
    const finals: unknown[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: (line) => finals.push(line) }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const you = tracks.get('you')!.ws
    const them = tracks.get('them')!.ws
    const stopping = session.closeGracefully(1_000)

    expect(you.sent).toContain(JSON.stringify({ type: 'CloseStream' }))
    expect(them.sent).toContain(JSON.stringify({ type: 'CloseStream' }))
    expect(you.readyState).toBe(MockWs.OPEN)
    expect(them.readyState).toBe(MockWs.OPEN)

    them.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: {
            alternatives: [
              {
                words: [{ punctuated_word: 'Done', start: 0, end: 0.4, speaker: 0, language: 'en' }]
              }
            ]
          }
        })
      )
    )
    you.emit('message', Buffer.from(JSON.stringify({ type: 'Metadata' })))
    them.emit('message', Buffer.from(JSON.stringify({ type: 'Metadata' })))
    you.close()
    them.close()

    await expect(stopping).resolves.toEqual({ timedOut: false })
    expect(finals).toEqual([expect.objectContaining({ speaker: 'them', name: 'Speaker 1', text: 'Done' })])
  })

  it('reports incomplete when Nova closes without terminal provider evidence', async () => {
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        cloudflareToken: 'test-token',
        cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gatewayId: 'default',
        WebSocketImpl: MockWs as unknown as typeof WebSocket
      },
      { onFinal: () => {} }
    )

    await expect(session.start()).resolves.toEqual({ ok: true })
    const tracks = (session as unknown as { tracks: Map<string, { ws: MockWs }> }).tracks
    const stopping = session.closeGracefully(1_000)
    // A finalized utterance may have been queued before CloseStream. It is not completion evidence for
    // the full stream, so a later bare close must still surface as incomplete.
    tracks.get('them')!.ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: {
            alternatives: [{ words: [{ punctuated_word: 'Earlier.', start: 0, end: 0.2, speaker: 0, language: 'en' }] }]
          }
        })
      )
    )
    tracks.get('you')!.ws.close()
    tracks.get('them')!.ws.close()
    await expect(stopping).resolves.toEqual({ timedOut: true })
  })
})
