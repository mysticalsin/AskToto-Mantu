import { PROVIDERS, requiresUserBaseUrl, type ProviderId } from '../../src/shared/providers'
import { operatorVisionModel, parseOperatorImage, type OperatorImage } from '../../src/shared/operator-vision'
import { ensureDefaultAiGateway } from './ai-gateway'
import { decryptVault } from './crypto'
import { seatAuthorizedForKeys, SEAT_NOT_APPROVED } from './fleet'
import { looksLikeSecret, providerRefusedPayload } from './redact'
import type { OperatorStore, VaultKeyRow } from './store'
import { persistProxyAsk } from './ask-meter'
import { decodeVaultPlaintext, isForbiddenVaultProvider, isVaultLlmProvider } from './vault'

const SYSTEM_CAP = 32_000
const MSG_CAP = 16_000
const MSG_MAX = 20
const TEXT_CAP = 64_000
/** Base64 image cap plus bounded system/history overhead. Enforced before JSON parsing/HMAC hashing. */
const REQUEST_BODY_CAP_BYTES = 6_000_000
const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages'
/** A provider call is a single request/response, never a stream, so it is bounded hard: nothing should
 *  ever hang an isolate waiting on a provider that stopped answering. */
const PROVIDER_FETCH_TIMEOUT_MS = 60_000

/** Wraps a fetch implementation so every provider call it makes carries the same abort timeout, without
 *  every call site having to remember to pass one. */
function withProviderTimeout(providerFetch: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    providerFetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS) })) as typeof fetch
}


export type UseMessage = { role: 'user' | 'assistant'; content: string }

export type UseRequest = {
  provider: string
  model: string
  system: string
  messages: UseMessage[]
  image?: OperatorImage
  temperature?: number
  maxTokens?: number
}

export type UseOk = { ok: true; text: string; inputTokens?: number; outputTokens?: number }
export type UseFail = {
  ok: false
  error: string
  status: number
  upstreamStatus?: number
  upstreamSnippet?: string
}

async function providerRefused(res: Response, secrets: readonly string[], screenshot = false): Promise<UseFail> {
  // Upstream errors can echo image/prompt content. Screenshot requests expose status only.
  const raw = screenshot ? '' : await res.text().catch(() => '')
  if (screenshot) await res.body?.cancel().catch(() => undefined)
  const fields = providerRefusedPayload(res.status, raw, secrets)
  return {
    ok: false,
    error: fields.error,
    status: 502,
    upstreamStatus: fields.upstreamStatus,
    ...(fields.upstreamSnippet ? { upstreamSnippet: fields.upstreamSnippet } : {})
  }
}

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

export async function readUseBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > REQUEST_BODY_CAP_BYTES) {
    await request.body?.cancel().catch(() => undefined)
    return null
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > REQUEST_BODY_CAP_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    reader.releaseLock()
  }
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
  for (const field of [
    'secret',
    'token',
    'apiKey',
    'api_key',
    'authorization',
    'key',
    'cf-aig-gateway-id',
    'gatewayId',
    'accountId'
  ]) {
    if (body[field] != null) return { ok: false, error: 'provider not allowed', status: 400 }
  }
  let image: OperatorImage | undefined
  if (body.image != null || body.vision === true || body.mode === 'vision') {
    if (body.mode !== 'vision') return { ok: false, error: 'A screenshot requires an explicit screen Ask.', status: 400 }
    const parsedImage = parseOperatorImage(body.image)
    if (!parsedImage.ok) return { ok: false, error: parsedImage.error, status: 400 }
    image = parsedImage.image
  }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  let model = typeof body.model === 'string' ? body.model.trim() : ''
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
  if (image) {
    const visionModel = operatorVisionModel(provider, model)
    if (!visionModel) return { ok: false, error: 'This managed model cannot read screenshots. Choose a supported vision model in Settings.', status: 400 }
    model = visionModel
  }
  const system = typeof body.system === 'string' ? clip(body.system, SYSTEM_CAP) : ''
  if (looksLikeImagePayload(system)) {
    return { ok: false, error: 'screenshots are not accepted on Operator use', status: 400 }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages required', status: 400 }
  }
  const messages: UseMessage[] = []
  for (const item of body.messages.slice(-MSG_MAX)) {
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
  if (image && messages.at(-1)?.role !== 'user') return { ok: false, error: 'A screenshot requires a final user question.', status: 400 }
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined
  const maxTokens = typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens) ? Math.min(8192, Math.max(16, Math.floor(body.maxTokens))) : undefined
  return { ok: true, req: { provider, model, system, messages, ...(image ? { image } : {}), temperature, maxTokens } }
}

