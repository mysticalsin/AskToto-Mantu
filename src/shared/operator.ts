/**
 * Operator dashboard: prompt-cache honesty, local ask-log types, list-price estimates.
 * Pure. Main and renderer agree on the same mapping so a missing provider field never becomes $0.
 */

export type CacheBadge = 'hit' | 'write' | 'n/a' | 'not-reported'
export type CacheTtl = '1h' | '5m' | '30m'
export type AskOutcome = 'answered' | 'error' | 'thumbs-down'

export interface StreamCacheUsage {
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  cacheUncached?: number
  cacheStatus?: CacheBadge
  cacheTtl?: CacheTtl
}

export const DEFAULT_OPERATOR_URL = 'https://metis-operator.tony-walteur.workers.dev'

export const CF_CONNECT_PATH = '/cloudflare/connect'

/** Narrow view of Node's `process.env`, read through `globalThis` so this file compiles under a
 *  WebWorker-lib tsconfig (the Operator Worker) without pulling @types/node into that project. */
type NodeLikeGlobal = { process?: { env?: Record<string, string | undefined> } }

function nodeEnv(): Record<string, string | undefined> {
  const g = globalThis as NodeLikeGlobal
  return g.process?.env ?? {}
}

/** A seat uses its own licence. Legacy managed deployments may still supply an ingest secret. */
export function resolveOperatorCredential(
  settings: { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string },
  env: Record<string, string | undefined> = nodeEnv()
): string {
  const saved = settings.operatorLicenseToken?.trim() || settings.operatorIngestSecret?.trim()
  if (saved) return saved
  // An environment credential belongs only to its configured (or shipped default) endpoint.
  // A renderer-controlled URL override must never redirect that credential to another service.
  return resolveOperatorBaseUrl(settings, env) === resolveOperatorBaseUrl({}, env)
    ? env.METIS_OPERATOR_INGEST_SECRET?.trim() || ''
    : ''
}

/** HTTPS Operator `/cloudflare/connect`. Null if the base is not https. */
export function cloudflareConnectHref(
  settings: { operatorUrl?: string } | null | undefined = {},
  env: Record<string, string | undefined> = nodeEnv()
): string | null {
  const raw = (settings?.operatorUrl || env.METIS_OPERATOR_URL || DEFAULT_OPERATOR_URL).trim()
  if (!/^https:\/\//i.test(raw)) return null
  return `${raw.replace(/\/$/, '')}${CF_CONNECT_PATH}`
}

/**
 * HTTPS Operator base for heartbeat / ingest / skills / Open Operator.
 * Settings → METIS_OPERATOR_URL → DEFAULT_OPERATOR_URL. Whitespace-only values are empty.
 * Empty Settings still phones home to the live Worker once an ingest secret is present.
 * Non-https overrides stay empty.
 */
export function resolveOperatorBaseUrl(
  settings: { operatorUrl?: string } | null | undefined = {},
  env: Record<string, string | undefined> = nodeEnv()
): string {
  const fromSettings = settings?.operatorUrl?.trim() ?? ''
  const fromEnv = env.METIS_OPERATOR_URL?.trim() ?? ''
  const raw = (fromSettings || fromEnv || DEFAULT_OPERATOR_URL).replace(/\/$/, '')
  return /^https:\/\//i.test(raw) ? raw : ''
}

/** True when a usable HTTPS Operator base resolves (Settings, env, or shipped DEFAULT). */
export function operatorUrlConfigured(
  settings: { operatorUrl?: string } | null | undefined,
  env: Record<string, string | undefined> = nodeEnv()
): boolean {
  return Boolean(resolveOperatorBaseUrl(settings, env))
}

/** Explicit Settings/env URL only — not the shipped DEFAULT. Retained for settings compatibility. */
export function operatorUrlExplicit(
  settings: { operatorUrl?: string } | null | undefined,
  env: Record<string, string | undefined> = nodeEnv()
): boolean {
  const fromSettings = settings?.operatorUrl?.trim() ?? ''
  const fromEnv = env.METIS_OPERATOR_URL?.trim() ?? ''
  return /^https:\/\//i.test(fromSettings || fromEnv)
}

/** Legacy Ask-text compatibility hook. Metadata-only telemetry cannot be overridden by old settings. */
export function shouldSendAskText(
  _settings: { operatorUrl?: string; sendAskText?: boolean } | null | undefined,
  _env: Record<string, string | undefined> = nodeEnv()
): boolean {
  return false
}

const OPERATOR_EVENT_TYPES = new Set(['ask', 'rating', 'listen', 'recap', 'crm'])
const ASK_MODES = new Set(['answer', 'vision', 'suggest', 'summary', 'recap'])
const ASK_OUTCOMES = new Set(['answered', 'error', 'thumbs-down'])
const QUESTION_TYPES = new Set([
  'factual',
  'how-to',
  'explain',
  'compare',
  'summarize',
  'draft',
  'translate',
  'code',
  'estimate',
  'decision',
  'screen',
  'behavioral',
  'other',
  'unknown'
])
const CRM_STATUSES = new Set(['pending', 'in_progress', 'in_review', 'submitted', 'success', 'failed', 'expired'])
const CACHE_STATUSES = new Set<CacheBadge>(['hit', 'write', 'n/a', 'not-reported'])
const CACHE_TTLS = new Set<CacheTtl>(['1h', '5m', '30m'])
const LICENSE_STATES = new Set(['licensed', 'trial', 'grace', 'expired', 'unlicensed'])
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

function metadataIdentifier(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value || value.length > max || value.includes('://') || !IDENTIFIER_RE.test(value)) return undefined
  return value
}

