/**
 * diagnostics-bundle.ts — what the support bundle contains: logs, crash dumps, the boot sentinel, the upgrade
 * receipts and a MANIFEST. Logs out, content never: this module never reaches for meetings, the brain store, the
 * wiki mirror or settings, and every text file passes the redaction gate (diagnostics-redaction.ts) before it is
 * previewed or handed to the export service, which writes it conflict-safely. Nothing here uploads; the only way
 * a bundle leaves the device is the owner choosing a destination in the export dialog.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addRedactionCounts,
  redactDiagnosticsText,
  zeroRedactionCounts,
  type RedactionCounts
} from './diagnostics-redaction'
import { UPGRADE_RECEIPTS_FILE } from '../../infra/observability/upgrade-receipts'

export interface DiagnosticsBundleInfo {
  userData: string
  version: string
  platform: string
  arch: string
  packaged: boolean
  now?: () => Date
}

export interface DiagnosticsBundle {
  entries: { name: string; bytes: Buffer }[]
  files: number
  /** Redactions applied per file name (the manifest is generated, so it has none). */
  redactions: Record<string, RedactionCounts>
}

export async function collectDiagnosticsBundle(info: DiagnosticsBundleInfo): Promise<DiagnosticsBundle> {
  const entries: { name: string; bytes: Buffer }[] = []
  const redactions: Record<string, RedactionCounts> = {}
  const take = async (src: string, name: string): Promise<void> => {
    try {
      const redacted = redactDiagnosticsText((await readFile(src)).toString('utf8'))
      entries.push({ name, bytes: Buffer.from(redacted.text, 'utf8') })
      redactions[name] = redacted.counts
    } catch {
      /* a locked/absent file is skipped, and the manifest shows exactly what made it */
    }
  }
  const logsDir = join(info.userData, 'logs')
  for (const f of await readdir(logsDir).catch(() => [] as string[])) {
    if (/\.log$|^responsiveness-report\.json$/.test(f)) await take(join(logsDir, f), f)
  }
  for (const f of await readdir(info.userData)) {
    if (/^crash-.*\.log$/.test(f)) await take(join(info.userData, f), f)
  }
  const sentinel = join(info.userData, 'boot-incomplete.json')
  await take(sentinel, 'boot-incomplete.json')
  await take(join(info.userData, UPGRADE_RECEIPTS_FILE), UPGRADE_RECEIPTS_FILE)
  const copied = entries.map((e) => e.name)
  const totals = zeroRedactionCounts()
  for (const counts of Object.values(redactions)) addRedactionCounts(totals, counts)
  const totalRedactions = Object.values(totals).reduce((a, b) => a + b, 0)
  const manifest = [
    `Métis diagnostics bundle`,
    `exported: ${(info.now ?? ((): Date => new Date()))().toISOString()}`,
    `version: ${info.version}`,
    `platform: ${info.platform} ${info.arch}`,
    `packaged: ${info.packaged}`,
    ``,
    `files (${copied.length}):`,
    ...copied.map((f) => `  ${f}`),
    ``,
    `redactions: ${totalRedactions} (secrets ${totals.secret}, emails ${totals.email}, home paths ${totals['home-path']}, url credentials ${totals['url-credential']}, content fields ${totals['content-field']})`,
    ``,
    `Deliberately NOT included: meeting transcripts, the .brain/ knowledge store, the wiki mirror,`,
    `and settings.json — this bundle is for diagnosing the app, never for moving content.`
  ].join('\n')
  entries.push({ name: 'MANIFEST.txt', bytes: Buffer.from(manifest, 'utf8') })
  return { entries, files: copied.length, redactions }
}

export interface DiagnosticsPreviewFile {
  name: string
  bytes: number
  /** SHA-256 of exactly the bytes that would be written. */
  sha256: string
  redactions: RedactionCounts & { total: number }
  /** The file as it would be written, cut to the display cap. */
  text: string
  textTruncated: boolean
}

export interface DiagnosticsPreview {
  files: DiagnosticsPreviewFile[]
  totalBytes: number
  totalRedactions: number
}

const DEFAULT_PREVIEW_TEXT_BYTES = 64 * 1024

/** The owner-facing view of a collected bundle: the same redacted bytes, never a second code path. */
export function previewDiagnosticsBundle(
  bundle: DiagnosticsBundle,
  opts: { maxTextBytes?: number } = {}
): DiagnosticsPreview {
  const cap = opts.maxTextBytes ?? DEFAULT_PREVIEW_TEXT_BYTES
  let totalBytes = 0
  let totalRedactions = 0
  const files = bundle.entries.map((entry): DiagnosticsPreviewFile => {
    const counts = bundle.redactions[entry.name] ?? zeroRedactionCounts()
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    const full = entry.bytes.toString('utf8')
    const textTruncated = entry.bytes.length > cap
    totalBytes += entry.bytes.length
    totalRedactions += total
    return {
      name: entry.name,
      bytes: entry.bytes.length,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
      redactions: { ...counts, total },
      text: textTruncated ? full.slice(0, cap) : full,
      textTruncated
    }
  })
  return { files, totalBytes, totalRedactions }
}
