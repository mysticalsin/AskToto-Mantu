import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { memoryAccess } from './memory-access'

/**
 * The erasure fence (Métis 2.12 G82, CAP-35 / R093 "no resurrection").
 *
 * `<userData>/identity/erasures.v1.json` records, per memory partition, when the owner erased their data. It is written
 * before any store is touched and never removed. Every place that could write erased data back (launch recovery of a
 * journal or a draft, a replayed save receipt, ingest of a meeting file that synced back, a legacy folder
 * copy-forward, a late import) asks one question: does this item start before the erasure? An item stamped strictly
 * earlier than `erasedAt` belongs to erased data and is skipped; anything the owner records afterwards is newer and
 * passes. Signing in again with the same account maps to the same partition id, so the fence still applies to it.
 *
 * It lives next to `memory-access` (not under features/) so the low-level stores can ask it without depending on a
 * feature. The check is synchronous and in memory; the file is read once at boot.
 */
const FenceFileSchema = z.object({
  v: z.literal(1),
  fences: z.record(z.string(), z.object({ erasedAt: z.number().int().nonnegative(), receiptId: z.string() }))
})
type FenceFile = z.infer<typeof FenceFileSchema>

export interface ErasureFence {
  /** Resolves once the fence file has been read. Async recovery entry points await it before they ask. */
  readonly ready: Promise<void>
  /** Records (memory first, then the file) that this partition was erased at `erasedAt`. False if the file write failed. */
  record(partitionId: string, receiptId: string, erasedAt: number): Promise<boolean>
  erasedAt(partitionId: string): number | null
}

/** The fence file under `<userData>/identity/`. */
export function erasureFenceFile(userDataDir: string): string {
  return join(userDataDir, 'identity', 'erasures.v1.json')
}

export function createErasureFence(file: string): ErasureFence {
  let state: FenceFile = { v: 1, fences: {} }
  // A fence only ever moves forward: an older erasure never relaxes a newer one.
  const merge = (partitionId: string, receiptId: string, erasedAt: number): void => {
    const previous = state.fences[partitionId]
    if (!previous || previous.erasedAt < erasedAt) {
      state = { v: 1, fences: { ...state.fences, [partitionId]: { erasedAt, receiptId } } }
    }
  }
  const ready = readFile(file, 'utf8').then(
    (text) => {
      try {
        const parsed = FenceFileSchema.safeParse(JSON.parse(text))
        if (parsed.success)
          for (const [pid, f] of Object.entries(parsed.data.fences)) merge(pid, f.receiptId, f.erasedAt)
      } catch {
        // unreadable: no earlier fence is known
      }
    },
    () => undefined // absent: no fence yet
  )
  return {
    ready,
    erasedAt: (partitionId) => state.fences[partitionId]?.erasedAt ?? null,
    async record(partitionId, receiptId, erasedAt) {
      await ready
      merge(partitionId, receiptId, erasedAt)
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.tmp`
        await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
        await rename(tmp, file)
        return true
      } catch {
        return false
      }
    }
  }
}

let configured: ErasureFence | null = null

export function configureErasureFence(fence: ErasureFence | null): void {
  configured = fence
}

/** Resolves when the configured fence has read its file (immediately when none is configured). */
export function erasureFenceReady(): Promise<void> {
  return configured?.ready ?? Promise.resolve()
}

function partitionInForce(partitionId?: string): string | null {
  if (partitionId) return partitionId
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** The meeting filename start stamp (local time, second resolution), the format `transcript-document-format.stamp` writes. */
function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** True when something that started at `stampedAt` (epoch ms) belongs to data this partition's owner erased. */
export function isErasureFenced(stampedAt: number, partitionId?: string): boolean {
  const pid = partitionInForce(partitionId)
  const erasedAt = pid ? (configured?.erasedAt(pid) ?? null) : null
  return erasedAt !== null && Number.isFinite(stampedAt) && stampedAt < erasedAt
}

/**
 * Same question for a file named by its start stamp (`2026-10-24_101500-…` or `.autosave-draft-2026-10-24_101500-…`).
 * The stamp has second resolution, so a file stamped in the very second the erasure began counts as erased (a new
 * recording cannot start then: erasure is refused while one records). A name with no stamp is never fenced.
 */
export function isErasureFencedName(name: string, partitionId?: string): boolean {
  const pid = partitionInForce(partitionId)
  const erasedAt = pid ? (configured?.erasedAt(pid) ?? null) : null
  if (erasedAt === null) return false
  const found = /(\d{4}-\d{2}-\d{2}_\d{6})/.exec(name)
  return found !== null && (found[1] as string) <= stampOf(erasedAt)
}
