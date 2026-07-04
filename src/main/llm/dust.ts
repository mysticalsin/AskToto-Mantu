// Static (eager) import — NOT `await import()`. The main process is bytecode-compiled (electron-vite
// bytecodePlugin → index.jsc); dynamic import() throws "A dynamic import callback was not specified" under
// bytecode, which broke Spotlight Ref / every Dust call in the built app. @dust-tt/client is CJS, so a
// static import resolves to a require at build time and is bytecode-safe (same pattern as the Anthropic SDK).
import { DustAPI } from '@dust-tt/client'
import { authStatus } from '../auth'
import { mainLog, auditLog } from '../logger'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText } from './shared'
import { redactSecrets } from '@shared/redact'

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
      // The SDK attaches content-bearing fields (rawText/conversation/message) to error objects on schema
      // drift — rawText is the raw response body, which for a conversation call is the full transcript +
      // prompt just sent to Dust. Strip those fields before this ever reaches the on-disk log; redactSecrets
      // alone only catches high-confidence secret patterns, not general transcript content.
      const sanitized = args.map((a) => {
        if (a && typeof a === 'object' && !(a instanceof Error)) {
          const { rawText, conversation, message, ...rest } = a as Record<string, unknown>
          return rest
        }
        return a
      })
      const blob = blobOf(sanitized)
      if (DUST_BENIGN.test(blob)) return // expected + handled elsewhere — don't alarm the console
      mainLog[level]('[dust-client]', redactSecrets(blob))
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

// One Dust conversation per meeting, not one per request. Fact-check, Explain, Spotlight Ref, and every
// other Dust-routed quick-action fired during the SAME meeting reuse this conversation, so the agent sees
// the accumulated back-and-forth instead of a cold start on every call. Reset exactly once, when a NEW
// meeting/listening session begins (see resetDustConversation, called from IPC.listeningState on `true`)
// — never on stop, so a follow-up drafted right after the call still shares context with what happened
// during it. Scoped to (workspaceId, agentId) so switching agents/workspaces mid-session can't leak one
// agent's conversation into another's. Also time-bounded (DUST_CONVERSATION_TTL_MS): without this, an
// unrelated ad-hoc question asked hours or days later — with no new meeting having started in between —
// would silently inherit that old meeting's private conversation history. Module-level state is safe
// here: AskToto is single-window/single-active-meeting by construction, there is no concurrent-meeting
// case to isolate against.
type DustConversationRef = { conversationId: string; workspaceId: string; agentId: string; createdAt: number }
const DUST_CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000 // 2h — covers a meeting plus an immediate follow-up draft
let activeConversation: DustConversationRef | null = null
// Serializes conversation CREATION per (workspaceId, agentId): two Dust requests fired close together
// (e.g. the auto-recap and a manual "Generate follow-up" click) must not both see no cached conversation
// and each call createConversation, forking one meeting into two disconnected Dust conversations. Only
// the create step needs this gate — once a conversation exists, concurrent postUserMessage calls into it
// are already safe.
let creationInFlight: Promise<void> | null = null
// Bumped on every reset so an in-flight createConversation that straddles a meeting-boundary reset can
// detect it happened and skip repopulating the cache with the (now-stale) previous meeting's conversation.
let conversationEpoch = 0

/** Call when a new meeting/listening session starts — the next Dust request begins a fresh conversation. */
export function resetDustConversation(): void {
  activeConversation = null
  conversationEpoch++
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
    // Snapshot the epoch before this request's creation gate/await — if a meeting-boundary reset bumps it
    // before we finish, we must not repopulate the cache with what is now a stale conversation.
    const epochAtStart = conversationEpoch
    // `any` preserves the original (dynamic-import `as any`) behavior — the client's request/response
    // types don't match this code's message shape, and reconciling the full Dust SDK surface is out of
    // scope for the bytecode fix. Runtime behavior is unchanged; only the static import differs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = new DustAPI(
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
    const workspaceId = creds.workspaceId || ''
    // freshConversation (background jobs like brain ingest): never join OR become the cached meeting
    // conversation — an extraction must not see meeting context, and the meeting must not see it.
    const isFresh = (c: DustConversationRef | null): c is DustConversationRef =>
      !opts.freshConversation &&
      !!c &&
      c.workspaceId === workspaceId &&
      c.agentId === opts.model &&
      Date.now() - c.createdAt < DUST_CONVERSATION_TTL_MS

    // If a concurrent request is already creating this meeting's conversation, wait for it instead of
    // racing a second createConversation — see creationInFlight comment above. Fresh-conversation
    // requests skip the gate entirely: they never touch the shared cache slot.
    let releaseCreationGate: (() => void) | null = null
    while (!opts.freshConversation && !isFresh(activeConversation)) {
      if (!creationInFlight) {
        creationInFlight = new Promise((resolve) => {
          releaseCreationGate = resolve
        })
        break // we now hold the gate — we're the one creating it
      }
      await creationInFlight.catch(() => {})
    }

    const messageBody = {
      content: preamble + userText(opts.req),
      mentions: [{ configurationId: opts.model }],
      context: dustContext()
    }
    let conversation: unknown
    let messageSId: string
    if (isFresh(activeConversation)) {
      const reusable = activeConversation
      // Same meeting, same agent — continue the existing conversation instead of starting cold.
      const posted = await api.postUserMessage({
        conversationId: reusable.conversationId,
        message: messageBody,
        signal: controller.signal
      })
      if (posted.isErr()) {
        // The cached conversation may have expired/been deleted server-side — fall back to a fresh one
        // rather than failing the whole ask over a stale cache entry.
        activeConversation = null
        if (await retryIfAuth(posted.error)) return
        return run(creds, allowRetry)
      }
      const fetched = await api.getConversation({ conversationId: reusable.conversationId, signal: controller.signal })
      if (fetched.isErr()) {
        activeConversation = null
        return fail(fetched.error.message)
      }
      conversation = fetched.value
      messageSId = posted.value.sId
      auditLog('dust.conversation', { action: 'reused' })
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let created: any
      try {
        created = await api.createConversation({
          title: null,
          visibility: 'unlisted',
          message: messageBody
        })
      } finally {
        // Release the creation gate no matter how this attempt settles — including a thrown exception,
        // which the happy-path-only release this replaced would have left permanently pending, deadlocking
        // every future Dust request in this app session (resetDustConversation never touches this gate).
        if (releaseCreationGate) {
          ;(releaseCreationGate as () => void)()
          creationInFlight = null
        }
      }
      if (created.isErr()) {
        if (await retryIfAuth(created.error)) return
        return fail(created.error.message)
      }
      conversation = created.value.conversation
      messageSId = created.value.message.sId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sId = (conversation as any)?.sId
      // A fresh-conversation request must not hijack the meeting's cache slot with its throwaway thread.
      // Nor may a request that straddled a meeting-boundary reset (epoch changed while we awaited
      // createConversation) repopulate the cache with the now-stale previous meeting's conversation.
      if (sId && !opts.freshConversation && epochAtStart === conversationEpoch) {
        activeConversation = { conversationId: sId, workspaceId, agentId: opts.model, createdAt: Date.now() }
      }
      auditLog('dust.conversation', { action: opts.freshConversation ? 'created-isolated' : 'created' })
    }
    const streamed = await api.streamAgentAnswerEvents({
      conversation,
      userMessageId: messageSId,
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
