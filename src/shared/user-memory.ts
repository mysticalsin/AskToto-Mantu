/**
 * The user memory contract shared by main, the preload bridge and the renderer (Métis 2.12 G57, CAP-29).
 *
 * Two typed classes, kept apart:
 *  - `preference`: durable, owner-stated ("call me Tony", "answer in Portuguese"). No expiry.
 *  - `project-context`: what the owner is working on now. Expires (PROPOSED: 30 days, refreshed each time it is used).
 *
 * Only the owner's own typed or spoken command, or the owner's Settings, can create a preference (G36): content-derived
 * text never can. Correcting a preference writes a new revision and tombstones the old; deleting writes a tombstone so
 * a later re-ingest or sync cannot bring it back. Tombstones hold a hash, never the text.
 *
 * The renderer can list, correct and delete by opaque id. There is no channel that adds an item, so what it sees is
 * only what main accepted from an owner command.
 */
import { z } from 'zod'

export const USER_MEMORY_IPC = {
  list: 'userMemory:list',
  correct: 'userMemory:correct',
  delete: 'userMemory:delete'
} as const

export const USER_MEMORY_KINDS = ['preference', 'project-context'] as const
export type UserMemoryKind = (typeof USER_MEMORY_KINDS)[number]

/**
 * Where an item came from. A preference is only ever `owner-typed`, `owner-spoken` or `settings`; `derived` (a re-ingest
 * or a sync, never the owner's own command) can only label project context.
 */
export const USER_MEMORY_SOURCES = ['owner-typed', 'owner-spoken', 'settings', 'derived'] as const
export type UserMemorySource = (typeof USER_MEMORY_SOURCES)[number]

const DAY_MS = 86_400_000
/** PROPOSED: project context lapses after 30 days without use. */
export const PROJECT_CONTEXT_TTL_MS = 30 * DAY_MS
/** PROPOSED: the longest remembered statement. */
export const USER_MEMORY_TEXT_MAX_CHARS = 400
/** PROPOSED: items kept per kind and partition; the least recently used project context is dropped first. */
export const USER_MEMORY_MAX_PREFERENCES = 100
export const USER_MEMORY_MAX_PROJECT_CONTEXT = 50

export const UserMemoryIdSchema = z.string().regex(/^[0-9a-f]{32}$/)
export const UserMemoryTextSchema = z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX_CHARS)

/** Renderer-safe view: the text the owner said, where and when, and when it ends. Never an instruction channel. */
export const UserMemoryItemSchema = z
  .object({
    id: UserMemoryIdSchema,
    kind: z.enum(USER_MEMORY_KINDS),
    text: UserMemoryTextSchema,
    source: z.enum(USER_MEMORY_SOURCES),
    at: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    /** Project context: when it lapses unless used again. Null for a preference. */
    expiresAt: z.number().int().nonnegative().nullable(),
    /** Project context: the conversation or meeting it came from, when there was one. */
    conversation: z.string().max(80).nullable()
  })
  .strict()
export type UserMemoryItem = z.infer<typeof UserMemoryItemSchema>

export const UserMemoryListSchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    items: z.array(UserMemoryItemSchema).max(200),
    /** How many deleted, corrected or expired items main remembers only as a count or a hash. */
    tombstones: z.number().int().nonnegative()
  })
  .strict()
export type UserMemoryList = z.infer<typeof UserMemoryListSchema>

export const UserMemoryCorrectSchema = z.object({ id: UserMemoryIdSchema, text: UserMemoryTextSchema }).strict()
export type UserMemoryCorrect = z.infer<typeof UserMemoryCorrectSchema>
export const UserMemoryDeleteSchema = z.object({ id: UserMemoryIdSchema }).strict()
export type UserMemoryDelete = z.infer<typeof UserMemoryDeleteSchema>

/** Content-free reply: never says why a write was refused. */
export const UserMemoryAckSchema = z.object({ ok: z.boolean() }).strict()
export type UserMemoryAck = z.infer<typeof UserMemoryAckSchema>
