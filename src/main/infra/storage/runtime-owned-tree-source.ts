import { createHash, type Hash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { prepareRuntimePhysicalAdmission, type RuntimePhysicalSnapshotInput } from './runtime-owned-files'
import { MAX_RUNTIME_EXCLUSIVE_FILE_BYTES, MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES } from './runtime-exclusive-file-sink'
import {
  ensureContained,
  sameIdentityRecord,
  type RuntimeOwnedTreeEntry,
  type RuntimeOwnedTreeReceipt
} from './runtime-owned-tree-record'
import { runtimeOwnedTreeReceipts } from './runtime-owned-tree-state'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

export interface RuntimeOwnedTreeFileSource {
  read(): Promise<Uint8Array | null>
  dispose(): Promise<void>
}

interface SourceState {
  readonly file: FileHandle
  readonly path: string
  readonly identity: Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }>['identity']
  readonly byteLength: number
  readonly sha256: string
  readonly assertCurrentSync: () => void
  readonly snapshot: RuntimePhysicalSnapshotInput
  readonly hash: Hash
  position: number
  busy: boolean
  closed: boolean
  verified: boolean
}

async function assertSourceVersion(state: SourceState): Promise<void> {
  const [opened, named] = await Promise.all([state.file.stat({ bigint: true }), lstat(state.path, { bigint: true })])
  if (
    !opened.isFile() ||
    opened.isSymbolicLink() ||
    opened.nlink !== 1n ||
    !sameIdentityRecord(state.identity, opened) ||
    !sameIdentityRecord(state.identity, named)
  ) {
    throw new Error('RUNTIME_TREE_SOURCE_CHANGED')
  }
}

export async function openRuntimeOwnedTreeFileSource(input: {
  readonly receipt: RuntimeOwnedTreeReceipt
  readonly relativePath: string
  readonly assertCurrentSync: () => void
}): Promise<RuntimeOwnedTreeFileSource> {
  const receipt = runtimeOwnedTreeReceipts.get(input.receipt as object)
  if (!receipt || receipt.disposed || receipt.consumed) throw new Error('RUNTIME_TREE_RECEIPT_INVALID')
  const entry = receipt.manifest.entries.find(
    (candidate): candidate is Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> =>
      candidate.kind === 'file' && candidate.path === input.relativePath
  )
  if (!entry) throw new Error('RUNTIME_TREE_SOURCE_NOT_PINNED')
  const byteLength = Number(entry.identity.size)
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_RUNTIME_EXCLUSIVE_FILE_BYTES) {
    throw new Error('RUNTIME_TREE_SOURCE_LIMIT')
  }
  const path = ensureContained(receipt.rootPath, input.relativePath)
  input.assertCurrentSync()
  const file = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const [opened, named] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      !sameIdentityRecord(entry.identity, opened) ||
      !sameIdentityRecord(entry.identity, named)
    ) {
      throw new Error('RUNTIME_TREE_SOURCE_CHANGED')
    }
    const physical = await prepareRuntimePhysicalAdmission(receipt.snapshot)
    try {
      input.assertCurrentSync()
      physical.assertCurrentSync()
    } finally {
      await physical.dispose()
    }
    const state: SourceState = {
      file,
      path,
      identity: entry.identity,
      byteLength,
      sha256: entry.sha256,
      assertCurrentSync: input.assertCurrentSync,
      snapshot: receipt.snapshot,
      hash: createHash('sha256'),
      position: 0,
      busy: false,
      closed: false,
      verified: false
    }
    return Object.freeze({
      async read(): Promise<Uint8Array | null> {
        if (state.closed || state.verified) return null
        if (state.busy) throw new Error('RUNTIME_TREE_SOURCE_READ_IN_PROGRESS')
        state.busy = true
        try {
          state.assertCurrentSync()
          const physical = await prepareRuntimePhysicalAdmission(state.snapshot)
          try {
            state.assertCurrentSync()
            physical.assertCurrentSync()
          } finally {
            await physical.dispose()
          }
          await assertSourceVersion(state)
          if (state.position === state.byteLength) {
            if (state.hash.digest('hex') !== state.sha256) throw new Error('RUNTIME_TREE_SOURCE_DIGEST_MISMATCH')
            state.verified = true
            await file.close()
            state.closed = true
            return null
          }
          const buffer = Buffer.alloc(
            Math.min(MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES, state.byteLength - state.position)
          )
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, state.position)
          if (bytesRead <= 0) throw new Error('RUNTIME_TREE_SOURCE_TRUNCATED')
          const chunk = buffer.subarray(0, bytesRead)
          state.position += bytesRead
          state.hash.update(chunk)
          await assertSourceVersion(state)
          const afterRead = await prepareRuntimePhysicalAdmission(state.snapshot)
          try {
            state.assertCurrentSync()
            afterRead.assertCurrentSync()
          } finally {
            await afterRead.dispose()
          }
          return Uint8Array.from(chunk)
        } catch (error) {
          await file.close().catch(() => undefined)
          state.closed = true
          throw error
        } finally {
          state.busy = false
        }
      },
      async dispose(): Promise<void> {
        if (state.closed) return
        if (state.busy) throw new Error('RUNTIME_TREE_SOURCE_READ_IN_PROGRESS')
        state.closed = true
        await file.close()
      }
    })
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
}
