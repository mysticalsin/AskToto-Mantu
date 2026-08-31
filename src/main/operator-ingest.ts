import { app } from 'electron'
import { redactSecrets } from '@shared/redact'
import { operatorUrlConfigured, shouldSendAskText, type AskLogLine, type StreamCacheUsage } from '@shared/operator'
import type { Settings } from '@shared/ipc'
import { getMachineId } from './license'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'

const HEARTBEAT_MS = 60_000
const ASK_TEXT_CAP = 4_000

export interface OperatorRuntimeSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  sendAskText?: boolean
  licenseKey?: string
}

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

function resolveUrl(settings: OperatorRuntimeSettings, env = process.env): string {
  return (settings.operatorUrl || env.METIS_OPERATOR_URL || '').trim().replace(/\/$/, '')
}

function resolveSecret(settings: OperatorRuntimeSettings, env = process.env): string {
  return (settings.operatorIngestSecret || env.METIS_OPERATOR_INGEST_SECRET || '').trim()
}

function osLabel(): 'darwin' | 'win' | string {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'darwin'
  return process.platform
}

function seatMeta(settings: OperatorRuntimeSettings): { seatHash: string; os: string; appVersion: string } {
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

async function signedPost(url: string, secret: string, path: string, bodyObj: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(bodyObj)
  const headers = {
    'content-type': 'application/json',
    ...operatorHmacHeaders(secret, deviceId(), body)
  }
  const res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body })
  if (!res.ok) {
    mainLog.warn(`[operator] ${path} ${res.status}`)
  }
}

export async function operatorHeartbeat(settings: OperatorRuntimeSettings): Promise<boolean> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return false
  try {
    await signedPost(url, secret, '/v1/heartbeat', seatMeta(settings))
    return true
  } catch (e) {
    mainLog.warn('[operator] heartbeat failed:', e)
    return false
  }
}

export function startOperatorRuntime(getSettings: () => OperatorRuntimeSettings): void {
  stopOperatorRuntime()
  const settings = getSettings()
  if (!operatorUrlConfigured(settings) || !resolveSecret(settings)) return
  void operatorHeartbeat(settings)
  heartbeatTimer = setInterval(() => {
    void operatorHeartbeat(getSettings())
  }, HEARTBEAT_MS)
  if (typeof heartbeatTimer === 'object' && heartbeatTimer && 'unref' in heartbeatTimer) {
    heartbeatTimer.unref()
  }
}

export interface OperatorAskEvent extends StreamCacheUsage {
  id: string
  ts?: number
  mode?: string
  skillId?: string
  skillVersion?: string
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
  settings: Settings | OperatorRuntimeSettings,
  event: OperatorAskEvent
): Promise<void> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return
  lastAskId = event.id
  const payload: Record<string, unknown> = {
    id: event.id,
    ts: event.ts ?? Date.now(),
    mode: event.mode,
    skillId: event.skillId,
    skillVersion: event.skillVersion,
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
  settings: OperatorRuntimeSettings,
  rating: 'up' | 'down',
  askId = lastAskId
): Promise<void> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret || !askId) return
  try {
    await signedPost(url, secret, '/v1/ingest', { event: 'rating', id: askId, rating, ...seatMeta(settings) })
  } catch (e) {
    mainLog.warn('[operator] rating ingest failed:', e)
  }
}
