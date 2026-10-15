import { randomBytes } from 'node:crypto'
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { recordLocalWrite } from './local-writes'

export interface AtomicSavedWriteStreamBounds {
  /** Explicit finite caller-admitted limits are required; this writer supplies no defaults. */
  maxBytes: number
  maxChunkBytes: number
  maxChunks: number
  /** Synchronous main-owned admission checks, never a renderer callback. */
  beforeChunk?: () => void
  beforeReplace?: () => void
  /** Async physical-root admission after temp sync and immediately before each rename attempt. */
  prepareBeforeReplace?: () => Promise<void>
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

function checkAdmission(check: (() => void) | undefined): void {
  if (!check) return
  const result = (check as () => unknown)()
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
  const then = (result as { then?: unknown }).then
  if (typeof then !== 'function') return
  void Promise.resolve(result).catch(() => {})
  const error = new Error('Streamed saved write admission checks must be synchronous.')
  error.name = 'ASYNC_ADMISSION'
  throw error
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

interface ExactByteView {
  buffer: ArrayBuffer
  byteLength: number
}

interface TempIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  nlink: number
}

type CreatedIdentity = Pick<TempIdentity, 'dev' | 'ino'>

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get

function exactFixedBytes(value: unknown): ExactByteView | null {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
  try {
    const buffer = typedArrayBuffer?.call(value)
    const byteOffset = typedArrayByteOffset?.call(value)
    const byteLength = typedArrayByteLength?.call(value)
    if (!(buffer instanceof ArrayBuffer) || !Number.isSafeInteger(byteLength)) return null
    if (byteOffset !== 0 || byteLength !== arrayBufferByteLength?.call(buffer)) return null
    const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (resizable?.call(buffer) === true) return null
    return { buffer, byteLength }
  } catch {
    return null
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, beforeWrite: () => void): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    beforeWrite()
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    beforeWrite()
    if (result.bytesWritten <= 0) throw new Error('Streamed saved write did not advance.')
    offset += result.bytesWritten
  }
}

