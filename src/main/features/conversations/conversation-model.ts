import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  CONVERSATION_LIMIT_PER_OWNER,
  CONVERSATION_RECENT_RUNS,
  CONVERSATION_TURN_LIMIT,
  CONVERSATION_TURN_MAX_CHARS,
  ConversationIdSchema,
  DRAFT_MAX_CHARS,
  DRAFT_MAX_PER_OWNER,
  DRAFT_TTL_MS,
  MeetingFileSchema,
  TurnIdSchema,
  type ConversationView,
  type DeadReason
} from '@shared/conversations'
import { AssistantIdSchema } from '@shared/assistants'

const PARTITION = z.string().regex(/^(?:legacy|[0-9a-f]{24})$/)
const KEY = z.string().regex(/^[0-9a-f]{64}$/)
const TIME = z.number().int().nonnegative()

export const RemoteRefSchema = z
  .object({ provider: z.literal('dust'), epoch: z.number().int().nonnegative(), at: TIME })
  .strict()
export type RemoteRef = z.infer<typeof RemoteRefSchema>

export const ConversationRecordSchema = z
  .object({
    id: ConversationIdSchema,
    ownerKey: KEY,
    tenantKey: KEY,
    assistantId: AssistantIdSchema,
    meetingFile: MeetingFileSchema.nullable(),
    remote: RemoteRefSchema.nullable(),
    createdAt: TIME,
    updatedAt: TIME,
    lastSeq: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    linkedFrom: ConversationIdSchema.nullable(),
    supersededBy: ConversationIdSchema.nullable(),
    anchorTurnId: TurnIdSchema.nullable(),
    recentRunIds: z.array(z.string().max(64)).max(CONVERSATION_RECENT_RUNS)
  })
  .strict()
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>

export const DraftSchema = z
  .object({
    conversationId: ConversationIdSchema,
    ownerKey: KEY,
    tenantKey: KEY,
    text: z.string().max(DRAFT_MAX_CHARS),
    updatedAt: TIME
  })
  .strict()
export type Draft = z.infer<typeof DraftSchema>

export const IndexDocSchema = z
  .object({
    v: z.literal(1),
    partitionId: PARTITION,
    ownerKey: KEY,
    tenantKey: KEY,
    // Foreign owners' records share the partition file and are kept untouched, so the bound is for the whole file.
    conversations: z.array(ConversationRecordSchema).max(CONVERSATION_LIMIT_PER_OWNER * 4),
    drafts: z.array(DraftSchema).max(DRAFT_MAX_PER_OWNER * 4)
  })
  .strict()
export type IndexDoc = z.infer<typeof IndexDocSchema>

export const TurnSchema = z
  .object({
    id: TurnIdSchema,
    seq: z.number().int().positive(),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(CONVERSATION_TURN_MAX_CHARS),
    at: TIME
  })
  .strict()
export type Turn = z.infer<typeof TurnSchema>

export const TurnDocSchema = z
  .object({
    v: z.literal(1),
    partitionId: PARTITION,
    ownerKey: KEY,
    tenantKey: KEY,
    conversationId: ConversationIdSchema,
    turns: z.array(TurnSchema).max(CONVERSATION_TURN_LIMIT)
  })
  .strict()
export type TurnDoc = z.infer<typeof TurnDocSchema>

export const newConversationId = (): string => `c_${randomBytes(16).toString('hex')}`
export const newTurnId = (): string => `t_${randomBytes(16).toString('hex')}`

/** What decides whether a thread is still attached to the things it was started from. */
export interface ThreadContext {
  assistantIds: ReadonlySet<string>
  assistantArchived: ReadonlySet<string>
  meetingFiles: ReadonlySet<string>
  /** The remote (Dust) conversation epoch now, and how long a remote conversation lives. */
  remoteEpoch: number
  remoteTtlMs: number
  now: number
}

export type ThreadStatus = { status: 'live'; deadReason: null } | { status: 'dead'; deadReason: DeadReason }

