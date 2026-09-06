import { app } from 'electron'
import { hostname } from 'node:os'
import { redactSecrets } from '@shared/redact'
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
import { getMachineId } from './license'
import { operatorFundsProvider } from '@shared/ask-routing'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'
import type { OperatorCrmEvent } from './operator-crm'
import { identityLicenseMeta } from './license/operator-status'

const HEARTBEAT_MS = 60_000
const ASK_TEXT_CAP = 4_000

export const OPERATOR_SEAT_NOT_APPROVED =
  'This seat is not approved. Tony must approve this device in Operator before platform keys work.'

export interface OperatorRuntimeSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  sendAskText?: boolean
  licenseKey?: string
  licenseValid?: boolean
  trialActive?: boolean
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastAskId: string | null = null
let fetchImpl: typeof fetch = fetch
/** In-memory funded providers from the last heartbeat. Never a secret. Never persisted. */
let lastFundedProviders: string[] = []
/** Tony approved this device in Operator. Default false until a heartbeat says so. */
let lastApproved = false

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

export type SeatLicenseMeta = { license: string; licenseLast4?: string; licenseId?: string }

/** License status + last4 only. Never the raw key. Never self-approve. */
export function licenseMeta(
  settings: OperatorRuntimeSettings,
  identity: SeatLicenseMeta | null = null
): SeatLicenseMeta {
  if (identity && (identity.license === 'licensed' || identity.license === 'grace')) {
    return identity
  }
  const raw = settings.licenseKey?.trim() || ''
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '')
  const licenseLast4 = alnum.length >= 4 ? alnum.slice(-4) : undefined
  const license = settings.licenseValid ? 'licensed' : settings.trialActive ? 'trial' : 'unlicensed'
  if (identity?.license === 'expired' && !settings.licenseValid) {
    return identity
  }
  return licenseLast4 ? { license, licenseLast4 } : { license }
}

export function seatMeta(settings: OperatorRuntimeSettings): {
  seatHash: string
  os: string
  appVersion: string
  hostname?: string
  ssoEmail?: string
  license: string
  licenseLast4?: string
  licenseId?: string
} {
  const rawSeat = settings.licenseKey?.trim() || getMachineId()
  const host = sanitizeOperatorHostname(hostname())
  let email: string | null = null
  try {
    email = sanitizeOperatorSsoEmail(authStatus().email)
  } catch {
    email = null
  }
  return {
    seatHash: hashOperatorId(rawSeat),
    os: osLabel(),
    appVersion: app.getVersion(),
    ...(host ? { hostname: host } : {}),
    ...(email ? { ssoEmail: email } : {}),
    ...licenseMeta(settings, safeIdentityLicenseMeta())
  }
}

function safeIdentityLicenseMeta(): SeatLicenseMeta | null {
  try {
    return identityLicenseMeta()
  } catch {
    return null
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
  bodyObj: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ ok: boolean; json: unknown; status: number }> {
  const body = JSON.stringify(bodyObj)
  const headers = {
    'content-type': 'application/json',
    ...operatorHmacHeaders(secret, deviceId(), body)
  }
  const res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body, signal })
  if (!res.ok) {
    mainLog.warn(`[operator] ${path} ${res.status}`)
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(await res.text())
  } catch {
    parsed = null
  }
  return { ok: res.ok, json: parsed, status: res.status }
}

function retryIdsFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const retry = (json as { retry?: unknown }).retry
  if (!Array.isArray(retry)) return []
  return [...new Set(retry.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
}

function fundedProvidersFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const funded = (json as { fundedProviders?: unknown }).fundedProviders
  if (!Array.isArray(funded)) return []
  return [
    ...new Set(
      funded.filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.length > 0 &&
          id.length <= 40 &&
          id !== 'dust' &&
          id !== 'local' &&
          id !== 'claude-cli' &&
          id !== 'codex-cli' &&
          id !== 'cloudflare-account'
      )
    )
  ]
}

export function operatorFundedProviders(): string[] {
  return lastFundedProviders
}

export function operatorBrokerConfigured(settings: OperatorRuntimeSettings, env = process.env): boolean {
  return operatorUrlConfigured(settings, env) && !!resolveSecret(settings, env)
}

function heartbeatApproved(json: unknown): boolean {
  return Boolean(json && typeof json === 'object' && (json as { approved?: unknown }).approved === true)
}

export function operatorSeatApproved(): boolean {
  return lastApproved
}

export function operatorCanBroker(provider: string, settings: OperatorRuntimeSettings): boolean {
  return (
    lastApproved &&
    operatorBrokerConfigured(settings) &&
    operatorFundsProvider(provider, lastFundedProviders)
  )
}

export type OperatorUseResult =
  | { ok: true; text: string; inputTokens?: number; outputTokens?: number }
  | { ok: false; error: string }

export async function operatorUseAsk(
  settings: OperatorRuntimeSettings,
  body: {
    provider: string
    model: string
    system?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    temperature?: number
    maxTokens?: number
  },
  signal?: AbortSignal
): Promise<OperatorUseResult> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) {
    return { ok: false, error: 'Operator cannot issue a use' }
  }
  if (!lastApproved) {
    return { ok: false, error: OPERATOR_SEAT_NOT_APPROVED }
  }
  if (!operatorFundsProvider(body.provider, lastFundedProviders)) {
    return { ok: false, error: 'Operator cannot issue a use' }
  }
  try {
    const res = await signedPost(
      url,
      secret,
      '/v1/use',
      {
        provider: body.provider,
        model: body.model,
        system: body.system || '',
        messages: body.messages,
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {})
      },
      signal
    )
    const json = res.json
    if (!res.ok || !json || typeof json !== 'object') {
      const err = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
        ? (json as { error: string }).error
        : 'Operator cannot issue a use'
      return { ok: false, error: err }
    }
    const text = typeof (json as { text?: unknown }).text === 'string' ? (json as { text: string }).text : ''
    if (!text) return { ok: false, error: 'Operator returned an empty answer' }
    return {
      ok: true,
      text,
      inputTokens:
        typeof (json as { inputTokens?: unknown }).inputTokens === 'number'
          ? (json as { inputTokens: number }).inputTokens
          : undefined,
      outputTokens:
        typeof (json as { outputTokens?: unknown }).outputTokens === 'number'
          ? (json as { outputTokens: number }).outputTokens
          : undefined
    }
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'Cancelled.' }
    mainLog.warn('[operator] use failed:', e)
    return { ok: false, error: 'Operator cannot issue a use' }
  }
}

export function setOperatorFundedProvidersForTests(ids: string[]): void {
  lastFundedProviders = [...ids]
}

export function setOperatorApprovedForTests(approved: boolean): void {
  lastApproved = approved
}

export async function operatorHeartbeat(
  settings: OperatorRuntimeSettings
): Promise<{ ok: boolean; retry: string[] }> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return { ok: false, retry: [] }
  try {
    const res = await signedPost(url, secret, '/v1/heartbeat', seatMeta(settings))
    if (res.ok) {
      lastFundedProviders = fundedProvidersFromHeartbeat(res.json)
      lastApproved = heartbeatApproved(res.json)
    }
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
