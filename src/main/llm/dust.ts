// Static (eager) import — NOT `await import()`. The main process is bytecode-compiled (electron-vite
// bytecodePlugin → index.jsc); dynamic import() throws "A dynamic import callback was not specified" under
// bytecode, which broke Spotlight Ref / every Dust call in the built app. @dust-tt/client is CJS, so a
// static import resolves to a require at build time and is bytecode-safe (same pattern as the Anthropic SDK).
import { DustAPI } from '@dust-tt/client'
import { authStatus } from '../auth'
import { mainLog, auditLog } from '../logger'
import { type StreamOptions, type StreamHandle, errMsg, idleWatchdog, userText } from './shared'
import { attachScreenshot, type DustFileContentFragment } from './dust-attachments'
import { redactSecrets } from '@shared/redact'
import { dustAgentUnavailableMessage } from '@shared/quick-actions'
import { DUST_SPOTLIGHT_REF_AGENT_ID } from '@shared/ipc'

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
  /expired_oauth_token|valid authenticat\w+ credentials?|is not valid json|failed parsing chunk|failed processing event stream|aborterror|operation was aborted/i

// A Dust OAuth token that has expired surfaces as a 401 before any answer token — but the exact
// wording drifts across Dust API versions: "expired_oauth_token_error", "…does not have valid
// authentication credentials", and (current) "the user request does not have a valid authenticated
// credential". Match the whole family ("authenticat…" + "credential" in either order, any suffixes)
// so the refresh-and-retry self-heal actually fires instead of surfacing the raw 401 to the user.
// Module-scope + exported so the phrasing coverage is pinned by tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isDustAuthError(err: any): boolean {
  if (!err) return false
  const blob = `${err.type ?? ''} ${err.code ?? ''} ${err.message ?? err}`.toLowerCase()
  return (
    err.status === 401 ||
    /oauth|unauthor|expired|invalid.*(token|credential)|authenticat\w*\s+credential|credential.*authenticat/.test(blob)
  )
}

// The mentioned Dust agent sId no longer resolves in the connected workspace: Dust accepts the user
// message but creates NO agent reply, so @dust-tt/client returns "Failed to retrieve agent message"
// (and the API can say "agent (configuration) not found"). Distinct from an auth error — the token is
// fine, the AGENT is stale/gone (e.g. after reconnecting to a different workspace). Auth is explicitly
// excluded so this never shadows the 401 refresh-and-retry self-heal (isDustAuthError above).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isDustAgentUnavailableError(err: any): boolean {
  if (!err || isDustAuthError(err)) return false
  const blob = `${err.type ?? ''} ${err.code ?? ''} ${err.message ?? err}`.toLowerCase()
  return (
    /failed to retrieve agent message/.test(blob) ||
    /agent[ _]?(configuration )?not[ _]?(found|available)/.test(blob) ||
    /no (such )?agent/.test(blob)
  )
}

// Turn a raw Dust error into what the user actually sees: a stale/removed agent becomes a plain
// re-pick step (Spotlight-specific when the mentioned agent is the hard-locked Spotlight Ref one);
// everything else surfaces its own message unchanged.
const mapDustError = (e: unknown, spotlight: boolean): string =>
  isDustAgentUnavailableError(e) ? dustAgentUnavailableMessage(spotlight) : errMsg(e)
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

// One Dust conversation per meeting per agent, not one per request. Fact-check, Explain, Spotlight Ref, and
// every other Dust-routed quick-action fired during the SAME meeting reuse their agent's conversation, so
// the agent sees the accumulated back-and-forth instead of a cold start on every call. Reset exactly once,
// when a NEW meeting/listening session begins (see resetDustConversation, called from IPC.listeningState on
// `true`) — never on stop, so a follow-up drafted right after the call still shares context with what
// happened during it. A MAP keyed by (workspaceId, agentId), not a single slot: Spotlight Ref is hard-pinned
// to its own agent sId, so with one slot every Spotlight click both missed the meeting thread AND overwrote
// it, cold-starting the next chat ask with none of the meeting's accumulated context (and vice versa). The
// key also keeps agents/workspaces isolated, so switching mid-session can't leak one agent's conversation
// into another's. Also time-bounded (DUST_CONVERSATION_TTL_MS): without this, an unrelated ad-hoc question
// asked hours or days later — with no new meeting having started in between — would silently inherit that
// old meeting's private conversation history. Module-level state is safe here: Métis is
// single-window/single-active-meeting by construction, there is no concurrent-meeting case to isolate
// against, and the map only ever holds the handful of agents used inside one meeting.
type DustConversationRef = { conversationId: string; workspaceId: string; agentId: string; createdAt: number }
const DUST_CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000 // 2h — covers a meeting plus an immediate follow-up draft
const conversationKey = (workspaceId: string, agentId: string): string => `${workspaceId}::${agentId}`
const activeConversations = new Map<string, DustConversationRef>()
// Serializes conversation CREATION per (workspaceId, agentId): two Dust requests fired close together
// (e.g. the auto-recap and a manual "Generate follow-up" click) must not both see no cached conversation
// and each call createConversation, forking one meeting into two disconnected Dust conversations. Only
// the create step needs this gate — once a conversation exists, concurrent postUserMessage calls into it
// are already safe. Keyed like the cache it guards: two different agents create independent conversations,
// so making one wait on the other's create would only add latency.
const creationInFlight = new Map<string, Promise<void>>()
// Bumped on every reset so an in-flight createConversation that straddles a meeting-boundary reset can
// detect it happened and skip repopulating the cache with the (now-stale) previous meeting's conversation.
let conversationEpoch = 0

