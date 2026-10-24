import { z } from 'zod'
import {
  JournalEntrySchema,
  RoutineRecordSchema,
  restoreRunning,
  type JournalEntry,
  type RoutineRecord
} from './routine-model'

/** The partition in force and the verified owner and tenant keys, or null when nobody is verified. */
export interface RoutineScope {
  partitionId: string
  ownerKey: string
  tenantKey: string
}

/** Sealed bytes by partition id. The only thing that ever touches disk. */
export interface RoutineFileIo {
  read(partitionId: string): Promise<Buffer | null>
  write(partitionId: string, data: Buffer): Promise<void>
}

export interface RoutineStoreDeps {
  io: RoutineFileIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): RoutineScope | null
}

export interface RoutineStoreView {
  /** Only the routines of the owner and tenant in force. */
  readonly own: readonly RoutineRecord[]
  /** Only the run leases of the owner and tenant in force. */
  readonly journal: readonly JournalEntry[]
  /** How many stored `running` leases were restored as `uncertain` when this file was opened. */
  readonly recovered: number
}

export type RoutineTxOutcome<T> =
  | { commit: false; value: T }
  | { commit: true; routines: readonly RoutineRecord[]; journal: readonly JournalEntry[]; value: T }

export type RoutineTxResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }

export interface RoutineStore {
  /**
   * Runs `fn` over the owner's routines and run leases and, when it asks to commit, writes them sealed. Transactions run
   * one at a time, which is what makes a lease claim exclusive. The transaction is refused (`stale`) if the expected scope
   * changed before it starts, while it reads, or before it writes, and a write's result is withheld if scope changed.
   * A file that cannot be opened or validated is never overwritten.
   */
  transact<T>(
    fn: (view: RoutineStoreView) => RoutineTxOutcome<T>,
    expectedScope?: RoutineScope
  ): Promise<RoutineTxResult<T>>
  /**
   * Run leases still `running` on disk are restored as `uncertain` the first time a partition is committed in this
   * process (nothing of this process can still be running then). After an owner change aborted every job, call this so
   * the next commit restores whatever those jobs left open.
   */
  rearm(): void
}

const DocSchema = z
  .object({
    v: z.literal(1),
    partitionId: z.string().regex(/^(?:legacy|[0-9a-f]{24})$/),
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
    tenantKey: z.string().regex(/^[0-9a-f]{64}$/),
    routines: z.array(RoutineRecordSchema).max(10_000),
    journal: z.array(JournalEntrySchema).max(10_000)
  })
  .strict()
type Doc = z.infer<typeof DocSchema>

const sameScope = (a: RoutineScope, b: RoutineScope | null): boolean =>
  b !== null && a.partitionId === b.partitionId && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey

export function createRoutineStore(deps: RoutineStoreDeps): RoutineStore {
  let tail: Promise<unknown> = Promise.resolve()
  const settledBoot = new Set<string>()

  const load = async (scope: RoutineScope): Promise<Doc | null> => {
    const bytes = await deps.io.read(scope.partitionId)
    if (bytes === null) {
      return { v: 1, ...scope, routines: [], journal: [] }
    }
    try {
      const parsed = DocSchema.safeParse(JSON.parse(deps.open(bytes)))
      return parsed.success && sameScope(scope, parsed.data) ? parsed.data : null
    } catch {
      return null
    }
  }

  const run = async <T>(
    fn: (view: RoutineStoreView) => RoutineTxOutcome<T>,
    expectedScope?: RoutineScope
  ): Promise<RoutineTxResult<T>> => {
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
    const mineRow = (row: { ownerKey: string; tenantKey: string }): boolean =>
      row.ownerKey === scope.ownerKey && row.tenantKey === scope.tenantKey
    const mineRoutines = doc.routines.filter(mineRow)
    const mineJournal = doc.journal.filter(mineRow)
    // Leases this process wrote and has not settled are live: only a partition not yet committed here is restored.
    const restored = settledBoot.has(scope.partitionId)
      ? { routines: mineRoutines, journal: mineJournal, recovered: 0 }
      : restoreRunning(mineRoutines, mineJournal)
    let outcome: RoutineTxOutcome<T>
    try {
      outcome = fn({ own: restored.routines, journal: restored.journal, recovered: restored.recovered })
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!outcome.commit) return { ok: true, value: outcome.value }
    // Whatever another owner's key sits on in this file is kept untouched and never shown.
    const next: Doc = {
      v: 1,
      ...scope,
      routines: [...doc.routines.filter((row) => !mineRow(row)), ...outcome.routines.filter(mineRow)],
      journal: [...doc.journal.filter((row) => !mineRow(row)), ...outcome.journal.filter(mineRow)]
    }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    try {
      await deps.io.write(scope.partitionId, deps.seal(JSON.stringify(next)))
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    settledBoot.add(scope.partitionId)
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    return { ok: true, value: outcome.value }
  }

  return {
    transact<T>(fn: (view: RoutineStoreView) => RoutineTxOutcome<T>, expectedScope?: RoutineScope) {
      const result = tail.then(() => run(fn, expectedScope))
      tail = result.catch(() => undefined)
      return result
    },
    rearm() {
      settledBoot.clear()
    }
  }
}
