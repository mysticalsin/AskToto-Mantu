import { z } from 'zod'
import { DegradeTargetSchema } from './component-failure-matrix'
import { OptionalComponentIdSchema } from './speech-pack'

/**
 * Optional-component offload (G87): remove one optional component's files and get a receipt with the bytes that
 * were actually freed. Two steps, never one: preview names the bytes and what degrades, then an explicit confirm
 * removes. Only that component's files are touched; meetings, the brain and every other userData entry are not.
 * Channels live here so src/shared/ipc.ts does not grow.
 */
export const COMPONENT_OFFLOAD_IPC = {
  preview: 'component-offload:preview',
  confirm: 'component-offload:confirm',
  receipts: 'component-offload:receipts'
} as const

export const OFFLOAD_REFUSAL_REASONS = [
  'not-removable',
  'bundled',
  'absent',
  'busy',
  'capture-active',
  'plan-expired',
  'stale-plan',
  'invalid-request',
  'failed'
] as const
export const OffloadRefusalReasonSchema = z.enum(OFFLOAD_REFUSAL_REASONS)

export const OffloadPreviewRequestSchema = z.object({ componentId: OptionalComponentIdSchema }).strict()

export const OffloadPlanSchema = z
  .object({
    planId: z.guid(),
    componentId: OptionalComponentIdSchema,
    label: z.string().min(1).max(80),
    /** Display only: the descriptor's installed size. The receipt carries the measured figure. */
    removableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    degradesTo: DegradeTargetSchema,
    expiresAt: z.iso.datetime()
  })
  .strict()

export const OffloadPreviewResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), plan: OffloadPlanSchema }).strict(),
  z.object({ ok: z.literal(false), reason: OffloadRefusalReasonSchema }).strict()
])

export const OffloadConfirmRequestSchema = z.object({ planId: z.guid() }).strict()

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** What was removed. Carries no path: userData contains the person's username. */
export const OffloadReceiptSchema = z
  .object({
    receiptId: z.guid(),
    componentId: OptionalComponentIdSchema,
    label: z.string().min(1).max(80),
    removedAt: z.iso.datetime(),
    /** Measured: the sum of file sizes walked before the delete. */
    bytesFreed: byteCount,
    freeBytesBefore: byteCount.nullable(),
    freeBytesAfter: byteCount.nullable(),
    /** The component's location was checked after the delete and no longer exists. */
    verifiedAbsent: z.boolean(),
    /** Offload never touches meetings, the brain or any session data. Always false. */
    sessionDataTouched: z.literal(false)
  })
  .strict()

export const OffloadConfirmResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: OffloadReceiptSchema }).strict(),
  z.object({ ok: z.literal(false), reason: OffloadRefusalReasonSchema }).strict()
])

/** The most recent receipts, newest first. */
export const OffloadReceiptsSchema = z.array(OffloadReceiptSchema).max(20)

export const MAX_OFFLOAD_RECEIPTS = 20

export type OffloadRefusalReason = z.infer<typeof OffloadRefusalReasonSchema>
export type OffloadPreviewRequest = z.infer<typeof OffloadPreviewRequestSchema>
export type OffloadPlan = z.infer<typeof OffloadPlanSchema>
export type OffloadPreviewResult = z.infer<typeof OffloadPreviewResultSchema>
export type OffloadConfirmRequest = z.infer<typeof OffloadConfirmRequestSchema>
export type OffloadReceipt = z.infer<typeof OffloadReceiptSchema>
export type OffloadConfirmResult = z.infer<typeof OffloadConfirmResultSchema>
