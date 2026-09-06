import { sanitizeOperatorHostname, sanitizeOperatorSsoEmail } from '../../src/shared/operator'
import { normalizeQuestionType, QUESTION_TYPE_LABELS, type QuestionType } from '../../src/shared/question-type'
import {
  ADMIN_EMAILS,
  clearSessionCookie,
  accessMisconfigured,
  accessTeamDomain,
  deriveSessionSecret,
  isAdminApiPath,
  isConsolePath,
  redirectToAccess,
  resolveAdminIdentity,
  mintSessionToken,
  sessionCookieHeader,
  SESSION_REMINT_AFTER_MS,
  unauthorized,
  type AccessCtx
} from './access'
import { asCrmStatus } from './crm'
import { encryptPrompt } from './crypto'
import { geoFromRequest, type CfGeo } from './geo'
import { verifyIngestHmac } from './hmac'
import { json } from './http'
import { d1Store, type D1DatabaseLike } from './d1'
import { fundedProviders } from './keys'
import { licenseFromIngest, parseLicenseId, seatAuthorizedForKeys } from './fleet'
import { matchRoute } from './routes/registry'
import './routes'
import { computeIntegrationsVersion, handleIntegrationsSeat } from './routes/integrations-seat'
import { pruneRetention } from './retention'
import { d1SchemaStatus } from './routes/admin-core'
import { looksLikeSecret } from './redact'
import { memoryStore, type AskRow, type OperatorStore, type SeatRow } from './store'
import { resolveTierAndEntitlements } from './tiers'
import { binaryAssetResponse, isBinaryAssetPath, isPublicAssetPath, publicAssetResponse } from './assets'
import { handleUse } from './use'
import { OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import type { AdminCtx, Env, HandleOpts } from './routes/admin-ctx'

export type { Env, HandleOpts } from './routes/admin-ctx'

const RATE_WINDOW_MS = 60_000
/** Per-route HMAC buckets: heartbeats and manifest pulls are cheap and frequent by nature but never need
 *  to burst, ingest carries every ask, `use` is the one route that spends money per call, and
 *  `integrations` is pulled once per heartbeat cycle at most. */
const RATE_LIMITS: Record<string, number> = {
  heartbeat: 5,
  ingest: 60,
  use: 120,
  manifest: 5,
  integrations: 10
}

/** Admin console mutations (every non-GET `/v1/admin/*` request), keyed by the signed-in email, same
 *  window as the device buckets above: generous enough for normal console use (bulk group or member
 *  edits, a run of license generates), low enough to blunt a compromised session or a buggy client
 *  hammering D1 with writes. GET is never limited. */
const ADMIN_MUTATION_RATE_LIMIT = 60

function rateBucketFor(pathname: string): { key: string; max: number } | null {
  if (pathname === '/v1/heartbeat') return { key: 'heartbeat', max: RATE_LIMITS.heartbeat }
  if (pathname === '/v1/ingest') return { key: 'ingest', max: RATE_LIMITS.ingest }
  if (pathname === '/v1/use') return { key: 'use', max: RATE_LIMITS.use }
  if (pathname === '/v1/skills/manifest') return { key: 'manifest', max: RATE_LIMITS.manifest }
  if (pathname === '/v1/integrations') return { key: 'integrations', max: RATE_LIMITS.integrations }
  return null
}

/** `mode ask · Type label`. The question text itself is never in a preview; only its declared type is. */
function redactedPreview(mode: string | undefined, questionType: QuestionType): string {
  const label = QUESTION_TYPE_LABELS[questionType]
  return mode ? `${mode} ask · ${label}` : `Ask · ${label}`
}

function questionTypeFromBody(body: Record<string, unknown>): QuestionType {
  return normalizeQuestionType(body.questionType)
}

/**
 * A browser cross-site mutation always carries `Sec-Fetch-Site` (modern browsers) or an `Origin` header
 * that differs from the Worker's own host (older ones, or a `fetch` from another origin). A same-origin
 * console request, and any non-browser caller that sends neither header (a server-to-server Bearer call,
 * or a test), is treated as same-site: this is a CSRF gate, not a bearer-token authorization check. It
 * covers every mutating method the admin API uses, not only POST, so a PATCH or DELETE route added later
 * is gated the day it is registered.
 */
const CSRF_GATED_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT'])

function isCrossSiteMutation(request: Request, url: URL): boolean {
  if (!CSRF_GATED_METHODS.has(request.method)) return false
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite) return secFetchSite !== 'same-origin'
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host !== url.host
  } catch {
    return true
  }
}

