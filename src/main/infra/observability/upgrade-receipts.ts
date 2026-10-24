/**
 * upgrade-receipts.ts — a local, metadata-only record of every version change this install has seen.
 *
 * On each launch `recordLaunchVersion` compares the running version with the last one recorded and appends one
 * receipt when they differ: `first-run`, `upgrade` (newer), `rollback` (older) or `changed` (not comparable). A
 * receipt holds two version strings and a timestamp — never a path, account or content. The log is bounded on
 * read, never throws, and rides in the diagnostics bundle so support can see the install history the owner
 * chose to share.
 */
import { appendFile, readFile } from 'node:fs/promises'

/** File name inside userData; the diagnostics bundle collects it by this name. */
export const UPGRADE_RECEIPTS_FILE = 'upgrade-receipts.jsonl'

export type UpgradeReceiptKind = 'first-run' | 'upgrade' | 'rollback' | 'changed'

export interface UpgradeReceipt {
  schema: 1
  kind: UpgradeReceiptKind
  /** Absent on `first-run`. */
  from?: string
  to: string
  at: string
}

const MAX_RECEIPTS = 50
const VERSION_RE = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/

function parseCore(version: string): number[] | null {
  if (!VERSION_RE.test(version)) return null
  return version.split(/[-+]/)[0].split('.').map(Number)
}

/** -1 when `a` is older than `b`, 1 when newer, 0 when equal, null when not comparable. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseCore(a)
  const pb = parseCore(b)
  if (!pa || !pb) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  // Same core: a pre-release sorts before the release; two different pre-releases are not comparable here.
  const baseA = a.split('+')[0]
  const baseB = b.split('+')[0]
  if (baseA === baseB) return 0
  const preA = baseA.includes('-')
  const preB = baseB.includes('-')
  if (!preA && !preB) return 0
  if (preA && preB) return null
  return preA ? -1 : 1
}

export function classifyVersionChange(previous: string | undefined, current: string): UpgradeReceiptKind | null {
  if (previous === undefined) return 'first-run'
  if (previous === current) return null
  const order = compareVersions(previous, current)
  if (order === 0) return null
  if (order === null) return 'changed'
  return order < 0 ? 'upgrade' : 'rollback'
}

function isReceipt(value: unknown): value is UpgradeReceipt {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    r.schema === 1 &&
    (r.kind === 'first-run' || r.kind === 'upgrade' || r.kind === 'rollback' || r.kind === 'changed') &&
    typeof r.to === 'string' &&
    typeof r.at === 'string' &&
    (r.from === undefined || typeof r.from === 'string')
  )
}

/** Newest-last, at most MAX_RECEIPTS; malformed or torn lines are skipped. A missing file is an empty log. */
export async function readUpgradeReceipts(logPath: string): Promise<UpgradeReceipt[]> {
  let raw: string
  try {
    raw = await readFile(logPath, 'utf8')
  } catch {
    return []
  }
  const receipts: UpgradeReceipt[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isReceipt(parsed)) receipts.push(parsed)
    } catch {
      /* torn line from an interrupted write */
    }
  }
  return receipts.slice(-MAX_RECEIPTS)
}

/** Appends a receipt when the running version differs from the last recorded one. Never rejects. */
export async function recordLaunchVersion(opts: {
  logPath: string
  version: string
  now?: () => Date
}): Promise<UpgradeReceipt | null> {
  try {
    if (!opts.version) return null
    const existing = await readUpgradeReceipts(opts.logPath)
    const previous = existing.length ? existing[existing.length - 1].to : undefined
    const kind = classifyVersionChange(previous, opts.version)
    if (!kind) return null
    const receipt: UpgradeReceipt = {
      schema: 1,
      kind,
      ...(previous !== undefined ? { from: previous } : {}),
      to: opts.version,
      at: (opts.now ?? ((): Date => new Date()))().toISOString()
    }
    // No mkdir: userData exists by the time the boot sentinel has been written, and a missing directory must
    // fail closed (no receipt) rather than be created.
    await appendFile(opts.logPath, JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: 0o600 })
    return receipt
  } catch {
    return null
  }
}
