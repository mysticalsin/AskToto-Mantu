/**
 * POST /v1/ask — streaming Operator proxy (FRAME G5/G7/G10).
 * Same seat + vault rules as /v1/use. SSE to the seat. Never returns a vault secret.
 */
import { PROVIDERS, type ProviderId } from '../../src/shared/providers'
import { resolvePortalCloudflareModel } from '../../src/shared/ask-routing'
import { persistProxyAsk } from './ask-meter'
import { seatAuthorizedForKeys, SEAT_NOT_APPROVED } from './fleet'
import { json } from './http'
import type { OperatorStore } from './store'
import { decryptActiveLlmSecret, parseUseBody, type UseRequest } from './use'

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages'
const ASK_FETCH_TIMEOUT_MS = 120_000
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-accel-buffering': 'no'
} as const

function fail(error: string, status: number): Response {
  return json({ ok: false, error }, status)
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function leaked(blob: string, secret: string, cipher: string, iv: string): boolean {
  return blob.includes(secret) || blob.includes(cipher) || blob.includes(iv)
}

function withAskTimeout(providerFetch: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    providerFetch(input, { ...init, signal: AbortSignal.timeout(ASK_FETCH_TIMEOUT_MS) })) as typeof fetch
}

function openaiMessages(req: UseRequest): { role: string; content: string }[] {
  return [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages]
}

function upstreamUrl(provider: string, accountId: string | undefined, baseUrl: string): string | { error: string; status: number } {
  if (provider === 'cloudflare') {
    const id = (accountId || '').trim()
    if (!id) return { error: 'Operator cannot issue a use', status: 503 }
    return `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1/chat/completions`
  }
  if (provider === 'anthropic') return ANTHROPIC_MESSAGES
  const root = baseUrl.replace(/\/$/, '')
  return root.endsWith('/chat/completions') ? root : `${root}/chat/completions`
}

function upstreamInit(
  provider: string,
  secret: string,
  req: UseRequest
): { urlExtra?: never; headers: Record<string, string>; body: string } {
  if (provider === 'anthropic') {
    return {
      headers: {
        'content-type': 'application/json',
        'x-api-key': secret,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        stream: true,
        ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages
      })
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${secret}`
  }
  if (provider === 'cloudflare') headers['cf-aig-gateway-id'] = 'default'
  return {
    headers,
    body: JSON.stringify({
      model: req.model,
      messages: openaiMessages(req),
      stream: true,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {})
    })
  }
}

function usageFromPayload(parsed: Record<string, unknown>): { input?: number; output?: number } {
  const usage = parsed.usage
  if (!usage || typeof usage !== 'object') return {}
  const u = usage as Record<string, unknown>
  const input =
    typeof u.prompt_tokens === 'number'
      ? u.prompt_tokens
      : typeof u.input_tokens === 'number'
        ? u.input_tokens
        : undefined
  const output =
    typeof u.completion_tokens === 'number'
      ? u.completion_tokens
      : typeof u.output_tokens === 'number'
        ? u.output_tokens
        : undefined
  return { input, output }
}

function deltaFromPayload(parsed: Record<string, unknown>): string {
  const choices = parsed.choices
  if (Array.isArray(choices)) {
    const content = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content
    if (typeof content === 'string') return content
  }
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as { text?: unknown } | undefined
    if (typeof delta?.text === 'string') return delta.text
  }
  return ''
}

function bufferedText(data: unknown): { text: string; input?: number; output?: number } | null {
  if (!data || typeof data !== 'object') return null
  const body = data as {
    content?: unknown
    choices?: { message?: { content?: unknown } }[]
    usage?: Record<string, unknown>
  }
  let text = ''
  if (Array.isArray(body.content)) {
    text = body.content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: unknown; text?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
      .trim()
  } else if (typeof body.choices?.[0]?.message?.content === 'string') {
    text = body.choices[0].message.content.trim()
  }
  if (!text) return null
  const usage = usageFromPayload(body as Record<string, unknown>)
  return { text, input: usage.input, output: usage.output }
}

function sseResponse(
  store: OperatorStore,
  deviceId: string,
  now: number,
  req: UseRequest,
  secret: string,
  cipher: string,
  iv: string,
  upstream: Response
): Response {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let outcome = 'answered'
      const send = (obj: unknown): boolean => {
        const line = sseLine(obj)
        if (leaked(line, secret, cipher, iv)) {
          outcome = 'error'
          controller.enqueue(encoder.encode(sseLine({ t: 'error', message: 'Operator cannot issue a use' })))
          return false
        }
        controller.enqueue(encoder.encode(line))
        return true
      }
      try {
        const ctype = upstream.headers.get('content-type') || ''
        if (!upstream.body || !ctype.includes('text/event-stream')) {
          const parsed = bufferedText(await upstream.json().catch(() => null))
          if (!parsed) {
            outcome = 'error'
            send({ t: 'error', message: 'provider returned an empty answer' })
            return
          }
          inputTokens = parsed.input
          outputTokens = parsed.output
          if (parsed.text && !send({ t: 'delta', text: parsed.text })) return
          send({ t: 'done', inputTokens, outputTokens })
          return
        }
        const reader = upstream.body.getReader()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const raw of parts) {
            const trimmed = raw.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>
            } catch {
              continue
            }
            const usage = usageFromPayload(parsed)
            if (usage.input != null) inputTokens = usage.input
            if (usage.output != null) outputTokens = usage.output
            const text = deltaFromPayload(parsed)
            if (text && !send({ t: 'delta', text })) return
          }
        }
        send({ t: 'done', inputTokens, outputTokens })
      } catch {
        outcome = 'error'
        send({ t: 'error', message: 'Operator cannot issue a use' })
      } finally {
        try {
          await persistProxyAsk(store, {
            deviceId,
            now,
            provider: req.provider,
            model: req.model,
            inputTokens,
            outputTokens,
            outcome
          })
        } catch {
          /* metering must never fail the seat stream */
        }
        controller.close()
      }
    }
  })
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}

export async function handleAsk(
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
  let req = parsed.req
  if (req.provider === 'cloudflare') {
    if (req.model.startsWith('workers-ai/')) return fail('model not allowed', 400)
    req = { ...req, model: resolvePortalCloudflareModel(req.model, 'base') }
  }
  const unlocked = await decryptActiveLlmSecret(store, env.OPERATOR_VAULT_KEY, req.provider)
  if (!unlocked) return fail('Operator cannot issue a use', 503)
  const def = req.provider in PROVIDERS ? PROVIDERS[req.provider as ProviderId] : null
  if (!def || def.kind === 'cli' || def.kind === 'dust' || def.kind === 'local') {
    return fail('provider not allowed', 400)
  }
  const dest = upstreamUrl(req.provider, unlocked.accountId, def.baseUrl)
  if (typeof dest !== 'string') return fail(dest.error, dest.status)
  const init = upstreamInit(req.provider, unlocked.secret, req)
  let upstream: Response
  try {
    upstream = await withAskTimeout(providerFetch)(dest, {
      method: 'POST',
      headers: init.headers,
      body: init.body
    })
  } catch {
    return fail('Operator cannot issue a use', 503)
  }
  if (!upstream.ok) return fail('provider refused the Operator key', 502)
  await store.audit(crypto.randomUUID(), now, deviceId, 'ask', null, req.provider)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'ask',
    actor: deviceId,
    device_id: deviceId,
    country: null,
    detail: `ask ${req.provider}`
  })
  return sseResponse(store, deviceId, now, req, unlocked.secret, unlocked.row.cipher, unlocked.row.iv, upstream)
}
