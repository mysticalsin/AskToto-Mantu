import { ADMIN_EMAILS, adminIdentity, unauthorized, type AccessCtx } from './access'
import { asCrmStatus } from './crm'
import { decryptPrompt, encryptPrompt, sha256Hex, signSkillPack } from './crypto'
import { buildDashboard } from './dashboard'
import { geoFromRequest, type CfGeo } from './geo'
import { verifyIngestHmac } from './hmac'
import { d1Store, type D1DatabaseLike } from './d1'
import { memoryStore, type AskRow, type OperatorStore, type SeatRow } from './store'
import { renderConsole } from './ui'
import { fundedProvidersFromEnv } from './funded'
import { handleOperatorAsk } from './ask'
import { isPublicAssetPath, publicAssetResponse } from './assets'

export interface Env {
  DB?: D1DatabaseLike
  OPERATOR_INGEST_SECRET: string
  OPERATOR_PROMPT_KEY: string
  OPERATOR_SKILL_PRIVATE_KEY: string
  OPERATOR_SKILL_PUBLIC_KEY?: string
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  NVIDIA_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  DASHSCOPE_API_KEY?: string
  MINIMAX_API_KEY?: string
  KIMI_API_KEY?: string
  OPENROUTER_API_KEY?: string
  GROQ_API_KEY?: string
  MISTRAL_API_KEY?: string
  XAI_API_KEY?: string
  GEMINI_API_KEY?: string
}

export interface HandleOpts {
  store?: OperatorStore
  now?: number
  access?: AccessCtx['access']
  geo?: CfGeo
  fetchImpl?: typeof fetch
}

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 90

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function isAdminPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/v1/admin')
}

function redactedPreview(_question: string | undefined, mode: string | undefined): string {
  return mode ? `${mode} ask` : 'Ask'
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: AccessCtx,
  opts: HandleOpts = {}
): Promise<Response> {
  const url = new URL(request.url)
  const store = opts.store ?? (env.DB ? d1Store(env.DB) : memoryStore())
  const now = opts.now ?? Date.now()
  const accessCtx: AccessCtx = opts.access ? { access: opts.access } : ctx

  if (url.pathname === '/health') {
    return json({
      ok: true,
      service: 'metis-operator',
      configured: Boolean(env.OPERATOR_INGEST_SECRET && env.OPERATOR_PROMPT_KEY)
    })
  }

  // /assets/* is the packed client JS. Access must never wrap it — a 302 login HTML page is not a
  // bundle. HMAC paths stay HMAC. Admin HTML stays Access.
  if (isPublicAssetPath(url.pathname)) {
    return publicAssetResponse(url.pathname)
  }

  if (isAdminPath(url.pathname)) {
    const ident = await adminIdentity(request, accessCtx, env)
    if (!ident) return unauthorized()
    return adminRoute(request, url, env, store, ident.email, now)
  }

  if (
    url.pathname === '/v1/ingest' ||
    url.pathname === '/v1/heartbeat' ||
    url.pathname === '/v1/skills/manifest' ||
    url.pathname === '/v1/ask'
  ) {
    const bodyText = request.method === 'GET' ? '' : await request.text()
    const hmac = await verifyIngestHmac(request, bodyText, env.OPERATOR_INGEST_SECRET, now, (n) => store.takeNonce(n, now))
    if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status)
    if (await store.hitRate(hmac.deviceId, now, RATE_WINDOW_MS, RATE_MAX)) {
      return json({ ok: false, error: 'rate limited' }, 429)
    }
    const geo = opts.geo ?? geoFromRequest(request)
    if (url.pathname === '/v1/heartbeat') return heartbeat(store, hmac.deviceId, bodyText, now, geo, env)
    if (url.pathname === '/v1/skills/manifest') return manifest(store)
    if (url.pathname === '/v1/ask') return handleOperatorAsk(bodyText, env as unknown as Record<string, unknown>, opts.fetchImpl ?? fetch)
    return ingest(store, env, hmac.deviceId, bodyText, now, geo)
  }

  return json({ ok: false, error: 'not found' }, 404)
}