function csrfRefused(): Response {
  return json({ ok: false, error: 'cross-site request refused', code: 'csrf' }, 403)
}

export async function handleRequest(request: Request, env: Env, ctx: AccessCtx, opts: HandleOpts = {}): Promise<Response> {
  const startedAt = Date.now()
  const res = await routeRequest(request, env, ctx, opts)
  logRequest(request, res, startedAt)
  return res
}

function logRequest(request: Request, res: Response, startedAt: number): void {
  try {
    const url = new URL(request.url)
    console.log(
      JSON.stringify({
        t: 'req',
        route: url.pathname,
        method: request.method,
        status: res.status,
        ms: Date.now() - startedAt,
        device: request.headers.get(OPERATOR_HMAC_HEADERS.device) || undefined,
        requestId: request.headers.get('cf-ray') || undefined
      })
    )
  } catch {
    /* a log line must never fail a response */
  }
}

/** `SELECT 1` bounded to 2 s: a health check must never hang on a D1 outage. The Worker cannot cancel
 *  an in-flight D1 call, but racing it against a timeout keeps the response itself bounded. */
const HEALTH_D1_TIMEOUT_MS = 2000

async function healthD1Status(db: D1DatabaseLike | undefined): Promise<'ok' | 'error' | 'unbound'> {
  if (!db) return 'unbound'
  const timeout = new Promise<'error'>((resolve) => setTimeout(() => resolve('error'), HEALTH_D1_TIMEOUT_MS))
  const probe = db
    .prepare('SELECT 1')
    .all()
    .then(() => 'ok' as const)
    .catch(() => 'error' as const)
  return Promise.race([probe, timeout])
}

/** `schema` for `/health` (task B6, plan D10): `ok`, or the same missing-table list
 *  `/v1/admin/health.json` computes (`d1SchemaStatus`/`EXPECTED_D1_TABLES`, `./routes/admin-core`),
 *  so the two endpoints can never disagree about what "schema ok" means. `unbound` short-circuits
 *  without touching D1, same as `healthD1Status`. */
async function healthSchemaStatus(db: D1DatabaseLike | undefined): Promise<'ok' | 'unbound' | string[]> {
  if (!db) return 'unbound'
  const status = await d1SchemaStatus(db)
  return status.ok ? 'ok' : status.missing
}

/** Max of `seats.last_seen` and `asks.ts` (task B6): the newest moment any seat actually reported
 *  in. Bounded reads only - `listAsks(1)` is ordered `ts DESC` (see `d1.ts`), so its first row is the
 *  most recent ask without scanning the table; seats has no such ordering to lean on, so this reduces
 *  the full (small, per-fleet) seat list rather than adding a second store method for one number. */
async function lastIngestAt(store: OperatorStore): Promise<number | null> {
  const [seats, recentAsks] = await Promise.all([store.listSeats(), store.listAsks(1)])
  const seatMax = seats.reduce<number | null>((acc, s) => (acc == null || s.last_seen > acc ? s.last_seen : acc), null)
  const askMax = recentAsks[0]?.ts ?? null
  if (seatMax == null) return askMax
  if (askMax == null) return seatMax
  return Math.max(seatMax, askMax)
}

/** Newest `platform.heartbeat` audit row (task B6): `retention.ts`'s cron writes exactly one per run,
 *  so its `ts` is "when the cron last actually ran" without a dedicated table. */
async function lastCronAt(store: OperatorStore): Promise<number | null> {
  const rows = await store.listAudit(1, { action: 'platform.heartbeat' })
  return rows[0]?.ts ?? null
}

