import Anthropic from '@anthropic-ai/sdk'
import type { AskStart } from '@shared/ipc'
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

export function streamAnthropic(opts: StreamOptions): StreamHandle {
  let settled = false
  let aborted = false
  let wd: { ping: () => void; clear: () => void }
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
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: opts.req.mode === 'recap' ? 8192 : 4096, // recaps run long — give them headroom
    ...(noTemperature ? {} : { temperature: opts.temperature }),
    // Cache the static system/profile/context prefix (ephemeral) so repeated glances + multi-turn skip
    // re-processing it — cuts time-to-first-token and cost. The volatile screenshot stays in the message.
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: anthropicMessages(opts.req)
  })
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
  stream.on('error', fail)
  stream
    .finalMessage()
    .then((m) => {
      if (settled) return
      settled = true
      wd.clear()
      opts.handlers.onDone({
        inputTokens: m.usage?.input_tokens,
        outputTokens: m.usage?.output_tokens
      })
    })
    .catch(fail)
  return {
    abort: () => {
      aborted = true
      wd.clear()
      stream.abort()
    }
  }
}
