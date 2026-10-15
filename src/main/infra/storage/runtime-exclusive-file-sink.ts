import { createHash } from 'node:crypto'
import {
  close as closeFd,
  fstat as fstatFd,
  fsync as fsyncFd,
  read as readFd,
  write as writeFd,
  type BigIntStats
} from 'node:fs'
import { lstat } from 'node:fs/promises'
import { sameRuntimeFileVersion } from './runtime-file-version'

export const MAX_RUNTIME_EXCLUSIVE_FILE_BYTES = 100_000_000_000
export const MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES = 1024 * 1024

export type RuntimeExclusiveFileReceipt =
  | { readonly status: 'created'; readonly path: string; readonly version: BigIntStats }
  | { readonly status: 'created-unconfirmed'; readonly path: string }

export interface RuntimeExclusiveFileSink {
  write(chunk: Uint8Array): Promise<void>
  writeOwned(chunk: Uint8Array, assertCurrentSync: () => void): Promise<RuntimeExclusiveFileWriteAck>
  checkpointOwned(
    assertCustodyCurrentSync: () => void,
    maximumReadBytes: number
  ): Promise<RuntimeExclusiveFileCheckpoint>
  readback(
    maximumBytes: number,
    assertCurrentSync?: () => void
  ): Promise<{ readonly byteLength: number; readonly sha256: string }>
  sync(): Promise<void>
  syncOwned(assertCurrentSync: () => void): Promise<void>
  close(): Promise<RuntimeExclusiveFileReceipt>
}

export interface RuntimeExclusiveFileCheckpoint {
  readonly version: BigIntStats
  readonly byteLength: number
  readonly sha256: string
}

