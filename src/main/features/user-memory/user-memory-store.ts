/**
 * The user memory store (G57, CAP-29): durable preferences and expiring project context, sealed per memory partition.
 *
 * Storage: `<root>/<partition>.um1`, one AES-256-GCM record (the G26 keyring, the partition bound in as additional
 * data). The partition is G19's verified (tenant, owner) partition; with none open nothing is read or written, and
 * another partition's file is never touched. A file that cannot be read is `unavailable` and never overwritten.
 *
 * What may create a preference (G36): only `remember`, and only from an owner command record (typed or spoken by the
 * owner, `authority: instruction`) or the owner's Settings. Text that came from content (a meeting, a screen, a
 * document, a re-ingest or a sync) goes through `admitDerived`, which can never produce a preference.
 *
 * Tombstones: deleting or correcting writes a hash of (kind, normalized text), never the text, and `admitDerived`
 * refuses a candidate whose hash is tombstoned, so a re-ingest or a sync cannot bring it back. Only an explicit owner
 * command lifts a tombstone. Expiry removes project context and leaves only a count.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { mayProposeActions, type ContextRecord } from '@shared/context-authority'
import {
  PROJECT_CONTEXT_TTL_MS,
  USER_MEMORY_KINDS,
  USER_MEMORY_MAX_PREFERENCES,
  USER_MEMORY_MAX_PROJECT_CONTEXT,
  USER_MEMORY_SOURCES,
  USER_MEMORY_TEXT_MAX_CHARS,
  type UserMemoryItem,
  type UserMemoryKind,
  type UserMemoryList,
  type UserMemorySource
} from '@shared/user-memory'
import { atomicSavedWrite } from '../../infra/storage/atomic-saved-write'
import type { MemoryKeyring } from '../dictation'

export interface UserMemoryStoreDeps {
  rootDir(): string
  keyring: MemoryKeyring
  /** The memory partition in force, on every use; null when none is open. */
  partition(): string | null
  now(): number
  newId?(): string
}

export interface RememberMeta {
  kind: UserMemoryKind
  /** The turn the owner said it in. */
  turnId: string
  /** The conversation or meeting it was said in, when there was one. */
  conversation?: string | null
}

export interface Retrieved {
  preferences: UserMemoryItem[]
  projectContext: UserMemoryItem[]
}

export interface UserMemoryStore {
  /** An owner command (G36) states a preference or project context. Lifts a tombstone on the same text. */
  remember(record: ContextRecord, meta: RememberMeta): Promise<boolean>
  /** The owner's Settings states a preference. */
  rememberFromSettings(text: string): Promise<boolean>
  /**
   * Text derived from content (a re-ingest, a sync, a meeting). Project context only, and never what was deleted or
   * corrected away. Returns whether it was stored.
   */
  admitDerived(candidate: { kind: UserMemoryKind; text: string; conversation?: string | null }): Promise<boolean>
  list(): Promise<UserMemoryList>
  /** A new revision replaces the item; the old text is tombstoned. */
  correct(id: string, text: string): Promise<boolean>
  /** Removes the item and tombstones its text. */
  delete(id: string): Promise<boolean>
  /** What a prompt may carry now. Sweeps expired project context and refreshes the TTL of what is returned. */
  retrieve(): Promise<Retrieved>
}

const StoredItemSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    kind: z.enum(USER_MEMORY_KINDS),
    text: z.string().min(1).max(USER_MEMORY_TEXT_MAX_CHARS),
    source: z.enum(USER_MEMORY_SOURCES),
    at: z.number().int().nonnegative(),
    turnId: z.string().max(200).nullable(),
    conversation: z.string().max(80).nullable(),
    revision: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative().nullable(),
    lastUsedAt: z.number().int().nonnegative()
  })
  .strict()
type StoredItem = z.infer<typeof StoredItemSchema>

const FileSchema = z
  .object({
    v: z.literal(1),
    partition: z.string().min(1).max(64),
    items: z.array(StoredItemSchema).max(500),
    tombstones: z.array(z.object({ h: z.string().length(64), at: z.number().int().nonnegative() }).strict()),
    tombstoneCount: z.number().int().nonnegative()
  })
  .strict()
type Stored = z.infer<typeof FileSchema>

const PARTITION = /^(?:legacy|[0-9a-f]{24,32})$/
const REFRESH_MIN_MS = 3_600_000
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()
const clean = (text: string): string | null => {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 0 && t.length <= USER_MEMORY_TEXT_MAX_CHARS ? t : null
}
const conversationLabel = (value: string | null | undefined): string | null => {
  const v = value?.trim().slice(0, 80)
  return v ? v : null
}

