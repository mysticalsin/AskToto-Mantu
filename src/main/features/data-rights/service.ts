/**
 * The data-rights service (Métis 2.12 G82): the propose / confirm pair behind the erase action, a single flight, the
 * receipt log and the export entry point.
 *
 * Same contract as the assistants (G48): `preview` returns exactly what would go with a hash, `confirm` must echo it,
 * a proposal expires after 120 s and is dropped when the owner is revoked or the partition changes. Both calls are
 * refused while a meeting is being recorded, and a second confirm while one erasure runs answers `busy`. Main supplies
 * the owner; nothing here accepts a path, a store list or an owner from the caller.
 */
import { createHash } from 'node:crypto'
import {
  DATA_RIGHTS_PROPOSAL_TTL_MS,
  previewDigestInput,
  type ConfirmResult,
  type DataExportResult,
  type DataRightsRefusal,
  type ErasurePreviewItem,
  type ErasureReceipt,
  type LastReceiptResult,
  type PreviewResult
} from '@shared/data-rights'
import { DATA_STORES, type DataStoreId } from '@shared/data-store-inventory'

export interface DataRightsScope {
  readonly partitionId: string
}

export interface DataRightsServiceDeps {
  /** The verified owner's partition, or null when nobody is signed in. */
  scope(): DataRightsScope | null
  now(): number
  newId(): string
  /** True while a meeting is being recorded (the transcript store has an open session). */
  hasOpenSession(): boolean
  /** Counts shown in the preview, by store. Counts only: never a name. */
  counts(): Promise<Partial<Record<DataStoreId, number>>>
  /** Runs the erasure for the verified owner and returns its receipt. */
  erase(): Promise<ErasureReceipt>
  appendReceipt(receipt: ErasureReceipt): Promise<void>
  readLastReceipt(): Promise<ErasureReceipt | null>
  exportData(): Promise<DataExportResult>
  /** Outcome tokens only. */
  audit?(phase: string, detail: { reason?: string; count?: number }): void
}

export interface DataRightsService {
  preview(): Promise<PreviewResult>
  confirm(input: { proposalId: string; previewHash: string }): Promise<ConfirmResult>
  lastReceipt(): Promise<LastReceiptResult>
  exportData(): Promise<DataExportResult>
  /** Sign-out, revocation or an owner switch: the pending proposal is forgotten. */
  onOwnerChange(): void
}

interface Proposal {
  partitionId: string
  previewHash: string
  expiresAt: number
}

const refuse = (reason: DataRightsRefusal['reason']): DataRightsRefusal => ({ ok: false, reason })

export function createDataRightsService(deps: DataRightsServiceDeps): DataRightsService {
  const proposals = new Map<string, Proposal>()
  let running = false
  const audit = (phase: string, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit?.(phase, detail)
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const refused = (reason: DataRightsRefusal['reason']): DataRightsRefusal => {
    audit('refused', { reason })
    return refuse(reason)
  }

  return {
    onOwnerChange: () => proposals.clear(),

    async preview() {
      const scope = deps.scope()
      if (!scope) return refused('signed-out')
      if (deps.hasOpenSession()) return refused('meeting-recording')
      let counts: Partial<Record<DataStoreId, number>> = {}
      try {
        counts = await deps.counts()
      } catch {
        counts = {}
      }
      const items: ErasurePreviewItem[] = DATA_STORES.map((entry) => ({
        store: entry.id,
        label: entry.label,
        policy: entry.erase,
        ...(counts[entry.id] === undefined ? {} : { count: counts[entry.id] })
      }))
      const previewHash = createHash('sha256').update(previewDigestInput(items)).digest('hex')
      const now = deps.now()
      for (const [id, pending] of proposals) if (pending.expiresAt <= now) proposals.delete(id)
      proposals.clear() // one proposal at a time: a new preview replaces the last
      const proposalId = deps.newId()
      const expiresAt = now + DATA_RIGHTS_PROPOSAL_TTL_MS
      proposals.set(proposalId, { partitionId: scope.partitionId, previewHash, expiresAt })
      audit('proposed')
      return { ok: true, proposalId, previewHash, expiresAt, items }
    },

    async confirm(input) {
      const scope = deps.scope()
      if (!scope) return refused('signed-out')
      if (running) return refused('busy')
      const pending = proposals.get(input.proposalId)
      if (!pending || pending.partitionId !== scope.partitionId) return refused('unknown-proposal')
      if (pending.previewHash !== input.previewHash) return refused('preview-mismatch')
      if (pending.expiresAt <= deps.now()) {
        proposals.delete(input.proposalId)
        return refused('expired')
      }
      if (deps.hasOpenSession()) return refused('meeting-recording')
      running = true
      proposals.delete(input.proposalId)
      try {
        const receipt = await deps.erase()
        try {
          await deps.appendReceipt(receipt)
        } catch {
          audit('receipt-unwritten')
        }
        audit(receipt.failed > 0 ? 'partial' : 'done', { count: receipt.failed })
        return { ok: true, receipt }
      } catch {
        return refused('unavailable')
      } finally {
        running = false
      }
    },

    async lastReceipt() {
      if (!deps.scope()) return refused('signed-out')
      try {
        return { ok: true, receipt: await deps.readLastReceipt() }
      } catch {
        return refused('unavailable')
      }
    },

    async exportData() {
      if (!deps.scope()) return refused('signed-out')
      if (running) return refused('busy')
      try {
        return await deps.exportData()
      } catch {
        return refused('unavailable')
      }
    }
  }
}