async function adminRoute(
  request: Request,
  url: URL,
  env: Env,
  store: OperatorStore,
  email: string,
  now: number
): Promise<Response> {
  if (url.pathname === '/' && request.method === 'GET') {
    const dash = await buildDashboard(store, email, now)
    return html(renderConsole(dash))
  }
  if (url.pathname === '/v1/admin/dashboard' && request.method === 'GET') {
    return json(stripSecrets(await buildDashboard(store, email, now)))
  }
  if (url.pathname === '/v1/admin/summary' && request.method === 'GET') {
    const dash = await buildDashboard(store, email, now)
    return json({
      ok: true,
      live: dash.kpis.live,
      dau: dash.kpis.dau,
      wau: dash.kpis.wau,
      costToday: dash.kpis.costToday,
      hitRate: dash.kpis.cacheHit,
      pending: dash.kpis.pendingDiffs
    })
  }
  if (url.pathname === '/v1/admin/asks' && request.method === 'GET') {
    const asks = await store.listAsks(100)
    return json({
      ok: true,
      asks: asks.map((a) => ({ ...a, prompt_cipher: undefined, prompt_iv: undefined, question: undefined }))
    })
  }
  const reveal = /^\/v1\/admin\/asks\/([^/]+)$/.exec(url.pathname)
  if (reveal && request.method === 'GET') {
    const row = await store.getAsk(reveal[1])
    if (!row) return json({ ok: false, error: 'not found' }, 404)
    let question = ''
    if (row.prompt_cipher && row.prompt_iv) {
      question = await decryptPrompt(row.prompt_cipher, row.prompt_iv, env.OPERATOR_PROMPT_KEY)
    }
    await store.audit(crypto.randomUUID(), now, email, 'reveal', row.id, 'ask text')
    return json({ ok: true, id: row.id, question })
  }
  if (url.pathname === '/v1/admin/skills/draft' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as { skillId?: string }
    const skillId = body.skillId || 'general'
    const asks = (await store.listAsks(80)).filter((a) => a.mode === skillId || a.skill_id === skillId)
    const evidence = asks
      .map((a) => a.preview || '')
      .filter(Boolean)
      .slice(0, 8)
    const fromVersion = asks.find((a) => a.skill_version)?.skill_version || '1.1.0'
    const id = crypto.randomUUID()
    await store.putProposal({
      id,
      skill_id: skillId,
      from_version: fromVersion,
      evidence_json: JSON.stringify(evidence),
      diff: `# unified diff against ${skillId} v${fromVersion}\n# Edit, then Approve. Push is a separate click.\n`,
      rationale: evidence.length
        ? `Clustered ${evidence.length} recent Asks in ${skillId}.`
        : `No recent Asks in ${skillId} yet. Draft is a blank edit.`,
      status: 'pending',
      created_by: email,
      created_at: now,
      decided_at: null,
      reject_reason: null
    })
    await store.audit(crypto.randomUUID(), now, email, 'draft', null, skillId)
    return json({ ok: true, id })
  }
  const decide = /^\/v1\/admin\/skills\/([^/]+)\/(approve|reject|push)$/.exec(url.pathname)
  if (decide && request.method === 'POST') {
    const id = decide[1]
    const action = decide[2]
    const row = await store.getProposal(id)
    if (!row) return json({ ok: false, error: 'not found' }, 404)
    const body = await request.json().catch(() => ({})) as { diff?: string; reason?: string; body?: string }
    if (action === 'reject') {
      await store.putProposal({
        ...row,
        status: 'rejected',
        reject_reason: body.reason || 'rejected',
        decided_at: now
      })
      await store.audit(crypto.randomUUID(), now, email, 'reject', null, row.skill_id)
      return json({ ok: true })
    }
    if (action === 'approve') {
      await store.putProposal({
        ...row,
        status: 'approved',
        diff: typeof body.diff === 'string' ? body.diff : row.diff,
        decided_at: now
      })
      await store.audit(crypto.randomUUID(), now, email, 'approve', null, row.skill_id)
      return json({ ok: true, pushed: false })
    }
    if (row.status !== 'approved') return json({ ok: false, error: 'approve first' }, 400)
    if (!env.OPERATOR_SKILL_PRIVATE_KEY) return json({ ok: false, error: 'skill signing key missing' }, 500)
    const nextVersion = bump(row.from_version)
    const skillBody = skillPackBody(row.skill_id, nextVersion, body.body || row.diff)
    const digest = await sha256Hex(skillBody)
    const signed = await signSkillPack(
      { skillId: row.skill_id, version: nextVersion, sha256: digest, body: skillBody },
      env.OPERATOR_SKILL_PRIVATE_KEY
    )
    await store.putPack({
      id: crypto.randomUUID(),
      skill_id: row.skill_id,
      version: nextVersion,
      sha256: digest,
      body: skillBody,
      signed,
      pushed_at: now,
      pushed_by: email
    })
    await store.putProposal({ ...row, status: 'pushed', decided_at: now })
    await store.audit(crypto.randomUUID(), now, email, 'push', null, `${row.skill_id}@${nextVersion}`)
    return json({ ok: true, pushed: true, version: nextVersion, signed })
  }
  const crmRetry = /^\/v1\/admin\/crm\/([^/]+)\/retry$/.exec(url.pathname)
  if (crmRetry && request.method === 'POST') {
    const row = await store.getCrm(crmRetry[1])
    if (!row) return json({ ok: false, error: 'not found' }, 404)
    if (row.status !== 'failed' && row.status !== 'expired') {
      return json({ ok: false, error: 'only Failed or Expired can retry' }, 400)
    }
    await store.upsertCrm({
      ...row,
      status: 'pending',
      retry_requested: 1,
      ts: now
    })
    await store.audit(crypto.randomUUID(), now, email, 'crm-retry', null, row.id)
    return json({ ok: true, autoSend: false })
  }
  return json({ ok: false, error: 'not found' }, 404)
}

