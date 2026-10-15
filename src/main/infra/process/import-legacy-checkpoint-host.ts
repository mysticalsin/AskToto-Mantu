import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ImportLegacyWorkerPort } from '../../import-legacy-checkpoint-contract'

export interface ImportLegacyCheckpointHostOptions {
  entryPath?: string
  workerFactory?: (entryPath: string) => Worker
}

/** One private worker instance per legacy pass; no shared meeting-speech FIFO can deadlock appends. */
export async function createImportLegacyCheckpointHost(
  options: ImportLegacyCheckpointHostOptions = {}
): Promise<ImportLegacyWorkerPort> {
  const entryPath = options.entryPath ?? join(__dirname, 'import-legacy-checkpoint-worker.js')
  const worker = (options.workerFactory ?? ((path) => new Worker(path)))(entryPath)
  let exited = false
  let exitCode = -1
  const messageListeners = new Set<(message: unknown) => void>()
  const errorListeners = new Set<() => void>()
  const exitListeners = new Set<(code: number) => void>()
  worker.on('message', (message: unknown) => {
    for (const listener of messageListeners) listener(message)
  })
  worker.on('error', () => {
    for (const listener of errorListeners) listener()
  })
  worker.on('exit', (code) => {
    exited = true
    exitCode = code
    for (const listener of exitListeners) listener(code)
  })
  return {
    onMessage: (listener) => {
      messageListeners.add(listener)
    },
    onError: (listener) => {
      errorListeners.add(listener)
    },
    onExit: (listener) => {
      if (exited) listener(exitCode)
      else exitListeners.add(listener)
    },
    post: (message, transfer) => {
      if (exited) throw new Error('Legacy checkpoint worker has exited.')
      worker.postMessage(message, transfer ?? [])
    },
    terminate: async () => {
      if (!exited) await worker.terminate()
    }
  }
}
