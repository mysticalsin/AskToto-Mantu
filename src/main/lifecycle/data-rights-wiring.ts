import { randomBytes } from 'node:crypto'
import type { IpcMain } from 'electron'
import {
  createDataExport,
  createDataRightsService,
  createProductionErasers,
  runErasure,
  type DataExportDeps,
  type DataRightsService,
  type ErasureHost
} from '../features/data-rights'
import {
  appendErasureReceipt,
  erasureReceiptLogFile,
  readLastErasureReceipt
} from '../features/data-rights/receipt-log'
import { registerDataRightsIpc } from '../ipc/data-rights-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { createErasureFence, configureErasureFence, erasureFenceFile } from '../memory-partition/erasure-fence'
import { memoryAccess, memoryPartitionsConfigured, onMemoryPartitionChange } from '../memory-partition/memory-access'

export interface DataRightsWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: {
    currentOwnerKey(): string | null
    currentTenantKey(): string | null
    onRevoked(cb: () => void): () => void
  }
  userDataPath(): string
  /** True while a meeting is being recorded (the transcript revision store has an open session). */
  hasOpenSession(): boolean
  /** The stores' own erasers, filled by lifecycle/data-rights-host.ts. */
  host: ErasureHost
  /** Waits (bounded) for in-flight ingest and index writes to settle once the fence has closed their admission. */
  quiesce(): Promise<void>
  /** Everything the export needs from main except the clock and version. */
  exportDeps: Omit<DataExportDeps, 'now'>
  /** Ids, counts and closed codes only. */
  audit(event: 'data.erasure' | 'data.export', record: Record<string, unknown>): void
  partition?(): string | null
  onPartitionChange?(listener: () => void): () => void
  now?(): number
}

function activePartition(): string | null {
  if (!memoryPartitionsConfigured()) return null
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/**
 * Builds the erasure fence and the data-rights service (G82), registers its IPC behind the shared sender authorizer and
 * forgets the pending proposal when the owner is revoked or the partition changes. The fence file is read here, before
 * launch recovery can run (this is called from `createOwnerSessionWiring`, ahead of any boot-work job). Hangs off the
 * owner-session wiring, so index.ts gains no lines.
 *
 * Without a verified owner key, tenant key and an open partition there is no scope and every call is refused as signed
 * out: erasing "this owner's" data needs to know the owner.
 */
export function bootstrapDataRights(deps: DataRightsWiringDeps): DataRightsService {
  const now = deps.now ?? Date.now
  const partition = deps.partition ?? activePartition
  const fence = createErasureFence(erasureFenceFile(deps.userDataPath()))
  configureErasureFence(fence)
  const scope = () => {
    const partitionId = partition()
    return partitionId && deps.ownerSession.currentOwnerKey() && deps.ownerSession.currentTenantKey()
      ? { partitionId }
      : null
  }
  const receiptLog = (): string => erasureReceiptLogFile(deps.userDataPath())
  const runExport = createDataExport({ ...deps.exportDeps, now: () => new Date(now()) })
  const service = createDataRightsService({
    scope,
    now,
    newId: () => randomBytes(16).toString('hex'),
    hasOpenSession: deps.hasOpenSession,
    counts: async () => ({ meetings: await deps.host.meetingCount() }),
    erase: () =>
      runErasure({
        erasers: createProductionErasers({ ...deps.host, partitionId: partition }),
        writeFence: async (receiptId, erasedAt) => {
          const pid = partition()
          return pid !== null && fence.record(pid, receiptId, erasedAt)
        },
        quiesce: deps.quiesce,
        now,
        newId: () => randomBytes(16).toString('hex'),
        audit: (record) => deps.audit('data.erasure', record)
      }),
    appendReceipt: (receipt) => appendErasureReceipt(receiptLog(), receipt),
    readLastReceipt: () => readLastErasureReceipt(receiptLog()),
    exportData: async () => {
      const result = await runExport()
      deps.audit(
        'data.export',
        result.ok ? { records: result.records, skipped: result.skipped } : { reason: result.reason }
      )
      return result
    },
    audit: (phase, detail) => deps.audit('data.erasure', { phase, ...detail })
  })
  registerDataRightsIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    service
  })
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.ownerSession.onRevoked(() => service.onOwnerChange())
  ;(deps.onPartitionChange ?? onMemoryPartitionChange)(() => service.onOwnerChange())
  return service
}