export interface RuntimeExclusiveFileWriteAck {
  readonly version: BigIntStats
  readonly byteLength: number
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

function sameStableFileOwner(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isFile() &&
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode &&
    expected.nlink === actual.nlink &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid &&
    expected.rdev === actual.rdev &&
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
  let closePromise: Promise<RuntimeExclusiveFileReceipt> | null = null
  const close = (): Promise<RuntimeExclusiveFileReceipt> => {
    if (closePromise) return closePromise
    if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
    closed = true
    closePromise = (async () => {
      try {
        if (!invalidated && currentVersion) {
          const beforeClose = currentVersion
          const afterClose = await captureCreatedFileVersion(input.fd, input.path)
          if (sameRuntimeFileVersion(beforeClose, afterClose)) currentVersion = afterClose
          else invalidated = true
        } else invalidated = true
      } catch {
        invalidated = true
      }
      await closeFdAsync(input.fd)
      return !invalidated && currentVersion
        ? { status: 'created', path: input.path, version: currentVersion }
        : { status: 'created-unconfirmed', path: input.path }
    })()
    return closePromise
  }
  const writeOwned = async (
    chunk: Uint8Array,
    assertCurrentSync: () => void
  ): Promise<RuntimeExclusiveFileWriteAck> => {
    if (closed || invalidated || !currentVersion) throw new Error('RUNTIME_EXCLUSIVE_FILE_SINK_INVALID')
    if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength > MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES ||
      position + chunk.byteLength > input.maximumBytes
    ) {
      throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
    }
    const ownedChunk = Buffer.from(chunk)
    busy = true
    let physicallyUncertain = false
    try {
      assertCurrentSync()
      const before = await captureCreatedFileVersion(input.fd, input.path)
      if (!sameRuntimeFileVersion(currentVersion, before) || before.size !== BigInt(position)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      assertCurrentSync()
      let written = 0
      while (written < ownedChunk.byteLength) {
        assertCurrentSync()
        const remaining = ownedChunk.byteLength - written
        physicallyUncertain = true
        const count = await writeFdAsync(input.fd, ownedChunk, written, remaining, position)
        if (count === 0) throw new Error('RUNTIME_EXCLUSIVE_FILE_ZERO_PROGRESS')
        if (!Number.isSafeInteger(count) || count < 0 || count > remaining)
          throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_COUNT_INVALID')
        written += count
        position += count
        const afterWrite = await captureCreatedFileVersion(input.fd, input.path)
        if (!sameStableFileOwner(currentVersion!, afterWrite) || afterWrite.size !== BigInt(position))
          throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
        currentVersion = afterWrite
        physicallyUncertain = false
        assertCurrentSync()
      }
      assertCurrentSync()
      const after = await captureCreatedFileVersion(input.fd, input.path)
      if (!sameRuntimeFileVersion(currentVersion, after) || after.size !== BigInt(position)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      currentVersion = after
      assertCurrentSync()
      return { version: after, byteLength: position }
    } catch (error) {
      if (physicallyUncertain) invalidated = true
      throw error
    } finally {
      busy = false
    }
  }
  const checkpointOwned = async (
    assertCurrentSync: () => void,
    maximumReadBytes: number
  ): Promise<RuntimeExclusiveFileCheckpoint> => {
    if (closed || invalidated || !currentVersion) throw new Error('RUNTIME_EXCLUSIVE_FILE_SINK_INVALID')
    if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
    if (!Number.isSafeInteger(maximumReadBytes) || maximumReadBytes < 1 || maximumReadBytes > 64 * 1024) {
      throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
    }
    busy = true
    let physicalPending = false
    try {
      assertCurrentSync()
      physicalPending = true
      const before = await captureCreatedFileVersion(input.fd, input.path)
      physicalPending = false
      if (!sameRuntimeFileVersion(currentVersion, before) || before.size !== BigInt(position)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      assertCurrentSync()
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(maximumReadBytes)
      let offset = 0
      while (offset <= position) {
        assertCurrentSync()
        const amount = Math.min(buffer.length, Math.max(1, position - offset))
        physicalPending = true
        const read = await new Promise<number>((resolveRead, rejectRead) => {
          readFd(input.fd, buffer, 0, amount, offset, (error, bytesRead) =>
            error ? rejectRead(error) : resolveRead(bytesRead)
          )
        })
        physicalPending = false
        if (!Number.isSafeInteger(read) || read < 0 || read > amount)
          throw new Error('RUNTIME_EXCLUSIVE_FILE_READ_COUNT_INVALID')
        if (offset === position) {
          if (read !== 0) throw new Error('RUNTIME_EXCLUSIVE_FILE_READBACK_TRAILING_BYTES')
          break
        }
        if (read === 0) throw new Error('RUNTIME_EXCLUSIVE_FILE_READBACK_EOF')
        hash.update(buffer.subarray(0, read))
        offset += read
        assertCurrentSync()
      }
      assertCurrentSync()
      physicalPending = true
      const after = await captureCreatedFileVersion(input.fd, input.path)
      physicalPending = false
      if (!sameRuntimeFileVersion(before, after) || after.size !== BigInt(position)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      currentVersion = after
      assertCurrentSync()
      return { version: after, byteLength: offset, sha256: hash.digest('hex') }
    } catch (error) {
      if (physicalPending) invalidated = true
      throw error
    } finally {
      busy = false
    }
  }
  const syncOwned = async (assertCurrentSync: () => void): Promise<void> => {
    if (closed || invalidated || !currentVersion) throw new Error('RUNTIME_EXCLUSIVE_FILE_SINK_INVALID')
    if (busy) throw new Error('RUNTIME_EXCLUSIVE_FILE_WRITE_IN_PROGRESS')
    busy = true
    let syncPending = false
    try {
      assertCurrentSync()
      const before = await captureCreatedFileVersion(input.fd, input.path)
      if (!sameRuntimeFileVersion(currentVersion, before)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      assertCurrentSync()
      syncPending = true
      await syncFdAsync(input.fd)
      syncPending = false
      assertCurrentSync()
      const after = await captureCreatedFileVersion(input.fd, input.path)
      if (!sameRuntimeFileVersion(before, after)) {
        invalidated = true
        throw new Error('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      }
      currentVersion = after
      assertCurrentSync()
    } catch (error) {
      if (syncPending) invalidated = true
      throw error
    } finally {
      busy = false
    }
  }
  const sink: RuntimeExclusiveFileSink = Object.freeze({
    async write(chunk: Uint8Array): Promise<void> {
      await writeOwned(chunk, () => undefined)
    },
    writeOwned,
    checkpointOwned,
    async readback(maximumBytes: number, assertCurrentSync: () => void = () => undefined) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < position || maximumBytes > input.maximumBytes)
        throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
      const { byteLength, sha256 } = await checkpointOwned(assertCurrentSync, 64 * 1024)
      return { byteLength, sha256 }
    },
    async sync(): Promise<void> {
      await syncOwned(() => undefined)
    },
    syncOwned,
    close
  })
  return {
    receipt: initialReceipt,
    sink,
    parentVersion,
    parentChildren
  }
}
