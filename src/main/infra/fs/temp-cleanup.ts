import { readdirSync, unlinkSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export function removeFile(path: string): Promise<void> {
  return unlink(path)
}

export function removeFilesBestEffort(paths: Iterable<string>): void {
  for (const path of paths) void unlink(path).catch(() => undefined)
}

export function removeFilesBestEffortSync(paths: Iterable<string>): void {
  for (const path of paths) {
    try {
      unlinkSync(path)
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function sweepMatchingFilesBestEffort(dir: string, pattern: RegExp): void {
  void (async () => {
    try {
      for (const name of await readdir(dir)) {
        if (pattern.test(name)) await unlink(join(dir, name)).catch(() => undefined)
      }
    } catch {
      /* best-effort cleanup */
    }
  })()
}

export function sweepMatchingFilesBestEffortSync(dir: string, pattern: RegExp): void {
  try {
    for (const name of readdirSync(dir)) {
      if (pattern.test(name)) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}