function bump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function skillPackBody(skillId: string, version: string, source: string): string {
  const trimmed = source.replace(/\r\n/g, '\n').trim()
  if (trimmed.startsWith('---')) {
    return trimmed.replace(/^version:\s*.*$/m, `version: ${version}`)
  }
  return `---\nid: ${skillId}\nversion: ${version}\nlocked: true\n---\n\n${trimmed}\n`
}

async function heartbeat(
  store: OperatorStore,
  deviceId: string,
  bodyText: string,
  now: number,
  geo: CfGeo,
  env: Env
): Promise<Response> {
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
  await store.upsertSeat(seatFromBody(deviceId, body, now, geo))
  await store.insertPulse({
    id: crypto.randomUUID(),
    device_id: deviceId,
    ts: now,
    kind: 'heartbeat',
    country: geo.country,
    city: geo.city
  })
  await ingestCrmList(store, deviceId, body, now)
  const retries = await store.listCrmRetries(deviceId)
  return json({
    ok: true,
    retry: retries.map((r) => r.id),
    fundedProviders: fundedProvidersFromEnv(env as unknown as Record<string, unknown>)
  })
}

async function ingest(
  store: OperatorStore,
  env: Env,
  deviceId: string,
  bodyText: string,
  now: number,
  geo: CfGeo
): Promise<Response> {
  const body = JSON.parse(bodyText || '{}') as Record<string, unknown>
  const id = String(body.id || crypto.randomUUID())
  if (body.event === 'rating') {
    await store.updateAskRating(id, String(body.rating || ''))
    return json({ ok: true })
  }
  if (body.event === 'crm') {
    if (body.confidential === true) return json({ ok: true, id, ingested: false })
    await upsertCrmEvent(store, deviceId, body, now)
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
    preview: redactedPreview(question, str(body.mode) ?? undefined)
  }
  await store.insertAsk(row)
  await store.insertPulse({
    id: crypto.randomUUID(),
    device_id: deviceId,
    ts: row.ts,
    kind: 'ask',
    country: geo.country,
    city: geo.city
  })
  await store.upsertSeat(seatFromBody(deviceId, body, now, geo))
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
    os: String(body.os || 'unknown'),
    app_version: String(body.appVersion || ''),
    first_seen: now,
    last_seen: now,
    country: geo.country,
    city: geo.city,
    lat: geo.lat,
    lon: geo.lon,
    last_index_at: lastIndexAt(body)
  }
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
): Promise<void> {
  if (body.confidential === true) return
  const status = asCrmStatus(body.status)
  if (!status) return
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
}

async function ingestCrmList(
  store: OperatorStore,
  deviceId: string,
  body: Record<string, unknown>,
  now: number
): Promise<void> {
  if (!Array.isArray(body.crm)) return
  for (const item of body.crm.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue
    await upsertCrmEvent(store, deviceId, item as Record<string, unknown>, now)
  }
}

function stripSecrets<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (key === 'prompt_cipher' || key === 'prompt_iv' || key === 'question' || key === 'ip') return undefined
      return value
    })
  ) as T
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
  }
}

export { ADMIN_EMAILS }
