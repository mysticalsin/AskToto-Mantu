import { z } from 'zod'
import { MemoryScopeSchema, type MemoryScope } from '@shared/contracts/memory-partition'

const OpaqueIdSchema = z.string().min(1).max(160)
const MemoryTextSchema = z.string().min(1).max(8_000)

export const MemoryServerOriginSchema = z.enum(['connector', 'document'])
export type MemoryServerOrigin = z.infer<typeof MemoryServerOriginSchema>

export const MemoryServerRecordSchema = z
  .object({
    id: OpaqueIdSchema,
    sourceId: OpaqueIdSchema,
    origin: MemoryServerOriginSchema,
    text: MemoryTextSchema,
    revision: z.number().int().positive()
  })
  .strict()
export type MemoryServerRecord = z.infer<typeof MemoryServerRecordSchema>

export const MemoryServerTombstoneSchema = z
  .object({ id: OpaqueIdSchema, sourceId: OpaqueIdSchema, deletedAt: z.number().int().nonnegative() })
  .strict()
export type MemoryServerTombstone = z.infer<typeof MemoryServerTombstoneSchema>

export const MemoryServerRetainSchema = z
  .object({ sourceId: OpaqueIdSchema, origin: MemoryServerOriginSchema, text: MemoryTextSchema })
  .strict()
export type MemoryServerRetain = z.infer<typeof MemoryServerRetainSchema>

export const MemoryServerCorrectionSchema = z
  .object({ expectedRevision: z.number().int().positive(), text: MemoryTextSchema })
  .strict()
export type MemoryServerCorrection = z.infer<typeof MemoryServerCorrectionSchema>

export const MemoryServerDeleteTargetSchema = z
  .object({ memoryId: OpaqueIdSchema.optional(), sourceId: OpaqueIdSchema.optional() })
  .strict()
  .refine((value) => value.memoryId !== undefined || value.sourceId !== undefined)
export type MemoryServerDeleteTarget = z.infer<typeof MemoryServerDeleteTargetSchema>

export type MemoryServerStatus = 'found' | 'no-results' | 'denied' | 'unavailable'
export type MemoryServerResult<T> =
  | { status: 'found'; value: T }
  | { status: 'no-results' }
  | { status: 'denied' }
  | { status: 'unavailable' }

/** All adapter calls require the Main-derived tenant and user pair. No renderer IPC exposes this interface. */
export interface MemoryServerAdapter {
  /** Implementations must enforce both scope keys and make tombstones authoritative against retain/recall races. */
  retain(scope: MemoryScope, input: MemoryServerRetain): Promise<MemoryServerResult<MemoryServerRecord>>
  recall(scope: MemoryScope, query: string): Promise<MemoryServerResult<MemoryServerRecord[]>>
  /** Missing, out-of-scope, and tombstoned IDs return denied to avoid exposing whether an ID exists. */
  correct(
    scope: MemoryScope,
    memoryId: string,
    correction: MemoryServerCorrection
  ): Promise<MemoryServerResult<MemoryServerRecord>>
  delete(scope: MemoryScope, target: MemoryServerDeleteTarget): Promise<MemoryServerResult<MemoryServerTombstone[]>>
  listTombstones(scope: MemoryScope, sourceId?: string): Promise<MemoryServerResult<MemoryServerTombstone[]>>
}

export function memoryServerResultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.union([
    z.object({ status: z.literal('found'), value }).strict(),
    z.object({ status: z.literal('no-results') }).strict(),
    z.object({ status: z.literal('denied') }).strict(),
    z.object({ status: z.literal('unavailable') }).strict()
  ]) as z.ZodType<MemoryServerResult<z.infer<T>>>
}

export function sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    MemoryScopeSchema.safeParse(left).success &&
    MemoryScopeSchema.safeParse(right).success &&
    left.tenantKey === right.tenantKey &&
    left.ownerKey === right.ownerKey
  )
}

export function unavailableMemoryServerResult<T>(): MemoryServerResult<T> {
  return { status: 'unavailable' }
}
