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
import { auditLog, mainLog } from '../logger'
import { hostAllowed, requestHostname } from '../net/egress-policy'

export type CloudSttLiveStartOpts = {
  provider: CloudSttProviderId
  asrLanguage?: string | null
  pinnedLang?: string | null
  /** Mic profile for "you" labels. */
  profile?: { name?: string | null; role?: string | null; title?: string | null } | null
  meetingId?: string
  captureId?: string
  cloudflareToken?: string | null
  cloudflareBaseUrl?: string | null
  cloudflareAccountId?: string | null
  gatewayId?: string | null
  sonioxApiKey?: string | null
  /** Managed host policy; null/undefined preserves the un-managed no-policy behavior. */
  egressAllowlist?: readonly string[] | null
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
  closeAcknowledged: boolean
  /** The provider confirmed it processed the graceful end-of-stream request. */
  terminalReceived: boolean
}

export type CloudSttLiveStopResult = { timedOut: boolean }

function novaTerminalEvidence(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const candidate = message as { type?: unknown }
  // `is_final`/`speech_final` certify an utterance or time range, not the whole stream. During
  // CloseStream, accept only Deepgram's completion Metadata as end-of-stream proof; a queued ordinary
  // Results event followed by a bare close must surface as incomplete instead of silently losing the tail.
  return candidate.type === 'Metadata'
}

class CloudSttEgressError extends Error {
  constructor() {
    super('Cloud STT connection is blocked by the managed network policy.')
    this.name = 'CloudSttEgressError'
  }
}

/**
 * Dual-track live STT: mic ("you", no diarization) + system ("them", diarize).
 */
