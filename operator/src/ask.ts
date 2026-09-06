import { operatorHostedKey } from './funded'

export type AskFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  minimax: 'https://api.minimax.io/v1/chat/completions',
  kimi: 'https://api.moonshot.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  grok: 'https://api.x.ai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
}

export type OperatorAskBody = {
  provider?: string
  model?: string
  system?: string
  messages?: { role?: string; content?: string }[]
  temperature?: number
  maxTokens?: number
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function sse(text: string): string {
  return `data: ${text}\n\n`
}

function redactSecrets(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('[redacted]')
}

export async function handleOperatorAsk(
  bodyText: string,
  env: Record<string, unknown>,
  fetchImpl: AskFetch = fetch
): Promise<Response> {
  let parsed: OperatorAskBody
  try {
    parsed = JSON.parse(bodyText || '{}') as OperatorAskBody
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }
  const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : ''
  const model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
  const key = operatorHostedKey(env, provider)
  if (!provider || !model) return json({ ok: false, error: 'provider and model required' }, 400)
  if (!key) return json({ ok: false, error: 'provider is not Operator-funded' }, 402)
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
    : []
  if (!messages.length) return json({ ok: false, error: 'messages required' }, 400)
  const system = typeof parsed.system === 'string' ? parsed.system : ''
  const maxTokens = typeof parsed.maxTokens === 'number' && parsed.maxTokens > 0 ? Math.min(parsed.maxTokens, 8192) : 4096
  const temperature = typeof parsed.temperature === 'number' ? parsed.temperature : undefined

  try {
    if (provider === 'anthropic') {
      return await proxyAnthropic(fetchImpl, key, { model, system, messages, maxTokens, temperature })
    }
    const url = OPENAI_URLS[provider]
    if (!url) return json({ ok: false, error: 'provider is not Operator-funded' }, 402)
    return await proxyOpenAI(fetchImpl, key, url, { model, system, messages, maxTokens, temperature })
  } catch (e) {
    const message = redactSecrets(e instanceof Error ? e.message : String(e), key)
    return json({ ok: false, error: message }, 502)
  }
}

async function proxyAnthropic(
  fetchImpl: AskFetch,
  key: string,
  req: {
    model: string
    system: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    maxTokens: number
    temperature?: number
  }
): Promise<Response> {
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      ...(req.system ? { system: req.system } : {}),
      ...(req.temperature == null ? {} : { temperature: req.temperature }),
      messages: req.messages
    })
  })
  return forwardUpstream(res, key, 'anthropic')
}

async function proxyOpenAI(
  fetchImpl: AskFetch,
  key: string,
  url: string,
  req: {
    model: string
    system: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    maxTokens: number
    temperature?: number
  }
): Promise<Response> {
  const messages = req.system
    ? [{ role: 'system', content: req.system }, ...req.messages]
    : req.messages
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      ...(req.temperature == null ? {} : { temperature: req.temperature }),
      messages
    })
  })
  return forwardUpstream(res, key, 'openai')
}

async function forwardUpstream(res: Response, key: string, kind: 'anthropic' | 'openai'): Promise<Response> {
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '')
    return json({ ok: false, error: redactSecrets(raw || `upstream ${res.status}`, key) }, res.status >= 400 ? res.status : 502)
  }
  const decoder = new TextDecoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = res.body!.getReader()
      let buf = ''
      const push = (obj: unknown): void => {
        controller.enqueue(new TextEncoder().encode(sse(JSON.stringify(obj))))
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const line of parts) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let parsed: unknown
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            const text = kind === 'anthropic' ? anthropicDelta(parsed) : openaiDelta(parsed)
            if (text) push({ t: 'delta', text })
          }
        }
        push({ t: 'done' })
        controller.close()
      } catch (e) {
        push({ t: 'error', message: redactSecrets(e instanceof Error ? e.message : String(e), key) })
        controller.close()
      }
    }
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

function anthropicDelta(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const row = parsed as { type?: string; delta?: { type?: string; text?: string } }
  if (row.type === 'content_block_delta' && row.delta?.type === 'text_delta' && typeof row.delta.text === 'string') {
    return row.delta.text
  }
  return ''
}

function openaiDelta(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const row = parsed as { choices?: { delta?: { content?: string } }[] }
  const text = row.choices?.[0]?.delta?.content
  return typeof text === 'string' ? text : ''
}
