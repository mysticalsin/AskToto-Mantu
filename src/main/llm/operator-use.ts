import { userText, type StreamHandle, type StreamOptions } from './shared'
import { operatorUseAsk, type OperatorRuntimeSettings } from '../operator-ingest'

export type OperatorBrokerOptions = StreamOptions & {
  operator: OperatorRuntimeSettings
}

/** HMAC /v1/use. Never a local API key. Never a screenshot. */
export function streamOperatorUse(opts: OperatorBrokerOptions): StreamHandle {
  const ac = new AbortController()
  let settled = false
  const finish = (fn: () => void): void => {
    if (settled) return
    settled = true
    fn()
  }
  if (opts.req.mode === 'vision' || opts.req.image) {
    queueMicrotask(() =>
      finish(() => opts.handlers.onError(`${opts.providerId} is Operator-funded and cannot receive screenshots.`))
    )
    return { abort: () => ac.abort() }
  }
  const messages = [
    ...opts.req.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: userText(opts.req) }
  ]
  void operatorUseAsk(
    opts.operator,
    {
      provider: opts.providerId,
      model: opts.model,
      system: opts.system,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.req.mode === 'recap' ? 8192 : 4096
    },
    ac.signal
  ).then((out) => {
    if (ac.signal.aborted) return
    if (!out.ok) {
      finish(() => opts.handlers.onError(out.error))
      return
    }
    finish(() => {
      opts.handlers.onDelta(out.text)
      opts.handlers.onDone({
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        cacheStatus: 'n/a'
      })
    })
  })
  return {
    abort: () => {
      ac.abort()
      settled = true
    }
  }
}
