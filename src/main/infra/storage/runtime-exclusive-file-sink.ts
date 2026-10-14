import { close as closeFd, fstat as fstatFd, fsync as fsyncFd, write as writeFd, type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { sameRuntimeFileVersion } from './runtime-file-version'

export const MAX_RUNTIME_EXCLUSIVE_FILE_BYTES = 100_000_000_000
export const MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES = 1024 * 1024

export type RuntimeExclusiveFileReceipt =
  | { readonly status: 'created'; readonly path: string; readonly version: BigIntStats }
  | { readonly status: 'created-unconfirmed'; readonly path: string }

export interface RuntimeExclusiveFileSink {
  write(chunk: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<RuntimeExclusiveFileReceipt>
}

export interface RuntimeExclusiveFileCreation {
  readonly receipt: RuntimeExclusiveFileReceipt
  readonly sink: RuntimeExclusiveFileSink
  readonly parentVersion: BigIntStats | null
  readonly parentChildren: readonly string[] | null
}

function statFd(fd: number): Promise<BigIntStats> {
  return new Promise((resolveStat, rejectStat) => {
    fstatFd(fd, { bigint: true }, (error, value) => {
      if (error) rejectStat(error)
      else resolveStat(value)
    })
  })
}

function closeFdAsync(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    closeFd(fd, (error) => (error ? rejectClose(error) : resolveClose()))
  })
}

function syncFdAsync(fd: number): Promise<void> {
  return new Promise((resolveSync, rejectSync) => {
    fsyncFd(fd, (error) => (error ? rejectSync(error) : resolveSync()))
  })
}

function writeFdAsync(fd: number, chunk: Buffer, offset: number, length: number, position: number): Promise<number> {
  return new Promise((resolveWrite, rejectWrite) => {
    writeFd(fd, chunk, offset, length, position, (error, bytesWritten) => {
      if (error) rejectWrite(error)
      else resolveWrite(bytesWritten)
    })
  })
}

async function captureCreatedFileVersion(fd: number, path: string): Promise<BigIntStats> {
  const [opened, named] = await Promise.all([statFd(fd), lstat(path, { bigint: true })])
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    !sameRuntimeFileVersion(opened, named)
  ) {
    throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_UNCONFIRMED')
  }
  return opened
}

function sameStableDirectoryIdentity(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isDirectory() &&
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

export async function prepareRuntimeExclusiveFileSink(input: {
  readonly fd: number
  readonly path: string
  readonly parentPath: string
  readonly parentVersion: BigIntStats
  readonly expectedParentChildren: readonly string[]
  readonly name: string
  readonly maximumBytes: number
  readonly readDirectoryNames: (path: string, maxEntries: number) => Promise<string[]>
}): Promise<RuntimeExclusiveFileCreation> {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 0 ||
    input.maximumBytes > MAX_RUNTIME_EXCLUSIVE_FILE_BYTES
  ) {
    throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
  }
  let version: BigIntStats | null = null
  let parentVersion: BigIntStats | null = null
  let parentChildren: readonly string[] | null = null
  try {
    version = await captureCreatedFileVersion(input.fd, input.path)
    const currentParent = await lstat(input.parentPath, { bigint: true })
    if (!sameStableDirectoryIdentity(input.parentVersion, currentParent)) {
      throw new Error('RUNTIME_EXCLUSIVE_FILE_PARENT_CHANGED')
    }
    const children = await input.readDirectoryNames(input.parentPath, input.expectedParentChildren.length + 1)
    const expected = [...input.expectedParentChildren, input.name].sort()
    if ([...children].sort().join('\0') !== expected.join('\0')) {
      throw new Error('RUNTIME_EXCLUSIVE_FILE_PARENT_CHANGED')
    }
    parentVersion = currentParent
    parentChildren = children
  } catch {
    // The exclusive open succeeded; retain it as an unconfirmed receipt and never adopt the named replacement.
  }

  const initialReceipt: RuntimeExclusiveFileReceipt =
    version && parentVersion && parentChildren
      ? { status: 'created', path: input.path, version }
      : { status: 'created-unconfirmed', path: input.path }
  let currentVersion = version
  let position = version ? Number(version.size) : 0
  let closed = false
  let busy = false
  let invalidated = initialReceipt.status !== 'created'
  const close = async (): Promise<RuntimeExclusiveFileReceipt> => {
    if (closed)
      return invalidated || !currentVersion
        ? { status: 'created-unconfirmed', path: input.path }
        : { status: 'created', path: input.path, version: currentVersion }
    if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
    closed = true
    try {
      if (!invalidated && currentVersion) currentVersion = await captureCreatedFileVersion(input.fd, input.path)
      else invalidated = true
    } catch {
      invalidated = true
    }
    await closeFdAsync(input.fd)
    return !invalidated && currentVersion
      ? { status: 'created', path: input.path, version: currentVersion }
      : { status: 'created-unconfirmed', path: input.path }
  }
  const sink: RuntimeExclusiveFileSink = Object.freeze({
    async write(chunk: Uint8Array): Promise<void> {
      if (closed || invalidated || !currentVersion) throw new Error('RUNTIME_EXCLUSIVE_FILE_SINK_INVALID')
      if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
      if (
        chunk.byteLength > MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES ||
        position + chunk.byteLength > input.maximumBytes
      ) {
        throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
      }
      busy = true
      try {
        const before = await captureCreatedFileVersion(input.fd, input.path)
        if (!sameRuntimeFileVersion(currentVersion, before) || before.size !== BigInt(position)) {
          invalidated = true
          throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
        }
        const ownedChunk = Buffer.from(chunk)
        let written = 0
        while (written < ownedChunk.byteLength) {
          const count = await writeFdAsync(
            input.fd,
            ownedChunk,
            written,
            ownedChunk.byteLength - written,
            position + written
          )
          if (count <= 0) throw new Error('RUNTIME_EXCLUSIVE_FILE_ZERO_PROGRESS')
          written += count
        }
        const after = await captureCreatedFileVersion(input.fd, input.path)
        if (after.size !== BigInt(position + ownedChunk.byteLength)) {
          invalidated = true
          throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
        }
        currentVersion = after
        position += ownedChunk.byteLength
      } catch (error) {
        invalidated = true
        throw error
      } finally {
        busy = false
      }
    },
    async sync(): Promise<void> {
      if (closed || invalidated || !currentVersion) throw new Error('RUNTIME_EXCLUSIVE_FILE_SINK_INVALID')
      if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
      busy = true
      try {
        const before = await captureCreatedFileVersion(input.fd, input.path)
        if (!sameRuntimeFileVersion(currentVersion, before)) {
          invalidated = true
          throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
        }
        await syncFdAsync(input.fd)
        const after = await captureCreatedFileVersion(input.fd, input.path)
        if (!sameRuntimeFileVersion(before, after)) {
          invalidated = true
          throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
        }
        currentVersion = after
      } catch (error) {
        invalidated = true
        throw error
      } finally {
        busy = false
      }
    },
    close
  })
  return {
    receipt: initialReceipt,
    sink,
    parentVersion,
    parentChildren
  }
}
