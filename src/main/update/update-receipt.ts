import { readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import type { InstallReceipt } from './update-lifecycle'

const RECEIPT_FILE = 'update-receipt.json'
const MAX_RECEIPT_BYTES = 4096
const VERSION = z.string().regex(/^\d+(?:\.\d+){1,3}$/)
const ReceiptSchema = z
  .object({ schema: z.literal(1), fromVersion: VERSION, toVersion: VERSION, at: z.number().int().nonnegative() })
  .strict()

/** The install receipt: versions and a timestamp only. A missing, oversized or malformed file counts as absent. */
export async function readInstallReceipt(userDataDir: string): Promise<InstallReceipt | null> {
  const file = join(userDataDir, RECEIPT_FILE)
  try {
    if ((await stat(file)).size > MAX_RECEIPT_BYTES) return null
    const parsed = ReceiptSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Written atomically once a verified update is staged (it may install on a quit) and again right before a relaunch,
 *  so the next boot can tell a finished install from one that never happened. */
export async function writeInstallReceipt(userDataDir: string, receipt: InstallReceipt): Promise<void> {
  await atomicSavedWrite(join(userDataDir, RECEIPT_FILE), Buffer.from(JSON.stringify(receipt)))
}

export async function clearInstallReceipt(userDataDir: string): Promise<void> {
  await unlink(join(userDataDir, RECEIPT_FILE)).catch(() => {
    /* already gone */
  })
}
