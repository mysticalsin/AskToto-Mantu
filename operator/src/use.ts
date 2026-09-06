import { PROVIDERS, requiresUserBaseUrl, type ProviderId } from '../../src/shared/providers'
import { decryptVault } from './crypto'
import { seatAuthorizedForKeys, SEAT_NOT_APPROVED } from './fleet'
import { looksLikeSecret } from './redact'
import type { OperatorStore, VaultKeyRow } from './store'
import { decodeVaultPlaintext, isForbiddenVaultProvider, isVaultLlmProvider } from './vault'

const SYSTEM_CAP = 32_000
const MSG_CAP = 16_000
const MSG_MAX = 20
const TEXT_CAP = 64_000
const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages'

export type UseMessage = { role: 'user' | 'assistant'; content: string }

export type UseRequest = {
  provider: string
  model: string
  system: string
  messages: UseMessage[]
  temperature?: number
  maxTokens?: number
}

export type UseOk = { ok: true; text: string; inputTokens?: number; outputTokens?: number }
export type UseFail = { ok: false; error: string; status: number }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function fail(error: string, status: number): Response {
  return json({ ok: false, error }, status)
}

function clip(raw: string, cap: number): string {
  return raw.length <= cap ? raw : raw.slice(0, cap)
}

function looksLikeImagePayload(raw: string): boolean {
  const s = raw.toLowerCase()
  return (
    s.includes('data:image/') ||
    s.includes('"type":"image"') ||
    s.includes('"image_url"') ||
    s.includes('"source":{"type":"base64"')
  )
}

export function parseUseBody(bodyText: string): { ok: true; req: UseRequest } | UseFail {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { ok: false, error: 'invalid json', status: 400 }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'invalid json', status: 400 }
  const body = parsed as Record<string, unknown>
  if (body.image != null || body.vision === true || body.mode === 'vision') {
    return { ok: false, error: 'screenshots are not accepted on Operator use', status: 400 }
  }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!provider || !model) return { ok: false, error: 'provider and model required', status: 400 }
  if (looksLikeSecret(provider) || looksLikeSecret(model)) {
    return { ok: false, error: 'provider not allowed', status: 400 }
  }
  if (isForbiddenVaultProvider(provider) || !isVaultLlmProvider(provider) || provider === 'custom') {
    return { ok: false, error: 'provider not allowed', status: 400 }
  }
  if (provider !== 'cloudflare' && provider in PROVIDERS && requiresUserBaseUrl(provider as ProviderId)) {
    return { ok: false, error: 'provider not allowed', status: 400 }
  }
  const system = typeof body.system === 'string' ? clip(body.system, SYSTEM_CAP) : ''
  if (looksLikeImagePayload(system)) {
    return { ok: false, error: 'screenshots are not accepted on Operator use', status: 400 }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages required', status: 400 }
  }
  const messages: UseMessage[] = []
  for (const item of body.messages.slice(0, MSG_MAX)) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : ''
    const content = typeof row.content === 'string' ? clip(row.content, MSG_CAP) : ''
    if (!role || !content) continue
    if (looksLikeImagePayload(content)) {
      return { ok: false, error: 'screenshots are not accepted on Operator use', status: 400 }
    }
    messages.push({ role, content })
  }
  if (!messages.length) return { ok: false, error: 'messages required', status: 400 }
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined
  const maxTokens = typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens) ? Math.min(8192, Math.max(16, Math.floor(body.maxTokens))) : undefined
  return { ok: true, req: { provider, model, system, messages, temperature, maxTokens } }
}

export async function decryptActiveLlmSecret(
  store: OperatorStore,
  vaultKey: string,
  provider: string
): Promise<{ secret: string; accountId?: string; row: VaultKeyRow } | null> {
  const rows = await store.listVaultRows()
  const row = rows.find((r) => r.provider === provider && r.status === 'active')
  if (!row) return null
  try {
    const plain = decodeVaultPlaintext(await decryptVault(row.cipher, row.iv, vaultKey))
    if (!plain.secret) return null
    return { secret: plain.secret, accountId: plain.accountId, row }
  } catch {
    return null
  }
}

function publicUseResult(text: string, inputTokens?: number, outputTokens?: number): UseOk {
  return {
    ok: true,
    text: clip(text, TEXT_CAP),
    ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
    ...(typeof outputTokens === 'number' ? { outputTokens } : {})
  }
}

