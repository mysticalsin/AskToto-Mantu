import { app } from 'electron'
import { hostname as osHostname } from 'node:os'
import { redactSecrets } from '@shared/redact'
import { filterFundedProviders } from '@shared/ask-routing'
import { inspectBundleResponse } from '@shared/bundle-response'
import { operatorUrlConfigured, shouldSendAskText, type AskLogLine, type StreamCacheUsage } from '@shared/operator'
import { buildSeatMeta, type SeatMeta } from '@shared/operator-seat'
import { classifyQuestionType, normalizeQuestionType, type QuestionType } from '@shared/question-type'
import type { Settings } from '@shared/ipc'
import { getMachineId, memberLicenseStatus, licenseDisplayStatus } from './license'
import { getSettings as getStoreSettings } from './store'
import { authStatus } from './auth'
import { lastIndexedAt } from './brain/intelligence-index'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'
import type { OperatorCrmEvent } from './operator-crm'
import { drainOperatorQueue, enqueueOperatorItem, type QueueSendResult } from './operator-queue'
import { operatorEntitled, recordOperatorHeartbeatResult } from './operator-entitlements-state'
import { maybeRefreshOperatorIntegrations } from './operator-integrations'
import { parseOperatorHeartbeatEntitlements } from '@shared/operator-entitlements'

const HEARTBEAT_MS = 60_000
const ASK_TEXT_CAP = 4_000

export interface OperatorRuntimeSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  sendAskText?: boolean
  licenseKey?: string
  /** Operator seat license (METIS-OP-1) jti/last4, once activated (operator-license-activate.ts). */
  operatorLicenseJti?: string
  operatorLicenseLast4?: string
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

/** Test-only override for the queue's directory, mirroring setOperatorFetchForTests. Production always
 *  resolves the real Electron userData dir. */
let queueDirOverride: string | null = null
export function setOperatorQueueDirForTests(dir: string | null): void {
  queueDirOverride = dir
}
function queueDir(): string {
  return queueDirOverride ?? app.getPath('userData')
}

/** This Mac's real hostname (os.hostname()). Never a placeholder; sanitized downstream by buildSeatMeta. */
function safeHostname(): string | undefined {
  try {
    return osHostname()
  } catch {
    return undefined
  }
}

/** The signed-in Mantu/Azure AD identity (src/main/auth.ts), when one exists. Never a guess, never the
 *  local license-server email — only a verified, domain-locked SSO session counts as "signed in". */
function safeSsoEmail(): string | undefined {
  try {
    const status = authStatus()
    return status.signedIn ? status.email : undefined
  } catch {
    return undefined
  }
}

/** Real license state from the member-pass subsystem (src/main/license/activate.ts), falling back to
 *  the local trial clock (src/main/license.ts) only when there is no real activation. Both are the
 *  actual on-device state machines — never invented, and 'trial' only when the trial is genuinely
 *  active right now. */
function safeLicenseState(): string | undefined {
  try {
    const member = memberLicenseStatus()
    if (member.state !== 'unlicensed') return member.state
    const display = licenseDisplayStatus()
    return display.trialActive ? 'trial' : 'unlicensed'
  } catch {
    return undefined
  }
}

/** Last successful Solid Intelligence index run (src/main/brain/intelligence-index.ts). */
function safeLastIndexAt(): number | undefined {
  try {
    return lastIndexedAt(getStoreSettings())
  } catch {
    return undefined
  }
}

function seatMeta(settings: OperatorRuntimeSettings): SeatMeta {
  const rawSeat = settings.licenseKey?.trim() || getMachineId()
  return buildSeatMeta({
    seatHash: hashOperatorId(rawSeat),
    os: osLabel(),
    appVersion: app.getVersion(),
    hostname: safeHostname(),
    ssoEmail: safeSsoEmail(),
    license: safeLicenseState(),
    lastIndexAt: safeLastIndexAt(),
    // PLAN.md P2.2b #1: only present once this seat activated an Operator license — buildSeatMeta
    // already sanitizes/validates both (16-hex jti, >=4-char last4), so an unactivated seat (both
    // fields '') simply omits them, exactly like every other optional field here.
    licenseId: settings.operatorLicenseJti,
    licenseLast4: settings.operatorLicenseLast4
  })
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
): Promise<{ ok: boolean; json: unknown; status: number }> {
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
    return { ok: false, json: null, status: res.status }
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
  return { ok: res.ok, json: parsed, status: res.status }
}

