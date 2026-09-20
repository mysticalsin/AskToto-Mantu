/**
 * POST /v1/decide — portal-mediated Jev decision proxy (Métis 2.0 Cap 1).
 * Seats never receive the TypeSafe key. Separate from VAULT_LLM_PROVIDERS / /v1/ask.
 *
 * Contracts: proof/METIS-2.0-CONTRACTS-CAP1.md
 * - vault id `typesafe_jev` in VAULT_DECISION_PROVIDERS only
 * - heartbeat `decisionProviders: { jev: boolean }` (flags only)
 * - templates: action_disambiguate | intel_rank | intel_score
 * - upstream: POST https://api.typesafe.ai/v1/systemone (portal only)
 */
import { decryptVault } from './crypto'
import { seatAuthorizedForKeys, SEAT_NOT_APPROVED } from './fleet'
import { json } from './http'
import { providerRefusedPayload } from './redact'
import { readOperatorSettings } from './routes/settings-store'
import type { OperatorStore, SeatRow } from './store'
import {
  DECIDE_TEMPLATES,
  JEV_PINNED_VERSION,
  TYPESAFE_JEV_PROVIDER,
  TYPESAFE_SYSTEMONE_URL,
  decodeVaultPlaintext,
  isDecideTemplate,
  type DecideTemplate
} from './vault'

const DECIDE_FETCH_TIMEOUT_MS = 12_000
const PAYLOAD_JSON_CAP = 8_000
const DEFAULT_DEADLINE_MS = 3_000
const MAX_DEADLINE_MS = 10_000

export type DecisionProvidersFlag = { jev: boolean }

export type DecideOk = {
  ok: true
  template: DecideTemplate
  result: unknown
  confidence: number | null
  provider: typeof TYPESAFE_JEV_PROVIDER
  pinnedVersion: string | null
}

function fail(error: string, status: number, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...extra }, status)
}

async function activeTypesafeJevRow(
  store: OperatorStore,
  vaultKey: string
): Promise<{ secret: string; cipher: string; iv: string } | null> {
  const rows = await store.listVaultRows()
  const row = rows.find((r) => r.provider === TYPESAFE_JEV_PROVIDER && r.status === 'active')
  if (!row) return null
  try {
    const plain = decodeVaultPlaintext(await decryptVault(row.cipher, row.iv, vaultKey))
    if (!plain.secret) return null
    return { secret: plain.secret, cipher: row.cipher, iv: row.iv }
  } catch {
    return null
  }
}

/** Portal kill switch + desktop/intel toggles via operator_settings. Defaults: enabled. */
export async function readJevPortalFlags(
  db: Parameters<typeof readOperatorSettings>[0]
): Promise<{ jevEnabled: boolean; jevDesktop: boolean; jevIntel: boolean }> {
  const { values } = await readOperatorSettings(db)
  return { jevEnabled: values.jevEnabled, jevDesktop: values.jevDesktop, jevIntel: values.jevIntel }
}

export async function decisionProvidersForSeat(
  store: OperatorStore,
  seat: SeatRow | null | undefined,
  now: number,
  opts?: { jevEnabled?: boolean; hasActiveJevKey?: boolean }
): Promise<DecisionProvidersFlag> {
  const authorized = !!(seat && (await seatAuthorizedForKeys(store, seat, now)))
  const jevEnabled = opts?.jevEnabled !== false
  let hasKey = opts?.hasActiveJevKey
  if (hasKey === undefined) {
    const meta = await store.listVaultMeta()
    hasKey = meta.some((m) => m.provider === TYPESAFE_JEV_PROVIDER && m.status === 'active')
  }
  return { jev: authorized && jevEnabled && !!hasKey }
}

function parseDecideBody(bodyText: string):
  | { ok: true; template: DecideTemplate; payload: Record<string, unknown>; deadlineMs: number }
  | { ok: false; error: string; status: number } {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText || '{}')
  } catch {
    return { ok: false, error: 'invalid json', status: 400 }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid body', status: 400 }
  const body = raw as Record<string, unknown>
  const template = typeof body.template === 'string' ? body.template.trim() : ''
  if (!isDecideTemplate(template)) {
    return { ok: false, error: `template not allowed (use ${DECIDE_TEMPLATES.join('|')})`, status: 400 }
  }
  const payload = body.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload object required', status: 400 }
  }
  const encoded = JSON.stringify(payload)
  if (encoded.length > PAYLOAD_JSON_CAP) {
    return { ok: false, error: 'payload too large', status: 413 }
  }
  let deadlineMs = DEFAULT_DEADLINE_MS
  if (typeof body.deadlineMs === 'number' && Number.isFinite(body.deadlineMs)) {
    deadlineMs = Math.max(250, Math.min(MAX_DEADLINE_MS, Math.floor(body.deadlineMs)))
  }
  return { ok: true, template, payload: payload as Record<string, unknown>, deadlineMs }
}