/** Call when a new meeting/listening session starts — the next Dust request begins a fresh conversation. */
export function resetDustConversation(): void {
  activeConversations.clear()
  conversationEpoch++
}

/**
 * Pre-create the meeting's Dust conversation BEFORE the first ask so that ask doesn't pay the
 * createConversation round trip on top of the agent's own time-to-first-token. Called fire-and-forget
 * from the listeningState handler right after resetDustConversation() — a failure here just means the
 * first ask creates the conversation itself, exactly as before. Keyed to the INTERACTIVE (base) agent:
 * quick actions and chat during the meeting are what need the warm start.
 *
 * Uses the same creationInFlight gate as streamDust so a prewarm can never race a real ask into forking
 * the meeting across two conversations, and the same epoch guard so a prewarm that straddles the next
 * meeting boundary can't cache a stale conversation.
 */
export async function prewarmDustConversation(
  creds: { apiKey: string; workspaceId: string; baseURL?: string },
  agentId: string
): Promise<void> {
  if (!creds.apiKey || !creds.workspaceId || !agentId) return
  const key = conversationKey(creds.workspaceId, agentId)
  const cached = activeConversations.get(key)
  const fresh = !!cached && Date.now() - cached.createdAt < DUST_CONVERSATION_TTL_MS
  if (fresh || creationInFlight.has(key)) return // warm already, or a real ask is creating one — don't race it
  const epochAtStart = conversationEpoch
  let release: (() => void) | null = null
  creationInFlight.set(
    key,
    new Promise((resolve) => {
      release = resolve
    })
  )
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = new DustAPI(
      { url: creds.baseURL || 'https://dust.tt' },
      { workspaceId: creds.workspaceId, apiKey: creds.apiKey },
      dustLogger()
    )
    // No message: an empty unlisted conversation. The first real ask lands in it through the normal
    // reused-conversation path (postUserMessage + stream) instead of paying createConversation.
    const created = await api.createConversation({ title: null, visibility: 'unlisted' })
    if (created?.isErr?.()) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sId = (created?.value?.conversation as any)?.sId
    if (sId && epochAtStart === conversationEpoch) {
      activeConversations.set(key, {
        conversationId: sId,
        workspaceId: creds.workspaceId,
        agentId,
        createdAt: Date.now()
      })
      auditLog('dust.conversation', { action: 'prewarmed' })
    }
  } catch {
    /* best-effort — the first ask simply creates the conversation itself */
  } finally {
    ;(release as unknown as () => void)?.()
    creationInFlight.delete(key)
  }
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
  const isAuthErr = isDustAuthError
  wd = idleWatchdog(() => {
    fail('Timed out — no response from the agent.')
    controller.abort()
  }, opts.idleMs)
  // Dust agents run with their own instructions and never receive opts.system. So fold EVERYTHING
  // the user configured (mode prompt, profile, imported context documents, and the anti-injection
  // guard) into the message itself — otherwise the model ignores what they sent.
  const preamble = opts.system ? opts.system.trim() + '\n\n— — — — —\n\n' : ''
  // Screen questions: Dust messages are text-only, so the screenshot rides along as a content fragment
  // (an uploaded file the agent's model reads). Uploaded once and reused across an auth-refresh replay.
  const wantsScreenshot = opts.req.mode === 'vision' && !!opts.req.image
  let screenshotFragment: DustFileContentFragment | null = null
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
    // Upload the screenshot before touching the conversation so a vision-capable Dust agent can see the
    // screen. Cached across an auth replay (the fileId is workspace-scoped, valid under the fresh token).
    // A non-auth upload failure is a pre-token error: return it so the ask fails over to a vision provider.
    if (wantsScreenshot && !screenshotFragment) {
      const attached = await attachScreenshot(api, opts.req.image as string)
      if (!attached.ok) {
        if (await retryIfAuth(attached.error)) return
        return fail(errMsg(attached.error))
      }
      screenshotFragment = attached.contentFragment
    }
    const workspaceId = creds.workspaceId || ''
    const cacheKey = conversationKey(workspaceId, opts.model)
    // freshConversation (background jobs like brain ingest): never join OR become the cached meeting
    // conversation — an extraction must not see meeting context, and the meeting must not see it.
    const cachedConversation = (): DustConversationRef | null => {
      if (opts.freshConversation) return null
      const c = activeConversations.get(cacheKey)
      return c && Date.now() - c.createdAt < DUST_CONVERSATION_TTL_MS ? c : null
    }

    // If a concurrent request is already creating this agent's conversation, wait for it instead of
    // racing a second createConversation — see creationInFlight comment above. Fresh-conversation
    // requests skip the gate entirely: they never touch the shared cache.
    let releaseCreationGate: (() => void) | null = null
    while (!opts.freshConversation && !cachedConversation()) {
      const pending = creationInFlight.get(cacheKey)
      if (!pending) {
        creationInFlight.set(
          cacheKey,
          new Promise((resolve) => {
            releaseCreationGate = resolve
          })
        )
        break // we now hold the gate — we're the one creating it
      }
      await pending.catch(() => {})
    }

    const messageBody = {
      content: preamble + userText(opts.req),
      mentions: [{ configurationId: opts.model }],
      context: dustContext()
    }
    let conversation: unknown
    let messageSId: string
    const reusable = cachedConversation()
    if (reusable) {
      // Screen question on an ongoing conversation: postUserMessage takes no attachment, so the screenshot
      // is attached to the conversation via its own content fragment first, then the message follows.
      if (screenshotFragment) {
        const frag = await api.postContentFragment({
          conversationId: reusable.conversationId,
          contentFragment: screenshotFragment,
          signal: controller.signal
        })
        if (frag.isErr()) {
          if (await retryIfAuth(frag.error)) return
          // Stale/deleted conversation — fall back to a fresh one (which attaches the fragment at create).
          activeConversations.delete(cacheKey)
          return run(creds, allowRetry)
        }
      }
      // Same meeting, same agent — continue the existing conversation instead of starting cold.
      const posted = await api.postUserMessage({
        conversationId: reusable.conversationId,
        message: messageBody,
        signal: controller.signal
      })
      if (posted.isErr()) {
        // Auth first, WITHOUT dropping the cached conversation: an expired token says nothing about the
        // conversation's validity, and clearing it here made the auth retry abandon the meeting thread
        // and open a second Dust conversation (losing all accumulated meeting context).
        if (await retryIfAuth(posted.error)) return
        // Non-auth failure: the cached conversation may have expired/been deleted server-side — fall
        // back to a fresh one rather than failing the whole ask over a stale cache entry.
        activeConversations.delete(cacheKey)
        return run(creds, allowRetry)
      }
      const fetched = await api.getConversation({ conversationId: reusable.conversationId, signal: controller.signal })
      if (fetched.isErr()) {
        activeConversations.delete(cacheKey)
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
          message: messageBody,
          // Attach the screenshot at creation so it lands with the first user message.
          ...(screenshotFragment ? { contentFragment: screenshotFragment } : {}),
          signal: controller.signal
        })
      } finally {
        // Release the creation gate no matter how this attempt settles — including a thrown exception,
        // which the happy-path-only release this replaced would have left permanently pending, deadlocking
        // every future Dust request in this app session (resetDustConversation never touches this gate).
        if (releaseCreationGate) {
          ;(releaseCreationGate as () => void)()
          creationInFlight.delete(cacheKey)
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
      // A fresh-conversation request must not hijack the meeting's cache with its throwaway thread.
      // Nor may a request that straddled a meeting-boundary reset (epoch changed while we awaited
      // createConversation) repopulate the cache with the now-stale previous meeting's conversation.
      if (sId && !opts.freshConversation && epochAtStart === conversationEpoch && !controller.signal.aborted) {
        activeConversations.set(cacheKey, {
          conversationId: sId,
          workspaceId,
          agentId: opts.model,
          createdAt: Date.now()
        })
      }
      auditLog('dust.conversation', { action: opts.freshConversation ? 'created-isolated' : 'created' })
    }
    let streamed = await api.streamAgentAnswerEvents({
      conversation,
      userMessageId: messageSId,
      signal: controller.signal
    })
    if (streamed.isErr()) {
      // The user message is ALREADY posted by this point — the whole-run retryIfAuth would post it a
      // second time and the agent would answer twice. On an auth failure, refresh the token and retry
      // ONLY the stream attach against the same conversation + message.
      if (allowRetry && !gotToken && opts.refreshDustAuth && isAuthErr(streamed.error)) {
        const fresh = await opts.refreshDustAuth().catch(() => null)
        if (fresh) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const freshApi: any = new DustAPI(
            { url: fresh.baseURL || 'https://dust.tt' },
            { workspaceId: fresh.workspaceId || '', apiKey: fresh.apiKey },
            dustLogger()
          )
          streamed = await freshApi.streamAgentAnswerEvents({
            conversation,
            userMessageId: messageSId,
            signal: controller.signal
          })
        }
      }
      if (streamed.isErr()) return fail(mapDustError(streamed.error, opts.model === DUST_SPOTLIGHT_REF_AGENT_ID))
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
        return fail(isDustAgentUnavailableError(event.error) ? dustAgentUnavailableMessage(opts.model === DUST_SPOTLIGHT_REF_AGENT_ID) : (event.error?.message || 'Dust returned an error.'))
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
