import { app, net, powerMonitor } from 'electron'
import { hostname as osHostname } from 'node:os'
import { filterFundedProviders } from '@shared/ask-routing'
import { inspectBundleResponse } from '@shared/bundle-response'
import {
  projectOperatorIngestMetadata,
  resolveOperatorBaseUrl,
  type AskLogLine,
  type StreamCacheUsage
} from '@shared/operator'
import { buildSeatMeta, type SeatMeta } from '@shared/operator-seat'
import { classifyQuestionType, normalizeQuestionType, type QuestionType } from '@shared/question-type'
import type { Settings } from '@shared/ipc'
import { getDurableMachineId, memberLicenseStatus, licenseDisplayStatus } from './license'
import { getSettings as getStoreSettings } from './store'
import { authStatus } from './auth'
import { lastIndexedAt } from './brain/intelligence-index'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { mainLog } from './logger'
import type { OperatorCrmEvent } from './operator-crm'
import { drainOperatorQueue, enqueueOperatorItem, enqueuePreEnrolItem, type QueueSendResult } from './operator-queue'
import {
  operatorManaged,
  operatorManagedTransport,
  operatorReportingOnlySeat,
  operatorTelemetryCredential,
  operatorTelemetryTransport
} from './operator-seat'
import { operatorReportingAllowed } from './operator-reporting-policy'
import { recordDecisionProvidersFromHeartbeat, resetDecisionProvidersState } from './operator-decision-providers-state'
import {
  operatorEntitled,
  recordOperatorHeartbeatResult,
  resetOperatorEntitlementsState
} from './operator-entitlements-state'
import { maybeRefreshOperatorIntegrations, resetOperatorIntegrationsState } from './operator-integrations'
import { parseOperatorHeartbeatEntitlements } from '@shared/operator-entitlements'
import { getActiveModelPolicy, refreshModelPolicyChecked } from './model-policy-client'

export const HEARTBEAT_MS = 60_000
// Half the <=60s fleet-policy bound, so a change lands inside it despite timer drift and a slow fetch.
export const POLICY_POLL_MS = 30_000
const POLICY_FAILURE_BACKOFF_INITIAL_MS = 1_000

if (HEARTBEAT_MS % POLICY_POLL_MS !== 0) {
  throw new Error('HEARTBEAT_MS must be divisible by POLICY_POLL_MS')
}

// Offline→online is detected within this window, well inside the 1 s immediate-refresh bound.
const NETWORK_WATCH_MS = 500

if (POLICY_POLL_MS % NETWORK_WATCH_MS !== 0) {
  throw new Error('POLICY_POLL_MS must be divisible by NETWORK_WATCH_MS')
}
const POLICY_POLL_TICKS = POLICY_POLL_MS / NETWORK_WATCH_MS
const HEARTBEAT_TICKS = HEARTBEAT_MS / NETWORK_WATCH_MS

export interface OperatorRuntimeSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  operatorLicenseToken?: string
  sendAskText?: boolean
  licenseKey?: string
  /** Operator seat license (METIS-OP-1) jti/last4, once activated (operator-license-activate.ts). */
  operatorLicenseJti?: string
  operatorLicenseLast4?: string
  /** Zero-config enrolment (O07/O08): the reporting-only licence, its origin, the persisted state and the
   *  last confirmed tier. Absent on settings objects built before enrolment existed. */
  operatorReportingToken?: string
  operatorReportingJti?: string
  operatorReportingLast4?: string
  operatorLicenseOrigin?: 'admin' | 'sso' | 'token' | null
  operatorEnrollState?: 'unenrolled' | 'enrolled' | 'revoked'
  operatorTier?: string | null
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let policyRetryTimer: ReturnType<typeof setTimeout> | null = null
let policyRefreshNow: ((source: string) => void) | null = null
let policySignalUnsubscribers: Array<() => void> = []
let runtimeGeneration = 0
let lastAskId: string | null = null
let fetchImpl: typeof fetch = fetch
/** In-memory funded providers from the last heartbeat. Never a secret. Never persisted. */
let lastFundedProviders: string[] = []

export function setOperatorFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

