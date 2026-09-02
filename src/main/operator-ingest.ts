import { app } from 'electron'
import { redactSecrets } from '@shared/redact'
import { operatorUrlConfigured, shouldSendAskText, type AskLogLine, type StreamCacheUsage } from '@shared/operator'
import { classifyOperatorReply, operatorReplyProblem } from '@shared/operator-response'
import type { Settings } from '@shared/ipc'
import { getMachineId } from './license'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'
import type { OperatorCrmEvent } from './operator-crm'

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

export type { OperatorCrmEvent, OperatorCrmStatus } from './operator-crm'

export interface OperatorRuntimeHooks {
  onCrmRetry?: (ids: string[]) => Promise<void>
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
  // redirect: 'manual' — a Cloudflare Access 302 must surface as a failure, never be followed into a
  // 200 login page that a lenient parse would report as a successful heartbeat.
  const res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body, redirect: 'manual' })
  const reply = classifyOperatorReply({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    text: await res.text()
  })
  if (!reply.ok) mainLog.warn(operatorReplyProblem(path, reply))
  return { ok: reply.ok, json: reply.json }
}

function retryIdsFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const retry = (json as { retry?: unknown }).retry
  if (!Array.isArray(retry)) return []
  return [...new Set(retry.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
}

export async function operatorHeartbeat(
  settings: OperatorRuntimeSettings
): Promise<{ ok: boolean; retry: string[] }> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return { ok: false, retry: [] }
  try {
    const res = await signedPost(url, secret, '/v1/heartbeat', seatMeta(settings))
    return { ok: res.ok, retry: retryIdsFromHeartbeat(res.json) }
  } catch (e) {
    mainLog.warn('[operator] heartbeat failed:', e)
    return { ok: false, retry: [] }
  }
}

export function startOperatorRuntime(
  getSettings: () => OperatorRuntimeSettings,
  hooks?: OperatorRuntimeHooks
): void {
  stopOperatorRuntime()
  const settings = getSettings()
  if (!operatorUrlConfigured(settings) || !resolveSecret(settings)) return
  const tick = async (): Promise<void> => {
    const beat = await operatorHeartbeat(getSettings())
    if (beat.retry.length && hooks?.onCrmRetry) {
      await hooks.onCrmRetry(beat.retry)
    }
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

export async function recordOperatorCrmSend(
  settings: OperatorRuntimeSettings,
  event: OperatorCrmEvent
): Promise<void> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return
  const title = event.title?.replace(/\s+/g, ' ').trim().slice(0, 160)
  try {
    await signedPost(url, secret, '/v1/ingest', {
      event: 'crm',
      id: event.id,
      ts: event.ts ?? Date.now(),
      status: event.status,
      title: title || 'CRM send',
      connector: event.connector || 'unknown',
      ...(event.meetingHash ? { meetingHash: event.meetingHash } : {}),
      ...(event.action ? { action: event.action } : {}),
      ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
      ...(typeof event.latencyMs === 'number' ? { latencyMs: event.latencyMs } : {}),
      ...(event.remoteId ? { remoteId: event.remoteId } : {}),
      ...(event.remoteUrl ? { remoteUrl: event.remoteUrl } : {}),
      ...(event.error ? { error: event.error.slice(0, 200) } : {}),
      ...seatMeta(settings)
    })
  } catch (e) {
    mainLog.warn('[operator] crm ingest failed:', e)
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