export function createUserMemoryStore(deps: UserMemoryStoreDeps): UserMemoryStore {
  const newId = deps.newId ?? ((): string => randomBytes(16).toString('hex'))
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work)
    chain = run.catch(() => undefined)
    return run
  }
  const partitionOf = (): string | null => {
    try {
      const partition = deps.partition()
      return partition !== null && PARTITION.test(partition) ? partition : null
    } catch {
      return null
    }
  }
  const pathOf = (partition: string): string => join(deps.rootDir(), `${partition}.um1`)
  const aadOf = (partition: string): string => `user-memory:${partition}`
  const hashOf = (partition: string, kind: UserMemoryKind, text: string): string =>
    createHash('sha256')
      .update(`${partition}\0${kind}\0${normalize(text)}`)
      .digest('hex')

  async function load(partition: string): Promise<Stored | null> {
    const empty: Stored = { v: 1, partition, items: [], tombstones: [], tombstoneCount: 0 }
    let bytes: Buffer
    try {
      bytes = await readFile(pathOf(partition))
    } catch (error) {
      return isMissing(error) && partitionOf() === partition ? empty : null
    }
    try {
      const opened = await deps.keyring.open(bytes, aadOf(partition))
      if (!opened || partitionOf() !== partition) return null
      const parsed = FileSchema.safeParse(JSON.parse(opened.toString('utf8')))
      return parsed.success && parsed.data.partition === partition ? parsed.data : null
    } catch {
      return null
    }
  }

  async function save(partition: string, stored: Stored): Promise<boolean> {
    try {
      if (partitionOf() !== partition) return false
      const sealed = await deps.keyring.seal(Buffer.from(JSON.stringify(stored), 'utf8'), aadOf(partition))
      if (!sealed || partitionOf() !== partition) return false
      await mkdir(deps.rootDir(), { recursive: true, mode: 0o700 })
      await atomicSavedWrite(pathOf(partition), sealed, () => {
        if (partitionOf() !== partition) throw new Error('User memory owner changed before replacement.')
      })
      return partitionOf() === partition
    } catch {
      return false
    }
  }

  /** Runs `change` on the partition's stored state under the write lock and saves it when `change` says so. */
  function mutate<T>(
    fallback: T,
    change: (stored: Stored, partition: string, now: number) => { result: T; dirty: boolean }
  ): Promise<T> {
    const partition = partitionOf()
    if (!partition) return Promise.resolve(fallback)
    return serial(async () => {
      if (partitionOf() !== partition) return fallback
      const stored = await load(partition)
      if (!stored || partitionOf() !== partition) return fallback
      const { result, dirty } = change(stored, partition, deps.now())
      if (!dirty) return result
      return (await save(partition, stored)) ? result : fallback
    })
  }

  /** Drops project context whose time is up, leaving a count. Returns whether anything changed. */
  function sweep(stored: Stored, now: number): boolean {
    const live = stored.items.filter((item) => item.expiresAt === null || item.expiresAt > now)
    const lapsed = stored.items.length - live.length
    if (lapsed === 0) return false
    stored.items = live
    stored.tombstoneCount += lapsed
    return true
  }

  function cap(stored: Stored): void {
    for (const [kind, max] of [
      ['preference', USER_MEMORY_MAX_PREFERENCES],
      ['project-context', USER_MEMORY_MAX_PROJECT_CONTEXT]
    ] as const) {
      const ofKind = stored.items.filter((item) => item.kind === kind).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      for (const dropped of ofKind.slice(max)) stored.items = stored.items.filter((item) => item.id !== dropped.id)
    }
  }

  function addTombstone(stored: Stored, hash: string, now: number): void {
    if (!stored.tombstones.some((tombstone) => tombstone.h === hash)) stored.tombstones.push({ h: hash, at: now })
    stored.tombstoneCount += 1
  }

  function place(
    stored: Stored,
    partition: string,
    now: number,
    entry: {
      kind: UserMemoryKind
      text: string
      source: UserMemorySource
      turnId: string | null
      conversation: string | null
    }
  ): void {
    const h = hashOf(partition, entry.kind, entry.text)
    stored.tombstones = stored.tombstones.filter((t) => t.h !== h)
    const same = stored.items.find((item) => item.kind === entry.kind && normalize(item.text) === normalize(entry.text))
    const expiresAt = entry.kind === 'project-context' ? now + PROJECT_CONTEXT_TTL_MS : null
    if (same) {
      same.lastUsedAt = now
      same.expiresAt = expiresAt
      // A repeated owner command updates its source and turn provenance. Derived syncs never downgrade an
      // owner-stated record, but refresh an already-derived record's provenance and TTL.
      if (entry.source !== 'derived' || same.source === 'derived') {
        same.source = entry.source
        same.at = now
        same.turnId = entry.turnId
        same.conversation = entry.conversation
      }
      return
    }
    stored.items.push({
      id: newId(),
      kind: entry.kind,
      text: entry.text,
      source: entry.source,
      at: now,
      turnId: entry.turnId,
      conversation: entry.conversation,
      revision: 1,
      expiresAt,
      lastUsedAt: now
    })
    cap(stored)
  }

  const view = (item: StoredItem): UserMemoryItem => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    source: item.source,
    at: item.at,
    turnId: item.turnId,
    revision: item.revision,
    expiresAt: item.expiresAt,
    conversation: item.conversation
  })

  return {
    remember(record, meta) {
      const text = typeof record?.text === 'string' ? clean(record.text) : null
      if (!text || !mayProposeActions(record)) return Promise.resolve(false)
      const source: UserMemorySource = record.origin === 'user-spoken-by-owner' ? 'owner-spoken' : 'owner-typed'
      return mutate(false, (stored, partition, now) => {
        sweep(stored, now)
        place(stored, partition, now, {
          kind: meta.kind,
          text,
          source,
          turnId: meta.turnId.slice(0, 200),
          conversation: meta.kind === 'project-context' ? conversationLabel(meta.conversation) : null
        })
        return { result: true, dirty: true }
      })
    },

    rememberFromSettings(text) {
      const cleaned = clean(text)
      if (!cleaned) return Promise.resolve(false)
      return mutate(false, (stored, partition, now) => {
        sweep(stored, now)
        place(stored, partition, now, {
          kind: 'preference',
          text: cleaned,
          source: 'settings',
          turnId: null,
          conversation: null
        })
        return { result: true, dirty: true }
      })
    },

    admitDerived(candidate) {
      const text =
        candidate.kind === 'project-context' && typeof candidate.text === 'string' ? clean(candidate.text) : null
      if (!text) return Promise.resolve(false)
      return mutate(false, (stored, partition, now) => {
        const swept = sweep(stored, now)
        const h = hashOf(partition, candidate.kind, text)
        if (stored.tombstones.some((t) => t.h === h)) return { result: false, dirty: swept }
        place(stored, partition, now, {
          kind: 'project-context',
          text,
          source: 'derived',
          turnId: null,
          conversation: conversationLabel(candidate.conversation)
        })
        return { result: true, dirty: true }
      })
    },

    async list() {
      const unavailable: UserMemoryList = { status: 'unavailable', items: [], tombstones: 0 }
      const partition = partitionOf()
      if (!partition) return unavailable
      return serial(async () => {
        const stored = await load(partition)
        if (!stored || partitionOf() !== partition) return unavailable
        if (sweep(stored, deps.now())) await save(partition, stored)
        const items = [...stored.items].sort((a, b) => b.at - a.at).map(view)
        return { status: 'ok', items, tombstones: stored.tombstoneCount }
      })
    },

    correct(id, text) {
      const cleaned = clean(text)
      if (!cleaned) return Promise.resolve(false)
      return mutate(false, (stored, partition, now) => {
        const swept = sweep(stored, now)
        const old = stored.items.find((item) => item.id === id)
        if (!old) return { result: false, dirty: swept }
        if (normalize(old.text) === normalize(cleaned)) return { result: true, dirty: swept }
        const rest = stored.items.filter((item) => item.id !== id)
        const duplicate = rest.find((item) => item.kind === old.kind && normalize(item.text) === normalize(cleaned))
        addTombstone(stored, hashOf(partition, old.kind, old.text), now)
        const newHash = hashOf(partition, old.kind, cleaned)
        // The correction is explicit owner input, so it may deliberately reintroduce a prior value.
        stored.tombstones = stored.tombstones.filter((tombstone) => tombstone.h !== newHash)
        const revised: StoredItem = {
          ...old,
          id: newId(),
          text: cleaned,
          source: 'settings',
          at: now,
          turnId: null,
          conversation: null,
          revision: Math.max(old.revision, duplicate?.revision ?? 0) + 1,
          lastUsedAt: now,
          expiresAt: old.kind === 'project-context' ? now + PROJECT_CONTEXT_TTL_MS : null
        }
        stored.items = [...rest.filter((item) => item.id !== duplicate?.id), revised]
        return { result: true, dirty: true }
      })
    },

    delete(id) {
      return mutate(false, (stored, partition, now) => {
        sweep(stored, now)
        const old = stored.items.find((item) => item.id === id)
        if (!old) return { result: false, dirty: false }
        stored.items = stored.items.filter((item) => item.id !== id)
        addTombstone(stored, hashOf(partition, old.kind, old.text), now)
        return { result: true, dirty: true }
      })
    },

    async retrieve() {
      const none: Retrieved = { preferences: [], projectContext: [] }
      return mutate(none, (stored, _partition, now) => {
        const swept = sweep(stored, now)
        const used = stored.items.filter((item) => item.kind === 'project-context')
        let refreshed = false
        for (const item of used) {
          // Used, so it lives on: refreshed at most hourly, so a busy session is not a write per question.
          if (now - item.lastUsedAt < REFRESH_MIN_MS) continue
          item.lastUsedAt = now
          item.expiresAt = now + PROJECT_CONTEXT_TTL_MS
          refreshed = true
        }
        const byRecent = (a: StoredItem, b: StoredItem): number => a.at - b.at
        return {
          result: {
            preferences: stored.items
              .filter((i) => i.kind === 'preference')
              .sort(byRecent)
              .map(view),
            projectContext: used.sort(byRecent).map(view)
          },
          dirty: swept || refreshed
        }
      })
    }
  }
}
