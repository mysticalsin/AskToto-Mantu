import { constants, type Stats } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'
import type { ContentPresence, FileVersion } from './dataless'

export type ContentVersion = Omit<FileVersion, 'path'>
export type StorageFailure =
  | { status: 'missing' }
  | { status: 'unavailable'; code: string }
  | { status: 'timeout' }
  | { status: 'degraded' }
  | { status: 'aborted' }
export interface StorageReadStats {
  dev: number
  ino: number
  nlink: number
  size: number
  mtimeMs: number
  ctimeMs: number
  isFile: boolean
}
export interface StorageReadHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  stat(): Promise<StorageReadStats>
  close(): Promise<void>
}
export interface StorageOpenedRead {
  handle: StorageReadHandle
  stats: StorageReadStats
}
export interface StreamOptions {
  /** Explicit finite source ceiling; the gateway supplies no limit default. */
  maxBytes: number
  /** Explicit finite chunk ceiling; the gateway supplies no chunk default. */
  maxChunkBytes: number
  signal?: AbortSignal
}
export type StorageStreamResult =
  | { status: 'ok'; version: ContentVersion; bytesRead: number; chunksRead: number }
  | { status: 'dataless' | 'unknown'; version: ContentVersion }
  | StorageFailure

interface StreamFs {
  openRead?(path: string): Promise<StorageOpenedRead>
  stat(path: string): Promise<{
    mtimeMs: number
    ctimeMs: number
    size: number
    dev?: number
    ino?: number
  }>
}
interface StorageGateway {
  stream(
    relPath: string,
    sink: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>,
    options: StreamOptions
  ): Promise<StorageStreamResult>
}

const STREAM_CHUNK_FAILURE = 'Stream requires an unchanged regular non-symlink file.'

function readStats(stats: Stats): StorageReadStats {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    isFile: stats.isFile()
  }
}

