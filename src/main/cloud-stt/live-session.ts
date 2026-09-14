/**
 * Live WebSocket STT session (Métis 1.9.1 enterprise-live).
 *
 * Opens authorized Nova-3 (AI Gateway) and/or Soniox WS using adapter URL/start builders +
 * credentials from the main-side keystore/env. Streams PCM16 frames; normalizes finals and maps
 * them to Listen lines (mic profile / remote diarization clusters).
 *
 * CLOUD_ONLY callers must not fall back to local Whisper/Parakeet when this fails — surface the
 * honest error from start().
 */
import WebSocket from 'ws'
import {
  buildNova3GatewayWsUrl,
  buildSonioxStartConfig,
  normalizeNova3ResultsMessage,
  normalizeSonioxMessage,
  type CloudSttScope
} from './adapter'
import {
  resolveCloudSttCredentials,
  type CloudSttResolvedCreds,
  CLOUD_STT_CREDENTIALS_MISSING
} from './credentials'
import { float32ToPcm16le } from './pcm'
import {
  mapCloudFinalsToLines,
  type CloudSttLineSpeaker,
  type CloudSttMappedLine
} from '../../shared/cloud-stt-line-map'
import type { CloudSttProviderId } from '../../shared/cloud-stt-provider'
import { mainLog } from '../logger'

export type CloudSttLiveStartOpts = {
  provider: CloudSttProviderId
  asrLanguage?: string | null
  pinnedLang?: string | null
  /** Mic profile for "you" labels. */
  profile?: { name?: string | null } | null
  meetingId?: string
  captureId?: string
  cloudflareToken?: string | null
  cloudflareBaseUrl?: string | null
  cloudflareAccountId?: string | null
  gatewayId?: string | null
  sonioxApiKey?: string | null
  /** Injected WebSocket ctor for tests (`ws`-compatible). */
  WebSocketImpl?: typeof WebSocket
}

export type CloudSttLiveHandlers = {
  onFinal: (line: CloudSttMappedLine) => void
  onInterim?: (channel: CloudSttLineSpeaker, text: string) => void
  onError?: (message: string) => void
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void
}

type TrackSession = {
  channel: CloudSttLineSpeaker
  ws: WebSocket
  open: boolean
  diarize: boolean
}

/**
 * Dual-track live STT: mic ("you", no diarization) + system ("them", diarize).
 */
export class CloudSttLiveSession {
  private tracks = new Map<CloudSttLineSpeaker, TrackSession>()
  private closed = false
  private creds: Extract<CloudSttResolvedCreds, { ok: true }> | null = null
  private opts: CloudSttLiveStartOpts
  private handlers: CloudSttLiveHandlers
  private Ws: typeof WebSocket
  private msgSeq = 0

  constructor(opts: CloudSttLiveStartOpts, handlers: CloudSttLiveHandlers) {
    this.opts = opts
    this.handlers = handlers
    this.Ws = opts.WebSocketImpl ?? WebSocket
  }

