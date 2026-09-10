import {
  BUNDLE_GOT_LOGIN_HTML,
  inspectBundleResponse,
  isHtmlContentType,
  looksLikeAccessRedirect
} from '@shared/bundle-response'
import { getMachineId } from '../license'
import { hashOperatorId, operatorHmacHeaders } from '../operator-hmac-sign'
import { mainLog } from '../logger'
import { userText, type StreamHandle, type StreamOptions } from './shared'

const OPERATOR_NATURAL_STOP_REASONS = new Set(['stop', 'end_turn', 'stop_sequence'])

/**
 * Seat-side Ask through Operator-hosted keys.
 * The Worker holds the raw LLM key. This process never persists it, never vaults it, never logs it.
 */
export function streamOperatorAsk(opts: StreamOptions): StreamHandle {
  const transport = opts.operatorTransport
  let aborted = false
  let settled = false
  const ac = new AbortController()

  const fail = (message: string): void => {
    if (settled || aborted) return
    settled = true
    opts.handlers.onError(message)
  }

  if (!transport?.url || !transport.secret) {
    queueMicrotask(() => fail('Operator is not reachable. Check Operator URL in Settings.'))
    return { abort: () => ac.abort() }
  }

  const messages = [
    ...opts.req.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: userText(opts.req) }
  ]
  const body = JSON.stringify({
    provider: opts.providerId,
    model: opts.model,
    system: opts.system,
    messages,
    temperature: opts.temperature,
    maxTokens: opts.req.mode === 'recap' ? 8192 : 4096
  })

  const url = `${transport.url.replace(/\/$/, '')}/v1/ask`
  const headers = {
    'content-type': 'application/json',
    ...operatorHmacHeaders(transport.secret, hashOperatorId(getMachineId()), body)
  }

  void (async () => {
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal })
      if (aborted) return
      const ctype = res.headers.get('content-type') || ''
      const location = res.headers.get('location')
      if (isHtmlContentType(ctype) || looksLikeAccessRedirect(location)) {
        fail(BUNDLE_GOT_LOGIN_HTML)
        return
      }
      if (res.ok) {
        const inspected = inspectBundleResponse({
          status: res.status,
          contentType: ctype,
          location,
          expected: 'binary'
        })
        if (!inspected.ok) {
          fail(inspected.message)
          return
        }
      }
      if (!res.ok || !ctype.includes('text/event-stream')) {
        let message = `Operator ask failed (${res.status})`
        try {
          const parsed = (await res.json()) as { error?: string }
          if (parsed.error) message = parsed.error
        } catch {
          /* keep status message */
        }
        fail(message)
        return
      }
      if (!res.body) {
        fail('Operator ask returned an empty stream.')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (aborted) return
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          let parsed: { t?: string; text?: string; message?: string; finishReason?: string; status?: string }
          try {
            parsed = JSON.parse(payload) as {
              t?: string
              text?: string
              message?: string
              finishReason?: string
              status?: string
            }
          } catch {
            continue
          }
          if (parsed.t === 'delta' && parsed.text) opts.handlers.onDelta(parsed.text)
          if (parsed.t === 'error') {
            fail(parsed.message || 'Operator ask failed.')
            return
          }
          if (parsed.t === 'done') {
            if (settled || aborted) return
            settled = true
            const suppliedReason = parsed.finishReason?.trim().toLowerCase()
            const suppliedStatus = parsed.status?.trim().toLowerCase()
            // The deployed legacy gateway sends a bare explicit `done`; keep that one shape working.
            // Once a gateway supplies metadata, fail closed: only a known natural text stop is complete.
            const legacyDone = !suppliedReason && !suppliedStatus
            const naturalStop = !!suppliedReason && OPERATOR_NATURAL_STOP_REASONS.has(suppliedReason)
            const completeStatus = !suppliedStatus || suppliedStatus === 'complete'
            const complete = completeStatus && (legacyDone || naturalStop)
            opts.handlers.onDone({}, {
              status: complete ? 'complete' : 'incomplete',
              reason: suppliedReason || 'done'
            })
            return
          }
        }
      }
      if (!settled && !aborted) {
        fail('Operator ask stream ended before a done event.')
      }
    } catch (e) {
      if (aborted) return
      const message = e instanceof Error ? e.message : String(e)
      mainLog.warn('[operator-ask] failed:', message)
      fail(message)
    }
  })()

  return {
    abort: () => {
      aborted = true
      ac.abort()
    }
  }
}
