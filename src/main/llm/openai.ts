import OpenAI from 'openai'
import type { AskStart } from '@shared/ipc'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText, imageMime, VISION_GUARD } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
function openaiMessages(req: AskStart, system: string): any[] {
  const msgs: any[] = [{ role: 'system', content: system }]
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

/** OpenAI-compatible (GPT, Kimi/Moonshot, custom base URL) — the default for any non-cli/dust/anthropic kind. */
export function streamOpenAI(opts: StreamOptions): StreamHandle {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL || undefined })
  const controller = new AbortController()
  const wd = idleWatchdog(() => {
    opts.handlers.onError('Stream timed out — no response from the model.')
    controller.abort()
  }, opts.idleMs)
  void (async () => {
    try {
      // OpenAI o-series reasoning models (o1/o3/o4…) reject `temperature` and `max_tokens`
      // (they use `max_completion_tokens` and a fixed temperature) — branch the params accordingly.
      const isOSeries = /(^|\/)o\d/i.test(opts.model)
      // Some reasoning models reject a CUSTOM temperature — only the default (1) is allowed, and sending
      // any other value 400s. OpenAI o-series and Kimi Code's kimi-for-coding both behave this way, so we
      // omit `temperature` entirely for them (and let the provider use its required default).
      const fixedTemperature = isOSeries || /kimi-for-coding/i.test(opts.model)
      const params: any = {
        model: opts.model,
        stream: true,
        // Ask the provider to include token usage in the final stream chunk (else onDone reports blank).
        stream_options: { include_usage: true },
        messages: openaiMessages(opts.req, opts.system)
      }
      // Reasoning-only models (o-series, kimi-for-coding) spend a big chunk of the budget on hidden
      // reasoning BEFORE the answer, so give them more headroom or the answer can come back empty
      // (esp. on vision, where describing the image eats tokens). o-series uses max_completion_tokens.
      const maxTokens = fixedTemperature || opts.req.mode === 'recap' ? 8192 : 4096
      if (isOSeries) {
        params.max_completion_tokens = maxTokens
      } else {
        params.max_tokens = maxTokens
      }
      if (!fixedTemperature) {
        params.temperature = opts.temperature
      }
      const stream = (await client.chat.completions.create(params, {
        signal: controller.signal
      })) as unknown as AsyncIterable<{
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }>
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta
        // Reasoning-only models (e.g. Kimi Code's kimi-for-coding) stream their thinking as
        // `reasoning_content` BEFORE any answer `content`. Keep the stall-watchdog alive during that phase
        // so it doesn't abort the stream while the model is reasoning; the answer arrives in `content`.
        if (delta?.reasoning_content) wd.ping()
        const d = delta?.content
        if (d) {
          wd.ping()
          opts.handlers.onDelta(d)
        }
        const u = (chunk as { usage?: typeof usage }).usage
        if (u) usage = u
      }
      wd.clear()
      // Report real usage only if the provider included it; never a fabricated chunk count.
      opts.handlers.onDone({
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens
      })
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
