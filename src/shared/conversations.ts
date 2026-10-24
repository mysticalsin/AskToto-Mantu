/**
 * The conversation contract shared by main, the preload bridge and the renderer (Métis 2.12 G49, CAP-26).
 *
 * Conversations persist encrypted in main under the active memory partition, scoped to the verified owner and tenant.
 * A conversation whose assistant, meeting or remote thread is gone stays readable and carries a typed dead reason;
 * appending to it starts a linked successor, so a thread is never dropped and never re-parented. The composer draft is
 * kept per conversation in main with a retention bound. History is paged by a monotonic `seq` cursor and returns an
 * anchor so the renderer can restore its reading position.
 *
 * Channels live here, not in ipc.ts. The renderer never sees or supplies an owner key, a tenant key or a `seq`.
 */
import { z } from 'zod'
import { AssistantIdSchema } from './assistants'

export const CONVERSATION_IPC = {
  list: 'conversations:list',
  open: 'conversations:open',
  history: 'conversations:history',
  append: 'conversations:append',
  draftGet: 'conversations:draftGet',
  draftSet: 'conversations:draftSet',
  setAnchor: 'conversations:setAnchor'
} as const

/** PROPOSED bounds. */
export const CONVERSATION_LIMIT_PER_OWNER = 300
export const CONVERSATION_TURN_LIMIT = 2_000
export const CONVERSATION_TURN_MAX_CHARS = 16_000
export const CONVERSATION_RECENT_RUNS = 64
export const DRAFT_MAX_CHARS = 8_000
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60_000
export const DRAFT_MAX_PER_OWNER = 20
export const HISTORY_PAGE_MAX = 50

export const ConversationIdSchema = z.string().regex(/^c_[0-9a-f]{32}$/)
export const TurnIdSchema = z.string().regex(/^t_[0-9a-f]{32}$/)
/** `s<seq>`: a position in the conversation, never a count. `s0` and non-digits are not cursors. */
export const CursorSchema = z.string().regex(/^s[1-9][0-9]{0,8}$/)
export const RunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const MeetingFileSchema = z.string().min(1).max(260)

export const DEAD_REASONS = [
  'superseded',
  'assistant-missing',
  'assistant-archived',
  'meeting-missing',
  'remote-lost'
] as const
export const DeadReasonSchema = z.enum(DEAD_REASONS)
export type DeadReason = z.infer<typeof DeadReasonSchema>

export const REFUSAL_REASONS = ['signed-out', 'invalid', 'not-found', 'limit', 'stale', 'unavailable'] as const
export const RefusalSchema = z.object({ ok: z.literal(false), reason: z.enum(REFUSAL_REASONS) }).strict()
export type ConversationRefusal = z.infer<typeof RefusalSchema>

const TIME = z.number().int().nonnegative()

export const ConversationViewSchema = z
  .object({
    id: ConversationIdSchema,
    assistantId: AssistantIdSchema,
    status: z.enum(['live', 'dead']),
    deadReason: DeadReasonSchema.nullable(),
    linkedFrom: ConversationIdSchema.nullable(),
    supersededBy: ConversationIdSchema.nullable(),
    updatedAt: TIME,
    turnCount: z.number().int().nonnegative()
  })
  .strict()
export type ConversationView = z.infer<typeof ConversationViewSchema>

export const TurnViewSchema = z
  .object({
    id: TurnIdSchema,
    seq: z.number().int().positive(),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(CONVERSATION_TURN_MAX_CHARS),
    at: TIME
  })
  .strict()
export type TurnView = z.infer<typeof TurnViewSchema>

export const ListRequestSchema = z.undefined()
export const OpenRequestSchema = z
  .object({
    assistantId: AssistantIdSchema,
    meetingFile: MeetingFileSchema.optional(),
    /** Start a new empty thread even when one exists for this assistant ("New chat"). */
    fresh: z.boolean().optional()
  })
  .strict()
export const HistoryRequestSchema = z
  .object({
    conversationId: ConversationIdSchema,
    before: CursorSchema.optional(),
    after: CursorSchema.optional(),
    limit: z.number().int().min(1).max(HISTORY_PAGE_MAX)
  })
  .strict()
  .refine((r) => r.before === undefined || r.after === undefined)
export const AppendRequestSchema = z
  .object({
    conversationId: ConversationIdSchema,
    assistantId: AssistantIdSchema,
    runId: RunIdSchema,
    turns: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(CONVERSATION_TURN_MAX_CHARS) })
          .strict()
      )
      .min(1)
      .max(2)
  })
  .strict()
export const DraftGetRequestSchema = z.object({ conversationId: ConversationIdSchema }).strict()
export const DraftSetRequestSchema = z
  .object({ conversationId: ConversationIdSchema, text: z.string().max(DRAFT_MAX_CHARS) })
  .strict()
export const SetAnchorRequestSchema = z.object({ conversationId: ConversationIdSchema, turnId: TurnIdSchema }).strict()

export const ListResultSchema = z.union([
  z
    .object({ ok: z.literal(true), conversations: z.array(ConversationViewSchema).max(CONVERSATION_LIMIT_PER_OWNER) })
    .strict(),
  RefusalSchema
])
export const OpenResultSchema = z.union([
  z.object({ ok: z.literal(true), conversation: ConversationViewSchema, created: z.boolean() }).strict(),
  RefusalSchema
])
export const HistoryResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      turns: z.array(TurnViewSchema).max(HISTORY_PAGE_MAX),
      nextBefore: CursorSchema.nullable(),
      latestSeq: z.number().int().nonnegative(),
      anchor: z.object({ turnId: TurnIdSchema, seq: z.number().int().positive() }).strict().nullable(),
      status: z.enum(['live', 'dead']),
      deadReason: DeadReasonSchema.nullable()
    })
    .strict(),
  RefusalSchema
])
export const AppendResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      conversationId: ConversationIdSchema,
      linkedFrom: ConversationIdSchema.nullable(),
      deadReason: DeadReasonSchema.nullable(),
      lastSeq: z.number().int().nonnegative()
    })
    .strict(),
  RefusalSchema
])
export const DraftGetResultSchema = z.union([
  z
    .object({ ok: z.literal(true), text: z.string().max(DRAFT_MAX_CHARS).nullable(), updatedAt: TIME.nullable() })
    .strict(),
  RefusalSchema
])
export const EmptyResultSchema = z.union([z.object({ ok: z.literal(true) }).strict(), RefusalSchema])

export type ListResult = z.infer<typeof ListResultSchema>
export type OpenResult = z.infer<typeof OpenResultSchema>
export type HistoryResult = z.infer<typeof HistoryResultSchema>
export type AppendResult = z.infer<typeof AppendResultSchema>
export type DraftGetResult = z.infer<typeof DraftGetResultSchema>
export type EmptyResult = z.infer<typeof EmptyResultSchema>
export type AppendRequest = z.infer<typeof AppendRequestSchema>
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>