export function openaiMessages(req: UseRequest): unknown[] {
  return [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    ...req.messages.map((message, index) => req.image && index === req.messages.length - 1
      ? { role: message.role, content: [
          { type: 'text', text: message.content },
          { type: 'image_url', image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` } }
        ] }
      : message)
  ]
}

export function anthropicMessages(req: UseRequest): unknown[] {
  return req.messages.map((message, index) => req.image && index === req.messages.length - 1
    ? { role: message.role, content: [
        { type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.data } },
        { type: 'text', text: message.content }
      ] }
    : message)
}

/** Keep usage metadata but never retain screenshot payloads in AI Gateway logs or cache. */
export function screenshotGatewayHeaders(req: UseRequest): Record<string, string> {
  return req.image ? { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' } : {}
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
      messages: anthropicMessages(req)
    })
  })
  if (!res.ok) return providerRefused(res, [secret], !!req.image)
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
  await ensureDefaultAiGateway(secret, id, providerFetch)
  const messages = openaiMessages(req)
  const res = await providerFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'cf-aig-gateway-id': 'default',
      ...screenshotGatewayHeaders(req)
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {})
    })
  })
  if (!res.ok) return providerRefused(res, [secret], !!req.image)
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
  const messages = openaiMessages(req)
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
  if (!res.ok) return providerRefused(res, [secret], !!req.image)
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
  const seat = await store.getSeat(deviceId)
  if (!seat || !(await seatAuthorizedForKeys(store, seat, now))) return fail(SEAT_NOT_APPROVED, 403)
  const parsed = parseUseBody(bodyText)
  if (!parsed.ok) return fail(parsed.error, parsed.status)
  const unlocked = await decryptActiveLlmSecret(store, env.OPERATOR_VAULT_KEY, parsed.req.provider)
  if (!unlocked) return fail('Operator cannot issue a use', 503)
  const def = parsed.req.provider in PROVIDERS ? PROVIDERS[parsed.req.provider as ProviderId] : null
  if (!def || def.kind === 'cli' || def.kind === 'dust' || def.kind === 'local') {
    return fail('provider not allowed', 400)
  }
  const timedFetch = withProviderTimeout(providerFetch)
  let out: { text: string; inputTokens?: number; outputTokens?: number } | UseFail
  try {
    out =
      parsed.req.provider === 'cloudflare'
        ? await callCloudflareGateway(unlocked.secret, unlocked.accountId, parsed.req, timedFetch)
        : def.kind === 'anthropic'
          ? await callAnthropic(unlocked.secret, parsed.req, timedFetch)
          : await callOpenAICompat(unlocked.secret, parsed.req, def.baseUrl, timedFetch)
  } catch {
    return fail('Operator cannot issue a use', 503)
  }
  if (!('text' in out)) {
    return json(
      {
        ok: false,
        error: out.error,
        ...(out.upstreamStatus != null ? { upstreamStatus: out.upstreamStatus } : {}),
        ...(out.upstreamSnippet ? { upstreamSnippet: out.upstreamSnippet } : {})
      },
      out.status
    )
  }
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
  try {
    await persistProxyAsk(store, {
      deviceId,
      now,
      provider: parsed.req.provider,
      model: parsed.req.model,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      outcome: 'answered'
    })
  } catch {
    /* metering must never fail the buffered use */
  }
  return json(result)
}
