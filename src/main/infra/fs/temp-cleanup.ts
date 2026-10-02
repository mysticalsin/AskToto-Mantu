import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

type SyncFs = {
  readdirSync(path: string): string[]
  unlinkSync(path: string): void
}

function syncFs(): SyncFs {
  return (process as typeof process & { getBuiltinModule: (id: 'node:fs') => SyncFs }).getBuiltinModule('node:fs')
}

export function removeFile(path: string): Promise<void> {
  return unlink(path)
}

export function removeFilesBestEffort(paths: Iterable<string>): void {
  for (const path of paths) void unlink(path).catch(() => undefined)
}

export function removeFilesBestEffortSync(paths: Iterable<string>): void {
  const fs = syncFs()
  for (const path of paths) {
    try {
      fs.unlinkSync(path)
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
  const fs = syncFs()
  try {
    for (const name of fs.readdirSync(dir)) {
      if (pattern.test(name)) {
        try {
          fs.unlinkSync(join(dir, name))
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}
