/**
 * The data-rights contract shared by main, the preload bridge and the renderer (Métis 2.12 G82, CAP-35 / R093-R095).
 *
 * Two owner actions: erase the Métis data of this account, and export it. Erasure is two calls on purpose, like the
 * assistants: `preview` returns what would go (labels and counts, never a file name) with a hash, and `confirm` must
 * echo that hash. The renderer never supplies an owner, a tenant, a path or a list of stores: main knows who is
 * signed in, so a payload with any extra key is invalid. Receipts carry store ids, outcomes, counts and closed codes
 * only, never a path, an email or the text of an error.
 */
import { z } from 'zod'
import { DATA_STORE_IDS, type DataStoreId } from './data-store-inventory'

export const DATA_RIGHTS_IPC = {
  preview: 'dataRights:preview',
  export: 'dataRights:export',
  lastReceipt: 'dataRights:lastReceipt',
  confirm: 'dataRights:confirm'
} as const

export const DATA_RIGHTS_PROPOSAL_TTL_MS = 120_000

export const DataRightsNoPayloadSchema = z.undefined()

const PROPOSAL_ID = z.string().regex(/^[0-9a-f]{32}$/)
const PREVIEW_HASH = z.string().regex(/^[0-9a-f]{64}$/)
const STORE_ID = z.enum(DATA_STORE_IDS as [DataStoreId, ...DataStoreId[]])

export const DataRightsConfirmRequestSchema = z.object({ proposalId: PROPOSAL_ID, previewHash: PREVIEW_HASH }).strict()

export const ErasureOutcomeSchema = z.enum([
  'erased',
  'nothing',
  'failed',
  'retained',
  'external-pending',
  'not-configured'
])
export type ErasureOutcome = z.infer<typeof ErasureOutcomeSchema>

const CODE = z.string().regex(/^[a-z0-9-]{1,64}$/)
const COUNT = z.number().int().nonnegative().max(10_000_000)

export const ErasureStoreResultSchema = z
  .object({ store: STORE_ID, outcome: ErasureOutcomeSchema, count: COUNT.optional() })
  .strict()
export const ErasureExceptionSchema = z.object({ store: STORE_ID, code: CODE }).strict()

export const ErasureReceiptSchema = z
  .object({
    receiptId: PROPOSAL_ID,
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative(),
    stores: z.array(ErasureStoreResultSchema).max(128),
    exceptions: z.array(ErasureExceptionSchema).max(128),
    failed: COUNT
  })
  .strict()
export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>

export const ErasurePreviewItemSchema = z
  .object({
    store: STORE_ID,
    label: z.string().max(120),
    count: COUNT.optional(),
    policy: z.enum(['delete', 'retain', 'external'])
  })
  .strict()
export type ErasurePreviewItem = z.infer<typeof ErasurePreviewItemSchema>

export const DataRightsRefusalSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum([
      'signed-out',
      'invalid',
      'unavailable',
      'meeting-recording',
      'unknown-proposal',
      'preview-mismatch',
      'expired',
      'busy',
      'stale'
    ])
  })
  .strict()
export type DataRightsRefusal = z.infer<typeof DataRightsRefusalSchema>

export const PreviewResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      proposalId: PROPOSAL_ID,
      previewHash: PREVIEW_HASH,
      expiresAt: z.number().int().nonnegative(),
      items: z.array(ErasurePreviewItemSchema).max(128)
    })
    .strict(),
  DataRightsRefusalSchema
])
export type PreviewResult = z.infer<typeof PreviewResultSchema>

export const ConfirmResultSchema = z.union([
  z.object({ ok: z.literal(true), receipt: ErasureReceiptSchema }).strict(),
  DataRightsRefusalSchema
])
export type ConfirmResult = z.infer<typeof ConfirmResultSchema>

export const LastReceiptResultSchema = z.union([
  z.object({ ok: z.literal(true), receipt: ErasureReceiptSchema.nullable() }).strict(),
  DataRightsRefusalSchema
])
export type LastReceiptResult = z.infer<typeof LastReceiptResultSchema>

export const ExportResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      cancelled: z.boolean().optional(),
      records: COUNT,
      skipped: COUNT
    })
    .strict(),
  DataRightsRefusalSchema
])
export type DataExportResult = z.infer<typeof ExportResultSchema>

/** Stable text of a preview, hashed by main so the confirm can only apply to exactly what was shown. */
export function previewDigestInput(items: readonly ErasurePreviewItem[]): string {
  return JSON.stringify(items.map((item) => [item.store, item.policy, item.count ?? null]))
}