export function stopOperatorRuntime(): void {
  runtimeGeneration++
  lastFundedProviders = []
  resetDecisionProvidersState()
  resetOperatorIntegrationsState()
  resetOperatorEntitlementsState()
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (policyRetryTimer) {
    clearTimeout(policyRetryTimer)
    policyRetryTimer = null
  }
  for (const unsubscribe of policySignalUnsubscribers.splice(0)) {
    unsubscribe()
  }
  policyRefreshNow = null
}

function resolveUrl(settings: OperatorRuntimeSettings, env = process.env): string {
  return resolveOperatorBaseUrl(settings, env)
}

/** Telemetry credential: any licence or secret, including the reporting-only auto-enrolled one. */
function resolveSecret(settings: OperatorRuntimeSettings, env = process.env): string {
  return operatorTelemetryCredential(settings, env)
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

function seatMeta(settings: OperatorRuntimeSettings): Partial<SeatMeta> {
  const rawSeat = settings.licenseKey?.trim()
  const meta: Partial<SeatMeta> = buildSeatMeta({
    seatHash: rawSeat ? hashOperatorId(rawSeat) : '',
    os: osLabel(),
    appVersion: app.getVersion(),
    hostname: safeHostname(),
    ssoEmail: safeSsoEmail(),
    license: safeLicenseState(),
    lastIndexAt: safeLastIndexAt(),
    // PLAN.md P2.2b #1: only present once this seat activated an Operator license — buildSeatMeta
    // already sanitizes/validates both (16-hex jti, >=4-char last4), so an unactivated seat (both
    // fields '') simply omits them, exactly like every other optional field here.
    licenseId: settings.operatorLicenseJti || settings.operatorReportingJti,
    licenseLast4: settings.operatorLicenseLast4 || settings.operatorReportingLast4
  })
  // A keyless seat is identified by the signed durable device ID. Let the Worker derive its hash from
  // that same header; a second read of a changing local ID could put a different seat hash in the body.
  if (!rawSeat) delete meta.seatHash
  return meta
}

export type { OperatorCrmEvent, OperatorCrmStatus } from './operator-crm'

export interface OperatorRuntimeHooks {
  onCrmRetry?: (ids: string[]) => Promise<void>
  onReadinessChanged?: () => void
  /** Refresh main-owned authority metadata before every policy fetch, even an unchanged response. */
  beforePolicyRefresh?: () => Promise<void>
  /** Runs before every heartbeat tick, including on an install with no credential yet (zero-config enrolment). */
  beforeHeartbeat?: () => Promise<void>
  /** Runs after every heartbeat with what the Worker confirmed or refused (enrolment promotion and revoke). */
  afterHeartbeat?: (beat: OperatorHeartbeatOutcome) => Promise<void>
}

async function signedPost(
  url: string,
  secret: string,
  path: string,
  bodyObj: Record<string, unknown>
): Promise<{ ok: boolean; json: unknown; status: number }> {
  const projected = path === '/v1/ingest' ? projectOperatorIngestMetadata(bodyObj) : bodyObj
  // An unsupported legacy record can never become valid by retrying. Treat it as consumed without a
  // network call so it cannot disclose content or remain a permanent durable-queue poison pill.
  if (!projected) return { ok: true, json: null, status: 204 }
  const machineId = getDurableMachineId()
  if (!machineId) throw new Error('Métis device identity is not persisted')
  const body = JSON.stringify(projected)
  const headers = {
    'content-type': 'application/json',
    ...operatorHmacHeaders(secret, hashOperatorId(machineId), body)
  }
  const res = await fetchImpl(`${url}${path}`, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000)
  })
  const text = await res.text()
  let parsed: unknown = null
  if (res.headers.get('content-type')?.includes('application/json')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* malformed response */
    }
  }
  const inspected = inspectBundleResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    bodyPrefix: text.slice(0, 1024),
    expected: 'json'
  })
  if (!inspected.ok) {
    mainLog.warn(`[operator] ${path} ${inspected.message}`)
    return { ok: false, json: parsed, status: res.status }
  }
  if (!res.ok) {
    mainLog.warn(`[operator] ${path} ${res.status}`)
  }
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
  const projected = projectOperatorIngestMetadata(bodyObj)
  if (!projected) return
  let result: QueueSendResult
  try {
    const res = await signedPost(url, secret, '/v1/ingest', projected)
    result = { ok: res.ok, status: res.status, retryAfterMs: retryAfterMsFromJson(res.json) }
  } catch (e) {
    mainLog.warn('[operator] ingest failed:', e)
    result = { ok: false }
  }
  if (!result.ok && shouldQueueOnFailure(result.status)) {
    enqueueOperatorItem(queueDir(), { path: '/v1/ingest', body: projected }, { retryAfterMs: result.retryAfterMs })
  }
}

