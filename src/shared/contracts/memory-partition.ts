import { z } from 'zod'

/**
 * Local memory partitioning (Métis 2.12 G19, CAP-29).
 *
 * Everything derived from a person's meetings that an answer can draw on (the knowledge store, its caches, the
 * follow-up conversation) belongs to one partition: the verified tenant plus the verified user. Both keys are the
 * Main-derived HMACs the owner-session authority issues (G02); neither contains an email or a tenant id.
 */
const KEY = z.string().regex(/^[0-9a-f]{64}$/)

export const MemoryScopeSchema = z.object({ tenantKey: KEY, ownerKey: KEY }).strict()
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

/**
 * What a read of local memory found. Callers branch on it instead of treating "nothing came back" as one case.
 *
 * - `ok`: the partition of the verified owner was read.
 * - `signed-out`: nobody is verified, so no partition was read (never the last owner's).
 * - `locked`: the partition exists but the content key that decrypts it is locked on this device.
 * - `partition-empty`: the verified owner's partition holds nothing yet (a new account, or a switch to one).
 * - `unavailable`: the partition could not be resolved or read (identity unverified, ledger or store unreadable).
 * - `stale`: the owner changed and the new partition is not active yet; the read was refused, not answered.
 */
export const RECALL_STATUSES = ['ok', 'signed-out', 'locked', 'partition-empty', 'unavailable', 'stale'] as const
export const RecallStatusSchema = z.enum(RECALL_STATUSES)
export type RecallStatus = z.infer<typeof RecallStatusSchema>