function anthropicText(data: unknown): { text: string; inputTokens?: number; outputTokens?: number } | null {
  if (!data || typeof data !== 'object') return null
  const body = data as { content?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
  const blocks = Array.isArray(body.content) ? body.content : []
  const text = blocks
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown; text?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim()
  if (!text) return null
  return {
    text,
    inputTokens: typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : undefined,
    outputTokens: typeof body.usage?.output_tokens === 'number' ? body.usage.output_tokens : undefined
  }
}

function openaiText(data: unknown): { text: string; inputTokens?: number; outputTokens?: number } | null {
  if (!data || typeof data !== 'object') return null
  const body = data as {
    choices?: { message?: { content?: unknown } }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const text = typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content.trim() : ''
  if (!text) return null
  return {
    text,
    inputTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : undefined,
    outputTokens: typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : undefined
  }
}

async function callAnthropic(
  secret: string,
  req: UseRequest,
  providerFetch: typeof fetch
): Promise<{ text: string; inputTokens?: number; outputTokens?: number } | UseFail> {
  const res = await providerFetch(ANTHROPIC_MESSAGES, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages
    })
  })
  if (!res.ok) return { ok: false, error: 'provider refused the Operator key', status: 502 }
  const parsed = anthropicText(await res.json().catch(() => null))
  if (!parsed) return { ok: false, error: 'provider returned an empty answer', status: 502 }
  return parsed
}

async function callCloudflareGateway(
  secret: string,
  accountId: string | undefined,
  req: UseRequest,
  providerFetch: typeof fetch
): Promise<{ text: string; inputTokens?: number; outputTokens?: number } | UseFail> {
  const id = (accountId || '').trim()
  if (!id) return { ok: false, error: 'Operator cannot issue a use', status: 503 }
  const url = `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1/chat/completions`
  const messages = [...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...req.messages]
  const res = await providerFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'cf-aig-gateway-id': 'default'
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {})
    })
  })
  if (!res.ok) return { ok: false, error: 'provider refused the Operator key', status: 502 }
  const parsed = openaiText(await res.json().catch(() => null))
  if (!parsed) return { ok: false, error: 'provider returned an empty answer', status: 502 }
  return parsed
}

async function callOpenAICompat(
  secret: string,
  req: UseRequest,
  baseUrl: string,
  providerFetch: typeof fetch
): Promise<{ text: string; inputTokens?: number; outputTokens?: number } | UseFail> {
  const root = baseUrl.replace(/\/$/, '')
  const url = root.endsWith('/chat/completions') ? root : `${root}/chat/completions`
  const messages = [...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...req.messages]
  const res = await providerFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {})
    })
  })
  if (!res.ok) return { ok: false, error: 'provider refused the Operator key', status: 502 }
  const parsed = openaiText(await res.json().catch(() => null))
  if (!parsed) return { ok: false, error: 'provider returned an empty answer', status: 502 }
  return parsed
}

export async function handleUse(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  deviceId: string,
  bodyText: string,
  now: number,
  providerFetch: typeof fetch = fetch
): Promise<Response> {
  if (!env.OPERATOR_VAULT_KEY) return fail('Operator cannot issue a use', 503)
  const seats = await store.listSeats()
  const seat = seats.find((s) => s.device_id === deviceId)
  if (!seat || !(await seatAuthorizedForKeys(store, seat, now))) return fail(SEAT_NOT_APPROVED, 403)
  const parsed = parseUseBody(bodyText)
  if (!parsed.ok) return fail(parsed.error, parsed.status)
  const unlocked = await decryptActiveLlmSecret(store, env.OPERATOR_VAULT_KEY, parsed.req.provider)
  if (!unlocked) return fail('Operator cannot issue a use', 503)
  const def = parsed.req.provider in PROVIDERS ? PROVIDERS[parsed.req.provider as ProviderId] : null
  if (!def || def.kind === 'cli' || def.kind === 'dust' || def.kind === 'local') {
    return fail('provider not allowed', 400)
  }
  let out: { text: string; inputTokens?: number; outputTokens?: number } | UseFail
  try {
    out =
      parsed.req.provider === 'cloudflare'
        ? await callCloudflareGateway(unlocked.secret, unlocked.accountId, parsed.req, providerFetch)
        : def.kind === 'anthropic'
          ? await callAnthropic(unlocked.secret, parsed.req, providerFetch)
          : await callOpenAICompat(unlocked.secret, parsed.req, def.baseUrl, providerFetch)
  } catch {
    return fail('Operator cannot issue a use', 503)
  }
  if (!('text' in out)) return fail(out.error, out.status)
  const result = publicUseResult(out.text, out.inputTokens, out.outputTokens)
  const blob = JSON.stringify(result)
  if (blob.includes(unlocked.secret) || blob.includes(unlocked.row.cipher) || blob.includes(unlocked.row.iv)) {
    return fail('Operator cannot issue a use', 503)
  }
  await store.audit(crypto.randomUUID(), now, deviceId, 'use', null, parsed.req.provider)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'use',
    actor: deviceId,
    device_id: deviceId,
    country: null,
    detail: `use ${parsed.req.provider}`
  })
  return json(result)
}
