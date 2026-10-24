import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MAX_OFFLOAD_RECEIPTS,
  OffloadReceiptSchema,
  OffloadReceiptsSchema,
  type OffloadReceipt
} from '@shared/component-offload'

export interface OffloadReceiptStore {
  /** Newest first, at most MAX_OFFLOAD_RECEIPTS. An unreadable or invalid file reads as empty. */
  list(): Promise<OffloadReceipt[]>
  append(receipt: OffloadReceipt): Promise<void>
}

/**
 * Bounded receipt log (G87): a JSON array written to a temporary file and renamed into place, so a crash leaves the
 * old log or the new one, never half of either. Receipts carry no path, transcript or account detail; the file
 * is install-scoped, not owner data. Writes are serialised.
 */
export function createOffloadReceiptStore(filePath: string, max: number = MAX_OFFLOAD_RECEIPTS): OffloadReceiptStore {
  let chain: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<OffloadReceipt[]> => {
    try {
      const parsed = OffloadReceiptsSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }
  return {
    list: () => chain.then(read, read),
    append(receipt) {
      const next = chain.then(async () => {
        const safe = OffloadReceiptSchema.parse(receipt)
        const merged = [safe, ...(await read())].slice(0, max)
        await mkdir(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp`
        try {
          await writeFile(tmp, JSON.stringify(merged), { encoding: 'utf8', mode: 0o600 })
          await rename(tmp, filePath)
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => undefined)
          throw error
        }
      })
      chain = next.catch(() => undefined)
      return next
    }
  }
}