async function routeRequest(request: Request, env: Env, ctx: AccessCtx, opts: HandleOpts = {}): Promise<Response> {
  const url = new URL(request.url)
  const store = opts.store ?? (env.DB ? d1Store(env.DB) : memoryStore())
  const now = opts.now ?? Date.now()
  const accessCtx: AccessCtx = opts.access ? { access: opts.access } : ctx

  if (url.pathname === '/health') {
    const [d1, schema, lastIngest, lastCron] = await Promise.all([
      healthD1Status(env.DB),
      healthSchemaStatus(env.DB),
      lastIngestAt(store),
      lastCronAt(store)
    ])
    return json({
      ok: true,
      service: 'metis-operator',
      configured: Boolean(env.OPERATOR_INGEST_SECRET && env.OPERATOR_PROMPT_KEY),
      version: env.OPERATOR_VERSION?.trim() || 'dev',
      builtAt: env.OPERATOR_BUILT_AT?.trim() || null,
      env: env.OPERATOR_ENV?.trim() || 'production',
      d1,
      schema,
      lastIngestAt: lastIngest,
      lastCronAt: lastCron
    })
  }

  if (isPublicAssetPath(url.pathname)) {
    if (isBinaryAssetPath(url.pathname)) return binaryAssetResponse(request, env)
    return publicAssetResponse(url.pathname) ?? json({ ok: false, error: 'not found' }, 404)
  }

  if (url.pathname === '/logout' && request.method === 'POST') {
    const team = accessTeamDomain(env.TEAM_DOMAIN)
    const location = team ? `${team}/cdn-cgi/access/logout` : '/'
    return new Response(null, { status: 303, headers: { Location: location, 'Set-Cookie': clearSessionCookie() } })
  }

  if (isConsolePath(url.pathname) || isAdminApiPath(url.pathname)) {
    const ident = await resolveAdminIdentity(request, accessCtx, env, now)
    if (ident.status === 'misconfigured') return accessMisconfigured(ident.error)
    if (ident.status === 'ok') {
      if (isCrossSiteMutation(request, url)) return csrfRefused()
      if (
        request.method !== 'GET' &&
        (await store.hitRate(`admin:${ident.email}`, now, RATE_WINDOW_MS, ADMIN_MUTATION_RATE_LIMIT))
      ) {
        return json({ ok: false, error: 'rate limited', code: 'rate', retryAfterMs: RATE_WINDOW_MS }, 429)
      }
      const res = await adminRoute(request, url, env, store, ident.email, now, opts)
      return withSession(res, env, ident, now, url.pathname)
    }
    if (ident.status === 'denied' || isAdminApiPath(url.pathname) || request.method !== 'GET') {
      return unauthorized()
    }
    return redirectToAccess(request, env)
  }

  if (
    url.pathname === '/v1/ingest' ||
    url.pathname === '/v1/heartbeat' ||
    url.pathname === '/v1/skills/manifest' ||
    url.pathname === '/v1/use' ||
    url.pathname === '/v1/integrations'
  ) {
    const bodyText = request.method === 'GET' ? '' : await request.text()
    const hmac = await verifyIngestHmac(request, bodyText, env.OPERATOR_INGEST_SECRET, now, (n) => store.takeNonce(n, now))
    if (!hmac.ok) return json({ ok: false, error: hmac.error, ...(hmac.code ? { code: hmac.code } : {}) }, hmac.status)
    const bucket = rateBucketFor(url.pathname)
    if (bucket && (await store.hitRate(`${bucket.key}:${hmac.deviceId}`, now, RATE_WINDOW_MS, bucket.max))) {
      return json({ ok: false, error: 'rate limited', retryAfterMs: RATE_WINDOW_MS }, 429)
    }
    const geo = opts.geo ?? geoFromRequest(request)
    if (url.pathname === '/v1/heartbeat') return heartbeat(store, hmac.deviceId, bodyText, now, geo)
    if (url.pathname === '/v1/skills/manifest') return manifest(store)
    if (url.pathname === '/v1/integrations') {
      if (request.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405)
      return handleIntegrationsSeat(store, env, hmac.deviceId, now)
    }
    if (url.pathname === '/v1/use') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
      return handleUse(store, env, hmac.deviceId, bodyText, now, opts.providerFetch ?? opts.cfFetch ?? fetch)
    }
    return ingest(store, env, hmac.deviceId, bodyText, now, geo)
  }

  return json({ ok: false, error: 'not found' }, 404)
}

