import OpenAI from 'openai'
import type { AskStart } from '@shared/ipc'
import { PROVIDERS, requiresUserBaseUrl, type ProviderId } from '@shared/providers'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText, imageMime, VISION_GUARD } from './shared'
import { noteHeadroomFromHeaders, type HeaderBag } from './usage-headroom'

/* eslint-disable @typescript-eslint/no-explicit-any */
function openaiMessages(req: AskStart, system: string, cacheBreakpoint = false): any[] {
  const msgs: any[] = [
    cacheBreakpoint
      ? { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
      : { role: 'system', content: system }
  ]
  for (const t of req.history) msgs.push({ role: t.role, content: t.content })
  const text = userText(req)
  if (req.mode === 'vision' && req.image) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: text + VISION_GUARD },
        { type: 'image_url', image_url: { url: `data:${imageMime(req.image)};base64,${req.image}` } }
      ]
    })
  } else {
    msgs.push({ role: 'user', content: text })
  }
  return msgs
}

/** The 400/422 error body (lowercased) if this is an OpenAI-compatible param rejection, else null. */
function rejectionBody(e: unknown): string | null {
  if (!(e instanceof OpenAI.APIError)) return null
  if (e.status !== 400 && e.status !== 422) return null
  return (String(e.message ?? '') + JSON.stringify((e as any).error ?? '')).toLowerCase()
}
/**
 * Two OPTIONAL params can each be rejected independently by some endpoints (local models, certain proxies):
 * `stream_options.include_usage` (usage reporting) and `reasoning_effort` (Kimi effort control). They are
 * detected separately so a rejection of ONE never causes the other to be silently dropped on retry.
 */
function isStreamOptionsRejection(e: unknown): boolean {
  const body = rejectionBody(e)
  return !!body && (body.includes('stream_options') || body.includes('include_usage'))
}
function isReasoningEffortRejection(e: unknown): boolean {
  const body = rejectionBody(e)
  return !!body && body.includes('reasoning_effort')
}
/** MQA-100: `response_format` is only ever set for on-device extraction (llama-server supports it and
 *  converts it to a GBNF grammar). It joins the same drop-on-rejection ladder as the two params above so
 *  a runtime that does not implement it degrades to unconstrained decoding — which is exactly today's
 *  behaviour — instead of failing the request outright. 'grammar' is matched too because llama.cpp
 *  reports the conflict in those terms. */
function isResponseFormatRejection(e: unknown): boolean {
  const body = rejectionBody(e)
  return !!body && (body.includes('response_format') || body.includes('json_schema') || body.includes('grammar'))
}

/** Resolve the completion ceiling without changing established cloud-provider budgets. */
export function outputTokenBudget(model: string, mode: AskStart['mode'], override?: number): number {
  if (override !== undefined) return override
  const fixedTemperature = /(^|\/)o\d/i.test(model) || /kimi-for-coding/i.test(model)
  return fixedTemperature || mode === 'recap' ? 8192 : 4096
}

