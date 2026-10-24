import type { AskMode, ChatTurn } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import type { AskContextRequest } from '@shared/session-context-request'

/** Ask lifecycle types. A leaf module so the ask helpers can name them without importing state.ts (no cycle). */

export interface AnswerState {
  id: string
  /** Stable identity of the card on screen: the ask id that produced it, kept when a rollback restores it. */
  cardId?: string
  /** Monotonic per `useAsk` instance; bumps on every visible card change (new card, rollback, clear). */
  revision?: number
  text: string
  streaming: boolean
  /** Missing is legacy/unspecified; only the current request's successful terminal event is complete. */
  completion?: 'pending' | 'complete' | 'incomplete'
  error: string | null
  prompt: string
  // User-facing header (the claim/question being asked). The `prompt` is the engineered scaffold that
  // goes to the model and must NEVER be shown; `label` is what the UI displays. Falls back to '' (hidden).
  label?: string
  kind?: 'answer' | 'factcheck' // drives the verdict-card rendering for fact-checks
  // True when this answer was grounded in a screenshot (req.mode === 'vision') — drives the "Viewed
  // screen" trust chip independent of `label`/`prompt`, so a real typed question can show as the header
  // AND still carry the trust chip (previously the chip only showed when label was the literal string
  // 'Viewed screen', which overwrote — and so could never coexist with — the user's actual question).
  usedScreen?: boolean
  // True when this answer ASKED for the screen fast path and main reported it had no screen context left
  // to inject (MQA-180: the description expired, focus moved, or Private View went on between the ask and
  // the send — routine on a Retry / "Go deeper" replay, which re-sends the intent flag minutes later).
  // The badge above is already cleared by then; this is what lets the UI say WHY, instead of degrading
  // silently — the same contract the live capture path holds for a failed capture.
  screenMissed?: boolean
  outputIntent?: 'direct' | 'ambient'
  // True only for AMBIENT auto-suggestions (req.mode === 'suggest'). Marks the card as auto-answer.
  // Ambient cards stay until Tony clicks or a new question replaces them. No TTL. Never auto-send.
  ephemeral?: boolean
  // Who is answering (from streamMeta, sent before any token) — lets the waiting UI name the brain
  // ("Asking your Dust agent…") instead of an anonymous spinner. Follows the latest retry/failover.
  provider?: ProviderId
  tier?: 'base' | 'think' | 'deep'
}

export interface AskRequest {
  mode: AskMode
  outputIntent?: 'direct' | 'ambient'
  /** G28: binds a conversation reply to its session and reply generation so main can route the spoken answer. */
  conversationReply?: { sessionId: string; replyGeneration: number }
  prompt?: string
  inputOrigin?: 'user-typed' | 'user-spoken-by-owner'
  label?: string
  kind?: 'answer' | 'factcheck'
  /** When true, main runs secret-redaction over `prompt` (not just `transcript`). Set only when the
   *  prompt embeds transcript-derived text (e.g. the fact-check transcript fallback) — never on a
   *  user's typed question, which must never be altered. */
  redactPrompt?: boolean
  image?: string
  /** Saved-meeting transcript, for summary and recap only. Live conversation context is `context`: main derives it. */
  transcript?: string
  /** The conversation context main derives from its own ledger (a SessionContext snapshot); see session-context-request. */
  context?: AskContextRequest
  history?: ChatTurn[]
  depth?: 'deeper' // set by "Go deeper" → ask for a fuller answer than the brief default
  agentOverride?: string // pins a specific Dust agent sId regardless of tier routing (e.g. Spotlight Ref)
  providerOverride?: ProviderId // forces this one request to a provider regardless of the active `provider` setting
  // Screen fast-path: answer using main's pre-analyzed, on-device screen context instead of a fresh capture.
  // A boolean intent only — main injects the actual description from its own cache (see screen-preprocess.ts).
  wantsScreenContext?: boolean
}