export async function openRegularRead(path: string): Promise<StorageOpenedRead> {
  const flags =
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags)
  try {
    const opened = readStats(await handle.stat())
    const entry = await lstat(path)
    const current = await stat(path)
    if (
      !opened.isFile ||
      entry.isSymbolicLink() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
      opened.mtimeMs !== current.mtimeMs ||
      opened.ctimeMs !== current.ctimeMs
    ) {
      const error = new Error(STREAM_CHUNK_FAILURE) as NodeJS.ErrnoException
      error.code = 'EINVAL'
      throw error
    }
    const readHandle: StorageReadHandle = {
      read: (buffer: Uint8Array, offset: number, length: number, position: number | null) =>
        handle.read(buffer, offset, length, position),
      stat: async () => readStats(await handle.stat()),
      close: () => handle.close()
    }
    return { handle: readHandle, stats: opened }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

interface Request {
  readonly signal: AbortSignal
  ended(phase: 'waiting' | 'running'): StorageFailure
  close(): void
}

type Settled<T> = { status: 'ok'; value: T } | StorageFailure
type StatedFile = { file: FileVersion; regular: boolean }
type RootResult = { status: 'ok'; root: string } | StorageFailure

interface Runtime {
  currentRoot(): RootResult
  underRoot(root: string, relPath: string): string | null
  openRequest(deadlineMs: number, signal?: AbortSignal): Request
  statFile(path: string, request: Request): Promise<Settled<StatedFile>>
  isSymlink(path: string, request: Request): Promise<boolean>
  presenceWithin(files: readonly FileVersion[], request: Request): Promise<Map<string, ContentPresence>>
  resolveInside(base: string, path: string, request: Request): Promise<Settled<string>>
  call<T>(
    lane: 'metadata' | 'content',
    request: Request,
    fsCall: () => Promise<T>,
    onLate?: (pending: Promise<Settled<T>>) => void
  ): Promise<Settled<T>>
  untilSink(
    sink: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>,
    chunk: Uint8Array,
    request: Request
  ): Promise<Settled<void>>
  failureOf(error: unknown): StorageFailure
  outsideRoot(): StorageFailure
  fs: StreamFs
  contentDeadlineMs: number
}

export function createStorageStreamReader(runtime: Runtime): StorageGateway['stream'] {
  return async (relPath, sink, options): Promise<StorageStreamResult> => {
    try {
      const maxBytes = options?.maxBytes
      const maxChunkBytes = options?.maxChunkBytes
      const signal = options?.signal
      if (
        !options ||
        typeof sink !== 'function' ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        !Number.isSafeInteger(maxChunkBytes) ||
        maxChunkBytes <= 0 ||
        maxChunkBytes > maxBytes
      )
        return { status: 'unavailable', code: 'INVALID_SIZE_LIMIT' }
      const current = runtime.currentRoot()
      if (current.status !== 'ok') return current
      const path = runtime.underRoot(current.root, relPath)
      if (!path) return runtime.outsideRoot()
      const request = runtime.openRequest(runtime.contentDeadlineMs, signal)
      let handle: StorageReadHandle | undefined
      let closeInBackground = false
      try {
        const [stated, symlink] = await Promise.all([runtime.statFile(path, request), runtime.isSymlink(path, request)])
        if (stated.status !== 'ok') return stated
        if (symlink) return { status: 'unavailable', code: 'SYMLINK' }
        if (!stated.value.regular) return { status: 'unavailable', code: 'NOT_REGULAR' }
        const version = {
          mtimeMs: stated.value.file.mtimeMs,
          ctimeMs: stated.value.file.ctimeMs,
          size: stated.value.file.size
        }
        if (version.size > maxBytes) return { status: 'unavailable', code: 'SIZE_LIMIT' }
        if (request.signal.aborted) return request.ended('waiting')
        const presence = (await runtime.presenceWithin([stated.value.file], request)).get(path)
        if (request.signal.aborted) return request.ended('waiting')
        if (presence !== 'local') return { status: presence ?? 'unknown', version }
        const real = await runtime.resolveInside(current.root, path, request)
        if (real.status !== 'ok') return real
        if (!runtime.fs.openRead) return { status: 'unavailable', code: 'STREAM_UNAVAILABLE' }
        const opened = await runtime.call(
          'content',
          request,
          () => runtime.fs.openRead!(real.value),
          (pending) => {
            void pending.then((result) => {
              if (result.status === 'ok') return result.value.handle.close().catch(() => {})
            })
          }
        )
        if (opened.status !== 'ok') return opened
        handle = opened.value.handle
        const initialStats = opened.value.stats
        if (
          !initialStats.isFile ||
          initialStats.size !== version.size ||
          initialStats.mtimeMs !== version.mtimeMs ||
          initialStats.ctimeMs !== version.ctimeMs
        )
          return { status: 'unavailable', code: 'SOURCE_CHANGED' }

        let bytesRead = 0
        let chunksRead = 0
        while (true) {
          if (request.signal.aborted) return request.ended('waiting')
          const buffer = new Uint8Array(Math.min(maxChunkBytes, maxBytes - bytesRead + 1))
          const read = await runtime.call(
            'content',
            request,
            () => handle!.read(buffer, 0, buffer.byteLength, null),
            (pending) => {
              closeInBackground = true
              const abandoned = handle
              handle = undefined
              if (abandoned) void pending.then(() => abandoned.close().catch(() => {}))
            }
          )
          if (read.status !== 'ok') return read
          if (
            !Number.isSafeInteger(read.value.bytesRead) ||
            read.value.bytesRead < 0 ||
            read.value.bytesRead > buffer.byteLength
          )
            return { status: 'unavailable', code: 'STREAM_READ_INVALID' }
          if (read.value.bytesRead === 0) break
          if (bytesRead > maxBytes - read.value.bytesRead) return { status: 'unavailable', code: 'SIZE_LIMIT' }
          const chunk = read.value.bytesRead === buffer.byteLength ? buffer : buffer.slice(0, read.value.bytesRead)
          const delivered = await runtime.untilSink(sink, chunk, request)
          if (delivered.status !== 'ok') return delivered
          bytesRead += chunk.byteLength
          chunksRead += 1
        }
        const finalStats = await runtime.call(
          'metadata',
          request,
          () => handle!.stat(),
          (pending) => {
            closeInBackground = true
            const abandoned = handle
            handle = undefined
            if (abandoned) void pending.then(() => abandoned.close().catch(() => {}))
          }
        )
        if (finalStats.status !== 'ok') return finalStats
        if (
          bytesRead !== version.size ||
          finalStats.value.size !== version.size ||
          finalStats.value.mtimeMs !== version.mtimeMs ||
          finalStats.value.ctimeMs !== version.ctimeMs ||
          finalStats.value.nlink !== initialStats.nlink ||
          finalStats.value.dev !== initialStats.dev ||
          finalStats.value.ino !== initialStats.ino
        )
          return { status: 'unavailable', code: 'SOURCE_CHANGED' }
        const finalPathStats = await runtime.call('metadata', request, () => runtime.fs.stat(real.value))
        if (finalPathStats.status !== 'ok') return finalPathStats
        if (
          finalPathStats.value.size !== version.size ||
          finalPathStats.value.mtimeMs !== version.mtimeMs ||
          finalPathStats.value.ctimeMs !== version.ctimeMs ||
          finalPathStats.value.dev !== initialStats.dev ||
          finalPathStats.value.ino !== initialStats.ino
        )
          return { status: 'unavailable', code: 'SOURCE_CHANGED' }
        if (await runtime.isSymlink(real.value, request)) return { status: 'unavailable', code: 'SOURCE_CHANGED' }
        return { status: 'ok', version, bytesRead, chunksRead }
      } finally {
        request.close()
        if (!closeInBackground) await handle?.close().catch(() => {})
      }
    } catch (error) {
      return runtime.failureOf(error)
    }
  }
}
