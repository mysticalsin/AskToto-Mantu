import { utilityProcess } from 'electron'
import { join } from 'node:path'

type ExtractChild = {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  postMessage(message: Record<string, unknown>): void
  kill?(): boolean
}

type ExtractFork = (modulePath: string, args: string[], options: { serviceName: string; stdio: 'pipe' }) => ExtractChild

export interface WindowsExtractionOptions {
  fork?: ExtractFork
  timeoutMs?: number
}

const DEFAULT_EXTRACTION_TIMEOUT_MS = 10 * 60_000

/**
 * Windows' system tar can deadlock when it delegates bzip2 to a child process. Use the reviewed in-process
 * decoder in a utility process so recovery remains bounded without freezing the overlay's main process.
 */
export function extractParakeetArchiveWindows(
  archivePath: string,
  destDir: string,
  { fork = utilityProcess.fork as unknown as ExtractFork, timeoutMs = DEFAULT_EXTRACTION_TIMEOUT_MS }: WindowsExtractionOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'parakeet-extract-host.js'), [], {
      serviceName: 'metis-parakeet-extract',
      stdio: 'pipe'
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill?.()
      } catch {
        // The helper may already have exited after posting its result.
      }
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error('Preparing transcription files timed out. Try again.'))
    }, timeoutMs)

    child.on('message', (message: unknown) => {
      const response = message as { type?: unknown; message?: unknown }
      if (response?.type === 'result') finish()
      else if (response?.type === 'error') {
        finish(new Error(typeof response.message === 'string' ? response.message : 'Could not prepare transcription files.'))
      }
    })
    child.on('exit', (code) => {
      finish(new Error(`The transcription preparation helper exited before completion (code ${code ?? 'unknown'}).`))
    })
    try {
      child.postMessage({ type: 'extract', archivePath, destDir })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