function finiteNonNegative(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
}

function putDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

function operatorErrorClass(raw: unknown): 'transient' | 'auth' | 'rate-limit' | 'usage-cap' | 'empty-response' | 'unknown' {
  if (typeof raw !== 'string') return 'unknown'
  const value = raw.trim().toLowerCase()
  if (/rate.?limit|\b429\b|too many requests/.test(value)) return 'rate-limit'
  if (/usage.?cap|quota|credit|billing limit/.test(value)) return 'usage-cap'
  if (/empty.?response|no response|empty output/.test(value)) return 'empty-response'
  if (/\b401\b|\b403\b|auth|unauthori[sz]ed|forbidden|credential/.test(value)) return 'auth'
  if (/transient|timeout|timed out|network|econn|fetch failed|unavailable|\b5\d\d\b/.test(value)) return 'transient'
  return 'unknown'
}

function projectSeatMetadata(source: Record<string, unknown>, target: Record<string, unknown>): void {
  putDefined(target, 'seatHash', metadataIdentifier(source.seatHash, 128))
  putDefined(target, 'os', metadataIdentifier(source.os, 32))
  putDefined(target, 'appVersion', metadataIdentifier(source.appVersion, 64))
  putDefined(target, 'hostname', sanitizeOperatorHostname(source.hostname) ?? undefined)
  putDefined(target, 'ssoEmail', sanitizeOperatorSsoEmail(source.ssoEmail) ?? undefined)
  putDefined(target, 'license', typeof source.license === 'string' && LICENSE_STATES.has(source.license) ? source.license : undefined)
  putDefined(
    target,
    'licenseLast4',
    typeof source.licenseLast4 === 'string' && /^[A-Za-z0-9]{4}$/.test(source.licenseLast4)
      ? source.licenseLast4
      : undefined
  )
  putDefined(
    target,
    'licenseId',
    typeof source.licenseId === 'string' && /^[a-f0-9]{16}$/.test(source.licenseId) ? source.licenseId : undefined
  )
  const lastIndexAt = finiteNonNegative(source.lastIndexAt)
  putDefined(target, 'lastIndexAt', lastIndexAt && lastIndexAt > 0 ? lastIndexAt : undefined)
}

/**
 * Desktop-to-Operator `/v1/ingest` privacy boundary. It constructs a new object from approved
 * metadata fields only; unknown, nested and content-bearing fields therefore have no serialization
 * path. `null` means the event cannot be represented safely and should be treated as consumed.
 */
