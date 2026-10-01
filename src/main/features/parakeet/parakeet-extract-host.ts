/** Windows-only Parakeet archive extraction runs here, never on Electron's main thread. */
import { extractTarBz2Windows } from '../../scripts/tar-bz2-extract.mjs'

export interface ParakeetExtractHostPort {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): unknown
  postMessage(message: Record<string, unknown>): void
  start?(): void
}

function requestFrom(event: { data?: unknown } | unknown): { type?: unknown; archivePath?: unknown; destDir?: unknown } {
  return event && typeof event === 'object' && 'data' in event
    ? ((event as { data: unknown }).data as { type?: unknown; archivePath?: unknown; destDir?: unknown })
    : (event as { type?: unknown; archivePath?: unknown; destDir?: unknown })
}

export function attachParakeetExtractHost(port: ParakeetExtractHostPort): void {
  port.on('message', (event) => {
    const request = requestFrom(event)
    if (request?.type !== 'extract' || typeof request.archivePath !== 'string' || typeof request.destDir !== 'string') {
      port.postMessage({ type: 'error', message: 'Invalid Parakeet extraction request.' })
      return
    }
    try {
      extractTarBz2Windows(request.archivePath, request.destDir)
      port.postMessage({ type: 'result' })
    } catch (error) {
      port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  })
  port.start?.()
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParakeetExtractHostPort }).parentPort
if (parentPort) attachParakeetExtractHost(parentPort)
