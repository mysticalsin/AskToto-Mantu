/**
 * POST /v1/ask — streaming Operator proxy (FRAME G5/G7/G10).
 * Same seat + vault rules as /v1/use. SSE to the seat. Never returns a vault secret.
 */
import { PROVIDERS, type ProviderId } from '../../src/shared/providers'
import { resolvePortalCloudflareModel } from '../../src/shared/ask-routing'
import { persistProxyAsk } from './ask-meter'
import { ensureDefaultAiGateway } from './ai-gateway'
import { seatAuthorizedForKeys, SEAT_NOT_APPROVED } from './fleet'
import { json } from './http'
import { providerRefusedPayload } from './redact'
import type { OperatorStore } from './store'
import { anthropicMessages, decryptActiveLlmSecret, openaiMessages, parseUseBody, screenshotGatewayHeaders, type UseRequest } from './use'

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages'
const ASK_FETCH_TIMEOUT_MS = 120_000
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-accel-buffering': 'no'
} as const

function fail(error: string, status: number, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...extra }, status)
}

async function providerRefusedResponse(upstream: Response, secrets: readonly string[], screenshot = false): Promise<Response> {
  const raw = screenshot ? '' : await upstream.text().catch(() => '')
  if (screenshot) await upstream.body?.cancel().catch(() => undefined)
  const fields = providerRefusedPayload(upstream.status, raw, secrets)
  return fail(fields.error, 502, {
    upstreamStatus: fields.upstreamStatus,
    ...(fields.upstreamSnippet ? { upstreamSnippet: fields.upstreamSnippet } : {})
  })
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function leaked(blob: string, secret: string, cipher: string, iv: string): boolean {
  return blob.includes(secret) || blob.includes(cipher) || blob.includes(iv)
}

function withAskTimeout(providerFetch: typeof fetch, callerSignal?: AbortSignal): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const signals = [init?.signal, callerSignal, AbortSignal.timeout(ASK_FETCH_TIMEOUT_MS)].filter(
      (signal): signal is AbortSignal => Boolean(signal)
    )
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    return providerFetch(input, { ...init, redirect: 'manual', signal })
  }) as typeof fetch
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
        messages: anthropicMessages(req)
      })
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${secret}`
  }
  if (provider === 'cloudflare') Object.assign(headers, { 'cf-aig-gateway-id': 'default' }, screenshotGatewayHeaders(req))
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

function bufferedResult(
  provider: string,
  data: unknown
): { text: string; finishReason?: string; input?: number; output?: number } | null {
  if (!data || typeof data !== 'object') return null
  const body = data as {
    content?: unknown
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]
    stop_reason?: unknown
    usage?: Record<string, unknown>
  }
  let text = ''
  if (Array.isArray(body.content)) {
    let malformedTextBlock = false
    text = body.content
      .map((b) => {
        if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'text') return ''
        const blockText = (b as { text?: unknown }).text
        if (typeof blockText !== 'string') {
          malformedTextBlock = true
          return ''
        }
        return blockText
      })
      .join('')
      .trim()
    if (malformedTextBlock) return null
  } else if (typeof body.choices?.[0]?.message?.content === 'string') {
    text = body.choices[0].message.content.trim()
  }
  const usage = usageFromPayload(body as Record<string, unknown>)
  const rawReason = provider === 'anthropic' ? body.stop_reason : body.choices?.[0]?.finish_reason
  return {
    text,
    ...(typeof rawReason === 'string' ? { finishReason: rawReason } : {}),
    input: usage.input,
    output: usage.output
  }
}

function streamFinishReason(provider: string, parsed: Record<string, unknown>): string | undefined {
  if (provider === 'anthropic') {
    if (parsed.type !== 'message_delta' || !parsed.delta || typeof parsed.delta !== 'object') return undefined
    const reason = (parsed.delta as { stop_reason?: unknown }).stop_reason
    return typeof reason === 'string' ? reason : undefined
  }
  const choices = parsed.choices
  if (!Array.isArray(choices)) return undefined
  const reason = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason
  return typeof reason === 'string' ? reason : undefined
}

function isNaturalCompletion(provider: string, finishReason: string | undefined): finishReason is string {
  if (provider === 'anthropic') return finishReason === 'end_turn' || finishReason === 'stop_sequence'
  return finishReason === 'stop'
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
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let outcome = 'answered'
  let cancelled = false
  let persisted = false
  const protectedValues = [secret, cipher, iv].filter(Boolean)
  const protectedTailLength = Math.max(0, ...protectedValues.map((value) => value.length - 1))

  const persist = async () => {
    if (persisted) return
    persisted = true
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
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pendingText = ''
      let outputBlocked = false
      const send = (obj: unknown): boolean => {
        if (cancelled) return false
        const line = sseLine(obj)
        if (leaked(line, secret, cipher, iv)) {
          outcome = 'error'
          controller.enqueue(encoder.encode(sseLine({ t: 'error', message: 'Operator cannot issue a use' })))
          return false
        }
        controller.enqueue(encoder.encode(line))
        return true
      }

      const flushText = (): boolean => {
        if (!pendingText) return true
        const text = pendingText
        pendingText = ''
        return send({ t: 'delta', text })
      }

      const queueText = (text: string): boolean => {
        pendingText += text
        if (protectedValues.some((value) => pendingText.includes(value))) {
          outputBlocked = true
          outcome = 'error'
          send({ t: 'error', message: 'Operator cannot issue a use' })
          return false
        }
        const readyLength = pendingText.length - protectedTailLength
        if (readyLength <= 0) return true
        const ready = pendingText.slice(0, readyLength)
        pendingText = pendingText.slice(readyLength)
        return send({ t: 'delta', text: ready })
      }

      const incomplete = (finishReason: string) => {
        outcome = 'error'
        if (!outputBlocked && !flushText()) return
        send({
          t: 'error',
          message: 'Provider response was incomplete. Please retry.',
          status: 'incomplete',
          finishReason,
          retryable: true
        })
      }

      const pump = async () => {
        try {
          const ctype = upstream.headers.get('content-type') || ''
          if (!upstream.body || !ctype.includes('text/event-stream')) {
            if (!upstream.body) {
              incomplete('malformed_payload')
              return
            }
            upstreamReader = upstream.body.getReader()
            let raw = ''
            for (;;) {
              const { done, value } = await upstreamReader.read()
              if (done) break
              raw += decoder.decode(value, { stream: true })
            }
            raw += decoder.decode()
            const data = (() => {
              try {
                return JSON.parse(raw) as unknown
              } catch {
                return null
              }
            })()
            const parsed = bufferedResult(req.provider, data)
            if (!parsed) {
              incomplete('malformed_payload')
              return
            }
            inputTokens = parsed.input
            outputTokens = parsed.output
            if (parsed.text && !queueText(parsed.text)) return
            if (!parsed.text.trim()) {
              incomplete('empty_output')
              return
            }
            if (!isNaturalCompletion(req.provider, parsed.finishReason)) {
              incomplete(parsed.finishReason ?? 'unexpected_eof')
              return
            }
            if (!flushText()) return
            send({
              t: 'done',
              status: 'complete',
              finishReason: parsed.finishReason,
              inputTokens,
              outputTokens
            })
            return
          }

          upstreamReader = upstream.body.getReader()
          let buf = ''
          let finishReason: string | undefined
          let sawAnthropicStop = false
          let substantiveOutput = false
          let malformedPayload = false
          let terminalError: 'conflicting_terminal' | 'out_of_order_terminal' | undefined
          let sawOpenAiDone = false
          let terminalReached = false

          const processLine = (raw: string): boolean => {
            const trimmed = raw.trim()
            if (!trimmed.startsWith('data:')) return true
            const payload = trimmed.slice(5).trim()
            if (!payload) return true
            if (terminalReached) {
              terminalError ??= 'out_of_order_terminal'
              return true
            }
            if (payload === '[DONE]') {
              if (req.provider === 'anthropic' || sawOpenAiDone || !finishReason) {
                terminalError ??= 'out_of_order_terminal'
              }
              sawOpenAiDone = true
              terminalReached = true
              return true
            }
            if (sawOpenAiDone) terminalError ??= 'out_of_order_terminal'
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>
            } catch {
              malformedPayload = true
              return true
            }
            const usage = usageFromPayload(parsed)
            if (usage.input != null) inputTokens = usage.input
            if (usage.output != null) outputTokens = usage.output
            const reason = streamFinishReason(req.provider, parsed)
            if (reason) {
              if (sawAnthropicStop) terminalError ??= 'out_of_order_terminal'
              if (finishReason && finishReason !== reason) terminalError ??= 'conflicting_terminal'
              else finishReason ??= reason
            }
            if (req.provider === 'anthropic' && parsed.type === 'message_stop') {
              if (sawAnthropicStop) terminalError ??= 'out_of_order_terminal'
              sawAnthropicStop = true
              terminalReached = true
            }
            const text = deltaFromPayload(parsed)
            if (text && (finishReason || sawAnthropicStop)) terminalError ??= 'out_of_order_terminal'
            if (text.trim()) substantiveOutput = true
            return !text || queueText(text)
          }

          for (;;) {
            const { done, value } = await upstreamReader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const parts = buf.split('\n')
            buf = parts.pop() ?? ''
            for (const raw of parts) {
              if (!processLine(raw)) {
                await upstreamReader.cancel('blocked output')
                return
              }
            }
            if (terminalReached) {
              await upstreamReader.cancel('provider terminal received').catch(() => undefined)
              break
            }
          }
          buf += decoder.decode()
          if (buf && !processLine(buf)) return

          if (!substantiveOutput) {
            incomplete('empty_output')
            return
          }
          if (malformedPayload) {
            incomplete('malformed_payload')
            return
          }
          if (terminalError) {
            incomplete(terminalError)
            return
          }
          if (req.provider !== 'anthropic' && !sawOpenAiDone) {
            incomplete('unexpected_eof')
            return
          }
          if (!isNaturalCompletion(req.provider, finishReason)) {
            incomplete(finishReason ?? 'unexpected_eof')
            return
          }
          if (req.provider === 'anthropic' && !sawAnthropicStop) {
            incomplete(finishReason)
            return
          }
          if (!flushText()) return
          send({ t: 'done', status: 'complete', finishReason, inputTokens, outputTokens })
        } catch {
          if (!cancelled) {
            outcome = 'error'
            send({
              t: 'error',
              message: 'Operator cannot issue a use',
              status: 'incomplete',
              finishReason: 'stream_error',
              retryable: true
            })
          }
        } finally {
          try {
            upstreamReader?.releaseLock()
          } catch {
            /* upstream reader is already released */
          }
          await persist()
          if (!cancelled) {
            try {
              controller.close()
            } catch {
              /* downstream already closed */
            }
          }
        }
      }

      void pump()
    },
    async cancel(reason) {
      cancelled = true
      outcome = 'error'
      try {
        await upstreamReader?.cancel(reason)
      } catch {
        /* cancellation is best effort */
      }
      await persist()
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
  providerFetch: typeof fetch = fetch,
  callerSignal?: AbortSignal
): Promise<Response> {
  if (!env.OPERATOR_VAULT_KEY) return fail('Operator cannot issue a use', 503)
  const seat = await store.getSeat(deviceId)
  if (!seat || !(await seatAuthorizedForKeys(store, seat, now))) return fail(SEAT_NOT_APPROVED, 403)
  const parsed = parseUseBody(bodyText)
  if (!parsed.ok) return fail(parsed.error, parsed.status)
  let req = parsed.req
  if (req.provider === 'cloudflare') {
    if (req.model.startsWith('workers-ai/')) return fail('model not allowed', 400)
    // parseUseBody pins screenshots to Scout; the DeepSeek catalogue is text-only.
    if (!req.image) req = { ...req, model: resolvePortalCloudflareModel(req.model, 'base') }
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
  const askFetch = withAskTimeout(providerFetch, callerSignal)
  let upstream: Response
  try {
    if (req.provider === 'cloudflare' && unlocked.accountId) {
      await ensureDefaultAiGateway(unlocked.secret, unlocked.accountId, askFetch)
    }
    upstream = await askFetch(dest, {
      method: 'POST',
      headers: init.headers,
      body: init.body
    })
  } catch {
    return fail('Operator cannot issue a use', 503)
  }
  if (!upstream.ok) {
    return providerRefusedResponse(upstream, [unlocked.secret, unlocked.row.cipher, unlocked.row.iv], !!req.image)
  }
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
