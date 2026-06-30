import { authStatus } from '../auth'
import { mainLog } from '../logger'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText } from './shared'

/**
 * Logger for the @dust-tt/client. It logs several EXPECTED, already-handled conditions straight to
 * whatever logger we hand it — and passing raw `console` spammed the terminal with scary errors:
 *   - the pre-refresh 401 (`expired_oauth_token_error`) that our self-heal re-mints + retries,
 *   - the terminal `done` line the client's SSE JSON parser chokes on at end-of-stream,
 *   - the AbortError on normal teardown (we abort the controller when the answer completes / is stopped).
 * Genuine, unexpected client errors still reach the user via handlers.onError. This wrapper swallows the
 * benign lines and routes anything else to the diagnostic log, keeping the console clean. Built on
 * `console` so any method the client calls still exists.
 */
const DUST_BENIGN =
  /expired_oauth_token|valid authentication credentials|is not valid json|failed parsing chunk|failed processing event stream|aborterror|operation was aborted/i
function dustLogger(): Console {
  const blobOf = (args: unknown[]): string =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`
        if (a && typeof a === 'object') {
          try {
            return JSON.stringify(a, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v))
          } catch {
            return String(a)
          }
        }
        return String(a)
      })
      .join(' ')
  const forward = (level: 'info' | 'warn', args: unknown[]): void => {
    try {
      if (DUST_BENIGN.test(blobOf(args))) return // expected + handled elsewhere — don't alarm the console
      mainLog[level]('[dust-client]', ...args)
    } catch {
      /* logging must never throw into the stream */
    }
  }
  const logger = Object.create(console) as Console // inherit every console method, override the noisy ones
  logger.error = (...a: unknown[]) => forward('warn', a)
  logger.warn = (...a: unknown[]) => forward('warn', a)
  logger.info = (...a: unknown[]) => forward('info', a)
  logger.log = (...a: unknown[]) => forward('info', a)
  logger.debug = (...a: unknown[]) => forward('info', a)
  return logger
}

/** Dust message context tied to the signed-in user, so usage is attributable in the Dust workspace. */
function dustContext(): Record<string, unknown> {
  let timezone = 'UTC'
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    /* keep UTC */
  }
  const me = authStatus()
  const email = me.email || null
  const username = email ? email.split('@')[0] : 'asktoto'
  return {
    username,
    fullName: me.name || username,
    email,
    profilePictureUrl: null,
    timezone,
    origin: 'api'
  }
}

/**
 * Dust routes through one of the user's own agents (the "model" is the agent sId). The agent's own
 * instructions/tools/retrieval govern the reply, so our system prompt is folded into the message instead.
 */
export function streamDust(opts: StreamOptions): StreamHandle {
  const controller = new AbortController()
  let settled = false
  let gotToken = false
  let wd: { ping: () => void; clear: () => void }
  const fail = (msg: string): void => {
    if (settled || controller.signal.aborted) return
    settled = true
    wd?.clear()
    opts.handlers.onError(msg)
  }
  // A Dust OAuth token that has expired surfaces as a 401 / expired_oauth_token_error before any
  // answer token. Recognise it so we can refresh + retry exactly once instead of failing the ask.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isAuthErr = (err: any): boolean => {
    if (!err) return false
    const blob = `${err.type ?? ''} ${err.code ?? ''} ${err.message ?? err}`.toLowerCase()
    return err.status === 401 || /oauth|unauthor|expired|invalid.*(token|credential)|authentication credential/.test(blob)
  }
  wd = idleWatchdog(() => {
    fail('Timed out — no response from the agent.')
    controller.abort()
  }, opts.idleMs)
  // Dust agents run with their own instructions and never receive opts.system. So fold EVERYTHING
  // the user configured (mode prompt, profile, imported context documents, and the anti-injection
  // guard) into the message itself — otherwise the model ignores what they sent.
  const preamble = opts.system ? opts.system.trim() + '\n\n— — — — —\n\n' : ''
  const run = async (
    creds: { apiKey: string; workspaceId?: string; baseURL?: string },
    allowRetry: boolean
  ): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DustAPI } = (await import('@dust-tt/client')) as any
    const api = new DustAPI(
      { url: creds.baseURL || 'https://dust.tt' },
      { workspaceId: creds.workspaceId || '', apiKey: creds.apiKey },
      dustLogger()
    )
    // On a pre-token auth failure, refresh the token once and replay the same request.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const retryIfAuth = async (err: any): Promise<boolean> => {
      if (!allowRetry || gotToken || !opts.refreshDustAuth || !isAuthErr(err)) return false
      const fresh = await opts.refreshDustAuth().catch(() => null)
      if (!fresh) return false
      await run(fresh, false)
      return true
    }
    const created = await api.createConversation({
      title: null,
      visibility: 'unlisted',
      message: {
        content: preamble + userText(opts.req),
        mentions: [{ configurationId: opts.model }],
        context: dustContext()
      }
    })
    if (created.isErr()) {
      if (await retryIfAuth(created.error)) return
      return fail(created.error.message)
    }
    const { conversation, message } = created.value
    const streamed = await api.streamAgentAnswerEvents({
      conversation,
      userMessageId: message.sId,
      signal: controller.signal
    })
    if (streamed.isErr()) {
      if (await retryIfAuth(streamed.error)) return
      return fail(streamed.error.message)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of streamed.value.eventStream as AsyncIterable<any>) {
      if (!event) continue
      if (event.type === 'generation_tokens') {
        // Only stream the visible answer tokens, not chain-of-thought / delimiters.
        if (!event.classification || event.classification === 'tokens') {
          if (typeof event.text === 'string') {
            gotToken = true
            wd.ping()
            opts.handlers.onDelta(event.text)
          }
        }
      } else if (event.type === 'user_message_error' || event.type === 'agent_error') {
        return fail(event.error?.message || 'Dust returned an error.')
      } else if (event.type === 'agent_message_success') {
        if (!settled) {
          settled = true
          wd.clear()
          opts.handlers.onDone({})
        }
        return
      }
    }
    if (!settled) {
      settled = true
      wd.clear()
      opts.handlers.onDone({})
    }
  }
  void (async () => {
    try {
      await run({ apiKey: opts.apiKey, workspaceId: opts.workspaceId, baseURL: opts.baseURL }, true)
    } catch (e) {
      if (controller.signal.aborted) return
      fail(errMsg(e))
    }
  })()
  return {
    abort: () => {
      wd.clear()
      controller.abort()
    }
  }
}
