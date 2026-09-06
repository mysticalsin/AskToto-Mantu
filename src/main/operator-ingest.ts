import { app } from 'electron'
import { hostname } from 'node:os'
import { redactSecrets } from '@shared/redact'
import { filterFundedProviders } from '@shared/ask-routing'
import { inspectBundleResponse } from '@shared/bundle-response'
import {
  operatorUrlConfigured,
  sanitizeOperatorHostname,
  sanitizeOperatorSsoEmail,
  shouldSendAskText,
  type AskLogLine,
  type StreamCacheUsage
} from '@shared/operator'
import { authStatus } from './auth'
import type { Settings } from '@shared/ipc'
import { timeSavedFromTotals, DEFAULT_TIME_SAVED_ASSUMPTIONS } from '@shared/time-saved'
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
  usageStats?: Settings['usageStats']
  timeSaved?: Settings['timeSaved']
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastAskId: string | null = null
let fetchImpl: typeof fetch = fetch
/** In-memory funded providers from the last heartbeat. Never a secret. Never persisted. */
let lastFundedProviders: string[] = []

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

export function seatMeta(settings: OperatorRuntimeSettings): {
  seatHash: string
  os: string
  appVersion: string
  product: 'metis-desktop'
  hostname?: string
  ssoEmail?: string
  savedMinutes?: number
  meetingsSummarized?: number
  conversationMinutes?: number
} {
  const rawSeat = settings.licenseKey?.trim() || getMachineId()
  const host = sanitizeOperatorHostname(hostname())
  let email: string | null = null
  try {
    email = sanitizeOperatorSsoEmail(authStatus().email)
  } catch {
    email = null
  }
  const usage = settings.usageStats
  const assumptions = settings.timeSaved ?? DEFAULT_TIME_SAVED_ASSUMPTIONS
  const saved = usage
    ? timeSavedFromTotals(
        {
          meetingsSummarized: usage.meetingsSummarized,
          conversationMinutes: usage.conversationMinutes
        },
        assumptions
      )
    : null
  return {
    seatHash: hashOperatorId(rawSeat),
    os: osLabel(),
    appVersion: app.getVersion(),
    product: 'metis-desktop',
    ...(host ? { hostname: host } : {}),
    ...(email ? { ssoEmail: email } : {}),
    ...(saved && saved.savedMinutes > 0
      ? {
          savedMinutes: saved.savedMinutes,
          meetingsSummarized: saved.meetings,
          conversationMinutes: saved.conversationMinutes
        }
      : {})
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
  const res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body })
  const text = await res.text()
  const inspected = inspectBundleResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    bodyPrefix: text.slice(0, 1024),
    expected: 'json'
  })
  if (!inspected.ok) {
    mainLog.warn(`[operator] ${path} ${inspected.message}`)
    return { ok: false, json: null }
  }
  if (!res.ok) {
    mainLog.warn(`[operator] ${path} ${res.status}`)
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { ok: res.ok, json: parsed }
}

function retryIdsFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const retry = (json as { retry?: unknown }).retry
  if (!Array.isArray(retry)) return []
  return [...new Set(retry.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
}

export function fundedProvidersFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const funded = (json as { fundedProviders?: unknown }).fundedProviders
  if (!Array.isArray(funded)) return []
  return filterFundedProviders(funded.filter((id): id is string => typeof id === 'string'))
}

export function operatorFundedProviders(): string[] {
  return lastFundedProviders
}

export function setOperatorFundedProvidersForTests(ids: string[]): void {
  lastFundedProviders = filterFundedProviders(ids)
}

export function operatorAskTransport(settings: OperatorRuntimeSettings): { url: string; secret: string } | null {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!url || !secret) return null
  return { url, secret }
}

export async function operatorHeartbeat(
  settings: OperatorRuntimeSettings
): Promise<{ ok: boolean; retry: string[] }> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return { ok: false, retry: [] }
  try {
    const res = await signedPost(url, secret, '/v1/heartbeat', seatMeta(settings))
    if (res.ok) lastFundedProviders = fundedProvidersFromHeartbeat(res.json)
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