export function projectOperatorIngestMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const event = source.event === undefined ? 'ask' : source.event
  if (typeof event !== 'string' || !OPERATOR_EVENT_TYPES.has(event)) return null
  const id = metadataIdentifier(source.id, 128)
  if (!id) return null

  const projected: Record<string, unknown> = event === 'ask' ? { id } : { event, id }
  putDefined(projected, 'ts', finiteNonNegative(source.ts))

  if (event === 'rating') {
    if (source.rating !== 'up' && source.rating !== 'down') return null
    projected.rating = source.rating
  } else if (event === 'listen' || event === 'recap') {
    putDefined(projected, 'minutes', finiteNonNegative(source.minutes))
  } else if (event === 'crm') {
    if (typeof source.status !== 'string' || !CRM_STATUSES.has(source.status)) return null
    projected.status = source.status
    putDefined(projected, 'connector', metadataIdentifier(source.connector, 32))
    putDefined(projected, 'attempt', finiteNonNegative(source.attempt))
    putDefined(projected, 'latencyMs', finiteNonNegative(source.latencyMs))
    if (source.credentialSource === 'operator' || source.credentialSource === 'local') {
      projected.credentialSource = source.credentialSource
    }
    if (source.error !== undefined) projected.error = operatorErrorClass(source.error)
  } else {
    putDefined(projected, 'mode', typeof source.mode === 'string' && ASK_MODES.has(source.mode) ? source.mode : undefined)
    putDefined(projected, 'skillId', metadataIdentifier(source.skillId, 80))
    putDefined(projected, 'skillVersion', metadataIdentifier(source.skillVersion, 40))
    putDefined(projected, 'provider', metadataIdentifier(source.provider, 48))
    putDefined(projected, 'model', metadataIdentifier(source.model, 120))
    for (const key of ['ttftMs', 'totalMs', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'cacheUncached']) {
      putDefined(projected, key, finiteNonNegative(source[key]))
    }
    putDefined(
      projected,
      'cacheStatus',
      typeof source.cacheStatus === 'string' && CACHE_STATUSES.has(source.cacheStatus as CacheBadge)
        ? source.cacheStatus
        : undefined
    )
    putDefined(
      projected,
      'cacheTtl',
      typeof source.cacheTtl === 'string' && CACHE_TTLS.has(source.cacheTtl as CacheTtl) ? source.cacheTtl : undefined
    )
    putDefined(
      projected,
      'outcome',
      typeof source.outcome === 'string' && ASK_OUTCOMES.has(source.outcome) ? source.outcome : undefined
    )
    projected.questionType =
      typeof source.questionType === 'string' && QUESTION_TYPES.has(source.questionType) ? source.questionType : 'unknown'
    if (source.error !== undefined) projected.error = operatorErrorClass(source.error)
  }

  projectSeatMetadata(source, projected)
  return projected
}

export function promptCacheKey(mode: string, skillLockHash: string): string {
  return `metis:${mode}:${skillLockHash}`
}

