import { z } from 'zod'
import { emptyOwnerData, OwnerDataSchema, type OwnerData } from './model'

/** The partition in force and the verified owner and tenant keys, or null when nobody is verified. */
export interface SuggestionScope {
  partitionId: string
  ownerKey: string
  tenantKey: string
}

/** Sealed bytes by partition id. The only thing that ever touches disk. */
export interface SuggestionFileIo {
  read(partitionId: string): Promise<Buffer | null>
  write(partitionId: string, data: Buffer): Promise<void>
}

export interface SuggestionStoreDeps {
  io: SuggestionFileIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): SuggestionScope | null
}

export interface StoreView {
  /** Only the data of the owner and tenant in force. */
  readonly own: OwnerData
}

export type TxOutcome<T> = { commit: false; value: T } | { commit: true; own: OwnerData; value: T }
export type TxResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }

export interface SuggestionStore {
  /**
   * Runs `fn` over the owner's data and, when it asks to commit, writes it sealed. Transactions run one at a time. The
   * transaction is refused (`stale`) if the expected scope changed before it starts, while it reads, or before it
   * writes; a write already in flight stays bound to its captured partition and its result is withheld if scope
   * changes. A file that cannot be opened or validated is never overwritten.
   */
  transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: SuggestionScope): Promise<TxResult<T>>
}

const EntrySchema = z
  .object({
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
    tenantKey: z.string().regex(/^[0-9a-f]{64}$/),
    data: OwnerDataSchema
  })
  .strict()
const DocSchema = z
  .object({
    v: z.literal(1),
    partitionId: z.string().regex(/^(?:legacy|[0-9a-f]{24})$/),
    entries: z.array(EntrySchema).max(64)
  })
  .strict()
type Doc = z.infer<typeof DocSchema>

const sameScope = (a: SuggestionScope, b: SuggestionScope | null): boolean =>
  b !== null && a.partitionId === b.partitionId && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey

/** The sealed, per-memory-partition suggestion store (G67). Same discipline as the assistant store (G48), different schema. */
export function createSuggestionStore(deps: SuggestionStoreDeps): SuggestionStore {
  let tail: Promise<unknown> = Promise.resolve()

  const load = async (scope: SuggestionScope): Promise<Doc | null> => {
    const bytes = await deps.io.read(scope.partitionId)
    if (bytes === null) return { v: 1, partitionId: scope.partitionId, entries: [] }
    try {
      const parsed = DocSchema.safeParse(JSON.parse(deps.open(bytes)))
      return parsed.success && parsed.data.partitionId === scope.partitionId ? parsed.data : null
    } catch {
      return null
    }
  }

  const run = async <T>(
    fn: (view: StoreView) => TxOutcome<T>,
    expectedScope?: SuggestionScope
  ): Promise<TxResult<T>> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    if (expectedScope && !sameScope(expectedScope, scope)) return { ok: false, reason: 'stale' }
    let doc: Doc | null
    try {
      doc = await load(scope)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    if (doc === null) return { ok: false, reason: 'unavailable' }
    const mine = (entry: { ownerKey: string; tenantKey: string }): boolean =>
      entry.ownerKey === scope.ownerKey && entry.tenantKey === scope.tenantKey
    const own = doc.entries.find(mine)?.data ?? emptyOwnerData()
    let outcome: TxOutcome<T>
    try {
      outcome = fn({ own })
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!outcome.commit) return { ok: true, value: outcome.value }
    const checked = OwnerDataSchema.safeParse(outcome.own)
    if (!checked.success) return { ok: false, reason: 'unavailable' }
    // Whatever another owner's key sits on in this file is kept untouched and never shown.
    const next: Doc = {
      v: 1,
      partitionId: scope.partitionId,
      entries: [
        ...doc.entries.filter((entry) => !mine(entry)),
        { ownerKey: scope.ownerKey, tenantKey: scope.tenantKey, data: checked.data }
      ]
    }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    try {
      await deps.io.write(scope.partitionId, deps.seal(JSON.stringify(next)))
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    // The write was bound to the captured partition, but its result must not be delivered after an owner switch.
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    return { ok: true, value: outcome.value }
  }

  return {
    transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: SuggestionScope): Promise<TxResult<T>> {
      const result = tail.then(() => run(fn, expectedScope))
      tail = result.catch(() => undefined)
      return result
    }
  }
}
