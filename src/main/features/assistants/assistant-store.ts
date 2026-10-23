import { z } from 'zod'
import { AssistantEntitySchema, MigrationRecordSchema, type AssistantEntity, type MigrationRecord } from './assistant-model'

/** The partition in force and the verified owner and tenant keys, or null when nobody is verified. */
export interface AssistantScope {
  partitionId: string
  ownerKey: string
  tenantKey: string
}

/** Sealed bytes by partition id. The only thing that ever touches disk. */
export interface AssistantFileIo {
  read(partitionId: string): Promise<Buffer | null>
  write(partitionId: string, data: Buffer): Promise<void>
}

export interface AssistantStoreDeps {
  io: AssistantFileIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): AssistantScope | null
}

export interface StoreView {
  /** Only the entities of the owner and tenant in force. */
  readonly own: readonly AssistantEntity[]
  readonly migration: MigrationRecord | null
}

export type TxOutcome<T> =
  | { commit: false; value: T }
  | { commit: true; own: AssistantEntity[]; migration?: MigrationRecord | null; value: T }

export type TxResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }

export interface AssistantStore {
  /**
   * Runs `fn` over the owner's assistants and, when it asks to commit, writes them sealed. Transactions run one at a time.
   * The transaction is refused (`stale`) if the expected scope changed before it starts, while it reads, or before it
   * writes. A write already in flight stays bound to its captured partition, and its result is withheld if scope changes.
   * A file that cannot be opened or validated is never overwritten.
   */
  transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: AssistantScope): Promise<TxResult<T>>
}

const DocSchema = z
  .object({
    v: z.literal(1),
    partitionId: z.string().regex(/^(?:legacy|[0-9a-f]{24})$/),
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
    tenantKey: z.string().regex(/^[0-9a-f]{64}$/),
    entities: z.array(AssistantEntitySchema).max(10_000),
    migration: MigrationRecordSchema.nullable()
  })
  .strict()
type Doc = z.infer<typeof DocSchema>

const sameScope = (a: AssistantScope, b: AssistantScope | null): boolean =>
  b !== null && a.partitionId === b.partitionId && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey

export function createAssistantStore(deps: AssistantStoreDeps): AssistantStore {
  let tail: Promise<unknown> = Promise.resolve()

  const load = async (scope: AssistantScope): Promise<Doc | null> => {
    const bytes = await deps.io.read(scope.partitionId)
    if (bytes === null) {
      return {
        v: 1,
        partitionId: scope.partitionId,
        ownerKey: scope.ownerKey,
        tenantKey: scope.tenantKey,
        entities: [],
        migration: null
      }
    }
    try {
      const parsed = DocSchema.safeParse(JSON.parse(deps.open(bytes)))
      return parsed.success &&
        parsed.data.partitionId === scope.partitionId &&
        parsed.data.ownerKey === scope.ownerKey &&
        parsed.data.tenantKey === scope.tenantKey
        ? parsed.data
        : null
    } catch {
      return null
    }
  }

  const run = async <T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: AssistantScope): Promise<TxResult<T>> => {
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
    const mine = (entity: AssistantEntity): boolean => entity.ownerKey === scope.ownerKey && entity.tenantKey === scope.tenantKey
    const own = doc.entities.filter(mine)
    let outcome: TxOutcome<T>
    try {
      outcome = fn({ own, migration: doc.migration })
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!outcome.commit) return { ok: true, value: outcome.value }
    // Whatever another owner's key sits on in this file is kept untouched and never shown.
    const foreign = doc.entities.filter((entity) => !mine(entity))
    const next: Doc = {
      v: 1,
      partitionId: scope.partitionId,
      ownerKey: scope.ownerKey,
      tenantKey: scope.tenantKey,
      entities: [...foreign, ...outcome.own.filter(mine)],
      migration: outcome.migration === undefined ? doc.migration : outcome.migration
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
    transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: AssistantScope): Promise<TxResult<T>> {
      const result = tail.then(() => run(fn, expectedScope))
      tail = result.catch(() => undefined)
      return result
    }
  }
}
