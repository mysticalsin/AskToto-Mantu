/**
 * The personal dictation dictionary (G26): term to preferred spelling, learned only from the owned span.
 *
 * What it learns from: a correction the person made inside Métis to text Métis itself dictated for them, passed as a
 * minted `OwnedSpan` (the original, which main holds) and the corrected text. `learnFromCorrection` refuses anything
 * that is not a minted span, so there is no path from a meeting transcript, another person's speech, a screen or a
 * field's readback, and no entry point that takes a term directly.
 *
 * Storage, per partition: `<userData>/dictation-memory/dictionary/<partition>.dd1`, one sealed record (AES-256-GCM,
 * the partition bound in as additional data). The partition is G19's active (tenant, owner) memory partition; with none
 * open the dictionary is unavailable. Another partition's file is neither read, changed nor deleted.
 *
 * Inspect and delete: `list`, `remove` (one entry) and `clear` (the whole dictionary). A delete never needs a span
 * and works on an unreadable file. A file that cannot be read is reported `unavailable` and never overwritten.
 *
 * Bounded (PROPOSED): 500 entries, the least recently updated evicted first; a term and its spelling at most 64
 * characters. Async fs only; nothing here logs or audits text.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DictionaryEntry, DictionaryList } from '@shared/dictation-memory'
import { atomicSavedWrite } from '../../infra/storage/atomic-saved-write'
import type { MemoryKeyring } from './dictation-memory-crypto'
import { DICTATION_DICTIONARY_LIMITS, type DictationDictionaryLimits } from './dictation-memory-policy'
import { isOwnedSpan, type OwnedSpan } from './dictation-owned-span'
import { extractTermCorrections } from './dictation-term-diff'

export interface DictationDictionaryDeps {
  /** `<userData>/dictation-memory/dictionary`. Created on first write. */
  rootDir(): string
  keyring: MemoryKeyring
  /** The memory partition in force (G19), on every use; null when none is open: the dictionary is then unavailable. */
  partition(): string | null
  /** Lifecycle generation supplied by the owner of this dictionary; changes on revoke/disposal. */
  ownerEpoch?(): number
  now(): number
  newId?(): string
  /** Test seam: may only tighten the policy. */
  limits?: Partial<DictationDictionaryLimits>
}

export interface DictationDictionary {
  list(): Promise<DictionaryList>
  /** The only way a term is learned. Returns how many entries were added or updated. */
  learnFromCorrection(span: OwnedSpan, correctedText: string): Promise<{ learned: number }>
  remove(id: string): Promise<boolean>
  /** Deletes every entry of this partition. Returns how many there were. */
  clear(): Promise<number>
}

