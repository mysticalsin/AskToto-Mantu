import {
  createSealedScopedStore,
  type SealedScope,
  type SealedScopedIo,
  type SealedScopedStore
} from '../../infra/storage/sealed-scoped-store'
import { emptyWorkspaceDoc, WorkspaceDocSchema, type WorkspaceDoc } from './workspace-model'

export interface WorkspaceStoreDeps {
  /** One sealed workspace file per partition. */
  io: SealedScopedIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): SealedScope | null
}

export type WorkspaceStore = SealedScopedStore<WorkspaceDoc>

/** The workspace state (selection, read positions, archive, pins) of every owner in the partition file, sealed. */
export function createWorkspaceStore(deps: WorkspaceStoreDeps): WorkspaceStore {
  return createSealedScopedStore<WorkspaceDoc>({
    schema: WorkspaceDocSchema,
    empty: (scope) => emptyWorkspaceDoc(scope),
    io: deps.io,
    seal: deps.seal,
    open: deps.open,
    scope: deps.scope
  })
}