async function isUnchangedTemp(
  path: string,
  identity: TempIdentity | undefined,
  expectedBytes: number
): Promise<boolean> {
  if (!identity) return false
  try {
    const entry = await lstat(path)
    return (
      entry.isFile() &&
      entry.nlink === 1 &&
      entry.dev === identity.dev &&
      entry.ino === identity.ino &&
      entry.nlink === identity.nlink &&
      entry.size === expectedBytes &&
      entry.size === identity.size &&
      entry.mtimeMs === identity.mtimeMs &&
      entry.ctimeMs === identity.ctimeMs
    )
  } catch {
    return false
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
  const limits: AtomicSavedWriteStreamBounds = {
    maxBytes: bounds.maxBytes,
    maxChunkBytes: bounds.maxChunkBytes,
    maxChunks: bounds.maxChunks,
    beforeChunk: bounds.beforeChunk,
    beforeReplace: bounds.beforeReplace,
    prepareBeforeReplace: bounds.prepareBeforeReplace
  }
  if (!validBounds(limits)) throw invalidLimit()
  const tmp = `${file}.${randomBytes(12).toString('hex')}.tmp`
  const iterator = chunks[Symbol.asyncIterator]()
  let handle: FileHandle | undefined
  let bytesWritten = 0
  let chunksWritten = 0
  let replaced = false
  let created = false
  let createdIdentity: CreatedIdentity | undefined
  let tempIdentity: TempIdentity | undefined
  try {
    checkAdmission(limits.beforeChunk)
    handle = await open(tmp, 'wx', 0o600)
    created = true
    const openedStats = await handle.stat()
    createdIdentity = { dev: openedStats.dev, ino: openedStats.ino }
    checkAdmission(limits.beforeChunk)
    while (true) {
      checkAdmission(limits.beforeChunk)
      const next = await iterator.next()
      if (next.done) break
      checkAdmission(limits.beforeChunk)
      const chunk = next.value
      const view = exactFixedBytes(chunk)
      if (
        !view ||
        view.byteLength === 0 ||
        view.byteLength > limits.maxChunkBytes ||
        chunksWritten >= limits.maxChunks ||
        bytesWritten > limits.maxBytes - view.byteLength
      )
        throw invalidLimit()
      // Producer memory is no longer trusted once yielded. Copy exactly one admitted chunk before any
      // write await so a retained reference cannot mutate bytes in flight.
      const owned = new Uint8Array(view.byteLength)
      owned.set(new Uint8Array(view.buffer, 0, view.byteLength))
      await writeAll(handle, owned, () => checkAdmission(limits.beforeChunk))
      bytesWritten += view.byteLength
      chunksWritten += 1
    }
    checkAdmission(limits.beforeChunk)
    await handle.sync()
    checkAdmission(limits.beforeChunk)
    const syncedStats = await handle.stat()
    if (!syncedStats.isFile() || syncedStats.nlink !== 1 || syncedStats.size !== bytesWritten) {
      const error = new Error('Streamed saved write temporary file changed before promotion.')
      error.name = 'TEMP_OWNERSHIP'
      throw error
    }
    tempIdentity = {
      dev: syncedStats.dev,
      ino: syncedStats.ino,
      size: syncedStats.size,
      mtimeMs: syncedStats.mtimeMs,
      ctimeMs: syncedStats.ctimeMs,
      nlink: syncedStats.nlink
    }
    if (tempIdentity.dev !== createdIdentity.dev || tempIdentity.ino !== createdIdentity.ino) {
      const error = new Error('Streamed saved write temporary file identity changed.')
      error.name = 'TEMP_OWNERSHIP'
      throw error
    }
    checkAdmission(limits.beforeChunk)
    await handle.close()
    checkAdmission(limits.beforeChunk)
    handle = undefined
    for (let attempt = 0; ; attempt++) {
      checkAdmission(limits.beforeChunk)
      if (!(await isUnchangedTemp(tmp, tempIdentity, bytesWritten))) {
        const error = new Error('Streamed saved write lost ownership of its temporary file.')
        error.name = 'TEMP_OWNERSHIP'
        throw error
      }
      await limits.prepareBeforeReplace?.()
      if (!(await isUnchangedTemp(tmp, tempIdentity, bytesWritten))) {
        const error = new Error('Streamed saved write lost ownership of its temporary file.')
        error.name = 'TEMP_OWNERSHIP'
        throw error
      }
      // This synchronous policy check follows the final metadata await and stays outside the retry catch.
      checkAdmission(limits.beforeReplace)
      checkAdmission(limits.beforeChunk)
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
        const pendingReturn = iterator.return?.()
        if (pendingReturn) void Promise.resolve(pendingReturn).catch(() => {})
      } catch {
        // The original refusal/error owns the result; cleanup must not replace it.
      }
    }
    throw error
  } finally {
    let cleanupIdentity = tempIdentity
    if (!replaced && created && !cleanupIdentity && handle) {
      const current = await handle.stat().catch(() => undefined)
      if (
        current?.isFile() &&
        current.nlink === 1 &&
        current.dev === createdIdentity?.dev &&
        current.ino === createdIdentity?.ino
      ) {
        cleanupIdentity = {
          dev: current.dev,
          ino: current.ino,
          size: current.size,
          mtimeMs: current.mtimeMs,
          ctimeMs: current.ctimeMs,
          nlink: current.nlink
        }
      }
    }
    await handle?.close().catch(() => {})
    if (
      !replaced &&
      created &&
      cleanupIdentity &&
      cleanupIdentity.dev === createdIdentity?.dev &&
      cleanupIdentity.ino === createdIdentity?.ino &&
      (await isUnchangedTemp(tmp, cleanupIdentity, cleanupIdentity.size))
    )
      await unlink(tmp).catch(() => {})
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