/** Where one ingest event goes right now. `direct` = send with the credential, `queue` = the device is not
 *  enrolled yet so the already-projected event waits on disk, `drop` = reporting is off (kill switch), the seat
 *  was removed by an administrator, or there is no usable address. */
type IngestRoute = { kind: 'direct'; url: string; secret: string } | { kind: 'queue' } | { kind: 'drop' }

function ingestRoute(settings: OperatorRuntimeSettings): IngestRoute {
  const url = resolveUrl(settings)
  if (!url || !operatorReportingAllowed()) return { kind: 'drop' }
  const secret = resolveSecret(settings)
  if (secret) return { kind: 'direct', url, secret }
  return settings.operatorEnrollState === 'revoked' ? { kind: 'drop' } : { kind: 'queue' }
}

/** Send one projected `/v1/ingest` event, or hold it for enrolment. Never throws. */
async function dispatchIngest(route: IngestRoute, bodyObj: Record<string, unknown>): Promise<void> {
  if (route.kind === 'drop') return
  if (route.kind === 'direct') return postIngestWithQueue(route.url, route.secret, bodyObj)
  const projected = projectOperatorIngestMetadata(bodyObj)
  if (projected) enqueuePreEnrolItem(queueDir(), { path: '/v1/ingest', body: projected })
}

