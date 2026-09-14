import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CloudSttLiveSession } from './live-session'
import { CLOUD_STT_CREDENTIALS_MISSING } from './credentials'
import { mapCloudFinalsToLines } from '../../shared/cloud-stt-line-map'
import { normalizeNova3ResultsMessage } from './adapter'

class MockWs extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWs.CONNECTING
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
  }
  close(): void {
    this.readyState = MockWs.CLOSED
    this.emit('close')
  }
  terminate(): void {
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

  it('opens Nova WS with Authorization header and streams PCM; maps finals to lines', async () => {
    const finals: unknown[] = []
    const session = new CloudSttLiveSession(
      {
        provider: 'cloudflare-nova3',
        asrLanguage: 'French',
        profile: { name: 'Tony' },
        cloudflareToken: 'tok',
        cloudflareBaseUrl:
          'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1',
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
    const novaMsg = {
      type: 'Results',
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: 'bonjour',
            words: [
              { punctuated_word: 'Bonjour', start: 0.0, end: 0.4, speaker: 0, language: 'fr' }
            ]
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

  it('normalizer → line mapping (unit, no WS): mic profile + remote cluster', () => {
    const norm = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [
            {
              words: [
                { punctuated_word: 'Salut', start: 0, end: 0.3, speaker: 1, language: 'fr' }
              ]
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
})
