import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MemoryScopeSchema, type MemoryScope } from '@shared/contracts/memory-partition'

/**
 * The partition ledger (Métis 2.12 G19): which verified owner adopted the single-owner data that earlier builds
 * left under `.brain/`. It holds the two HMAC keys and a timestamp, never an email, a tenant id or a path.
 *
 * Adoption is one-time and recorded before the data is used: the first verified owner that signs in takes the
 * existing store in place (nothing is moved or rewritten) and every later owner gets a partition of their own.
 */
export const LEGACY_PARTITION_ID = 'legacy'
export const LEGACY_REL_ROOT = '.brain'

const LegacyClaimSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unclaimed') }).strict(),
  z
    .object({
      state: z.literal('adopted'),
      tenantKey: MemoryScopeSchema.shape.tenantKey,
      ownerKey: MemoryScopeSchema.shape.ownerKey,
      adoptedAt: z.number().int().positive().safe()
    })
    .strict()
])
export type LegacyClaim = z.infer<typeof LegacyClaimSchema>

const LedgerSchema = z.object({ v: z.literal(1), legacy: LegacyClaimSchema }).strict()
export type PartitionLedger = z.infer<typeof LedgerSchema>

export interface LedgerIo {
  /** The file text, or null when it does not exist. Any other failure rejects. */
  read(): Promise<string | null>
  /** Replaces the file atomically. */
  write(text: string): Promise<void>
}

export type LedgerLoad = { ok: true; ledger: PartitionLedger } | { ok: false }

/** A missing file is a fresh install. A file that exists but cannot be understood fails closed and is never rewritten. */
export async function loadLedger(io: LedgerIo): Promise<LedgerLoad> {
  let text: string | null
  try {
    text = await io.read()
  } catch {
    return { ok: false }
  }
  if (text === null) return { ok: true, ledger: { v: 1, legacy: { state: 'unclaimed' } } }
  try {
    const parsed = LedgerSchema.safeParse(JSON.parse(text))
    return parsed.success ? { ok: true, ledger: parsed.data } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export async function saveLedger(io: LedgerIo, ledger: PartitionLedger): Promise<boolean> {
  try {
    await io.write(`${JSON.stringify(LedgerSchema.parse(ledger), null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

export interface PartitionRef {
  /** `legacy`, or 24 lowercase hex characters derived from the two keys. */
  readonly id: string
  /** Path of the partition's store relative to the meetings folder. */
  readonly relRoot: string
  readonly legacy: boolean
}

export function partitionRefFor(scope: MemoryScope): PartitionRef {
  const id = createHash('sha256')
    .update(`metis.memory-partition.v1\0${scope.tenantKey}\0${scope.ownerKey}`)
    .digest('hex')
    .slice(0, 24)
  return { id, relRoot: `.brain-p-${id}`, legacy: false }
}

export const LEGACY_PARTITION: PartitionRef = { id: LEGACY_PARTITION_ID, relRoot: LEGACY_REL_ROOT, legacy: true }

export function ownsLegacy(ledger: PartitionLedger, scope: MemoryScope): boolean {
  return (
    ledger.legacy.state === 'adopted' &&
    ledger.legacy.tenantKey === scope.tenantKey &&
    ledger.legacy.ownerKey === scope.ownerKey
  )
}

/** The ledger file under `<userData>/identity/`, written through a temp file and a rename. */
export function fileLedgerIo(userDataDir: string): LedgerIo {
  const dir = join(userDataDir, 'identity')
  const path = join(dir, 'memory-partitions.v1.json')
  return {
    async read() {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
        throw error
      }
    },
    async write(text) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, path)
    }
  }
}
