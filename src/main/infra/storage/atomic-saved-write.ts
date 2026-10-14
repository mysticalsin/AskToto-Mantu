import { randomBytes } from 'node:crypto'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { recordLocalWrite } from './local-writes'

export interface AtomicSavedWriteStreamBounds {
  /** Trusted caller-owned limits; no default means unbounded. */
  maxBytes: number
  maxChunkBytes: number
  maxChunks: number
  /** Synchronous main-owned admission checks, never a renderer callback. */
  beforeChunk?: () => void
  beforeReplace?: () => void
}

export interface AtomicSavedWriteStreamResult {
  bytesWritten: number
  chunksWritten: number
  fileSyncCompleted: true
}

function invalidLimit(): Error {
  const error = new Error('Streamed saved write exceeded its admitted resource budget.')
  error.name = 'RESOURCE_LIMIT'
  return error
}

function validBounds(bounds: AtomicSavedWriteStreamBounds): boolean {
  return (
    Number.isSafeInteger(bounds.maxBytes) &&
    bounds.maxBytes > 0 &&
    Number.isSafeInteger(bounds.maxChunkBytes) &&
    bounds.maxChunkBytes > 0 &&
    bounds.maxChunkBytes <= bounds.maxBytes &&
    Number.isSafeInteger(bounds.maxChunks) &&
    bounds.maxChunks > 0
  )
}

function fixedOwnedBytes(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength)
    return false
  if (!(value.buffer instanceof ArrayBuffer)) return false
  try {
    const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    return resizable?.call(value.buffer) !== true
  } catch {
    return false
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (result.bytesWritten <= 0) throw new Error('Streamed saved write did not advance.')
    offset += result.bytesWritten
  }
}

/**
 * Writes a bounded async byte stream to an owned sibling temp, syncs that file, then atomically replaces
 * the destination. `fileSyncCompleted` describes the temp-file data sync only; parent-directory crash
 * durability remains platform-specific and is not claimed here.
 */
export async function atomicSavedWriteStream(
  file: string,
  chunks: AsyncIterable<Uint8Array>,
  bounds: AtomicSavedWriteStreamBounds
): Promise<AtomicSavedWriteStreamResult> {
  if (!validBounds(bounds)) throw invalidLimit()
  const tmp = `${file}.${randomBytes(12).toString('hex')}.tmp`
  const iterator = chunks[Symbol.asyncIterator]()
  let handle: FileHandle | undefined
  let bytesWritten = 0
  let chunksWritten = 0
  let replaced = false
  try {
    bounds.beforeChunk?.()
    handle = await open(tmp, 'wx', 0o600)
    while (true) {
      bounds.beforeChunk?.()
      const next = await iterator.next()
      if (next.done) break
      bounds.beforeChunk?.()
      const chunk = next.value
      if (
        !fixedOwnedBytes(chunk) ||
        chunk.byteLength === 0 ||
        chunk.byteLength > bounds.maxChunkBytes ||
        chunksWritten >= bounds.maxChunks ||
        bytesWritten > bounds.maxBytes - chunk.byteLength
      )
        throw invalidLimit()
      await writeAll(handle, chunk)
      bytesWritten += chunk.byteLength
      chunksWritten += 1
    }
    bounds.beforeChunk?.()
    await handle.sync()
    await handle.close()
    handle = undefined
    for (let attempt = 0; ; attempt++) {
      bounds.beforeReplace?.()
      try {
        await rename(tmp, file)
        replaced = true
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt))
      }
    }
    await recordLocalWrite(file)
    return { bytesWritten, chunksWritten, fileSyncCompleted: true }
  } catch (error) {
    if (!replaced) {
      try {
        await iterator.return?.()
      } catch {
        // The original refusal/error owns the result; cleanup must not replace it.
      }
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
    if (!replaced) await unlink(tmp).catch(() => {})
  }
}

/** Replaces one saved file only after its current owner admits the exact rename attempt. */
export async function atomicSavedWrite(file: string, data: Buffer, beforeReplace?: () => void): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      // Admission is synchronous and outside the rename retry handler so refusals propagate unchanged.
      beforeReplace?.()
      try {
        await rename(tmp, file)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // OneDrive and real-time scanners can briefly hold a new file open on Windows.
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt))
      }
    }
    await recordLocalWrite(file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}
