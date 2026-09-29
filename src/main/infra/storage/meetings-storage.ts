import { resolve } from 'node:path'
import type { ContentPresence, DatalessDetector } from './dataless'
import { createStorageGateway, poolAdmission, type FileClass, type StorageFs, type StorageGateway } from './gateway'

const CLASSIFY_BATCH = 1_000

/** One gateway per resolved root, so two spellings of one folder share its caches. */
let gateways = new Map<string, StorageGateway>()
let testStorageOptions: { detector?: DatalessDetector; fs?: StorageFs; poolSize?: number } | undefined
/** Every gateway's fs calls run under this one cap: the roots share the process's libuv pool. */
let admission = poolAdmission()

export function storageAt(root: string): StorageGateway {
  const key = resolve(root)
  const existing = gateways.get(key)
  if (existing) return existing
  const gateway = createStorageGateway({ root: () => root, ...testStorageOptions, admission })
  gateways.set(key, gateway)
  return gateway
}

export async function classifyAll(gateway: StorageGateway, relPaths: readonly string[]): Promise<Map<string, FileClass>> {
  const classes = new Map<string, FileClass>()
  for (let start = 0; start < relPaths.length; start += CLASSIFY_BATCH) {
    const batch = relPaths.slice(start, start + CLASSIFY_BATCH)
    for (const [rel, fileClass] of await gateway.classify(batch)) classes.set(rel, fileClass)
    const unknown = batch.filter((rel) => classes.get(rel)?.status === 'unknown')
    if (unknown.length > 0) {
      for (const [rel, fileClass] of await gateway.classify(unknown)) classes.set(rel, fileClass)
    }
  }
  return classes
}

const EVERY_FILE_LOCAL: DatalessDetector = {
  classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local']))
}

export function useStorageForTests(options: { detector?: DatalessDetector; fs?: StorageFs; poolSize?: number } = {}): void {
  testStorageOptions = {
    detector: options.detector ?? EVERY_FILE_LOCAL,
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.poolSize !== undefined ? { poolSize: options.poolSize } : {})
  }
  gateways = new Map()
  admission = poolAdmission(options.poolSize)
}
