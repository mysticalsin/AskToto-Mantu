import { z } from 'zod'
import { AssistantIdSchema } from '@shared/assistants'
import { WORKSPACE_PIN_MAX, WORKSPACE_SEARCH_QUERY_MIN, WORKSPACE_SNIPPET_MAX } from '@shared/conversation-workspace'
import { CONVERSATION_LIMIT_PER_OWNER, ConversationIdSchema } from '@shared/conversations'
import { isMine, type ConversationRecord } from './conversation-model'

const PARTITION = z.string().regex(/^(?:legacy|[0-9a-f]{24})$/)
const KEY = z.string().regex(/^[0-9a-f]{64}$/)
const TIME = z.number().int().nonnegative()
const SCOPED = { ownerKey: KEY, tenantKey: KEY }
/** Foreign owners' rows share the partition file and are kept untouched, so every bound is for the whole file. */
const OWNERS_MAX = 16
const ROWS_MAX = CONVERSATION_LIMIT_PER_OWNER * 4

export const OwnerRowSchema = z
  .object({
    ...SCOPED,
    baselinedAt: TIME,
    selected: ConversationIdSchema.nullable(),
    rev: z.number().int().nonnegative()
  })
  .strict()
export const ReadRowSchema = z
  .object({
    ...SCOPED,
    conversationId: ConversationIdSchema,
    readSeq: z.number().int().nonnegative(),
    manualUnread: z.boolean(),
    at: TIME
  })
  .strict()
export const ArchivedRowSchema = z.object({ ...SCOPED, conversationId: ConversationIdSchema, at: TIME }).strict()
export const PinRowSchema = z
  .object({
    ...SCOPED,
    kind: z.enum(['conversation', 'assistant']),
    id: z.union([ConversationIdSchema, AssistantIdSchema]),
    at: TIME
  })
  .strict()

export const WorkspaceDocSchema = z
  .object({
    v: z.literal(1),
    partitionId: PARTITION,
    ownerKey: KEY,
    tenantKey: KEY,
    owners: z.array(OwnerRowSchema).max(OWNERS_MAX),
    reads: z.array(ReadRowSchema).max(ROWS_MAX),
    archived: z.array(ArchivedRowSchema).max(ROWS_MAX),
    pins: z.array(PinRowSchema).max(WORKSPACE_PIN_MAX * 4)
  })
  .strict()
export type WorkspaceDoc = z.infer<typeof WorkspaceDocSchema>
export type OwnerRow = z.infer<typeof OwnerRowSchema>
export type ReadRow = z.infer<typeof ReadRowSchema>
export type PinRow = z.infer<typeof PinRowSchema>

type Owner = { ownerKey: string; tenantKey: string }

export const emptyWorkspaceDoc = (scope: Owner & { partitionId: string }): WorkspaceDoc => ({
  v: 1,
  partitionId: scope.partitionId,
  ownerKey: scope.ownerKey,
  tenantKey: scope.tenantKey,
  owners: [],
  reads: [],
  archived: [],
  pins: []
})

/**
 * Unread is derived on every read and never stored: a conversation is unread when its last position is past the
 * persisted read position, or when the person marked it unread. A superseded or archived one never counts.
 */
export function deriveUnread(
  record: Pick<ConversationRecord, 'lastSeq' | 'supersededBy'>,
  read: Pick<ReadRow, 'readSeq' | 'manualUnread'> | undefined,
  archived: boolean
): { unread: boolean; unreadTurns: number } {
  if (archived || record.supersededBy !== null) return { unread: false, unreadTurns: 0 }
  const unreadTurns = Math.max(0, record.lastSeq - (read?.readSeq ?? 0))
  return { unread: (read?.manualUnread ?? false) || unreadTurns > 0, unreadTurns }
}

/**
 * The first transaction for an owner marks the history that already exists as read, so an upgrade does not show every
 * old conversation as unread. After that a conversation with no read row has been read up to position 0.
 */
export function baselineOwner(
  doc: WorkspaceDoc,
  owner: Owner,
  records: readonly ConversationRecord[],
  now: number
): WorkspaceDoc {
  if (doc.owners.some(isMine(owner))) return doc
  const reads: ReadRow[] = records.map((r) => ({
    ownerKey: owner.ownerKey,
    tenantKey: owner.tenantKey,
    conversationId: r.id,
    readSeq: r.lastSeq,
    manualUnread: false,
    at: now
  }))
  return {
    ...doc,
    owners: [
      ...doc.owners,
      { ownerKey: owner.ownerKey, tenantKey: owner.tenantKey, baselinedAt: now, selected: null, rev: 0 }
    ],
    reads: [...doc.reads, ...reads]
  }
}

/** The owner's pins in a stable order (oldest first), at most `WORKSPACE_PIN_MAX`. Other owners' pins pass through. */
export function prunePins(pins: readonly PinRow[], owner: Owner): PinRow[] {
  const own = pins
    .filter(isMine(owner))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, WORKSPACE_PIN_MAX)
  return [...pins.filter((p) => !isMine(owner)(p)), ...own]
}

/**
 * Drops the owner's rows whose conversation or assistant no longer exists. Runs inside every committing transaction
 * (no timer). Other owners' rows pass through untouched.
 */
export function pruneWorkspace(
  doc: WorkspaceDoc,
  owner: Owner,
  live: { conversationIds: ReadonlySet<string>; assistantIds: ReadonlySet<string> }
): WorkspaceDoc {
  const mine = isMine(owner)
  return {
    ...doc,
    reads: doc.reads.filter((r) => !mine(r) || live.conversationIds.has(r.conversationId)),
    archived: doc.archived.filter((r) => !mine(r) || live.conversationIds.has(r.conversationId)),
    pins: prunePins(
      doc.pins.filter(
        (p) => !mine(p) || (p.kind === 'conversation' ? live.conversationIds : live.assistantIds).has(p.id)
      ),
      owner
    )
  }
}

/** NFKC and lower case; null when the query is too short to search. */
export function normalizeQuery(query: string): string | null {
  const normalized = query.normalize('NFKC').toLowerCase().trim()
  return normalized.length < WORKSPACE_SEARCH_QUERY_MIN ? null : normalized
}

/** A bounded window of `text` around the first match of `needle` (already normalized). */
export function snippetAround(text: string, needle: string, max = WORKSPACE_SNIPPET_MAX): string {
  const folded = text.normalize('NFKC').toLowerCase()
  // When folding changed the length, positions no longer line up with the original, so cut the folded text instead.
  const source = folded.length === text.length ? text : folded
  const at = Math.max(0, folded.indexOf(needle))
  if (source.length <= max) return source
  const start = Math.max(0, Math.min(at - Math.floor((max - needle.length) / 2), source.length - max))
  return source.slice(start, start + max)
}
