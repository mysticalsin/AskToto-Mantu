/**
 * The erasure orchestrator (Métis 2.12 G82, CAP-35 / R093, R095).
 *
 * `runErasure` walks the data-store inventory (shared/data-store-inventory.ts) in five phases and runs the eraser of
 * every `delete` row. It mirrors the credential cleanup (credential-cleanup.ts), which it also leans on for the
 * credential row:
 *  - the erasure fence is written first and, if it cannot be written, nothing is erased (an erasure that a late
 *    writer could undo is not an erasure);
 *  - one failing eraser never stops the rest, and a `delete` row without an eraser is reported as failed;
 *  - an eraser shared by several rows (the brain, its backup and its escrow are one purge) runs once;
 *  - after the last phase every row whose eraser can probe is probed again, and a row still present is `failed`
 *    whatever its eraser reported;
 *  - the receipt and the audit record carry store ids, counts and closed codes only, never a path, an email or the
 *    text of an error (those can quote what they failed on).
 *
 * Pure and Electron free: the production erasers live in erasers.ts.
 */
import type { ErasureOutcome, ErasureReceipt } from '@shared/data-rights'
import {
  DATA_STORES,
  erasablePhase,
  type DataStoreEntry,
  type DataStoreId,
  type ErasurePhase
} from '@shared/data-store-inventory'

export type EraserOutcome = Extract<ErasureOutcome, 'erased' | 'nothing' | 'failed' | 'not-configured'>

export interface StoreEraser {
  erase(): Promise<{ outcome: EraserOutcome; count?: number }>
  /** True when anything of the store is still on disk or in memory; probed after the last phase. */
  present?(): Promise<boolean>
}

export interface ErasureDeps {
  readonly erasers: Readonly<Partial<Record<DataStoreId, StoreEraser>>>
  /** Writes the erasure fence for this owner's partition (erased at `erasedAt`). False means it could not be written. */
  writeFence(receiptId: string, erasedAt: number): Promise<boolean>
  /** Phase 1 work that is not a store: cancel ingest, backfill, graph rebuild and import jobs, drop pending proposals. */
  quiesce(): Promise<void>
  now(): number
  newId(): string
  audit(record: Record<string, unknown>): void
}

const PHASES: readonly ErasurePhase[] = [1, 2, 3, 4, 5]

async function runOne(eraser: StoreEraser | undefined): Promise<{ outcome: EraserOutcome; count?: number }> {
  if (!eraser) return { outcome: 'failed' }
  try {
    return await eraser.erase()
  } catch {
    return { outcome: 'failed' }
  }
}

export async function runErasure(deps: ErasureDeps): Promise<ErasureReceipt> {
  const startedAt = deps.now()
  const receiptId = deps.newId()
  const stores: ErasureReceipt['stores'] = []
  const exceptions: ErasureReceipt['exceptions'] = []
  const finish = (): ErasureReceipt => {
    const failed = stores.filter((s) => s.outcome === 'failed').length
    const receipt: ErasureReceipt = { receiptId, startedAt, finishedAt: deps.now(), stores, exceptions, failed }
    try {
      deps.audit({
        receiptId,
        failed,
        erased: stores.filter((s) => s.outcome === 'erased').length,
        stores: stores.map((s) => `${s.store}:${s.outcome}`),
        exceptions: exceptions.map((e) => `${e.store}:${e.code}`)
      })
    } catch {
      // an audit failure never changes the outcome
    }
    return receipt
  }

  let fenced = false
  try {
    fenced = await deps.writeFence(receiptId, startedAt)
  } catch {
    fenced = false
  }
  if (!fenced) {
    stores.push({ store: 'identity', outcome: 'failed' })
    exceptions.push({ store: 'identity', code: 'fence-write-failed' })
    return finish()
  }
  try {
    await deps.quiesce()
  } catch {
    exceptions.push({ store: 'identity', code: 'quiesce-incomplete' })
  }

  const settled = new Map<StoreEraser, Promise<{ outcome: EraserOutcome; count?: number }>>()
  const probed: Array<{ entry: DataStoreEntry; eraser: StoreEraser }> = []
  for (const phase of PHASES) {
    for (const entry of erasablePhase(phase)) {
      const eraser = deps.erasers[entry.id]
      let run = eraser ? settled.get(eraser) : undefined
      if (!run) {
        run = runOne(eraser)
        if (eraser) settled.set(eraser, run)
      }
      const result = await run
      if (!eraser) exceptions.push({ store: entry.id, code: 'no-eraser' })
      else if (result.outcome === 'failed') exceptions.push({ store: entry.id, code: 'erase-failed' })
      else if (result.outcome === 'not-configured') exceptions.push({ store: entry.id, code: 'not-configured' })
      stores.push({
        store: entry.id,
        outcome: result.outcome,
        ...(result.count === undefined ? {} : { count: result.count })
      })
      if (eraser?.present) probed.push({ entry, eraser })
    }
  }

  for (const { entry, eraser } of probed) {
    let present = true
    try {
      present = (await eraser.present?.()) ?? false
    } catch {
      present = true
    }
    if (!present) continue
    const at = stores.findIndex((s) => s.store === entry.id)
    if (at >= 0 && stores[at]?.outcome !== 'failed') {
      stores[at] = { store: entry.id, outcome: 'failed' }
      exceptions.push({ store: entry.id, code: 'still-present' })
    }
  }

  for (const entry of DATA_STORES) {
    if (entry.erase === 'delete') continue
    stores.push({ store: entry.id, outcome: entry.erase === 'retain' ? 'retained' : 'external-pending' })
    exceptions.push({ store: entry.id, code: entry.reason ?? 'retained' })
  }
  return finish()
}
