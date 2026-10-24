import { z } from 'zod'
import { createSealedScopedStore, type TxResult } from '../../infra/storage/sealed-scoped-store'
import {
  AssistantEntitySchema,
  MigrationRecordSchema,
  type AssistantEntity,
  type MigrationRecord
} from './assistant-model'

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

export type { TxResult }

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

/** An adapter over the shared sealed, scoped store: it keeps G48's owner/tenant filtering and its public shape. */
export function createAssistantStore(deps: AssistantStoreDeps): AssistantStore {
  const core = createSealedScopedStore<Doc>({
    schema: DocSchema,
    empty: (scope) => ({ v: 1, ...scope, entities: [], migration: null }),
    io: deps.io,
    seal: deps.seal,
    open: deps.open,
    scope: deps.scope
  })
  return {
    transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: AssistantScope): Promise<TxResult<T>> {
      return core.transact<T>((doc, scope) => {
        const mine = (entity: AssistantEntity): boolean =>
          entity.ownerKey === scope.ownerKey && entity.tenantKey === scope.tenantKey
        const outcome = fn({ own: doc.entities.filter(mine), migration: doc.migration })
        if (!outcome.commit) return outcome
        // Whatever another owner's key sits on in this file is kept untouched and never shown.
        return {
          commit: true,
          value: outcome.value,
          doc: {
            ...doc,
            entities: [...doc.entities.filter((entity) => !mine(entity)), ...outcome.own.filter(mine)],
            migration: outcome.migration === undefined ? doc.migration : outcome.migration
          }
        }
      }, expectedScope)
    }
  }
}
