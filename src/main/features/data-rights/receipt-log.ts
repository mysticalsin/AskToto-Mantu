import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ErasureReceiptSchema, type ErasureReceipt } from '@shared/data-rights'

/** `<userData>/data-rights/erasure-receipts.jsonl`: kept after an erasure on purpose, it is the proof (ids, counts, codes). */
export function erasureReceiptLogFile(userDataDir: string): string {
  return join(userDataDir, 'data-rights', 'erasure-receipts.jsonl')
}

export async function appendErasureReceipt(file: string, receipt: ErasureReceipt): Promise<void> {
  const line = `${JSON.stringify(ErasureReceiptSchema.parse(receipt))}\n`
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await appendFile(file, line, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
}

/** The newest valid receipt, or null when there is none (or the log is unreadable). */
export async function readLastErasureReceipt(file: string): Promise<ErasureReceipt | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = ErasureReceiptSchema.safeParse(JSON.parse(lines[i] as string))
      if (parsed.success) return parsed.data
    } catch {
      // a torn line is skipped
    }
  }
  return null
}
