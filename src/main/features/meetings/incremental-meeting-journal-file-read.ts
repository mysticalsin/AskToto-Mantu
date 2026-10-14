import type { StorageGateway } from '../../infra/storage/gateway'
import { ownedBytes } from './incremental-meeting-journal-format'

export type BoundedJournalFileRead = { status: 'ok'; bytes: Buffer } | { status: 'missing' | 'unavailable' }

export function createBoundedJournalFileReader(options: {
  baseCurrent: () => boolean
  rootAligned: () => Promise<boolean>
  maxChunkBytes: number
  classify: StorageGateway['classify']
  stream: StorageGateway['stream']
}) {
  const { baseCurrent, rootAligned, maxChunkBytes, classify, stream } = options
  return async function readBytes(
    name: string,
    maxBytes: number,
    requestCurrent: () => boolean
  ): Promise<BoundedJournalFileRead> {
    const current = async () => {
      if (!(await rootAligned())) return false
      return baseCurrent() && requestCurrent()
    }
    if (!(await current())) return { status: 'unavailable' }
    let classification: Awaited<ReturnType<StorageGateway['classify']>>
    try {
      classification = await classify([name])
    } catch {
      return { status: 'unavailable' }
    }
    if (!(await current())) return { status: 'unavailable' }
    const file = classification.get(name)
    if (!file) return { status: 'unavailable' }
    if (file.status === 'missing') return { status: 'missing' }
    if (file.status !== 'ok' || file.isSymlink || !file.isRegular || file.version.size > maxBytes)
      return { status: 'unavailable' }
    const parts: Uint8Array[] = []
    let collectedBytes = 0
    let result: Awaited<ReturnType<StorageGateway['stream']>>
    try {
      result = await stream(
        name,
        async (chunk) => {
          if (!(await current())) throw new Error('STALE_OWNER')
          const length = chunk.byteLength
          if (!Number.isSafeInteger(length) || length <= 0 || collectedBytes > maxBytes - length)
            throw new Error('READ_LIMIT')
          parts.push(ownedBytes(chunk))
          collectedBytes += length
        },
        { maxBytes, maxChunkBytes: Math.min(maxChunkBytes, maxBytes) }
      )
    } catch {
      for (const part of parts) part.fill(0)
      return { status: 'unavailable' }
    }
    if (
      !(await current()) ||
      result.status !== 'ok' ||
      result.bytesRead !== collectedBytes ||
      collectedBytes > maxBytes
    ) {
      for (const part of parts) part.fill(0)
      return result.status === 'missing' ? { status: 'missing' } : { status: 'unavailable' }
    }
    const bytes = Buffer.concat(parts, collectedBytes)
    for (const part of parts) part.fill(0)
    return { status: 'ok', bytes }
  }
}
