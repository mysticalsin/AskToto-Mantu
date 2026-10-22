import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const CRASH_LOG = /^crash-(\d+)-(\d+)\.log$/
const RENDERER_CRASH_INTERVAL_MS = 10_000

/**
 * Keeps the newest `keep` crash-*.log files (D10-13). Ordered by (timestamp, per-process sequence) as numbers:
 * the sequence is not zero-padded, so a name sort would put `-10` before `-9`. Best-effort and async, so it
 * is safe to call from the crash path and from boot: it never throws and never blocks the main thread.
 */
export async function pruneCrashLogs(dir: string, keep = 5): Promise<void> {
  try {
    const logs = (await readdir(dir))
      .flatMap((name) => {
        const m = CRASH_LOG.exec(name)
        return m ? [{ name, ts: Number(m[1]), seq: Number(m[2]) }] : []
      })
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    for (const { name } of logs.slice(0, Math.max(0, logs.length - keep))) {
      await unlink(join(dir, name)).catch(() => {})
    }
  } catch {
    /* best-effort: never block startup or a crash handler */
  }
}

/** Allows one renderer-reported crash file per 10 s, so a throwing render loop cannot fill the disk. */
export function createRendererCrashThrottle(now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < RENDERER_CRASH_INTERVAL_MS) return false
    last = t
    return true
  }
}