/**
 * Derived on every read and never stored, so an assistant that reappears revives its thread. Precedence is fixed:
 * superseded, assistant-missing, assistant-archived, meeting-missing, remote-lost.
 */
export function deriveThreadStatus(record: ConversationRecord, ctx: ThreadContext): ThreadStatus {
  const dead = (deadReason: DeadReason): ThreadStatus => ({ status: 'dead', deadReason })
  if (record.supersededBy !== null) return dead('superseded')
  if (!ctx.assistantIds.has(record.assistantId)) return dead('assistant-missing')
  if (ctx.assistantArchived.has(record.assistantId)) return dead('assistant-archived')
  if (record.meetingFile !== null && !ctx.meetingFiles.has(record.meetingFile)) return dead('meeting-missing')
  if (
    record.remote !== null &&
    (record.remote.epoch !== ctx.remoteEpoch || ctx.now - record.remote.at > ctx.remoteTtlMs)
  ) {
    return dead('remote-lost')
  }
  return { status: 'live', deadReason: null }
}

export const viewOf = (record: ConversationRecord, ctx: ThreadContext): ConversationView => {
  const status = deriveThreadStatus(record, ctx)
  return {
    id: record.id,
    assistantId: record.assistantId,
    status: status.status,
    deadReason: status.deadReason,
    linkedFrom: record.linkedFrom,
    supersededBy: record.supersededBy,
    updatedAt: record.updatedAt,
    turnCount: record.turnCount
  }
}

/**
 * The retention bound for composer drafts, applied inside every transaction (no timer): a draft expires once it is
 * `DRAFT_TTL_MS` old (the boundary millisecond is expired), and an owner keeps at most `DRAFT_MAX_PER_OWNER`, the
 * least recently saved evicted first. Returns the drafts kept and how many expired. Other owners' drafts pass through.
 */
export function pruneDrafts(
  drafts: readonly Draft[],
  owner: { ownerKey: string; tenantKey: string },
  now: number
): { drafts: Draft[]; expired: number } {
  const mine = (d: Draft): boolean => d.ownerKey === owner.ownerKey && d.tenantKey === owner.tenantKey
  const live = drafts.filter((d) => !mine(d) || now - d.updatedAt < DRAFT_TTL_MS)
  const expired = drafts.length - live.length
  const own = live
    .filter(mine)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId))
  const keep = new Set(own.slice(0, DRAFT_MAX_PER_OWNER))
  return { drafts: live.filter((d) => !mine(d) || keep.has(d)), expired }
}

/** The longest supersede chain followed from one thread. */
export const MAX_CHAIN = 50

export const byRecent = (a: ConversationRecord, b: ConversationRecord): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

/** True for a row that belongs to the verified owner and tenant; other owners' rows share the partition file. */
export const isMine =
  (scope: { ownerKey: string; tenantKey: string }) =>
  (r: { ownerKey: string; tenantKey: string }): boolean =>
    r.ownerKey === scope.ownerKey && r.tenantKey === scope.tenantKey

export interface ThreadContextSources {
  /** The owner's assistants with their archive flag. Throws when they cannot be read. */
  assistants(): Promise<ReadonlyArray<{ id: string; archived: boolean }>>
  /** The saved meetings' own file names. Throws when they cannot be read. */
  meetings(): Promise<readonly string[]>
  remote(): { epoch: number; active: boolean; ttlMs: number }
  now(): number
}

/** What a thread is still attached to, or null when that cannot be read (nothing may then be decided). */
export async function buildThreadContext(sources: ThreadContextSources): Promise<ThreadContext | null> {
  try {
    const [assistants, meetings] = await Promise.all([sources.assistants(), sources.meetings()])
    const remote = sources.remote()
    return {
      assistantIds: new Set(assistants.map((a) => a.id)),
      assistantArchived: new Set(assistants.filter((a) => a.archived).map((a) => a.id)),
      meetingFiles: new Set(meetings),
      remoteEpoch: remote.epoch,
      remoteTtlMs: remote.ttlMs,
      now: sources.now()
    }
  } catch {
    return null
  }
}