/** OpenAI-compatible (GPT, Kimi/Moonshot, custom base URL) — the default for any non-cli/dust/anthropic kind. */
export function streamOpenAI(opts: StreamOptions): StreamHandle {
  // Guard against silently falling through to the SDK's default baseURL (api.openai.com) when a
  // provider whose endpoint the USER supplies has none configured — without this, a misconfigured
  // 'custom' (or 'cloudflare', whose endpoint is the operator's own Worker) entry would send its key
  // and model to OpenAI's real backend instead of failing loudly.
  if (requiresUserBaseUrl(opts.providerId) && !opts.baseURL) {
    // Fire asynchronously so the caller has already stored the returned handle before onError runs.
    // A synchronous onError re-enters attempt()/failover in index.ts and its streams.set would be
    // clobbered by this dummy handle, leaving Cancel/quit unable to abort the real fallback stream.
    queueMicrotask(() =>
      opts.handlers.onError(
        `No endpoint URL set for ${PROVIDERS[opts.providerId].label}. Open Settings and add one.`
      )
    )
    return { abort: () => {} }
  }
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL || undefined })
  const controller = new AbortController()
  const wd = idleWatchdog(() => {
    opts.handlers.onError('Stream timed out — no response from the model.')
    controller.abort()
  }, opts.idleMs)
  void (async () => {
    // OpenAI o-series reasoning models (o1/o3/o4…) reject `temperature` and `max_tokens`
    // (they use `max_completion_tokens` and a fixed temperature) — branch the params accordingly.
    const isOSeries = /(^|\/)o\d/i.test(opts.model)
    // Some reasoning models reject a CUSTOM temperature — only the default (1) is allowed, and sending
    // any other value 400s. OpenAI o-series and Kimi Code's kimi-for-coding both behave this way, so we
    // omit `temperature` entirely for them (and let the provider use its required default).
    const fixedTemperature = isOSeries || /kimi-for-coding/i.test(opts.model)
    // Hidden-reasoning models that DO accept a custom temperature (e.g. Grok's grok-4, which is both
    // the provider default and the think/deep tier model — see shared/providers.ts) still burn a big
    // chunk of the token budget on reasoning before the visible answer, same as the fixedTemperature
    // models below. Without the wider headroom these can hit max_tokens mid-reasoning and stream back
    // an empty/truncated answer with no error.
    const isHiddenReasoning = fixedTemperature || /(^|\/)grok-4/i.test(opts.model)
    // Reasoning-only models (o-series, kimi-for-coding, grok-4) spend a big chunk of the budget on hidden
    // reasoning BEFORE the answer, so give them more headroom or the answer can come back empty
    // (esp. on vision, where describing the image eats tokens). o-series uses max_completion_tokens.
    const maxTokens = outputTokenBudget(opts.model, opts.req.mode, opts.maxOutputTokens)

    // Inner function: build params + run the streaming loop. `includeUsage` controls whether
    // stream_options.include_usage is sent — some providers 400 on it, triggering a retry without it.
    const doStream = async (
      includeUsage: boolean,
      includeEffort: boolean,
      includeResponseFormat = true
    ): Promise<{ inputTokens?: number; outputTokens?: number; sawReasoning: boolean; sawContent: boolean }> => {
      const params: any = {
        model: opts.model,
        stream: true,
        messages: openaiMessages(opts.req, opts.system, !!opts.promptCacheKey)
      }
      if (opts.promptCacheKey) params.prompt_cache_key = opts.promptCacheKey
      // Ask the provider to include token usage in the final stream chunk (else onDone reports blank).
      // Omitted on retry when the provider rejected it (isStreamOptionsRejection).
      if (includeUsage) params.stream_options = { include_usage: true }
      // reasoning_effort has its OWN flag (independent of stream_options) so a rejection of one never drops
      // the other. Only Kimi sets opts.reasoningEffort (see StreamOptions), so every other provider's body
      // is unchanged. This is how "Kimi = light thinking by default, heavy only when Métis thinking is on"
      // reaches the wire.
      if (includeEffort && opts.reasoningEffort) params.reasoning_effort = opts.reasoningEffort
      // MQA-100: constrained decoding for the on-device extraction path. llama-server compiles this into
      // a GBNF grammar and masks every token that would break JSON syntax, so the output is guaranteed
      // parseable — the 0.8B bundled model otherwise emits an unterminated object often enough to fail a
      // real meeting ("No complete JSON object in model output"). Set ONLY by brain/ingest.ts for local;
      // every other caller leaves it undefined and its request body is byte-identical.
      if (includeResponseFormat && opts.responseFormat) params.response_format = opts.responseFormat
      if (isOSeries) {
        params.max_completion_tokens = maxTokens
      } else {
        params.max_tokens = maxTokens
      }
      if (!fixedTemperature) params.temperature = opts.temperature
      // llama-server per-slot prompt-cache pinning (PLAN.md §4.3) — an explicit two-key copy, never a
      // spread, so this narrow carrier can never smuggle extra fields (messages/model/stream) through it.
      // Only main/llm/local.ts ever sets llamaSlotOptions; every other caller leaves it undefined, so this
      // is a no-op and their request bodies stay byte-identical to before this field existed.
      if (opts.llamaSlotOptions) {
        if (opts.llamaSlotOptions.id_slot !== undefined) params.id_slot = opts.llamaSlotOptions.id_slot
        if (opts.llamaSlotOptions.cache_prompt !== undefined) params.cache_prompt = opts.llamaSlotOptions.cache_prompt
      }

      type ChatStream = AsyncIterable<{
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }>
      const apiCall = client.chat.completions.create(params, { signal: controller.signal })
      // Budget pre-emption: snapshot the provider's rate-limit headers (returned on EVERY response,
      // success included) so routing can skip this provider BEFORE it 429s next time (usage-headroom.ts).
      // `.withResponse()` exposes the raw Response without changing the stream we consume; guarded so an SDK
      // that lacks it, or a proxy that omits the headers, degrades to today's behaviour (fail-open).
      let stream: ChatStream
      const withResponse = (
        apiCall as unknown as { withResponse?: () => Promise<{ data: ChatStream; response?: { headers?: HeaderBag } }> }
      ).withResponse
      if (typeof withResponse === 'function') {
        const wr = await withResponse.call(apiCall)
        noteHeadroomFromHeaders(opts.providerId as ProviderId, wr.response?.headers)
        stream = wr.data
      } else {
        stream = (await apiCall) as unknown as ChatStream
      }
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
      let sawReasoning = false
      let sawContent = false
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta
        // Reasoning-only models (e.g. Kimi Code's kimi-for-coding) stream their thinking as
        // `reasoning_content` BEFORE any answer `content`. Keep the stall-watchdog alive during that phase
        // so it doesn't abort the stream while the model is reasoning; the answer arrives in `content`.
        if (delta?.reasoning_content) {
          wd.ping()
          sawReasoning = true
        }
        const d = delta?.content
        if (d) {
          wd.ping()
          sawContent = true
          opts.handlers.onDelta(d)
        }
        const u = (chunk as { usage?: typeof usage }).usage
        if (u) usage = u
      }
      return { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, sawReasoning, sawContent }
    }

    try {
      let usageResult: { inputTokens?: number; outputTokens?: number; sawReasoning: boolean; sawContent: boolean }
      // Both optional params are sent first; on a param rejection, drop ONLY the one the provider named,
      // then (if the retry trips the other) drop both. Never drop a param the provider actually accepted —
      // that's what silently killed reasoning_effort when only stream_options was rejected. Parameter
      // rejections arrive before any content, so re-running the stream can't duplicate output.
      try {
        usageResult = await doStream(true, true)
      } catch (e1) {
        if (controller.signal.aborted) throw e1
        const dropUsage = isStreamOptionsRejection(e1)
        const dropEffort = isReasoningEffortRejection(e1)
        const dropFormat = isResponseFormatRejection(e1)
        if (!dropUsage && !dropEffort && !dropFormat) throw e1
        try {
          usageResult = await doStream(!dropUsage, !dropEffort, !dropFormat)
        } catch (e2) {
          if (controller.signal.aborted) throw e2
          if (!isStreamOptionsRejection(e2) && !isReasoningEffortRejection(e2) && !isResponseFormatRejection(e2))
            throw e2
          usageResult = await doStream(false, false, false)
        }
      }
      wd.clear()
      // The model spent its whole budget on hidden reasoning and never produced an answer (seen on
      // Kimi Code's kimi-for-coding under a tight token budget). onDone with empty content would render
      // as the idle "Ask a question…" placeholder — indistinguishable from never having asked — so
      // surface it as a real, actionable error instead.
      if (usageResult.sawReasoning && !usageResult.sawContent) {
        opts.handlers.onError('The model produced only reasoning and no answer — try again or raise the token budget.')
        return
      }
      // Report real usage only if the provider included it; never a fabricated chunk count.
      opts.handlers.onDone({ inputTokens: usageResult.inputTokens, outputTokens: usageResult.outputTokens })
    } catch (e) {
      wd.clear()
      if (controller.signal.aborted) return
      opts.handlers.onError(errMsg(e))
    }
  })()
  return {
    abort: () => {
      wd.clear()
      controller.abort()
    }
  }
}
