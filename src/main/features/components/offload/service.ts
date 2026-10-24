import { randomUUID } from 'node:crypto'
import { OFFLOAD_DEGRADES_TO } from '@shared/component-failure-matrix'
import {
  OffloadConfirmRequestSchema,
  OffloadConfirmResultSchema,
  OffloadPreviewRequestSchema,
  OffloadPreviewResultSchema,
  type OffloadConfirmResult,
  type OffloadPreviewResult,
  type OffloadReceipt,
  type OffloadRefusalReason
} from '@shared/component-offload'
import type { OptionalComponentId, OptionalComponentStatus } from '@shared/speech-pack'
import type { OffloadReceiptStore } from './receipts'

/** One component's files, as the offload service may remove them. Targets decide their own paths; callers never do. */
export interface OffloadTarget {
  /** True while a download, install or self-test owns the component's files. */
  busy(): boolean
  /** Delete the component's files and report the bytes measured before the delete. */
  evict(): Promise<{ ok: true; bytesFreed: number } | { ok: false; reason: 'busy' | 'absent' | 'failed' }>
  /** True when the component's location no longer exists. */
  verifyAbsent(): Promise<boolean>
  /** Remove leftovers of an offload that crashed between its rename and its delete. */
  sweep(): Promise<void>
}

export interface ComponentOffloadDeps {
  /** The live optional-component statuses (the speech-pack snapshot's `optionalComponents`). */
  statuses: () => Promise<readonly OptionalComponentStatus[]>
  target: (id: OptionalComponentId) => OffloadTarget | null
  /** Live capture state; a throw reads as active. */
  captureActive: () => boolean
  /** Free bytes on the volume that holds the components, or null when it cannot be read. */
  freeBytes: () => Promise<number | null>
  receipts: OffloadReceiptStore
  now?: () => number
  newId?: () => string
  /** Component id, outcome and byte count only: no path, username or meeting content. */
  log?: (event: { component: OptionalComponentId; outcome: 'removed' | OffloadRefusalReason; bytes?: number }) => void
}

const PLAN_TTL_MS = 2 * 60 * 1000
const MAX_PLANS = 8

interface PlanRecord {
  componentId: OptionalComponentId
  presence: OptionalComponentStatus['presence']
  expiresAt: number
}

/**
 * Optional-component offload (G87): preview, then an explicit confirm, then a measured receipt. A plan is single
 * use and expires; every guard runs again at confirm, so nothing that changed in between is removed.
 */
export function createComponentOffloadService(deps: ComponentOffloadDeps) {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const plans = new Map<string, PlanRecord>()
  const inFlight = new Set<OptionalComponentId>()

  const captureActive = (): boolean => {
    try {
      return deps.captureActive()
    } catch {
      return true
    }
  }

  const freeBytes = async (): Promise<number | null> => {
    try {
      const value = await deps.freeBytes()
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }

  /** The refusal for a component right now, or the live status when removal may go ahead. */
  const guard = async (
    id: OptionalComponentId
  ): Promise<{ status: OptionalComponentStatus; target: OffloadTarget } | OffloadRefusalReason> => {
    let status: OptionalComponentStatus | undefined
    try {
      status = (await deps.statuses()).find((item) => item.id === id)
    } catch {
      return 'failed'
    }
    if (!status) return 'invalid-request'
    if (status.presence === 'bundled') return 'bundled'
    if (status.presence === 'absent') return 'absent'
    const target = status.removable ? deps.target(id) : null
    if (!target) return 'not-removable'
    if (captureActive()) return 'capture-active'
    if (inFlight.has(id)) return 'busy'
    try {
      if (target.busy()) return 'busy'
    } catch {
      return 'busy'
    }
    return { status, target }
  }

  const refuse = (
    id: OptionalComponentId | null,
    reason: OffloadRefusalReason
  ): { ok: false; reason: OffloadRefusalReason } => {
    if (id) deps.log?.({ component: id, outcome: reason })
    return { ok: false, reason }
  }

  const preview = async (value: unknown): Promise<OffloadPreviewResult> => {
    const parsed = OffloadPreviewRequestSchema.safeParse(value)
    if (!parsed.success) return OffloadPreviewResultSchema.parse(refuse(null, 'invalid-request'))
    const id = parsed.data.componentId
    const checked = await guard(id)
    if (typeof checked === 'string') return OffloadPreviewResultSchema.parse(refuse(id, checked))
    const planId = newId()
    const expiresAt = now() + PLAN_TTL_MS
    plans.set(planId, { componentId: id, presence: checked.status.presence, expiresAt })
    for (const [key, plan] of plans) if (plan.expiresAt <= now()) plans.delete(key)
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value as string)
    return OffloadPreviewResultSchema.parse({
      ok: true,
      plan: {
        planId,
        componentId: id,
        label: checked.status.label,
        removableBytes: checked.status.removableBytes,
        degradesTo: OFFLOAD_DEGRADES_TO[id],
        expiresAt: new Date(expiresAt).toISOString()
      }
    })
  }

  const confirm = async (value: unknown): Promise<OffloadConfirmResult> => {
    const parsed = OffloadConfirmRequestSchema.safeParse(value)
    if (!parsed.success) return OffloadConfirmResultSchema.parse(refuse(null, 'invalid-request'))
    const plan = plans.get(parsed.data.planId)
    // Single use, even when a later guard refuses.
    plans.delete(parsed.data.planId)
    if (!plan || plan.expiresAt <= now())
      return OffloadConfirmResultSchema.parse(refuse(plan?.componentId ?? null, 'plan-expired'))
    const id = plan.componentId
    const checked = await guard(id)
    if (typeof checked === 'string') return OffloadConfirmResultSchema.parse(refuse(id, checked))
    if (checked.status.presence !== plan.presence) return OffloadConfirmResultSchema.parse(refuse(id, 'stale-plan'))
    inFlight.add(id)
    try {
      const before = await freeBytes()
      const removed = await checked.target.evict()
      if (!removed.ok) return OffloadConfirmResultSchema.parse(refuse(id, removed.reason))
      const verifiedAbsent = await checked.target.verifyAbsent().catch(() => false)
      const after = await freeBytes()
      const receipt: OffloadReceipt = {
        receiptId: newId(),
        componentId: id,
        label: checked.status.label,
        removedAt: new Date(now()).toISOString(),
        bytesFreed: removed.bytesFreed,
        freeBytesBefore: before,
        freeBytesAfter: after,
        verifiedAbsent,
        sessionDataTouched: false
      }
      // The files are gone either way; a receipt that cannot be saved is reported as a failure of the receipt only.
      await deps.receipts.append(receipt).catch(() => undefined)
      deps.log?.({ component: id, outcome: 'removed', bytes: removed.bytesFreed })
      return OffloadConfirmResultSchema.parse({ ok: true, receipt })
    } finally {
      inFlight.delete(id)
    }
  }

  return {
    preview,
    confirm,
    receipts: () => deps.receipts.list(),
    /** Startup heal: remove what an interrupted offload left behind. Never throws. */
    async initialise(): Promise<void> {
      for (const id of ['local-llm', 'whisper', 'parakeet'] as const) {
        await deps
          .target(id)
          ?.sweep()
          .catch(() => undefined)
      }
    }
  }
}

export type ComponentOffloadService = ReturnType<typeof createComponentOffloadService>
