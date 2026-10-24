/**
 * The workspace-state contract shared by main, the preload bridge and the renderer (Métis 2.12 G50, CAP-27).
 *
 * Main owns one workspace state per verified owner and tenant: the selected conversation, read and unread state with
 * derived counts, archive, pins and a search over the owner's own conversations. Unread is derived from a persisted read
 * position against the conversation's last position and is never a stored count. The renderer never sees or supplies an
 * owner key, a tenant key or a `seq`: it marks a conversation read up to a turn id and main resolves the position.
 *
 * Channels live here, not in ipc.ts.
 */
import { z } from 'zod'
import { AssistantIdSchema } from './assistants'
import {
  CONVERSATION_LIMIT_PER_OWNER,
  ConversationIdSchema,
  ConversationViewSchema,
  RefusalSchema,
  TurnIdSchema
} from './conversations'

export const WORKSPACE_IPC = {
  get: 'workspace:get',
  select: 'workspace:select',
  markRead: 'workspace:markRead',
  markUnread: 'workspace:markUnread',
  setArchived: 'workspace:setArchived',
  setPinned: 'workspace:setPinned',
  search: 'workspace:search'
} as const

/** PROPOSED bounds. */
export const WORKSPACE_PIN_MAX = 12
export const WORKSPACE_SEARCH_QUERY_MIN = 2
export const WORKSPACE_SEARCH_QUERY_MAX = 100
export const WORKSPACE_SEARCH_LIMIT_MAX = 50
export const WORKSPACE_SEARCH_SCAN_BUDGET = 100
export const WORKSPACE_SNIPPET_MAX = 160

const REV = z.number().int().nonnegative()

export const GetRequestSchema = z.undefined()
export const SelectRequestSchema = z.object({ conversationId: ConversationIdSchema.nullable() }).strict()
export const MarkReadRequestSchema = z
  .object({ conversationId: ConversationIdSchema, throughTurnId: TurnIdSchema })
  .strict()
export const MarkUnreadRequestSchema = z.object({ conversationId: ConversationIdSchema }).strict()
export const SetArchivedRequestSchema = z
  .object({ conversationId: ConversationIdSchema, archived: z.boolean() })
  .strict()
export const SetPinnedRequestSchema = z.union([
  z.object({ kind: z.literal('conversation'), id: ConversationIdSchema, pinned: z.boolean() }).strict(),
  z.object({ kind: z.literal('assistant'), id: AssistantIdSchema, pinned: z.boolean() }).strict()
])
export const SearchRequestSchema = z
  .object({
    query: z.string().min(WORKSPACE_SEARCH_QUERY_MIN).max(WORKSPACE_SEARCH_QUERY_MAX),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(WORKSPACE_SEARCH_LIMIT_MAX)
  })
  .strict()

export const WorkspaceItemSchema = z
  .object({
    conversation: ConversationViewSchema,
    unread: z.boolean(),
    unreadTurns: z.number().int().nonnegative(),
    pinned: z.boolean(),
    archived: z.boolean()
  })
  .strict()
export type WorkspaceItem = z.infer<typeof WorkspaceItemSchema>

export const WorkspaceCountsSchema = z
  .object({
    unreadConversations: z.number().int().nonnegative(),
    readConversations: z.number().int().nonnegative(),
    archivedConversations: z.number().int().nonnegative()
  })
  .strict()

export const GetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      rev: REV,
      selectedConversationId: ConversationIdSchema.nullable(),
      counts: WorkspaceCountsSchema,
      items: z.array(WorkspaceItemSchema).max(CONVERSATION_LIMIT_PER_OWNER),
      pinnedAssistantIds: z.array(AssistantIdSchema).max(WORKSPACE_PIN_MAX)
    })
    .strict(),
  RefusalSchema
])
export const MutationResultSchema = z.union([z.object({ ok: z.literal(true), rev: REV }).strict(), RefusalSchema])

export const SearchHitSchema = z
  .object({
    conversationId: ConversationIdSchema,
    label: z.enum(['active', 'archived', 'dead']),
    turnId: TurnIdSchema.nullable(),
    snippet: z.string().max(WORKSPACE_SNIPPET_MAX).nullable(),
    matched: z.enum(['assistant-name', 'turn'])
  })
  .strict()
export const SearchResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      hits: z.array(SearchHitSchema).max(WORKSPACE_SEARCH_LIMIT_MAX),
      truncated: z.boolean()
    })
    .strict(),
  RefusalSchema
])

export type GetResult = z.infer<typeof GetResultSchema>
export type MutationResult = z.infer<typeof MutationResultSchema>
export type SearchResult = z.infer<typeof SearchResultSchema>
export type SearchHit = z.infer<typeof SearchHitSchema>
