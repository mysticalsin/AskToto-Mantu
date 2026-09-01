import { app } from 'electron'
import { redactSecrets } from '@shared/redact'
import {
  METIS_OPERATOR_URL,
  operatorConnectionOn,
  resolveOperatorSecret,
  resolveOperatorUrl,
  shouldSendAskText,
  type AskLogLine,
  type OperatorConnectionSettings,
  type StreamCacheUsage
} from '@shared/operator'
import { getMachineId } from './license'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'

const HEARTBEAT_MS = 60_000
const ASK_TEXT_CAP = 4_000

export { METIS_OPERATOR_URL }

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastAskId: string | null = null
let fetchImpl: typeof fetch = fetch

export function setOperatorFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

export function stopOperatorRuntime(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function osLabel(platform = process.platform): 'darwin' | 'win' | string {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'darwin'
  return platform
}

export function operatorOsLabel(platform = process.platform): string {
  return osLabel(platform)
}

function seatMeta(settings: OperatorConnectionSettings): { seatHash: string; os: string; appVersion: string } {
  const rawSeat = settings.licenseKey?.trim() || getMachineId()
  return {
    seatHash: hashOperatorId(rawSeat),
    os: osLabel(),
    appVersion: app.getVersion()
  }
}

function deviceId(): string {
  return hashOperatorId(getMachineId())
}

async function signedPost(
  url: string,
  secret: string,
  path: string,
  bodyObj: Record<string, unknown>
): Promise<{ ok: boolean; json: unknown }> {
  const body = JSON.stringify(bodyObj)
  const headers = {
    'content-type': 'application/json',
    ...operatorHmacHeaders(secret, deviceId(), body)
  }
  const res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body })
  if (!res.ok) {
    mainLog.warn(`[operator] ${path} ${res.status}`)
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(await res.text())
  } catch {
    parsed = null
  }
  return { ok: res.ok, json: parsed }
}

export async function operatorHeartbeat(
  settings: OperatorConnectionSettings
): Promise<{ ok: boolean }> {
  // Fleet law: never early-return on stored false / empty URL. Only a missing HMAC secret
  // skips the POST — the Worker rejects unsigned traffic.
  void operatorConnectionOn(settings)
  const url = resolveOperatorUrl(settings)
  const secret = resolveOperatorSecret(settings)
  if (!secret) return { ok: false }
  try {
    const res = await signedPost(url, secret, '/v1/heartbeat', seatMeta(settings))
    return { ok: res.ok }
  } catch (e) {
    mainLog.warn('[operator] heartbeat failed:', e)
    return { ok: false }
  }
}

export function startOperatorRuntime(getSettings: () => OperatorConnectionSettings): void {
  stopOperatorRuntime()
  const tick = async (): Promise<void> => {
    await operatorHeartbeat(getSettings())
  }
  void tick()
  heartbeatTimer = setInterval(() => {
    void tick()
  }, HEARTBEAT_MS)
  if (typeof heartbeatTimer === 'object' && heartbeatTimer && 'unref' in heartbeatTimer) {
    heartbeatTimer.unref()
  }
}

export interface OperatorAskEvent extends StreamCacheUsage {
  id: string
  ts?: number
  mode?: string
  provider?: string
  model?: string
  ttftMs?: number
  totalMs?: number
  outcome?: AskLogLine['outcome']
  question?: string
}

function sanitizeQuestion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return redactSecrets(trimmed).slice(0, ASK_TEXT_CAP)
}

export async function recordOperatorAsk(
  settings: OperatorConnectionSettings,
  event: OperatorAskEvent
): Promise<void> {
  const url = resolveOperatorUrl(settings)
  const secret = resolveOperatorSecret(settings)
  if (!secret) return
  lastAskId = event.id
  const payload: Record<string, unknown> = {
    id: event.id,
    ts: event.ts ?? Date.now(),
    mode: event.mode,
    provider: event.provider,
    model: event.model,
    ttftMs: event.ttftMs,
    totalMs: event.totalMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    cacheUncached: event.cacheUncached,
    cacheStatus: event.cacheStatus,
    cacheTtl: event.cacheTtl,
    outcome: event.outcome ?? 'answered',
    ...seatMeta(settings)
  }
  if (shouldSendAskText(settings)) {
    const q = sanitizeQuestion(event.question)
    if (q) payload.question = q
  }
  try {
    await signedPost(url, secret, '/v1/ingest', payload)
  } catch (e) {
    mainLog.warn('[operator] ingest failed:', e)
  }
}

export async function recordOperatorRating(
  settings: OperatorConnectionSettings,
  rating: 'up' | 'down',
  askId = lastAskId
): Promise<void> {
  const url = resolveOperatorUrl(settings)
  const secret = resolveOperatorSecret(settings)
  if (!secret || !askId) return
  try {
    await signedPost(url, secret, '/v1/ingest', { event: 'rating', id: askId, rating, ...seatMeta(settings) })
  } catch (e) {
    mainLog.warn('[operator] rating ingest failed:', e)
  }
}
