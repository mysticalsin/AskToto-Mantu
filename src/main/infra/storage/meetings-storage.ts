/**
 * The process's one Storage (ADR-021: one admission cap per process). Main-process code reaches a folder of
 * meetings (the meetings root, a team transcript folder) only through storageAt(folder), naming the folder on
 * every request because Settings can move it.
 */
import type { ContentPresence, DatalessDetector } from './dataless'
import { createStorage, type FileClass, type Storage, type StorageGateway, type StorageOptions } from './gateway'

/** Paths per classify call: far below admission's MAX_QUEUED (4096), so a large folder never degrades itself. */
const CLASSIFY_BATCH = 1_000

let storage: Storage | undefined

export function storageAt(root: string): StorageGateway {
  storage ??= createStorage()
  return storage.at(root)
}

/** Every path's class, in batches. Paths a batch left 'unknown' are asked once more: a cold platform probe can
 *  outlast one classify deadline, and it caches its verdicts for the second ask. */
export async function classifyAll(gateway: StorageGateway, relPaths: readonly string[]): Promise<Map<string, FileClass>> {
  const classes = new Map<string, FileClass>()
  for (let start = 0; start < relPaths.length; start += CLASSIFY_BATCH) {
    const batch = relPaths.slice(start, start + CLASSIFY_BATCH)
    for (const [rel, fileClass] of await gateway.classify(batch)) classes.set(rel, fileClass)
    const unknown = batch.filter((rel) => classes.get(rel)?.status === 'unknown')
    if (unknown.length === 0) continue
    for (const [rel, fileClass] of await gateway.classify(unknown)) classes.set(rel, fileClass)
  }
  return classes
}

const EVERY_FILE_LOCAL: DatalessDetector = {
  classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])),
  markLocal: () => {}
}

/** Test-only: a fresh Storage whose detector and fs the test controls. By default every file is local and the
 *  real fs is used, so a test neither spawns the platform probe (PowerShell on the Windows runner) nor depends
 *  on its timing. */
export function useStorageForTests(options: StorageOptions = {}): void {
  storage = createStorage({ detector: EVERY_FILE_LOCAL, ...options })
}