const FileSchema = z
  .object({
    v: z.literal(1),
    partition: z.string().min(1).max(64),
    entries: z
      .array(
        z
          .object({
            id: z.string().regex(/^[0-9a-f]{32}$/),
            heard: z.string().min(1).max(128),
            preferred: z.string().min(1).max(128),
            count: z.number().int().positive(),
            createdAtMs: z.number().int().nonnegative(),
            updatedAtMs: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(2_000)
  })
  .strict()
type Stored = z.infer<typeof FileSchema>
type StoredEntry = Stored['entries'][number]

/** G19 ids: `legacy` or 24 hex characters (32 is accepted for synthetic fixtures). */
const PARTITION = /^(?:legacy|[0-9a-f]{24,32})$/
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

export function createDictationDictionary(deps: DictationDictionaryDeps): DictationDictionary {
  const limits: DictationDictionaryLimits = { ...DICTATION_DICTIONARY_LIMITS, ...deps.limits }
  const newId = deps.newId ?? ((): string => randomBytes(16).toString('hex'))
  let chain: Promise<unknown> = Promise.resolve()

  /** One writer at a time: concurrent corrections are applied in order and none is lost. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
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
  const ownerEpochOf = (): number | null => {
    if (!deps.ownerEpoch) return 0
    try {
      const epoch = deps.ownerEpoch()
      return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null
    } catch {
      return null
    }
  }
  const ownerIsCurrent = (partition: string, epoch: number): boolean =>
    partitionOf() === partition && ownerEpochOf() === epoch
  const pathOf = (partition: string): string => join(deps.rootDir(), `${partition}.dd1`)
  const aadOf = (partition: string): string => `dictation-dictionary:${partition}`

  type Load = { status: 'ok'; stored: Stored } | { status: 'unavailable' }

  async function load(partition: string): Promise<Load> {
    const empty: Stored = { v: 1, partition, entries: [] }
    let bytes: Buffer
    try {
      bytes = await readFile(pathOf(partition))
    } catch (error) {
      return isMissing(error) ? { status: 'ok', stored: empty } : { status: 'unavailable' }
    }
    try {
      const opened = await deps.keyring.open(bytes, aadOf(partition))
      if (!opened) return { status: 'unavailable' }
      const parsed = FileSchema.safeParse(JSON.parse(opened.toString('utf8')))
      return parsed.success && parsed.data.partition === partition
        ? { status: 'ok', stored: parsed.data }
        : { status: 'unavailable' }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async function save(partition: string, stored: Stored): Promise<boolean> {
    try {
      const sealed = await deps.keyring.seal(Buffer.from(JSON.stringify(stored), 'utf8'), aadOf(partition))
      if (!sealed) return false
      await mkdir(deps.rootDir(), { recursive: true, mode: 0o700 })
      await atomicSavedWrite(pathOf(partition), sealed)
      return true
    } catch {
      return false
    }
  }

  const view = (entry: StoredEntry): DictionaryEntry => ({
    id: entry.id,
    heard: entry.heard,
    preferred: entry.preferred,
    count: entry.count,
    updatedAtMs: entry.updatedAtMs
  })

  return {
    async list() {
      const partition = partitionOf()
      const epoch = ownerEpochOf()
      if (!partition || epoch === null) return { status: 'unavailable', entries: [] }
      const loaded = await serial(async (): Promise<Load> => {
        if (!ownerIsCurrent(partition, epoch)) return { status: 'unavailable' }
        const result = await load(partition)
        return result.status === 'ok' && ownerIsCurrent(partition, epoch) ? result : { status: 'unavailable' }
      })
      if (loaded.status !== 'ok' || !ownerIsCurrent(partition, epoch)) return { status: 'unavailable', entries: [] }
      const entries = [...loaded.stored.entries].sort(
        (a, b) => b.updatedAtMs - a.updatedAtMs || a.heard.localeCompare(b.heard)
      )
      return { status: 'ok', entries: entries.map(view) }
    },

    async learnFromCorrection(span, correctedText) {
      if (!isOwnedSpan(span) || typeof correctedText !== 'string') return { learned: 0 }
      const partition = partitionOf()
      if (!partition) return { learned: 0 }
      const pairs = extractTermCorrections(span.text, correctedText).filter(
        (pair) => pair.heard.length <= limits.maxTermChars && pair.preferred.length <= limits.maxTermChars
      )
      if (pairs.length === 0) return { learned: 0 }
      return serial(async () => {
        const loaded = await load(partition)
        if (loaded.status !== 'ok') return { learned: 0 }
        const now = deps.now()
        let entries = [...loaded.stored.entries]
        for (const pair of pairs) {
          const at = entries.findIndex((entry) => entry.heard === pair.heard)
          if (at >= 0) {
            const entry = entries[at]
            entries[at] =
              entry.preferred === pair.preferred
                ? { ...entry, count: entry.count + 1, updatedAtMs: now }
                : { ...entry, preferred: pair.preferred, count: 1, updatedAtMs: now }
          } else {
            entries.push({
              id: newId(),
              heard: pair.heard,
              preferred: pair.preferred,
              count: 1,
              createdAtMs: now,
              updatedAtMs: now
            })
          }
        }
        if (entries.length > limits.maxEntries) {
          entries = [...entries].sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, limits.maxEntries)
        }
        return (await save(partition, { v: 1, partition, entries })) ? { learned: pairs.length } : { learned: 0 }
      })
    },

    async remove(id) {
      const partition = partitionOf()
      if (!partition || !/^[0-9a-f]{32}$/.test(id)) return false
      return serial(async () => {
        const loaded = await load(partition)
        if (loaded.status !== 'ok') return false
        const entries = loaded.stored.entries.filter((entry) => entry.id !== id)
        if (entries.length === loaded.stored.entries.length) return false
        return save(partition, { v: 1, partition, entries })
      })
    },

    async clear() {
      const partition = partitionOf()
      if (!partition) return 0
      return serial(async () => {
        const loaded = await load(partition)
        const count = loaded.status === 'ok' ? loaded.stored.entries.length : 0
        try {
          await unlink(pathOf(partition))
        } catch (error) {
          if (!isMissing(error)) return 0
        }
        return count
      })
    }
  }
}
