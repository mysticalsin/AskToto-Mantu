import { ADMIN_EMAILS, adminIdentity, unauthorized, type AccessCtx } from './access'
import { decryptPrompt, encryptPrompt, sha256Hex, signSkillPack } from './crypto'
import { verifyIngestHmac } from './hmac'
import { d1Store, type D1DatabaseLike } from './d1'
import { memoryStore, type AskRow, type OperatorStore } from './store'
import { renderConsole } from './ui'
import { aggregateCacheSlice, estimateCacheCost, formatUsdEstimate, type AskLogLine } from '../../src/shared/operator'

export interface Env {
  DB?: D1DatabaseLike
  OPERATOR_INGEST_SECRET: string
  OPERATOR_PROMPT_KEY: string
  OPERATOR_SKILL_PRIVATE_KEY: string
  OPERATOR_SKILL_PUBLIC_KEY?: string
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
}

export interface HandleOpts {
  store?: OperatorStore
  now?: number
  access?: AccessCtx['access']
}

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 90
const ONLINE_MS = 2 * 60_000

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

  if (isAdminPath(url.pathname)) {
    const ident = await adminIdentity(request, accessCtx, env)
    if (!ident) return unauthorized()
    return adminRoute(request, url, env, store, ident.email, now)
  }

  if (url.pathname === '/v1/ingest' || url.pathname === '/v1/heartbeat' || url.pathname === '/v1/skills/manifest') {
    const bodyText = request.method === 'GET' ? '' : await request.text()
    const hmac = await verifyIngestHmac(request, bodyText, env.OPERATOR_INGEST_SECRET, now, (n) => store.takeNonce(n, now))
    if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status)
    if (await store.hitRate(hmac.deviceId, now, RATE_WINDOW_MS, RATE_MAX)) {
      return json({ ok: false, error: 'rate limited' }, 429)
    }
    if (url.pathname === '/v1/heartbeat') return heartbeat(store, hmac.deviceId, bodyText, now)
    if (url.pathname === '/v1/skills/manifest') return manifest(store)
    return ingest(store, env, hmac.deviceId, bodyText, now)
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
    return html(await consolePage(store, email, now))
  }
  if (url.pathname === '/v1/admin/summary' && request.method === 'GET') {
    return json({ ok: true, ...(await summary(store, now)) })
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

async function heartbeat(store: OperatorStore, deviceId: string, bodyText: string, now: number): Promise<Response> {
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
  await store.upsertSeat({
    device_id: deviceId,
    seat_hash: String(body.seatHash || deviceId),
    os: String(body.os || 'unknown'),
    app_version: String(body.appVersion || ''),
    first_seen: now,
    last_seen: now
  })
  return json({ ok: true })
}

async function ingest(store: OperatorStore, env: Env, deviceId: string, bodyText: string, now: number): Promise<Response> {
  const body = JSON.parse(bodyText || '{}') as Record<string, unknown>
  const id = String(body.id || crypto.randomUUID())
  if (body.event === 'rating') {
    await store.updateAskRating(id, String(body.rating || ''))
    return json({ ok: true })
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
  await store.upsertSeat({
    device_id: deviceId,
    seat_hash: String(body.seatHash || deviceId),
    os: String(body.os || 'unknown'),
    app_version: String(body.appVersion || ''),
    first_seen: now,
    last_seen: now
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

async function summary(store: OperatorStore, now: number): Promise<{
  live: number
  dau: number
  costToday: string | null
  hitRate: string | null
  pending: number
}> {
  const seats = await store.listSeats()
  const live = seats.filter((s) => now - s.last_seen < ONLINE_MS).length
  const startDay = now - 24 * 60 * 60 * 1000
  const dau = seats.filter((s) => s.last_seen >= startDay).length
  const asks = await store.listAsks(2000)
  const lines: AskLogLine[] = asks.map((a) => ({
    ts: a.ts,
    cacheRead: a.cache_read ?? undefined,
    cacheWrite: a.cache_write ?? undefined,
    cacheUncached: a.cache_uncached ?? undefined,
    cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
    cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
    model: a.model ?? undefined,
    provider: a.provider ?? undefined,
    outputTokens: a.output_tokens ?? undefined
  }))
  const slice = aggregateCacheSlice(lines.filter((l) => l.ts && l.ts >= startDay))
  let saved = 0
  let anyCost = false
  for (const a of asks.filter((x) => x.ts >= startDay)) {
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
        cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    if (est) {
      anyCost = true
      saved += est.usd
    }
  }
  const pending = (await store.listProposals()).filter((p) => p.status === 'pending').length
  return {
    live,
    dau,
    costToday: anyCost ? `${formatUsdEstimate(saved)}` : null,
    hitRate: slice.hitRate == null ? null : `${Math.round(slice.hitRate * 100)}%`,
    pending
  }
}

async function consolePage(store: OperatorStore, email: string, now: number): Promise<string> {
  const s = await summary(store, now)
  const seats = (await store.listSeats()).map((row) => ({
    device_id: row.device_id,
    os: row.os,
    app_version: row.app_version,
    last_seen: row.last_seen,
    online: now - row.last_seen < ONLINE_MS
  }))
  const asks = (await store.listAsks(40)).map((a) => ({
    id: a.id,
    ts: a.ts,
    mode: a.mode || '',
    preview: a.preview || 'Ask',
    cache_status: a.cache_status || 'not-reported',
    provider: a.provider || ''
  }))
  const proposals = (await store.listProposals()).map((p) => ({
    id: p.id,
    skill_id: p.skill_id,
    from_version: p.from_version,
    status: p.status,
    rationale: p.rationale,
    diff: p.diff,
    evidence: JSON.parse(p.evidence_json || '[]') as string[]
  }))
  return renderConsole({ email, ...s, seats, asks, proposals })
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
