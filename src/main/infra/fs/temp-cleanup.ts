import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export function removeFile(path: string): Promise<void> {
  return unlink(path)
}

export function removeFilesBestEffort(paths: Iterable<string>): void {
  for (const path of paths) void unlink(path).catch(() => undefined)
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