export class CloudSttLiveSession {
  private tracks = new Map<CloudSttLineSpeaker, TrackSession>()
  private closed = false
  private closing = false
  private creds: Extract<CloudSttResolvedCreds, { ok: true }> | null = null
  private opts: CloudSttLiveStartOpts
  private handlers: CloudSttLiveHandlers
  private Ws: typeof WebSocket
  private msgSeq = 0
  private blockedHosts = new Set<string>()
  private gracefulClose: Promise<CloudSttLiveStopResult> | null = null
  private resolveGracefulClose: ((result: CloudSttLiveStopResult) => void) | null = null
  private gracefulCloseTimer: ReturnType<typeof setTimeout> | null = null
  private closedStatusSent = false

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
      return {
        ok: false,
        error: msg || CLOUD_STT_CREDENTIALS_MISSING,
        code: e instanceof CloudSttEgressError ? 'EGRESS' : 'CONNECT'
      }
    }
  }

  updateLanguage(asrLanguage: string | null | undefined, pinnedLang: string | null | undefined): void {
    this.opts.asrLanguage = asrLanguage
    this.opts.pinnedLang = pinnedLang
  }

  pushFloat32(channel: CloudSttLineSpeaker, samples: Float32Array): void {
    if (this.closed || this.closing) return
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
    if (this.closed) return
    this.closed = true
    this.closing = false
    this.clearGracefulCloseTimer()
    const tracks = [...this.tracks.values()]
    this.tracks.clear()
    for (const track of tracks) {
      try {
        if (track.ws.readyState === this.Ws.OPEN) {
          track.ws.close()
        } else if (track.ws.readyState === this.Ws.CONNECTING) {
          track.ws.terminate?.()
          track.ws.close()
        }
      } catch {
        /* ignore */
      }
    }
    this.finishGracefulClose({ timedOut: true })
    this.signalClosed()
  }

  /**
   * Stop accepting PCM, ask the provider to flush its tail, and only then close sockets.
   * Soniox documents an empty final frame plus `finished:true`; Deepgram/Nova documents
   * `CloseStream` followed by its final response and connection close. A bounded timeout
   * prevents a broken provider connection from keeping capture shutdown alive indefinitely.
   */
  closeGracefully(timeoutMs = 5_000): Promise<CloudSttLiveStopResult> {
    if (this.closed) return Promise.resolve({ timedOut: false })
    if (this.gracefulClose) return this.gracefulClose

    this.closing = true
    this.gracefulClose = new Promise<CloudSttLiveStopResult>((resolve) => {
      this.resolveGracefulClose = resolve
    })

    const tracks = [...this.tracks.values()]
    if (tracks.length === 0) {
      this.completeGracefulClose(false)
      return this.gracefulClose
    }

    // Install the deadline before asking a provider to flush. Some implementations can synchronously
    // deliver the terminal result from send(); completeGracefulClose() must be able to clear this timer
    // instead of leaving a live handle behind after an already-complete stop.
    this.gracefulCloseTimer = setTimeout(() => {
      if (!this.closing || this.closed) return
      this.completeGracefulClose(true)
    }, Math.max(1, Math.min(timeoutMs, 15_000)))

    for (const track of tracks) {
      if (track.ws.readyState === this.Ws.OPEN) {
        try {
          if (this.creds?.provider === 'soniox') track.ws.send('')
          else track.ws.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {
          // Sending the protocol end-frame failed, so a bare transport close cannot honestly certify
          // that the final provider transcript was delivered.
          this.acknowledgeTrackClose(track, false)
        }
      } else if (track.ws.readyState !== this.Ws.CLOSING) {
        try {
          track.ws.terminate?.()
          track.ws.close()
        } catch {
          /* ignore */
        }
        this.acknowledgeTrackClose(track, false)
      }
    }
    return this.gracefulClose
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
      this.assertEgressAllowed(url)
      const ws = new this.Ws(url, {
        // gateway.ai.cloudflare.com reserves Authorization for an upstream provider credential. This
        // Workers AI socket is authenticated to AI Gateway itself, so use its dedicated header.
        headers: { 'cf-aig-authorization': `Bearer ${creds.token}` }
      })
      await this.attachWs(channel, ws, diarize, 'nova')
      return
    }

    this.assertEgressAllowed(creds.wsUrl)
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

  private assertEgressAllowed(url: string): void {
    const host = requestHostname(url)
    if (host !== null && hostAllowed(host, this.opts.egressAllowlist ?? null)) return
    if (host !== null && !this.blockedHosts.has(host)) {
      this.blockedHosts.add(host)
      mainLog.warn(`[cloud-stt] egress blocked by policy: ${host}`)
      auditLog('net.egress.blocked', { host, via: 'cloud-stt-ws' })
    }
    throw new CloudSttEgressError()
  }

  private attachWs(
    channel: CloudSttLineSpeaker,
    ws: WebSocket,
    diarize: boolean,
    kind: 'nova' | 'soniox'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const track: TrackSession = {
        channel,
        ws,
        open: false,
        diarize,
        closeAcknowledged: false,
        terminalReceived: false
      }
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
        } else if (this.closing) {
          this.acknowledgeTrackClose(track, track.terminalReceived)
        } else {
          this.handlers.onError?.(`Cloud STT ${kind} WebSocket error (${channel})`)
        }
      })

      ws.once('close', () => {
        track.open = false
        if (this.closing) this.acknowledgeTrackClose(track, track.terminalReceived)
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
        // Deepgram's CloseStream response ends with completion Metadata followed by close. A final Results
        // message can belong to an earlier utterance, so only the Metadata proves the provider flushed the
        // stream; the close handler resolves the track after that proof arrives.
        if (this.closing && novaTerminalEvidence(parsed)) {
          const track = this.tracks.get(channel)
          if (track) track.terminalReceived = true
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
      if (this.closing && norm.finished) {
        const track = this.tracks.get(channel)
        if (track) {
          track.terminalReceived = true
          try {
            track.ws.close()
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      mainLog.warn('[cloud-stt] normalize skipped', e instanceof Error ? e.message : e)
      // A provider error frame during the end-of-stream handshake is not a clean terminal response.
      // Finish promptly and truthfully rather than letting a later bare close erase the incomplete state.
      if (this.closing) {
        const track = this.tracks.get(channel)
        if (track) this.acknowledgeTrackClose(track, false)
      }
    }
  }

  private acknowledgeTrackClose(track: TrackSession, terminalEvidence: boolean): void {
    if (!this.closing || track.closeAcknowledged) return
    track.closeAcknowledged = true
    if (terminalEvidence) track.terminalReceived = true
    if ([...this.tracks.values()].every((candidate) => candidate.closeAcknowledged)) {
      this.completeGracefulClose(
        ![...this.tracks.values()].every((candidate) => candidate.terminalReceived)
      )
    }
  }

  private completeGracefulClose(timedOut: boolean): void {
    if (this.closed) return
    this.closed = true
    this.closing = false
    this.clearGracefulCloseTimer()
    const tracks = [...this.tracks.values()]
    this.tracks.clear()
    for (const track of tracks) {
      try {
        if (track.ws.readyState === this.Ws.OPEN || track.ws.readyState === this.Ws.CLOSING) track.ws.close()
        else if (track.ws.readyState === this.Ws.CONNECTING) track.ws.terminate?.()
      } catch {
        /* ignore */
      }
    }
    this.finishGracefulClose({ timedOut })
    this.signalClosed()
  }

  private finishGracefulClose(result: CloudSttLiveStopResult): void {
    const resolve = this.resolveGracefulClose
    this.resolveGracefulClose = null
    resolve?.(result)
  }

  private clearGracefulCloseTimer(): void {
    if (!this.gracefulCloseTimer) return
    clearTimeout(this.gracefulCloseTimer)
    this.gracefulCloseTimer = null
  }

  private signalClosed(): void {
    if (this.closedStatusSent) return
    this.closedStatusSent = true
    this.handlers.onStatus?.('closed')
  }
}

let active: CloudSttLiveSession | null = null
// `start()` opens the mic and remote tracks concurrently. Keep a cancellable reference before that
// await completes: otherwise a Stop during a partial open sees no active session and leaves the already
// authenticated socket alive until the other track's connect timeout.
let pending: CloudSttLiveSession | null = null
let activeGeneration = 0

export function getActiveCloudSttSession(): CloudSttLiveSession | null {
  return active
}

export async function startCloudSttLive(
  opts: CloudSttLiveStartOpts,
  handlers: CloudSttLiveHandlers
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const generation = ++activeGeneration
  if (active) {
    const prior = active
    prior.close()
    if (active === prior) active = null
  }
  if (pending) {
    const prior = pending
    prior.close()
    if (pending === prior) pending = null
  }
  const session = new CloudSttLiveSession(opts, handlers)
  pending = session
  const result = await session.start()
  if (pending === session) pending = null
  if (!result.ok || generation !== activeGeneration) {
    session.close()
    return result.ok
      ? { ok: false, error: 'Cloud STT session was replaced.', code: 'STALE' }
      : result
  }
  active = session
  return result
}

export async function stopCloudSttLive(opts?: {
  graceful?: boolean
  timeoutMs?: number
}): Promise<CloudSttLiveStopResult> {
  activeGeneration += 1
  const pendingSession = pending
  if (pendingSession) {
    pendingSession.close()
    if (pending === pendingSession) pending = null
  }
  const session = active
  if (!session) return { timedOut: false }
  if (!opts?.graceful) {
    session.close()
    if (active === session) active = null
    return { timedOut: false }
  }
  const result = await session.closeGracefully(opts.timeoutMs)
  if (active === session) active = null
  return result
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