function retryAfterMsFromJson(json: unknown): number | undefined {
  if (!json || typeof json !== 'object') return undefined
  const v = (json as { retryAfterMs?: unknown }).retryAfterMs
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** Durable-outbox eligibility (PLAN.md section 3): a network failure (status is undefined — the fetch
 *  itself threw), a 429, or a 5xx. Anything else (400s, a bad HMAC, a malformed body) is a real
 *  rejection that a retry would never fix, so it is logged and dropped instead of queued forever. */
function shouldQueueOnFailure(status: number | undefined): boolean {
  if (status === undefined) return true
  return status === 429 || status >= 500
}

/** POST one `/v1/ingest` event (ask, crm, rating, listen/recap). On success, nothing else happens. On a
 *  failure eligible for retry (network error, 429, 5xx), the exact same body is appended to the durable
 *  outbox so the Worker's INSERT OR REPLACE on (id, ts) dedups it once it lands. Never throws. */
async function postIngestWithQueue(url: string, secret: string, bodyObj: Record<string, unknown>): Promise<void> {
  let result: QueueSendResult
  try {
    const res = await signedPost(url, secret, '/v1/ingest', bodyObj)
    result = { ok: res.ok, status: res.status, retryAfterMs: retryAfterMsFromJson(res.json) }
  } catch (e) {
    mainLog.warn('[operator] ingest failed:', e)
    result = { ok: false }
  }
  if (!result.ok && shouldQueueOnFailure(result.status)) {
    enqueueOperatorItem(queueDir(), { path: '/v1/ingest', body: bodyObj }, { retryAfterMs: result.retryAfterMs })
  }
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

/** Gated centrally here (PLAN.md P2.2b #2) so every ask-routing call site that already consults this
 *  function (failover eligibility, "restore providers" checks, etc.) is gated for free, without each
 *  of them separately importing/consulting the entitlements state. An unconfigured seat is never gated
 *  (operatorEntitled('operator_keys') itself returns true in that case) — this only ever empties the
 *  list once a real Operator is configured and its license doesn't include operator_keys. */
export function operatorFundedProviders(): string[] {
  if (!operatorEntitled('operator_keys')) return []
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
  // Drain the durable outbox on every tick, BEFORE the heartbeat itself, so a just-flushed queue is
  // reflected in the {queued, dropped} counts this same heartbeat reports. Heartbeats are never queued.
  const queueReport = await drainOperatorQueue(queueDir(), Date.now(), async (path, body) => {
    const res = await signedPost(url, secret, path, body)
    return { ok: res.ok, status: res.status, retryAfterMs: retryAfterMsFromJson(res.json) }
  }).catch((e) => {
    mainLog.warn('[operator] queue drain failed:', e)
    return { queued: 0, dropped: 0 }
  })
  try {
    const res = await signedPost(url, secret, '/v1/heartbeat', {
      ...seatMeta(settings),
      queued: queueReport.queued,
      dropped: queueReport.dropped
    })
    if (res.ok) lastFundedProviders = fundedProvidersFromHeartbeat(res.json)
    // PLAN.md P2.2b #2/#3: a failed heartbeat leaves the entitlements snapshot and integrations cache
    // untouched (recordOperatorHeartbeatResult no-ops on ok:false; the version refresh below is only
    // ever consulted with a real reported version, never called with a guess).
    recordOperatorHeartbeatResult(res.ok, res.json)
    if (res.ok) {
      maybeRefreshOperatorIntegrations(settings, parseOperatorHeartbeatEntitlements(res.json).integrationsVersion)
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
  /** Short error CLASS only (e.g. 'transient', 'auth', 'rate-limit', 'usage-cap', 'empty-response') when
   *  outcome is 'error' — never the provider's raw message text, which can carry account/URL detail. */
  error?: string
  question?: string
  /**
   * Closed-taxonomy label computed on this seat (question-type.ts). A METRIC, not text: it always ships,
   * even with "Send Ask text" off, and never carries a substring of the prompt. When the caller did not
   * classify, recordOperatorAsk derives it here from the question so the dashboard never sees a blank
   * from a seat that had the text in hand.
   */
  questionType?: QuestionType
  /** True for a screenshot Ask. Only used to derive questionType when the caller did not pass one. */
  vision?: boolean
}

/** Resolve the wire value: caller's label wins; otherwise classify locally; never absent, never free-form. */
export function resolveQuestionType(event: Pick<OperatorAskEvent, 'questionType' | 'question' | 'vision'>): QuestionType {
  const given = normalizeQuestionType(event.questionType)
  if (given !== 'unknown') return given
  return classifyQuestionType(event.question, { vision: event.vision === true })
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
    questionType: resolveQuestionType(event),
    ...seatMeta(settings)
  }
  if (event.outcome === 'error' && event.error) {
    payload.error = event.error.slice(0, 64)
  }
  if (shouldSendAskText(settings)) {
    const q = sanitizeQuestion(event.question)
    if (q) payload.question = q
  }
  await postIngestWithQueue(url, secret, payload)
}

export async function recordOperatorCrmSend(
  settings: OperatorRuntimeSettings,
  event: OperatorCrmEvent
): Promise<void> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return
  const title = event.title?.replace(/\s+/g, ' ').trim().slice(0, 160)
  await postIngestWithQueue(url, secret, {
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
    ...(event.credentialSource ? { credentialSource: event.credentialSource } : {}),
    ...seatMeta(settings)
  })
}

/** `askId` is the real answer id from the renderer's feedback IPC (App.tsx threads ask.answer.id through
 *  Answer.tsx). Falls back to the last ask this process sent only when the renderer didn't have one
 *  (older payload shape) — never silently misattributes a rating to the wrong answer when a real id
 *  was available. */
export async function recordOperatorRating(
  settings: OperatorRuntimeSettings,
  rating: 'up' | 'down',
  askId = lastAskId
): Promise<void> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret || !askId) return
  await postIngestWithQueue(url, secret, { event: 'rating', id: askId, rating, ...seatMeta(settings) })
}