/** Cloud OpenAI only. llama-server and random OpenAI-compatible hosts are not this path. */
export function isOpenAICloudCacheEligible(
  providerId: string,
  kind: string,
  hasLlamaSlots: boolean
): boolean {
  return providerId === 'openai' && kind === 'openai' && !hasLlamaSlots
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function badgeFromFields(read?: number, write?: number, uncached?: number, forced?: CacheBadge): CacheBadge {
  if (forced) return forced
  if (read === undefined && write === undefined && uncached === undefined) return 'not-reported'
  if ((read ?? 0) > 0) return 'hit'
  if ((write ?? 0) > 0) return 'write'
  return 'write'
}

export function cacheBadge(u: StreamCacheUsage): CacheBadge {
  if (u.cacheStatus === 'n/a' || u.cacheStatus === 'not-reported') return u.cacheStatus
  return badgeFromFields(u.cacheRead, u.cacheWrite, u.cacheUncached, u.cacheStatus)
}

export function naCacheUsage(inputTokens?: number, outputTokens?: number): StreamCacheUsage {
  return { inputTokens, outputTokens, cacheStatus: 'n/a' }
}

/**
 * Anthropic: input_tokens is the uncached remainder. Do not treat it as total prompt size.
 * Missing cache_* fields stay undefined. A literal 0 from the provider is kept.
 */
export function mapAnthropicUsage(usage: unknown, ttl: CacheTtl = '1h'): StreamCacheUsage {
  if (!usage || typeof usage !== 'object') {
    return { cacheStatus: 'not-reported', cacheTtl: ttl }
  }
  const u = usage as Record<string, unknown>
  const creation = u.cache_creation && typeof u.cache_creation === 'object' ? (u.cache_creation as Record<string, unknown>) : null
  const ttlWrite =
    asInt(creation?.ephemeral_1h_input_tokens) ?? asInt(creation?.ephemeral_5m_input_tokens)
  const cacheWrite = asInt(u.cache_creation_input_tokens) ?? ttlWrite
  const cacheRead = asInt(u.cache_read_input_tokens)
  const cacheUncached = asInt(u.input_tokens)
  const inputTokens =
    cacheUncached !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (cacheUncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined
  return {
    inputTokens,
    outputTokens: asInt(u.output_tokens),
    cacheRead,
    cacheWrite,
    cacheUncached,
    cacheStatus: badgeFromFields(cacheRead, cacheWrite, cacheUncached),
    cacheTtl: ttl
  }
}

/**
 * OpenAI / OpenAI-compatible: cached_tokens from prompt_tokens_details or input_tokens_details.
 * cache_write_tokens when present. Missing = undefined. Never mint 0 as a fake miss.
 */
export function mapOpenAIUsage(usage: unknown): StreamCacheUsage {
  if (!usage || typeof usage !== 'object') {
    return { cacheStatus: 'not-reported' }
  }
  const u = usage as Record<string, unknown>
  const details =
    (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null) ??
    (u.input_tokens_details && typeof u.input_tokens_details === 'object'
      ? (u.input_tokens_details as Record<string, unknown>)
      : null)
  const cacheRead = details ? asInt(details.cached_tokens) : asInt(u.cached_tokens)
  const cacheWrite = asInt(u.cache_write_tokens) ?? (details ? asInt(details.cache_write_tokens) : undefined)
  const promptTokens = asInt(u.prompt_tokens) ?? asInt(u.input_tokens)
  const cacheUncached =
    promptTokens !== undefined && cacheRead !== undefined
      ? Math.max(0, promptTokens - cacheRead - (cacheWrite ?? 0))
      : promptTokens !== undefined && cacheWrite === undefined && cacheRead === undefined
        ? undefined
        : promptTokens
  return {
    inputTokens: promptTokens,
    outputTokens: asInt(u.completion_tokens) ?? asInt(u.output_tokens),
    cacheRead,
    cacheWrite,
    cacheUncached,
    cacheStatus: badgeFromFields(cacheRead, cacheWrite, cacheUncached)
  }
}

export function unsupportedCacheUsage(inputTokens?: number, outputTokens?: number): StreamCacheUsage {
  return { inputTokens, outputTokens, cacheStatus: 'not-reported' }
}

/** Published list-price multipliers. Labeled estimate only. Never an invoice. */
export const CACHE_PRICE_MULT = {
  anthropic5mWrite: 1.25,
  anthropic1hWrite: 2,
  anthropicRead: 0.1,
  openaiWrite: 1.25,
  openaiRead: 0.5
} as const

/** Small published list-price table, USD per million tokens. Family prefixes only. */
export const LIST_PRICE_TABLE: {
  test: (model: string) => boolean
  inputPerMTok: number
  outputPerMTok: number
  cachedInPerMTok?: number
  family: string
}[] = [
  { test: (m) => /@cf\/deepseek-ai\/deepseek-v4-flash/i.test(m), inputPerMTok: 0.44, outputPerMTok: 1.32, cachedInPerMTok: 0.014, family: 'Workers AI DeepSeek V4 Flash' },
  { test: (m) => /@cf\/deepseek-ai\/deepseek-v4-pro/i.test(m), inputPerMTok: 1.32, outputPerMTok: 3.96, cachedInPerMTok: 0.044, family: 'Workers AI DeepSeek V4 Pro' },
  { test: (m) => /deepseek-v4-flash/i.test(m), inputPerMTok: 0.14, outputPerMTok: 0.28, family: 'DeepSeek V4 Flash' },
  { test: (m) => /deepseek-v4-pro/i.test(m), inputPerMTok: 0.55, outputPerMTok: 2.19, family: 'DeepSeek V4 Pro' },
  { test: (m) => /claude-opus/i.test(m), inputPerMTok: 15, outputPerMTok: 75, family: 'Claude Opus' },
  { test: (m) => /claude-sonnet/i.test(m), inputPerMTok: 3, outputPerMTok: 15, family: 'Claude Sonnet' },
  { test: (m) => /claude-haiku/i.test(m), inputPerMTok: 1, outputPerMTok: 5, family: 'Claude Haiku' },
  { test: (m) => /gpt-5|o3|o4/i.test(m), inputPerMTok: 10, outputPerMTok: 30, family: 'OpenAI reasoning' },
  { test: (m) => /gpt-4o|gpt-4\.1/i.test(m), inputPerMTok: 2.5, outputPerMTok: 10, family: 'GPT-4o' },
  { test: (m) => /gpt-4/i.test(m), inputPerMTok: 10, outputPerMTok: 30, family: 'GPT-4' }
]

export function listPriceFor(model: string): {
  inputPerMTok: number
  outputPerMTok: number
  cachedInPerMTok?: number
  family: string
} | null {
  return LIST_PRICE_TABLE.find((row) => row.test(model)) ?? null
}

/**
 * Token list-price estimate. Null when tokens or a price row are missing.
 * Never returns a $0 invent — missing stays not reported.
 */
export function estimateListPrice(
  model: string,
  inputTokens?: number | null,
  outputTokens?: number | null,
  cacheRead?: number | null
): CostEstimate | null {
  const price = listPriceFor(model)
  if (!price) return null
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  const cached = cacheRead ?? 0
  if (input <= 0 && output <= 0 && cached <= 0) return null
  const cachedRate = price.cachedInPerMTok ?? price.inputPerMTok
  const uncached = Math.max(0, input - cached)
  const usd =
    (uncached / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (output / 1_000_000) * price.outputPerMTok
  if (!(usd > 0)) return null
  return { usd, savedUsd: 0, label: 'estimate, list price', family: price.family }
}

export interface CostEstimate {
  usd: number
  savedUsd: number
  label: 'estimate, list price'
  family: string
}

/**
 * Estimate spend and cache savings from REAL fields. Returns null when cache fields were not reported
 * so the UI can hide rather than show $0.00.
 */
export function estimateCacheCost(
  u: StreamCacheUsage,
  model: string,
  provider?: string
): CostEstimate | null {
  if (u.cacheStatus === 'n/a' || u.cacheStatus === 'not-reported') return null
  if (u.cacheRead === undefined && u.cacheWrite === undefined && u.cacheUncached === undefined) return null
  const price = listPriceFor(model)
  if (!price) return null
  const read = u.cacheRead ?? 0
  const write = u.cacheWrite ?? 0
  const uncached = u.cacheUncached ?? 0
  const out = u.outputTokens ?? 0
  const isAnthropic = provider === 'anthropic' || /claude/i.test(model)
  const writeMult = isAnthropic
    ? u.cacheTtl === '5m'
      ? CACHE_PRICE_MULT.anthropic5mWrite
      : CACHE_PRICE_MULT.anthropic1hWrite
    : CACHE_PRICE_MULT.openaiWrite
  const readMult = isAnthropic ? CACHE_PRICE_MULT.anthropicRead : CACHE_PRICE_MULT.openaiRead
  const inputUsd = (tok: number, mult: number): number => (tok / 1_000_000) * price.inputPerMTok * mult
  const spend =
    inputUsd(uncached, 1) + inputUsd(write, writeMult) + inputUsd(read, readMult) + (out / 1_000_000) * price.outputPerMTok
  const fullInput = inputUsd(uncached + write + read, 1)
  const cachedInput = inputUsd(uncached, 1) + inputUsd(write, writeMult) + inputUsd(read, readMult)
  return {
    usd: spend,
    savedUsd: fullInput - cachedInput,
    label: 'estimate, list price',
    family: price.family
  }
}

export function formatUsdEstimate(n: number): string {
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.01) return `${n < 0 ? '-' : ''}≈$0.01`
  return `≈$${abs.toFixed(2)}`
}

export interface AskLogLine {
  event?: 'ask' | 'rating'
  id?: string
  askId?: string
  ts: number
  mode?: string
  skillId?: string
  skillVersion?: string
  provider?: string
  model?: string
  ttftMs?: number
  totalMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  cacheUncached?: number
  cacheStatus?: CacheBadge
  cacheTtl?: CacheTtl
  rating?: 'up' | 'down'
  question?: string
  outcome?: AskOutcome
}

export type SkillProposalStatus = 'pending' | 'approved' | 'rejected'

export interface SkillProposal {
  id: string
  skillId: string
  fromVersion: string
  evidence: string[]
  diff: string
  rationale: string
  status: SkillProposalStatus
  rejectReason?: string
  createdAt: number
  decidedAt?: number
}

export interface OperatorCacheSlice {
  asks: number
  reported: number
  hitRate: number | null
  tokensRead: number
  tokensWrite: number
  tokensUncached: number
  ttftHitP50Ms: number | null
  ttftHitP95Ms: number | null
  ttftMissP50Ms: number | null
  ttftMissP95Ms: number | null
  ttftNaP50Ms: number | null
  ttftNaP95Ms: number | null
}

export interface OperatorDashboard {
  enabled: boolean
  windowDays: 7
  cache: OperatorCacheSlice
  byProvider: Record<string, OperatorCacheSlice>
  byMode: Record<string, OperatorCacheSlice>
  cost: { usd: number; savedUsd: number; label: 'estimate, list price'; hidden: boolean }
  proposals: SkillProposal[]
  asks: AskLogLine[]
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export function emptyCacheSlice(): OperatorCacheSlice {
  return {
    asks: 0,
    reported: 0,
    hitRate: null,
    tokensRead: 0,
    tokensWrite: 0,
    tokensUncached: 0,
    ttftHitP50Ms: null,
    ttftHitP95Ms: null,
    ttftMissP50Ms: null,
    ttftMissP95Ms: null,
    ttftNaP50Ms: null,
    ttftNaP95Ms: null
  }
}

export function aggregateCacheSlice(lines: AskLogLine[]): OperatorCacheSlice {
  const hit: number[] = []
  const miss: number[] = []
  const na: number[] = []
  let read = 0
  let write = 0
  let uncached = 0
  let reported = 0
  let asks = 0
  for (const line of lines) {
    if (line.event === 'rating') continue
    asks++
    const badge = cacheBadge({
      cacheRead: line.cacheRead,
      cacheWrite: line.cacheWrite,
      cacheUncached: line.cacheUncached,
      cacheStatus: line.cacheStatus
    })
    if (badge === 'n/a') {
      if (typeof line.ttftMs === 'number') na.push(line.ttftMs)
      continue
    }
    if (badge === 'not-reported') continue
    reported++
    if (typeof line.cacheRead === 'number') read += line.cacheRead
    if (typeof line.cacheWrite === 'number') write += line.cacheWrite
    if (typeof line.cacheUncached === 'number') uncached += line.cacheUncached
    if (typeof line.ttftMs === 'number') {
      if (badge === 'hit') hit.push(line.ttftMs)
      else miss.push(line.ttftMs)
    }
  }
  const denom = read + write + uncached
  return {
    asks,
    reported,
    hitRate: denom > 0 ? read / denom : null,
    tokensRead: read,
    tokensWrite: write,
    tokensUncached: uncached,
    ttftHitP50Ms: percentile(hit, 50),
    ttftHitP95Ms: percentile(hit, 95),
    ttftMissP50Ms: percentile(miss, 50),
    ttftMissP95Ms: percentile(miss, 95),
    ttftNaP50Ms: percentile(na, 50),
    ttftNaP95Ms: percentile(na, 95)
  }
}

/** Seat hostname from `os.hostname()`. Letters, digits, dot, hyphen, underscore. Max 64. */
export function sanitizeOperatorHostname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const host = raw.trim().slice(0, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host)) return null
  return host
}

/** SSO email from the seat session. Never invent one. Max 120. */
export function sanitizeOperatorSsoEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase().slice(0, 120)
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null
  return email
}
