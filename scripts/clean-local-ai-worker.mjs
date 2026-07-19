#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Remove only the standalone worker compiler output, using Node APIs so the build works on Windows. */
export async function cleanLocalAiWorker(repoRoot = REPO_ROOT) {
  await rm(join(resolve(repoRoot), 'out', 'local-ai-worker'), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cleanLocalAiWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