/** Mints (or reconstructs) the session cookie for an authenticated admin response. A session that came
 *  from a fresh Access identity (no `sessionIat`) always gets a new cookie; an existing session is only
 *  re-minted, and `Set-Cookie` re-sent, once it has been alive longer than `SESSION_REMINT_AFTER_MS` -
 *  otherwise the browser keeps the cookie it already has and this just recomputes the same token bytes
 *  for the `/session` JSON body and the `X-Metis-Session` header. */
async function withSession(
  res: Response,
  env: Env,
  ident: { email: string; sessionIat?: number },
  now: number,
  pathname: string
): Promise<Response> {
  const secret = await deriveSessionSecret(env)
  if (!secret) return res
  const shouldRemint = ident.sessionIat === undefined || now - ident.sessionIat > SESSION_REMINT_AFTER_MS
  const iat = shouldRemint ? now : ident.sessionIat!
  const token = await mintSessionToken(ident.email, iat, secret)
  const headers = new Headers(res.headers)
  if (shouldRemint) headers.append('Set-Cookie', sessionCookieHeader(token, now))
  headers.set('X-Metis-Session', token)
  if (pathname === '/session') {
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify({ ok: true, session: token }), { status: 200, headers })
  }
  return new Response(res.body, { status: res.status, headers })
}

async function adminRoute(
  request: Request,
  url: URL,
  env: Env,
  store: OperatorStore,
  email: string,
  now: number,
  opts: HandleOpts = {}
): Promise<Response> {
  const ctx: AdminCtx = { request, url, env, store, email, now, opts }
  const matched = await matchRoute<AdminCtx>(request, ctx)
  if (matched) return matched
  return json({ ok: false, error: 'not found' }, 404)
}

async function heartbeat(store: OperatorStore, deviceId: string, bodyText: string, now: number, geo: CfGeo): Promise<Response> {
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
  const seat = seatFromBody(deviceId, body, now, geo)
  await store.upsertSeat(seat)
  const stored = (await store.getSeat(deviceId)) ?? seat
  const pulseId = crypto.randomUUID()
  await store.insertPulse({
    id: pulseId,
    device_id: deviceId,
    ts: now,
    kind: 'heartbeat',
    country: geo.country,
    city: geo.city,
    region: geo.region ?? null
  })
  await store.insertEvent({
    id: pulseId,
    ts: now,
    kind: 'heartbeat',
    actor: seat.sso_email,
    device_id: deviceId,
    country: geo.country,
    detail: safeEventDetail([seat.os, geo.city, typeof body.path === 'string' ? body.path : '/'].filter(Boolean).join(' '))
  })
  await store.touchSession(deviceId, now, 'heartbeat', geo, seat)
  await ingestCrmList(store, deviceId, body, now)
  const retries = await store.listCrmRetries(deviceId)
  const { tier, entitlements } = await resolveTierAndEntitlements(store, stored, now)
  const integrationsVersion = await computeIntegrationsVersion(store, stored, tier)
  return json({
    ok: true,
    retry: retries.map((r) => r.id),
    fundedProviders: await fundedProviders(store, stored, now),
    approved: await seatAuthorizedForKeys(store, stored, now),
    tier,
    entitlements,
    integrationsVersion,
    ...(typeof body.queued === 'number' ? { queued: body.queued } : {}),
    ...(typeof body.dropped === 'number' ? { dropped: body.dropped } : {})
  })
}

