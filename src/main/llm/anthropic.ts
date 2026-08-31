import Anthropic from '@anthropic-ai/sdk'
import type { AskStart } from '@shared/ipc'
import { mapAnthropicUsage, type CacheTtl } from '@shared/operator'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText, imageMime, VISION_GUARD } from './shared'

function anthropicMessages(req: AskStart): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = req.history.map((t) => ({ role: t.role, content: t.content }))
  const text = userText(req)
  if (req.mode === 'vision' && req.image) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageMime(req.image), data: req.image } },
        { type: 'text', text: text + VISION_GUARD }
      ]
    })
  } else {
    msgs.push({ role: 'user', content: text })
  }
  return msgs
}

function isTtlRejection(e: unknown): boolean {
  const blob = `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { error?: unknown })?.error ?? '')}`.toLowerCase()
  return (
    (blob.includes('400') || blob.includes('invalid')) &&
    (blob.includes('ttl') || blob.includes('cache_control') || blob.includes('1h'))
  )
}

function systemBlocks(opts: StreamOptions, ttl: CacheTtl): Anthropic.TextBlockParam[] {
  const cached = opts.systemParts?.cachedPrefix ?? opts.system
  const volatile = opts.systemParts?.volatile ?? ''
  const cacheControl =
    ttl === '1h'
      ? ({ type: 'ephemeral', ttl: '1h' } as Anthropic.TextBlockParam['cache_control'] & { ttl: '1h' })
      : ({ type: 'ephemeral' } as Anthropic.TextBlockParam['cache_control'])
  const blocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: cached, cache_control: cacheControl }
  ]
  if (volatile) blocks.push({ type: 'text', text: volatile })
  return blocks
}

export function streamAnthropic(opts: StreamOptions): StreamHandle {
  let settled = false
  let aborted = false
  let wd: { ping: () => void; clear: () => void }
  let usedTtl: CacheTtl = '1h'
  let current: ReturnType<Anthropic['messages']['stream']> | null = null
  const fail = (e: unknown): void => {
    if (settled || aborted) return // user-initiated abort isn't an error
    settled = true
    wd?.clear()
    opts.handlers.onError(errMsg(e))
  }
  const client = new Anthropic({ apiKey: opts.apiKey })
  // Claude Opus 4.7+, Sonnet 5+, and Fable/Mythos-class models removed sampling parameters — sending
  // `temperature` returns a 400 on every request (the default model claude-opus-4-8 is one of them).
  // Omit it there; older models keep honoring the user's temperature setting.
  const noTemperature = /claude-(opus-4-[789]|opus-[5-9]|sonnet-[5-9]|fable|mythos)/i.test(opts.model)

  const start = (ttl: CacheTtl): ReturnType<Anthropic['messages']['stream']> => {
    usedTtl = ttl
    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: opts.req.mode === 'recap' ? 8192 : 4096, // recaps run long — give them headroom
      ...(noTemperature ? {} : { temperature: opts.temperature }),
      // Breakpoint on the last STABLE system block. 1h TTL: meetings have coffee-break gaps.
      system: systemBlocks(opts, ttl),
      messages: anthropicMessages(opts.req)
    })
    current = stream
    return stream
  }

  const attach = (stream: ReturnType<Anthropic['messages']['stream']>): void => {
    wd = idleWatchdog(() => {
      if (settled) return
      settled = true
      opts.handlers.onError('Stream timed out — no response from the model.')
      aborted = true
      stream.abort()
    }, opts.idleMs)
    stream.on('text', (t) => {
      wd.ping()
      opts.handlers.onDelta(t)
    })
    stream.on('error', (e) => {
      if (settled || aborted) return
      if (usedTtl === '1h' && isTtlRejection(e)) {
        wd.clear()
        attach(start('5m'))
        return
      }
      fail(e)
    })
    stream
      .finalMessage()
      .then((m) => {
        if (settled) return
        settled = true
        wd.clear()
        opts.handlers.onDone(mapAnthropicUsage(m.usage, usedTtl))
      })
      .catch((e) => {
        if (settled || aborted) return
        if (usedTtl === '1h' && isTtlRejection(e)) {
          wd.clear()
          attach(start('5m'))
          return
        }
        fail(e)
      })
  }

  attach(start('1h'))
  return {
    abort: () => {
      aborted = true
      wd?.clear()
      current?.abort()
    }
  }
}
