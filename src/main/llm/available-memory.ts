import { freemem } from 'node:os'
import { readVmStat } from '../infra/process/vm-stat'

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

// Settings polls model readiness, and each poll sizes the spawn profile. One vm_stat per window is plenty:
// the reading only chooses between profiles whose thresholds sit gigabytes apart.
const READING_TTL_MS = 10_000
let lastVmStat: { output: string; at: number } | null = null
let refreshing: Promise<void> | null = null

/** Runs vm_stat in the background and caches its output. A failed run drops the reading, so the gate falls
 *  back to freemem() (which errs small) rather than trusting a stale one. Concurrent calls share one run. */
export function refreshVmStatReading(): Promise<void> {
  refreshing ??= readVmStat()
    .then(
      (output) => { lastVmStat = { output, at: Date.now() } },
      () => { lastVmStat = null }
    )
    .finally(() => { refreshing = null })
  return refreshing
}

/** Boot: take the first reading now and keep it fresh every READING_TTL_MS. darwin only; returns a stop. */
export function startAvailableMemorySampler(platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'darwin') return () => {}
  void refreshVmStatReading()
  const timer = setInterval(() => void refreshVmStatReading(), READING_TTL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

const defaultDeps: MemoryReadingDeps = {
  platform: process.platform,
  freemem: () => freemem(),
  vmStat: () => {
    if (!lastVmStat) throw new Error('no vm_stat reading yet')
    return lastVmStat.output
  }
}

export function readAvailableMemoryBytes(deps: MemoryReadingDeps = defaultDeps): number {
  if (deps.platform !== 'darwin') return deps.freemem()
  try {
    return parseVmStatAvailableBytes(deps.vmStat()) ?? deps.freemem()
  } catch {
    return deps.freemem()
  }
}

/** Synchronous and never spawns: answers from the last background vm_stat reading (freemem() before the first
 *  lands) and, when that reading is missing or stale, starts a background refresh for the next caller. */
export function availableMemoryGB(platform: NodeJS.Platform = process.platform, now = Date.now()): number {
  if (platform === 'darwin' && (!lastVmStat || now - lastVmStat.at >= READING_TTL_MS)) void refreshVmStatReading()
  return readAvailableMemoryBytes({ ...defaultDeps, platform }) / 1024 ** 3
}
