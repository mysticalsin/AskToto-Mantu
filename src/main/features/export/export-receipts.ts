/**
 * export-receipts.ts — append-only local log of completed exports.
 *
 * A receipt names where an export landed and proves what was written (size and SHA-256); it never carries
 * meeting content. Lines are only ever appended.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ExportReceipt } from '@shared/ipc'

const KINDS = new Set(['meeting-markdown', 'recap-pdf', 'diagnostics-bundle', 'data-rights-bundle'])
const RESOLUTIONS = new Set(['none', 'keep-both', 'replace'])

export async function appendReceipt(logPath: string, receipt: ExportReceipt): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  await appendFile(logPath, `${JSON.stringify(receipt)}\n`, { flag: 'a', mode: 0o600 })
}

function asReceipt(value: unknown): ExportReceipt | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (
    typeof r.exportId === 'string' &&
    typeof r.kind === 'string' &&
    KINDS.has(r.kind) &&
    typeof r.destination === 'string' &&
    typeof r.bytes === 'number' &&
    typeof r.sha256 === 'string' &&
    typeof r.writtenAt === 'string' &&
    typeof r.conflictResolution === 'string' &&
    RESOLUTIONS.has(r.conflictResolution)
  ) {
    return r as unknown as ExportReceipt
  }
  return null
}

/** Latest receipt with this id, or null. Corrupt lines are skipped. */
export async function readReceipt(logPath: string, exportId: string): Promise<ExportReceipt | null> {
  let text: string
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return null
  }
  let found: ExportReceipt | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const receipt = asReceipt(JSON.parse(line))
      if (receipt && receipt.exportId === exportId) found = receipt
    } catch {
      /* skip a torn or foreign line */
    }
  }
  return found
}
