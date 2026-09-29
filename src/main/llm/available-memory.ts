import { execFileSync } from 'node:child_process'
import { freemem } from 'node:os'

/**
 * Memory the OS can hand to a new allocation without swapping, in bytes.
 *
 * On macOS `os.freemem()` reports only truly free pages. The kernel keeps nearly all idle RAM as
 * inactive, speculative or purgeable cache and reclaims it on demand, so a 32 GB Mac routinely reports
 * under 1 GB "free" while most of its RAM is available. Every gate that read freemem() there therefore
 * refused GPU offload and warm starts on machines with plenty of room. The darwin reading is
 * free + inactive + speculative + purgeable pages from `vm_stat` (the host_statistics64 counters).
 * Other platforms keep freemem(); an unreadable vm_stat falls back to it too, which errs small.
 */
export interface MemoryReadingDeps {
  platform: NodeJS.Platform
  freemem: () => number
  vmStat: () => string
}

/** Pages `vm_stat` reports that the kernel can reclaim for a new allocation without paging anything out. */
const AVAILABLE_PAGE_KINDS = ['free', 'inactive', 'speculative', 'purgeable'] as const

/** Available bytes from `vm_stat` output, or null when the output does not carry every needed counter. */
export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)
  if (!pageSize) return null
  let pages = 0
  for (const kind of AVAILABLE_PAGE_KINDS) {
    const line = new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output)
    if (!line) return null
    pages += Number(line[1])
  }
  return pages * Number(pageSize[1])
}

const defaultDeps: MemoryReadingDeps = {
  platform: process.platform,
  freemem: () => freemem(),
  vmStat: () => execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2_000 })
}

export function readAvailableMemoryBytes(deps: MemoryReadingDeps = defaultDeps): number {
  if (deps.platform !== 'darwin') return deps.freemem()
  try {
    return parseVmStatAvailableBytes(deps.vmStat()) ?? deps.freemem()
  } catch {
    return deps.freemem()
  }
}

// Settings polls model readiness, and each poll sizes the spawn profile. One vm_stat per window is plenty:
// the reading only chooses between profiles whose thresholds sit gigabytes apart.
const READING_TTL_MS = 10_000
let cached: { bytes: number; at: number } | null = null

export function availableMemoryGB(now = Date.now()): number {
  if (!cached || now - cached.at >= READING_TTL_MS) cached = { bytes: readAvailableMemoryBytes(), at: now }
  return cached.bytes / 1024 ** 3
}