async function ingest(store: OperatorStore, env: Env, deviceId: string, bodyText: string, now: number, geo: CfGeo): Promise<Response> {
  const body = JSON.parse(bodyText || '{}') as Record<string, unknown>
  const id = String(body.id || crypto.randomUUID())
  // An ask id is client-chosen. A row may only be created, replaced or rated by the device that owns it;
  // otherwise one seat could rewrite or thumbs-down another seat's history through a guessed id.
  const existing = await store.getAsk(id)
  if (existing && existing.device_id !== deviceId) return json({ ok: false, error: 'forbidden' }, 403)
  if (body.event === 'rating') {
    if (existing) await store.updateAskRating(id, String(body.rating || ''))
    const seat = seatFromBody(deviceId, body, now, geo)
    await store.insertEvent({
      id: crypto.randomUUID(),
      ts: now,
      kind: 'rating',
      actor: seat.sso_email,
      device_id: deviceId,
      country: geo.country,
      detail: safeEventDetail(String(body.rating || 'rating'))
    })
    return json({ ok: true })
  }
  if (body.event === 'listen' || body.event === 'recap') {
    const seat = seatFromBody(deviceId, body, now, geo)
    const minutes = num(body.minutes)
    await store.insertEvent({
      id,
      ts: now,
      kind: body.event,
      actor: seat.sso_email,
      device_id: deviceId,
      country: geo.country,
      detail: safeEventDetail(minutes != null ? `${minutes}m` : String(body.event))
    })
    await store.upsertSeat(seat)
    return json({ ok: true, id })
  }
  if (body.event === 'crm') {
    if (body.confidential === true) return json({ ok: true, id, ingested: false })
    const written = await upsertCrmEvent(store, deviceId, body, now)
    if (written === 'foreign') return json({ ok: false, error: 'forbidden' }, 403)
    const seat = seatFromBody(deviceId, body, now, geo)
    await store.insertEvent({
      id: crypto.randomUUID(),
      ts: now,
      kind: 'crm',
      actor: seat.sso_email,
      device_id: deviceId,
      country: geo.country,
      detail: safeEventDetail(String(body.status || body.connector || 'crm'))
    })
    return json({ ok: true, id })
  }
  let cipher: string | null = null
  let iv: string | null = null
  const question = typeof body.question === 'string' ? body.question : ''
  if (question) {
    const enc = await encryptPrompt(question, env.OPERATOR_PROMPT_KEY)
    cipher = enc.cipher
    iv = enc.iv
  }
  const questionType = questionTypeFromBody(body)
  const row: AskRow = {
    id,
    device_id: deviceId,
    ts: typeof body.ts === 'number' ? body.ts : now,
    mode: str(body.mode),
    skill_id: str(body.skillId),
    skill_version: str(body.skillVersion),
    provider: str(body.provider),
    model: str(body.model),
    ttft_ms: num(body.ttftMs),
    total_ms: num(body.totalMs),
    input_tokens: num(body.inputTokens),
    output_tokens: num(body.outputTokens),
    cache_read: num(body.cacheRead),
    cache_write: num(body.cacheWrite),
    cache_uncached: num(body.cacheUncached),
    cache_status: str(body.cacheStatus),
    cache_ttl: str(body.cacheTtl),
    outcome: str(body.outcome),
    rating: str(body.rating),
    prompt_cipher: cipher,
    prompt_iv: iv,
    preview: redactedPreview(str(body.mode) ?? undefined, questionType),
    question_type: questionType
  }
  await store.insertAsk(row)
  const pulseId = crypto.randomUUID()
  await store.insertPulse({
    id: pulseId,
    device_id: deviceId,
    ts: row.ts,
    kind: 'ask',
    country: geo.country,
    city: geo.city,
    region: geo.region ?? null
  })
  const seat = seatFromBody(deviceId, body, now, geo)
  await store.upsertSeat(seat)
  await store.touchSession(deviceId, row.ts, 'ask', geo, seat)
  await store.insertEvent({
    id: pulseId,
    ts: row.ts,
    kind: 'ask',
    actor: seat.sso_email,
    device_id: deviceId,
    country: geo.country,
    detail: safeEventDetail(row.mode || row.cache_status || 'ask')
  })
  return json({ ok: true, id })
}

async function manifest(store: OperatorStore): Promise<Response> {
  const packs = await store.latestPacks()
  return json({
    ok: true,
    skills: packs.map((p) => ({
      skillId: p.skill_id,
      version: p.version,
      sha256: p.sha256,
      signed: p.signed
    }))
  })
}

function lastIndexAt(body: Record<string, unknown>): number | null {
  return typeof body.lastIndexAt === 'number' && Number.isFinite(body.lastIndexAt) ? body.lastIndexAt : null
}

function seatFromBody(deviceId: string, body: Record<string, unknown>, now: number, geo: CfGeo): SeatRow {
  return {
    device_id: deviceId,
    seat_hash: String(body.seatHash || deviceId),
    os: typeof body.os === 'string' && body.os.trim() && body.os !== 'unknown' ? body.os.trim() : '',
    app_version: typeof body.appVersion === 'string' ? body.appVersion.trim() : '',
    first_seen: now,
    last_seen: now,
    country: geo.country,
    city: geo.city,
    region: geo.region ?? null,
    lat: geo.lat,
    lon: geo.lon,
    last_index_at: lastIndexAt(body),
    hostname: sanitizeOperatorHostname(body.hostname),
    sso_email: sanitizeOperatorSsoEmail(body.ssoEmail ?? body.email),
    license: licenseFromIngest(body),
    license_jti: parseLicenseId(body.licenseId)
  }
}

