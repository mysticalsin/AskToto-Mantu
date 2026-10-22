import { z } from 'zod'
import { SESSION_OUTPUT_KINDS } from './kernel/session-context'

/**
 * Main-derived conversation context (Métis 2.12 G13, CAP-02).
 *
 * The renderer never sends the live transcript with an ask, a suggestion, a screen ask or a follow-up. It sends
 * which output it is (`kind`), how much transcript tail it wants, and where in its own prompt the transcript goes
 * (a slot token). Main fills the slot from a SessionContext snapshot of the transcript ledger it owns, so every
 * output of one meeting reads the same revision, and a snapshot that went stale is refused rather than answered.
 *
 * Slot tokens are inert text. They are replaced in one pass and only when the request declares a `context`.
 */
export const TRANSCRIPT_SLOT = '⟦metis:session-transcript⟧'
/** The most recent line the other side spoke (the fact-check claim), from the same snapshot. */
export const LAST_THEM_SLOT = '⟦metis:session-last-them⟧'

/** Most characters of transcript tail a request may ask for. */
export const SESSION_CONTEXT_MAX_TAIL = 20_000
/** The tail a suggestion or screen ask uses when it names no size (matches the previous renderer constant). */
export const SESSION_CONTEXT_DEFAULT_TAIL = 6_000

export const AskContextRequestSchema = z
  .object({
    kind: z.enum(SESSION_OUTPUT_KINDS),
    /** Characters of the most recent transcript the request wants. */
    tailChars: z.number().int().min(1).max(SESSION_CONTEXT_MAX_TAIL).default(SESSION_CONTEXT_DEFAULT_TAIL),
    /** Fill the request's `transcript` field (the suggest and screen-fusion shape) from the snapshot. */
    field: z.boolean().optional(),
    /** Refuse the ask when main holds no transcript, instead of sending an empty transcript block. */
    requireTranscript: z.boolean().optional()
  })
  .strict()
export type AskContextRequest = z.output<typeof AskContextRequestSchema>

/** The request half of a slot-bearing prompt. Spread into an ask: `{ prompt, context: askContext('conversation') }`. */
export const askContext = (
  kind: AskContextRequest['kind'],
  options: Partial<Omit<AskContextRequest, 'kind'>> = {}
): AskContextRequest => ({ kind, ...options, tailChars: options.tailChars ?? SESSION_CONTEXT_DEFAULT_TAIL })

/**
 * Local and legacy-cloud engines commit lines in the renderer; main only sees them if the renderer forwards them.
 * This is the one place a line crosses toward main, and it feeds the ledger, never an ask. Relay segments reach
 * main directly and are never forwarded.
 */
export const SESSION_CONTEXT_IPC = { appendLine: 'session-context:appendLine' } as const

const StartedAtSchema = z.number().int().positive().safe()
const LineTimeSchema = z.number().int().nonnegative().safe()

export const SessionLedgerLineSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('final'),
      startedAt: StartedAtSchema,
      t: LineTimeSchema,
      speaker: z.enum(['you', 'them', 'unknown']),
      text: z.string().min(1).max(16_384)
    })
    .strict(),
  z.object({ op: z.literal('retract'), startedAt: StartedAtSchema, t: LineTimeSchema }).strict()
])
export type SessionLedgerLine = z.infer<typeof SessionLedgerLineSchema>

/** Content-free: accepted or refused, never why. */
export interface SessionLedgerLineResult {
  status: 'accepted' | 'refused'
}