  /**
   * Resolve credentials and open both track sockets. Returns honest error without throwing when
   * credentials are missing (CLOUD_ONLY must surface this, never boot local ASR).
   */
  async start(): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
    const resolved = resolveCloudSttCredentials({
      provider: this.opts.provider,
      cloudflareToken: this.opts.cloudflareToken,
      cloudflareBaseUrl: this.opts.cloudflareBaseUrl,
      cloudflareAccountId: this.opts.cloudflareAccountId,
      gatewayId: this.opts.gatewayId,
      sonioxApiKey: this.opts.sonioxApiKey
    })
    if (!resolved.ok) {
      return { ok: false, error: resolved.error, code: resolved.code }
    }
    this.creds = resolved
    this.handlers.onStatus?.('connecting')
    try {
      await Promise.all([this.openTrack('you', false), this.openTrack('them', true)])
      this.handlers.onStatus?.('open')
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.close()
      return { ok: false, error: msg || CLOUD_STT_CREDENTIALS_MISSING, code: 'CONNECT' }
    }
  }

  updateLanguage(asrLanguage: string | null | undefined, pinnedLang: string | null | undefined): void {
    this.opts.asrLanguage = asrLanguage
    this.opts.pinnedLang = pinnedLang
  }

  pushFloat32(channel: CloudSttLineSpeaker, samples: Float32Array): void {
    if (this.closed) return
    const track = this.tracks.get(channel)
    if (!track?.open || track.ws.readyState !== this.Ws.OPEN) return
    if (!samples.length || samples.length > 16_000 * 30) return
    const pcm = float32ToPcm16le(samples)
    try {
      track.ws.send(pcm)
    } catch (e) {
      mainLog.warn('[cloud-stt] send failed', e instanceof Error ? e.message : e)
    }
  }

  close(): void {
    this.closed = true
    for (const track of this.tracks.values()) {
      try {
        if (track.ws.readyState === this.Ws.OPEN) {
          if (this.creds?.provider === 'cloudflare-nova3') {
            track.ws.send(JSON.stringify({ type: 'CloseStream' }))
          }
          track.ws.close()
        } else if (track.ws.readyState === this.Ws.CONNECTING) {
          track.ws.terminate?.()
          track.ws.close()
        }
      } catch {
        /* ignore */
      }
    }
    this.tracks.clear()
    this.handlers.onStatus?.('closed')
  }

  private scope(channel: CloudSttLineSpeaker): CloudSttScope {
    return {
      meetingId: this.opts.meetingId,
      captureId: this.opts.captureId,
      track: channel,
      epoch: String(this.msgSeq)
    }
  }

  private async openTrack(channel: CloudSttLineSpeaker, diarize: boolean): Promise<void> {
    const creds = this.creds
    if (!creds) throw new Error(CLOUD_STT_CREDENTIALS_MISSING)

    if (creds.provider === 'cloudflare-nova3') {
      const url = buildNova3GatewayWsUrl({
        accountId: creds.accountId,
        gatewayId: creds.gatewayId,
        asrLanguage: this.opts.asrLanguage,
        pinnedLang: this.opts.pinnedLang,
        diarize,
        interimResults: true,
        encoding: 'linear16',
        sampleRate: 16000
      })
      if (!url) throw new Error(CLOUD_STT_CREDENTIALS_MISSING)
      const ws = new this.Ws(url, {
        headers: { Authorization: `Bearer ${creds.token}` }
      })
      await this.attachWs(channel, ws, diarize, 'nova')
      return
    }

    const ws = new this.Ws(creds.wsUrl)
    await this.attachWs(channel, ws, diarize, 'soniox')
    const start = buildSonioxStartConfig({
      asrLanguage: this.opts.asrLanguage,
      pinnedLang: this.opts.pinnedLang,
      enableSpeakerDiarization: diarize
    })
    ws.send(
      JSON.stringify({
        api_key: creds.apiKey,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: start.language_hints,
        enable_speaker_diarization: start.enable_speaker_diarization
      })
    )
  }

  private attachWs(
    channel: CloudSttLineSpeaker,
    ws: WebSocket,
    diarize: boolean,
    kind: 'nova' | 'soniox'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const track: TrackSession = { channel, ws, open: false, diarize }
      this.tracks.set(channel, track)
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`Cloud STT ${kind} WebSocket connect timed out`))
        try {
          ws.terminate?.()
          ws.close()
        } catch {
          /* ignore */
        }
      }, 12_000)

      ws.once('open', () => {
        track.open = true
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      })

      ws.on('message', (data: WebSocket.RawData) => {
        void this.onMessage(channel, kind, data)
      })

      ws.once('error', (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`Cloud STT ${kind} WebSocket error: ${err?.message || 'unknown'}`))
        } else {
          this.handlers.onError?.(`Cloud STT ${kind} WebSocket error (${channel})`)
        }
      })

      ws.once('close', () => {
        track.open = false
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`Cloud STT ${kind} WebSocket closed before open`))
        }
      })
    })
  }

  private onMessage(channel: CloudSttLineSpeaker, kind: 'nova' | 'soniox', data: WebSocket.RawData): void {
    if (this.closed) return
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8')

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }

    const seq = ++this.msgSeq
    const scope = this.scope(channel)
    try {
      if (kind === 'nova') {
        const norm = normalizeNova3ResultsMessage(
          parsed as Parameters<typeof normalizeNova3ResultsMessage>[0],
          { scope, messageSequence: seq }
        )
        if (norm.interimText) this.handlers.onInterim?.(channel, norm.interimText)
        for (const line of mapCloudFinalsToLines(norm.finals, channel, {
          profile: this.opts.profile
        })) {
          this.handlers.onFinal(line)
        }
        return
      }
      const norm = normalizeSonioxMessage(parsed as Parameters<typeof normalizeSonioxMessage>[0], {
        scope,
        messageSequence: seq
      })
      if (norm.interimText) this.handlers.onInterim?.(channel, norm.interimText)
      for (const line of mapCloudFinalsToLines(norm.finals, channel, {
        profile: this.opts.profile
      })) {
        this.handlers.onFinal(line)
      }
    } catch (e) {
      mainLog.warn('[cloud-stt] normalize skipped', e instanceof Error ? e.message : e)
    }
  }
}

let active: CloudSttLiveSession | null = null

export function getActiveCloudSttSession(): CloudSttLiveSession | null {
  return active
}

export async function startCloudSttLive(
  opts: CloudSttLiveStartOpts,
  handlers: CloudSttLiveHandlers
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  if (active) {
    active.close()
    active = null
  }
  const session = new CloudSttLiveSession(opts, handlers)
  const result = await session.start()
  if (!result.ok) {
    session.close()
    return result
  }
  active = session
  return result
}

export function stopCloudSttLive(): void {
  if (active) {
    active.close()
    active = null
  }
}

export function pushCloudSttPcm(channel: CloudSttLineSpeaker, samples: Float32Array): void {
  active?.pushFloat32(channel, samples)
}

export function updateCloudSttLiveLanguage(
  asrLanguage: string | null | undefined,
  pinnedLang: string | null | undefined
): void {
  active?.updateLanguage(asrLanguage, pinnedLang)
}