function safeEventDetail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().slice(0, 48)
  if (!s || looksLikeSecret(s)) return null
  return s
}

function meetingHashFromBody(body: Record<string, unknown>): string | null {
  if (typeof body.meetingHash === 'string' && /^[a-f0-9]{16,64}$/i.test(body.meetingHash.trim())) {
    return body.meetingHash.trim().toLowerCase().slice(0, 16)
  }
  if (typeof body.meetingFile === 'string') {
    const base = body.meetingFile.replace(/^.*[/\\]/, '').trim()
    if (!base) return null
    // Never persist a path or basename. Fold a legacy field into a short hash later on the client.
    if (/^[a-f0-9]{16,64}$/i.test(base)) return base.toLowerCase().slice(0, 16)
  }
  return null
}

async function upsertCrmEvent(
  store: OperatorStore,
  deviceId: string,
  body: Record<string, unknown>,
  now: number
): Promise<'written' | 'skipped' | 'foreign'> {
  if (body.confidential === true) return 'skipped'
  const status = asCrmStatus(body.status)
  if (!status) return 'skipped'
  const id = String(body.id || crypto.randomUUID())
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 160) : 'CRM send'
  const connector = typeof body.connector === 'string' ? body.connector.slice(0, 32) : 'unknown'
  const err = typeof body.error === 'string' ? body.error.slice(0, 200) : null
  const remoteId = typeof body.remoteId === 'string' ? body.remoteId.slice(0, 80) : null
  const remoteUrl =
    typeof body.remoteUrl === 'string' && /^https:\/\//i.test(body.remoteUrl) ? body.remoteUrl.slice(0, 300) : null
  const action = typeof body.action === 'string' ? body.action.slice(0, 32) : null
  const attempt = typeof body.attempt === 'number' && Number.isFinite(body.attempt) ? Math.max(0, Math.floor(body.attempt)) : 0
  const latencyMs =
    typeof body.latencyMs === 'number' && Number.isFinite(body.latencyMs) ? Math.max(0, Math.floor(body.latencyMs)) : 0
  const prev = await store.getCrm(id)
  // A CRM row (and the retry instruction the console attaches to it) belongs to the device that sent it.
  if (prev && prev.device_id !== deviceId) return 'foreign'
  await store.upsertCrm({
    id,
    device_id: deviceId,
    ts: typeof body.ts === 'number' ? body.ts : now,
    status,
    title: title || 'CRM send',
    connector,
    meeting_file: null,
    meeting_hash: meetingHashFromBody(body) ?? prev?.meeting_hash ?? null,
    last_error: err,
    retry_requested: 0,
    attempt: attempt || prev?.attempt || 0,
    latency_ms: latencyMs || prev?.latency_ms || 0,
    remote_id: remoteId ?? prev?.remote_id ?? null,
    remote_url: remoteUrl ?? prev?.remote_url ?? null,
    action: action ?? prev?.action ?? null
  })
  return 'written'
}

async function ingestCrmList(store: OperatorStore, deviceId: string, body: Record<string, unknown>, now: number): Promise<void> {
  if (!Array.isArray(body.crm)) return
  for (const item of body.crm.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue
    await upsertCrmEvent(store, deviceId, item as Record<string, unknown>, now)
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export default {
  async fetch(request: Request, env: Env, ctx: AccessCtx): Promise<Response> {
    return handleRequest(request, env, ctx)
  },
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const store: OperatorStore = env.DB ? d1Store(env.DB) : memoryStore()
    // `pruneRetention` closes stale sessions itself as its last step, so the cron needs only the one
    // call; `db` is only for the two raw-table prunes (`integration_grants`, `mcp_calls`) that live
    // outside `OperatorStore`.
    const result = await pruneRetention(store, Date.now(), {}, { db: env.DB })
    console.log(JSON.stringify({ t: 'retention', ...result }))
  }
}

export { ADMIN_EMAILS }