function retryIdsFromHeartbeat(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const retry = (json as { retry?: unknown }).retry
  if (!Array.isArray(retry)) return []
  return [...new Set(retry.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
}

function modelPolicyVersionFromHeartbeat(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const body = json as { modelPolicyVersion?: unknown; policyVersion?: unknown }
  const raw = body.modelPolicyVersion ?? body.policyVersion
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
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
  // An auto reporting seat, or any seat under the admin kill switch, never holds funded providers.
  if (!operatorReportingAllowed() || operatorReportingOnlySeat(getStoreSettings())) return []
  if (!operatorEntitled('operator_keys')) return []
  return lastFundedProviders
}

export function setOperatorFundedProvidersForTests(ids: string[]): void {
  lastFundedProviders = filterFundedProviders(ids)
}

/** Managed transport for Operator-funded asks. Null for an unconfigured or auto reporting seat. */
export function operatorAskTransport(settings: OperatorRuntimeSettings): { url: string; secret: string } | null {
  return operatorManagedTransport(settings)
}

/** Confirm a candidate licence before replacing the saved credential. No outbox or local writes. */
export async function confirmOperatorLicenseConnection(
  settings: OperatorRuntimeSettings
): Promise<{ ok: boolean; error?: string; confirmation?: unknown }> {
  if (!operatorReportingAllowed()) return { ok: false, error: 'Reporting is turned off by your IT administrator.' }
  const transport = operatorTelemetryTransport(settings)
  if (!transport) return { ok: false, error: 'Set a valid Métis service address before activating.' }
  if (!getDurableMachineId()) {
    return {
      ok: false,
      error:
        'Métis could not save this device identity in its data folder. Close other Métis copies, check that the folder is writable, and try again. If it persists, contact support to repair the data folder.'
    }
  }
  try {
    const result = await signedPost(transport.url, transport.secret, '/v1/heartbeat', { ...seatMeta(settings) })
    const data = result.json && typeof result.json === 'object' ? (result.json as Record<string, unknown>) : {}
    if (!result.ok || data.ok !== true) {
      const errors: Record<string, string> = {
        'license-invalid': 'This Métis licence is not valid. Check the licence you pasted.',
        'license-expired': 'This Métis licence has expired. Request a renewed licence.',
        'license-revoked': 'This Métis licence has been revoked. Contact your administrator.',
        'license-device':
          'This Métis licence is already activated on another device. Contact your administrator to transfer it.',
        'seat-revoked': 'This device has been revoked. Contact your administrator.'
      }
      return {
        ok: false,
        error: errors[String(data.code)] || 'Could not confirm your Métis licence. Check your connection and try again.'
      }
    }
    if (data.approved !== true || !parseOperatorHeartbeatEntitlements(data).tier) {
      return { ok: false, error: 'Your licence has not been approved for this device. Contact your administrator.' }
    }
    return { ok: true, confirmation: data }
  } catch {
    return { ok: false, error: 'Métis could not reach the licence service. Check your connection and try again.' }
  }
}

/** Apply only a server-confirmed response, after the matching credential has been saved. */
export function acceptOperatorHeartbeat(json: unknown): void {
  lastFundedProviders = fundedProvidersFromHeartbeat(json)
  recordOperatorHeartbeatResult(true, json)
}

export interface OperatorHeartbeatOutcome {
  ok: boolean
  retry: string[]
  /** Tier the Worker confirmed on a successful heartbeat. Lets enrolment promote or demote an auto seat. */
  tier?: string | null
  /** An authoritative refusal (401/403 or an explicit denial), with the Worker's error code when it sent one. */
  denied?: { status: number; code?: string }
}

export async function operatorHeartbeat(settings: OperatorRuntimeSettings): Promise<OperatorHeartbeatOutcome> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  const generation = runtimeGeneration
  if (!url || !secret) return { ok: false, retry: [] }
  if (!getDurableMachineId()) return { ok: false, retry: [] }
  const managed = operatorManaged(settings)
  // Drain the durable outbox on every tick, BEFORE the heartbeat itself, so a just-flushed queue is
  // reflected in the {queued, dropped} counts this same heartbeat reports. Heartbeats are never queued.
  const queueReport = await drainOperatorQueue(queueDir(), Date.now(), async (path, body) => {
    // Current durable producers only enqueue /v1/ingest. Older/corrupt queue files may contain live
    // inference paths; consuming those without a request is the only safe recovery because their body
    // cannot be represented by the telemetry projection and retrying would preserve a poison pill.
    if (path !== '/v1/ingest') return { ok: true }
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
    if (generation !== runtimeGeneration) return { ok: false, retry: [] }
    const body =
      res.json && typeof res.json === 'object'
        ? (res.json as { ok?: unknown; approved?: unknown; code?: unknown })
        : null
    if (res.status === 401 || res.status === 403 || body?.ok === false || body?.approved === false) {
      // An explicit rejection is not a network outage: revoke cached grants immediately.
      lastFundedProviders = []
      resetDecisionProvidersState()
      resetOperatorIntegrationsState()
      recordOperatorHeartbeatResult(true, null)
      return {
        ok: false,
        retry: [],
        denied: { status: res.status, ...(typeof body?.code === 'string' ? { code: body.code } : {}) }
      }
    }
    // Funded providers belong to a managed seat only: an auto reporting seat never holds any.
    if (res.ok) lastFundedProviders = managed ? fundedProvidersFromHeartbeat(res.json) : []
    // Command JEV availability: every heartbeat refreshes it (outside the steady-state skip below); only a
    // managed seat's own successful answer can turn it on.
    recordDecisionProvidersFromHeartbeat(res.ok && managed, res.json)
    // PLAN.md P2.2b #2/#3: a failed heartbeat leaves the entitlements snapshot and integrations cache
    // untouched (recordOperatorHeartbeatResult no-ops on ok:false; the version refresh below is only
    // ever consulted with a real reported version, never called with a guess).
    // A steady reporting seat has nothing new to persist: skip the encrypted settings write every minute.
    const steadyReporting =
      res.ok &&
      !managed &&
      settings.operatorTier === 'reporting' &&
      parseOperatorHeartbeatEntitlements(res.json).tier === 'reporting'
    if (!steadyReporting) recordOperatorHeartbeatResult(res.ok, res.json)
    if (res.ok && managed) {
      maybeRefreshOperatorIntegrations(settings, parseOperatorHeartbeatEntitlements(res.json).integrationsVersion)
      const policyVersion = modelPolicyVersionFromHeartbeat(res.json)
      const currentPolicyVersion = getActiveModelPolicy(settings)?.version ?? -1
      if (policyVersion !== null && policyVersion > currentPolicyVersion) {
        policyRefreshNow?.('operator-response')
      }
    }
    return {
      ok: res.ok,
      retry: retryIdsFromHeartbeat(res.json),
      ...(res.ok ? { tier: parseOperatorHeartbeatEntitlements(res.json).tier } : {})
    }
  } catch (e) {
    mainLog.warn('[operator] heartbeat failed:', e)
    return { ok: false, retry: [] }
  }
}

export function startOperatorRuntime(getSettings: () => OperatorRuntimeSettings, hooks?: OperatorRuntimeHooks): void {
  stopOperatorRuntime()
  const settings = getSettings()
  // Telemetry runs for any install with a usable address, even before it holds a credential, unless the
  // admin kill switch is on. Everything policy-shaped below runs only for a managed seat, so an install
  // without one behaves exactly as it did before zero-config reporting existed.
  if (!resolveUrl(settings) || !operatorReportingAllowed()) return
  const managedRuntime = operatorManaged(settings)
  const tick = async (): Promise<void> => {
    const generation = runtimeGeneration
    await hooks?.beforeHeartbeat?.().catch((e) => mainLog.warn('[operator] enrolment step failed:', e))
    if (generation !== runtimeGeneration) return
    const beat = await operatorHeartbeat(getSettings())
    if (generation !== runtimeGeneration) return
    await hooks?.afterHeartbeat?.(beat).catch((e) => mainLog.warn('[operator] post-heartbeat step failed:', e))
    if (generation !== runtimeGeneration) return
    if (managedRuntime) hooks?.onReadinessChanged?.()
    if (beat.retry.length && hooks?.onCrmRetry) {
      await hooks.onCrmRetry(beat.retry)
    }
  }
  // M2-0412: the fleet model policy polls on its own timer so a slow queue drain or heartbeat can never
  // push a policy change past the 60 s bound. Best-effort — a failed fetch never blocks the heartbeat.
  // Broadcast only when the policy actually changed, so Settings' managed/locked display updates without
  // an idle settings-changed churn every 30 s reaching the renderer.
  const policyGeneration = runtimeGeneration
  let policyInFlight = false
  let policyPending = false
  let policyPendingSource = 'pending'
  let policyFailureBackoffMs = POLICY_FAILURE_BACKOFF_INITIAL_MS
  const runPolicyRefresh = async (source: string): Promise<void> => {
    try {
      if (hooks?.beforePolicyRefresh) await hooks.beforePolicyRefresh()
      if (policyGeneration !== runtimeGeneration) return
      await refreshModelPolicyChecked(getSettings(), source).then(({ changed, ok }) => {
        if (policyGeneration !== runtimeGeneration) return
        if (ok) policyFailureBackoffMs = POLICY_FAILURE_BACKOFF_INITIAL_MS
        else schedulePolicyRetry()
        if (changed) hooks?.onReadinessChanged?.()
      })
    } catch {
      schedulePolicyRetry()
    }
  }
  const schedulePolicyRetry = (): void => {
    if (policyRetryTimer || policyGeneration !== runtimeGeneration) return
    const delay = Math.min(policyFailureBackoffMs, POLICY_POLL_MS)
    policyFailureBackoffMs = POLICY_POLL_MS
    policyRetryTimer = setTimeout(() => {
      policyRetryTimer = null
      pollPolicy('failure-backoff')
    }, delay)
    if (typeof policyRetryTimer === 'object' && policyRetryTimer && 'unref' in policyRetryTimer) {
      policyRetryTimer.unref()
    }
  }
  const pollPolicy = (source: string): void => {
    if (policyGeneration !== runtimeGeneration) return
    if (policyRetryTimer) {
      clearTimeout(policyRetryTimer)
      policyRetryTimer = null
    }
    // One refresh at a time: a request that lands mid-fetch runs right after it resolves.
    if (policyInFlight) {
      policyPending = true
      policyPendingSource = source
      return
    }
    policyInFlight = true
    void runPolicyRefresh(source).finally(() => {
      policyInFlight = false
      if (policyPending && policyGeneration === runtimeGeneration) {
        policyPending = false
        pollPolicy(policyPendingSource)
      }
    })
  }
  if (managedRuntime) {
    policyRefreshNow = pollPolicy
    const onFocus = (): void => pollPolicy('focus')
    const onActivate = (): void => pollPolicy('activate')
    const onResume = (): void => pollPolicy('resume')
    app.on('browser-window-focus', onFocus)
    app.on('activate', onActivate)
    powerMonitor.on('resume', onResume)
    policySignalUnsubscribers = [
      () => app.removeListener('browser-window-focus', onFocus),
      () => app.removeListener('activate', onActivate),
      () => powerMonitor.removeListener('resume', onResume)
    ]
    pollPolicy('startup')
  }
  void tick()
  // One timer at the network-watch cadence: every firing checks the OS connectivity flag (Electron has no
  // network-online event) for an offline→online edge, every POLICY_POLL_MS polls the policy, and every
  // HEARTBEAT_MS runs the heartbeat.
  // A seat without managed standing has no policy to poll, so it ticks at the heartbeat cadence only.
  let wasOnline = net.isOnline()
  let firings = 0
  heartbeatTimer = setInterval(
    () => {
      firings += 1
      if (!managedRuntime) {
        void tick()
        return
      }
      const online = net.isOnline()
      if (online && !wasOnline) pollPolicy('network-online')
      wasOnline = online
      if (firings % POLICY_POLL_TICKS !== 0) return
      pollPolicy('interval')
      if (firings % HEARTBEAT_TICKS === 0) void tick()
    },
    managedRuntime ? NETWORK_WATCH_MS : HEARTBEAT_MS
  )
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
  /**
   * Portal path tag for Keys/Overview spend lines (portal-cf / portal-direct / cli / seat-local).
   * Optional: server persistProxyAsk already tags Worker-metered rows; seat ingest should tag too
   * so REPLACE keeps path_tag when the client row wins the race.
   */
  pathTag?: 'portal-cf' | 'portal-direct' | 'cli' | 'seat-local'
}

/** Map seat provider → Ask path tag for Operator Keys Portal CF / Portal direct lines. */
export function pathTagForSeatProvider(
  provider: string | undefined,
  viaOperator: boolean
): 'portal-cf' | 'portal-direct' | 'cli' | 'seat-local' | undefined {
  if (!provider) return undefined
  if (viaOperator) {
    return provider === 'cloudflare' ? 'portal-cf' : 'portal-direct'
  }
  if (provider === 'claude-cli' || provider === 'codex-cli' || provider === 'gemini-cli') return 'cli'
  return 'seat-local'
}

/** Resolve the wire value: caller's label wins; otherwise classify locally; never absent, never free-form. */
export function resolveQuestionType(
  event: Pick<OperatorAskEvent, 'questionType' | 'question' | 'vision'>
): QuestionType {
  const given = normalizeQuestionType(event.questionType)
  if (given !== 'unknown') return given
  return classifyQuestionType(event.question, { vision: event.vision === true })
}

export async function recordOperatorAsk(
  settings: Settings | OperatorRuntimeSettings,
  event: OperatorAskEvent
): Promise<void> {
  const route = ingestRoute(settings)
  if (route.kind === 'drop') return
  // Background outputs must not steal the fallback target of a legacy answer-rating IPC.
  if (event.mode !== 'suggest' && event.mode !== 'summary' && event.mode !== 'recap') lastAskId = event.id
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
  if (event.pathTag) {
    payload.pathTag = event.pathTag
  }
  await dispatchIngest(route, payload)
}

export async function recordOperatorCrmSend(settings: OperatorRuntimeSettings, event: OperatorCrmEvent): Promise<void> {
  const route = ingestRoute(settings)
  await dispatchIngest(route, {
    event: 'crm',
    id: event.id,
    ts: event.ts ?? Date.now(),
    status: event.status,
    connector: event.connector || 'unknown',
    ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
    ...(typeof event.latencyMs === 'number' ? { latencyMs: event.latencyMs } : {}),
    ...(event.error ? { error: event.error } : {}),
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
  const route = ingestRoute(settings)
  if (!askId) return
  await dispatchIngest(route, { event: 'rating', id: askId, rating, ...seatMeta(settings) })
}