function extractResult(upstreamJson: unknown): { result: unknown; confidence: number | null } {
  if (!upstreamJson || typeof upstreamJson !== 'object') return { result: upstreamJson ?? null, confidence: null }
  const o = upstreamJson as Record<string, unknown>
  const confidence =
    typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? o.confidence
      : typeof o.score === 'number' && Number.isFinite(o.score)
        ? o.score
        : null
  const result = o.result !== undefined ? o.result : o.data !== undefined ? o.data : o
  return { result, confidence }
}

/** Admin Test: probe TypeSafe with a pasted secret OR the active vault row. Never returns the secret. */
export async function testTypesafeJev(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; status: number; pinnedVersion: string | null } | { ok: false; error: string; status: number }> {
  let secret = ''
  if (typeof body.secret === 'string' && body.secret.trim()) secret = body.secret.trim()
  else if (typeof body.token === 'string' && body.token.trim()) secret = body.token.trim()
  else {
    if (!env.OPERATOR_VAULT_KEY) return { ok: false, error: 'vault key missing', status: 500 }
    const unlocked = await activeTypesafeJevRow(store, env.OPERATOR_VAULT_KEY)
    if (!unlocked) return { ok: false, error: 'no active typesafe_jev key', status: 404 }
    secret = unlocked.secret
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DECIDE_FETCH_TIMEOUT_MS)
  try {
    const upstream = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        template: 'intel_score',
        payload: { probe: true, source: 'metis-operator-test' },
        ...(JEV_PINNED_VERSION ? { version: JEV_PINNED_VERSION } : {})
      }),
      signal: controller.signal,
      redirect: 'manual'
    })
    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => '')
      const fields = providerRefusedPayload(upstream.status, raw, [secret])
      return { ok: false, error: fields.error, status: 502 }
    }
    await upstream.body?.cancel().catch(() => undefined)
    return { ok: true, status: upstream.status, pinnedVersion: JEV_PINNED_VERSION }
  } catch {
    return { ok: false, error: 'typesafe unreachable', status: 503 }
  } finally {
    clearTimeout(timer)
  }
}

export async function handleDecide(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string; DB?: Parameters<typeof readOperatorSettings>[0] },
  deviceId: string,
  bodyText: string,
  now: number,
  providerFetch: typeof fetch = fetch,
  callerSignal?: AbortSignal
): Promise<Response> {
  if (!env.OPERATOR_VAULT_KEY) return fail('Operator cannot issue a decide', 503)
  const seat = await store.getSeat(deviceId)
  if (!seat || !(await seatAuthorizedForKeys(store, seat, now))) return fail(SEAT_NOT_APPROVED, 403)

  const flags = await readJevPortalFlags(env.DB)
  if (!flags.jevEnabled) return fail('decision provider disabled', 403)

  const parsed = parseDecideBody(bodyText)
  if (!parsed.ok) return fail(parsed.error, parsed.status)

  if (parsed.template.startsWith('intel_') && !flags.jevIntel) {
    return fail('jev intelligence disabled', 403)
  }
  if (parsed.template === 'action_disambiguate' && !flags.jevDesktop) {
    return fail('jev desktop disabled', 403)
  }

  const unlocked = await activeTypesafeJevRow(store, env.OPERATOR_VAULT_KEY)
  if (!unlocked) return fail('Operator cannot issue a decide', 503)

  const timeoutMs = Math.min(parsed.deadlineMs, DECIDE_FETCH_TIMEOUT_MS)
  const signals = [callerSignal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => Boolean(s))
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals)

  let upstream: Response
  try {
    upstream = await providerFetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${unlocked.secret}`
      },
      body: JSON.stringify({
        template: parsed.template,
        payload: parsed.payload,
        ...(JEV_PINNED_VERSION ? { version: JEV_PINNED_VERSION } : {})
      }),
      signal,
      redirect: 'manual'
    })
  } catch {
    return fail('Operator cannot issue a decide', 503)
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '')
    const fields = providerRefusedPayload(upstream.status, raw, [unlocked.secret, unlocked.cipher, unlocked.iv])
    return fail(fields.error, 502, {
      upstreamStatus: fields.upstreamStatus,
      ...(fields.upstreamSnippet ? { upstreamSnippet: fields.upstreamSnippet } : {})
    })
  }

  let upstreamJson: unknown
  try {
    upstreamJson = await upstream.json()
  } catch {
    return fail('Operator cannot issue a decide', 502)
  }

  const blob = JSON.stringify(upstreamJson)
  if (blob.includes(unlocked.secret) || blob.includes(unlocked.cipher) || blob.includes(unlocked.iv)) {
    return fail('Operator cannot issue a decide', 502)
  }

  const { result, confidence } = extractResult(upstreamJson)
  await store.audit(crypto.randomUUID(), now, deviceId, 'decide', null, parsed.template)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'decide',
    actor: deviceId,
    device_id: deviceId,
    country: null,
    detail: `decide ${parsed.template}`
  })

  const body: DecideOk = {
    ok: true,
    template: parsed.template,
    result,
    confidence,
    provider: TYPESAFE_JEV_PROVIDER,
    pinnedVersion: JEV_PINNED_VERSION
  }
  return json(body)
}
