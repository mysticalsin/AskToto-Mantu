/**
 * Atomic file replacement: the one tmp, fsync, rename sequence every durable write in the main process uses.
 *
 * Invariants:
 *   - The target holds either its previous bytes or the complete new bytes, never a truncated or partial
 *     file: the data is written to a sibling tmp file, fsynced, and only then renamed over the target.
 *   - A failed write or rename removes the tmp file and rethrows the original error, so callers keep their
 *     own user-facing message and the previous target survives.
 *   - A rename that fails with EPERM or EBUSY is retried a bounded number of times: OneDrive upload hashing
 *     and AV/EDR real-time scanning hold a just-written file open on Windows, and rename() then throws even
 *     though nothing is wrong. Any other error, or exhausted retries, throws.
 *   - Concurrent writers to one target must pass distinct `tmp` paths, or the first rename steals the
 *     second writer's bytes.
 */
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const RENAME_RETRIES = 4
const RENAME_BACKOFF_MS = 40

export interface AtomicWriteOptions {
  /** File mode of the new file. Defaults to owner read/write only. */
  mode?: number
  /** Sibling tmp path. Defaults to `<path>.tmp`. */
  tmp?: string
}

/** A tmp path no concurrent writer to the same target shares. */
export function uniqueTmpPath(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`
}

const isTransientRenameError = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY'
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fsyncFileSync(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function atomicWriteSync(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const tmp = options.tmp ?? `${path}.tmp`
  try {
    writeFileSync(tmp, data, { mode: options.mode ?? 0o600 })
    fsyncFileSync(tmp)
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path)
        return
      } catch (e) {
        if (!isTransientRenameError(e) || attempt >= RENAME_RETRIES) throw e
        sleepSync(RENAME_BACKOFF_MS * 2 ** attempt)
      }
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp)
    } catch {
      /* best-effort cleanup; the previous target is untouched */
    }
    throw e
  }
}

/** Async twin of atomicWriteSync: the same sequence, off the main-process event loop. */
export async function atomicWrite(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const tmp = options.tmp ?? `${path}.tmp`
  try {
    await writeFile(tmp, data, { mode: options.mode ?? 0o600 })
    const handle = await open(tmp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path)
        return
      } catch (e) {
        if (!isTransientRenameError(e) || attempt >= RENAME_RETRIES) throw e
        await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * 2 ** attempt))
      }
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) await unlink(tmp)
    } catch {
      /* best-effort cleanup; the previous target is untouched */
    }
    throw e
  }
}
