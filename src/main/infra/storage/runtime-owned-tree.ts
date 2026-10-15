import { createHash, type Hash } from 'node:crypto'
import { type BigIntStats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { MAX_RUNTIME_EXCLUSIVE_FILE_BYTES, MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES } from './runtime-exclusive-file-sink'
import {
  createRuntimeDirectoryAfterAdmission,
  createRuntimeExclusiveFileAfterAdmission,
  prepareRuntimeDirectoryCreation,
  prepareRuntimeExclusiveFileCreation,
  prepareRuntimeEmptyDirectoryRemoval,
  prepareRuntimePhysicalAdmission,
  removeRuntimeOwnedFileAfterAdmission,
  removeRuntimeEmptyDirectoryAfterAdmission,
  renameRuntimeDirectorySyncAfterAdmission,
  type RuntimeDirectoryCreationReceipt,
  type RuntimeExclusiveFileCreation,
  type RuntimeExclusiveFileSink,
  type RuntimePhysicalAdmission,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import { sameRuntimeFileVersion } from './runtime-file-version'
import {
  ensureContained,
  identityRecord,
  makeRuntimeOwnedTreeManifest,
  readIssuedRuntimeOwnedTreeRecord,
  sameIdentityRecord,
  type AuthenticatedRuntimeOwnedTreeRecord,
  type RuntimeOwnedTreeEntry,
  type RuntimeOwnedTreeFileMutationResult,
  type RuntimeOwnedTreeFileSink,
  type RuntimeOwnedTreeIdentity,
  type RuntimeOwnedTreeWriter,
  type RuntimeOwnedTreeReceipt
} from './runtime-owned-tree-record'
import { registerRuntimeOwnedTreeReceipt, runtimeOwnedTreeReceipts } from './runtime-owned-tree-state'
import {
  consumeRuntimePayloadFilePin,
  runtimePayloadDirectoryAllowed,
  runtimePayloadPlanBudget,
  runtimePayloadPlanComplete,
  runtimePayloadPlanRoot,
  type RuntimePayloadFilePin,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import { runtimeTreeParentDetails, type RuntimeTreeParentPin } from './runtime-pack-namespace'
export type {
  AuthenticatedRuntimeOwnedTreeRecord,
  RuntimeOwnedTreeAuthenticatedInput,
  RuntimeOwnedTreeEntry,
  RuntimeOwnedTreeFileMutationResult,
  RuntimeOwnedTreeFileSink,
  RuntimeOwnedTreeIdentity,
  RuntimeOwnedTreeManifest,
  RuntimeOwnedTreeRecordBinding,
  RuntimeOwnedTreeRecordIssuer,
  RuntimeOwnedTreeWriter
} from './runtime-owned-tree-record'

const MAX_TREE_NODES = 4096

interface TreeDirectory {
  readonly path: string
  version: BigIntStats
  children: string[]
}

interface TreeFile {
  readonly path: string
  readonly targetPath: string
  readonly expectedByteLength: number
  readonly expectedSha256: string
  version: BigIntStats | null
  sink: RuntimeExclusiveFileSink | null
  sha256: string | null
}

interface TreeWriterState {
  readonly rootPath: string
  readonly parentPath: string
  readonly plan: RuntimePayloadWritePlan
  snapshot: RuntimePhysicalSnapshotInput
  readonly directories: Map<string, TreeDirectory>
  readonly files: Map<string, TreeFile>
  readonly sinks: Set<RuntimeOwnedTreeFileSink>
  accepting: boolean
  rootCreated: boolean
  disposed: boolean
  queued: Promise<void>
  operations: Set<Promise<unknown>>
  receipt: RuntimeOwnedTreeReceipt | null
}

function replaceSnapshotPath(
  snapshot: RuntimePhysicalSnapshotInput,
  path: string,
  version: BigIntStats
): RuntimePhysicalSnapshotInput {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (node.path === path ? { path, version } : node)),
    directories: snapshot.directories.map((directory) =>
      directory.path === path ? { ...directory, version } : directory
    )
  }
}

function updateDirectory(
  state: TreeWriterState,
  path: string,
  version: BigIntStats,
  children: readonly string[]
): void {
  const previous = state.directories.get(path)
  if (previous) {
    previous.version = version
    previous.children = [...children]
  }
  state.snapshot = replaceSnapshotPath(state.snapshot, path, version)
  state.snapshot = {
    ...state.snapshot,
    directories: state.snapshot.directories.map((directory) =>
      directory.path === path ? { ...directory, version, children: [...children] } : directory
    )
  }
}

function sameStableDirectoryVersion(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isDirectory() &&
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

function sameStableFileVersion(expected: BigIntStats, actual: BigIntStats): boolean {
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
    expected.size === actual.size &&
    expected.blocks === actual.blocks &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

function removeTrackedNode(state: TreeWriterState, path: string): void {
  state.snapshot = {
    ...state.snapshot,
    roots: state.snapshot.roots.filter((root) => root.path !== path),
    nodes: state.snapshot.nodes.filter((node) => node.path !== path),
    directories: state.snapshot.directories.filter((directory) => directory.path !== path)
  }
}

function replaceTrackedNode(state: TreeWriterState, source: string, destination: string, version: BigIntStats): void {
  const nodes = state.snapshot.nodes.filter((node) => node.path !== source && node.path !== destination)
  nodes.push({ path: destination, version })
  state.snapshot = { ...state.snapshot, roots: state.snapshot.roots.filter((root) => root.path !== destination), nodes }
}

function trackedSnapshot(state: TreeWriterState): RuntimePhysicalSnapshotInput {
  const nodes = [...state.snapshot.nodes]
  const directories = [...state.snapshot.directories]
  for (const directory of state.directories.values()) {
    const nodeIndex = nodes.findIndex((node) => node.path === directory.path)
    if (nodeIndex < 0) nodes.push({ path: directory.path, version: directory.version })
    else nodes[nodeIndex] = { path: directory.path, version: directory.version }
    const directoryIndex = directories.findIndex((value) => value.path === directory.path)
    const value = { path: directory.path, version: directory.version, children: [...directory.children] }
    if (directoryIndex < 0) directories.push(value)
    else directories[directoryIndex] = value
  }
  for (const file of state.files.values()) {
    if (!file.version) continue
    const index = nodes.findIndex((node) => node.path === file.path)
    const value = { path: file.path, version: file.version }
    if (index < 0) nodes.push(value)
    else nodes[index] = value
  }
  return { ...state.snapshot, nodes, directories }
}

function trackOperation<T>(state: TreeWriterState, operation: Promise<T>): Promise<T> {
  state.operations.add(operation)
  operation.finally(() => state.operations.delete(operation)).catch(() => undefined)
  return operation
}

function queueMutation<T>(state: TreeWriterState, action: () => Promise<T>): Promise<T> {
  if (!state.accepting || state.disposed) return Promise.reject(new Error('RUNTIME_TREE_WRITER_CLOSED'))
  const result = state.queued.then(action)
  state.queued = result.then(
    () => undefined,
    () => undefined
  )
  return trackOperation(state, result)
}

export async function prepareRuntimeOwnedTreeCreation(input: {
  readonly parentPin: RuntimeTreeParentPin
  readonly plan: RuntimePayloadWritePlan
  readonly assertCurrentSync: () => void
}): Promise<RuntimeOwnedTreeWriter> {
  const treeParent = runtimeTreeParentDetails(input.parentPin, input.plan, input.assertCurrentSync)
  const rootPath = resolve(treeParent.rootPath)
  const parentPath = resolve(treeParent.parentPath)
  if (rootPath !== treeParent.rootPath || parentPath !== treeParent.parentPath || dirname(rootPath) !== parentPath) {
    throw new Error('RUNTIME_TREE_ROOT_PATH_INVALID')
  }
  if (runtimePayloadPlanRoot(input.plan) !== relative(treeParent.namespaceRootPath, rootPath).split(sep).join('/')) {
    throw new Error('RUNTIME_TREE_PLAN_ROOT_MISMATCH')
  }
  const budget = runtimePayloadPlanBudget(input.plan)
  if (budget.fileCount + budget.directoryCount > MAX_TREE_NODES) throw new Error('RUNTIME_TREE_PLAN_LIMIT')
  const state: TreeWriterState = {
    rootPath,
    parentPath,
    plan: input.plan,
    snapshot: treeParent.parentSnapshot,
    directories: new Map(),
    files: new Map(),
    sinks: new Set(),
    accepting: true,
    rootCreated: false,
    disposed: false,
    queued: Promise.resolve(),
    operations: new Set(),
    receipt: null
  }
  const writer: RuntimeOwnedTreeWriter = Object.freeze({
    createRoot(): Promise<RuntimeDirectoryCreationReceipt> {
      return queueMutation(state, async () => {
        if (state.rootCreated) throw new Error('RUNTIME_TREE_ROOT_ALREADY_CREATED')
        const admission = await prepareRuntimeDirectoryCreation({
          path: rootPath,
          parentPath,
          snapshot: state.snapshot
        })
        const result = await createRuntimeDirectoryAfterAdmission(admission, treeParent.assertCurrentSync)
        if (result.status !== 'created') throw new Error('RUNTIME_TREE_ROOT_UNCONFIRMED')
        treeParent.acknowledgeRoot(result)
        state.rootCreated = true
        state.directories.set(rootPath, { path: rootPath, version: result.version, children: [] })
        updateDirectory(state, parentPath, result.parentVersion, result.parentChildren)
        state.snapshot = {
          ...trackedSnapshot(state),
          roots: [...state.snapshot.roots, { path: rootPath, identity: result.version }]
        }
        return result
      })
    },
    createDirectory(relativePath: string): Promise<RuntimeDirectoryCreationReceipt> {
      return queueMutation(state, async () => {
        assertTreeReady(state)
        if (!runtimePayloadDirectoryAllowed(state.plan, relativePath)) {
          throw new Error('RUNTIME_TREE_DIRECTORY_NOT_IN_PLAN')
        }
        const path = ensureContained(rootPath, relativePath)
        const parentPath = dirname(path)
        const parent = state.directories.get(parentPath)
        if (!parent || state.directories.has(path) || state.files.has(path))
          throw new Error('RUNTIME_TREE_PARENT_INVALID')
        const admission = await prepareRuntimeDirectoryCreation({ path, parentPath, snapshot: trackedSnapshot(state) })
        const result = await createRuntimeDirectoryAfterAdmission(admission, treeParent.assertCurrentSync)
        if (result.status !== 'created') throw new Error('RUNTIME_TREE_DIRECTORY_UNCONFIRMED')
        state.directories.set(path, { path, version: result.version, children: [] })
        updateDirectory(state, parentPath, result.parentVersion, result.parentChildren)
        return result
      })
    },
    createFile(pin: RuntimePayloadFilePin): Promise<RuntimeOwnedTreeFileSink> {
      return queueMutation(state, async () => {
        assertTreeReady(state)
        const admitted = consumeRuntimePayloadFilePin(state.plan, pin)
        const expectedByteLength = admitted.byteLength
        if (expectedByteLength > MAX_RUNTIME_EXCLUSIVE_FILE_BYTES) throw new Error('RUNTIME_TREE_FILE_SIZE_INVALID')
        const relativePath = `${admitted.path}.partial`
        const path = ensureContained(rootPath, relativePath)
        const parentPath = dirname(path)
        const parent = state.directories.get(parentPath)
        if (!parent || state.directories.has(path) || state.files.has(path))
          throw new Error('RUNTIME_TREE_PARENT_INVALID')
        const admission = await prepareRuntimeExclusiveFileCreation({
          path,
          parentPath,
          snapshot: trackedSnapshot(state)
        })
        const creation: RuntimeExclusiveFileCreation = await createRuntimeExclusiveFileAfterAdmission(
          admission,
          expectedByteLength,
          treeParent.assertCurrentSync
        )
        const file: TreeFile = {
          path,
          targetPath: admitted.path,
          expectedByteLength,
          expectedSha256: admitted.sha256,
          version: creation.receipt.status === 'created' ? creation.receipt.version : null,
          sink: creation.sink,
          sha256: null
        }
        state.files.set(path, file)
        if (creation.parentVersion)
          updateDirectory(state, parentPath, creation.parentVersion, creation.parentChildren ?? [])
        const hash: Hash = createHash('sha256')
        let closePromise: Promise<
          Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> & { readonly byteLength: number }
        > | null = null
        const wrapped: RuntimeOwnedTreeFileSink = Object.freeze({
          write(chunk: Uint8Array): Promise<void> {
            if (!state.accepting || state.disposed) return Promise.reject(new Error('RUNTIME_TREE_WRITER_CLOSED'))
            if (chunk.byteLength > MAX_RUNTIME_EXCLUSIVE_FILE_CHUNK_BYTES)
              return Promise.reject(new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT'))
            const ownedChunk = Buffer.from(chunk)
            return trackOperation(
              state,
              creation.sink.write(ownedChunk).then(() => {
                hash.update(ownedChunk)
              })
            )
          },
          sync(): Promise<void> {
            if (!state.accepting || state.disposed) return Promise.reject(new Error('RUNTIME_TREE_WRITER_CLOSED'))
            return trackOperation(state, creation.sink.sync())
          },
          close(): Promise<
            Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> & { readonly byteLength: number }
          > {
            if (closePromise) return closePromise
            closePromise = trackOperation(
              state,
              (async () => {
                const receipt = await creation.sink.close()
                state.sinks.delete(wrapped)
                if (receipt.status !== 'created') throw new Error('RUNTIME_TREE_FILE_UNCONFIRMED')
                file.version = receipt.version
                file.sink = null
                const sha256 = hash.digest('hex')
                file.sha256 = sha256
                const byteLength = Number(receipt.version.size)
                if (!Number.isSafeInteger(byteLength)) throw new Error('RUNTIME_TREE_FILE_SIZE_INVALID')
                if (byteLength !== file.expectedByteLength) throw new Error('RUNTIME_TREE_FILE_SIZE_MISMATCH')
                if (sha256 !== file.expectedSha256) throw new Error('RUNTIME_TREE_FILE_DIGEST_MISMATCH')
                return Object.freeze({
                  path: receipt.path
                    .slice(rootPath.length + 1)
                    .split(sep)
                    .join('/'),
                  kind: 'file',
                  identity: identityRecord(receipt.version),
                  sha256,
                  byteLength
                })
              })()
            )
            return closePromise
          }
        })
        state.sinks.add(wrapped)
        return wrapped
      })
    },
    renameFile(
      sourceRelativePath: string,
      destinationRelativePath: string,
      assertCurrentSync: () => void
    ): Promise<RuntimeOwnedTreeFileMutationResult> {
      return queueMutation(state, async () => {
        assertTreeReady(state)
        const source = ensureContained(rootPath, sourceRelativePath)
        const destination = ensureContained(rootPath, destinationRelativePath)
        const file = state.files.get(source)
        const destinationParent = state.directories.get(dirname(destination))
        if (
          !file?.version ||
          !file.sha256 ||
          file.sink ||
          destinationRelativePath !== file.targetPath ||
          !destinationParent ||
          state.files.has(destination) ||
          state.directories.has(destination)
        ) {
          throw new Error('RUNTIME_TREE_FILE_MOVE_INVALID')
        }
        const sourceParentPath = dirname(source)
        const destinationParentPath = dirname(destination)
        const sourceParent = state.directories.get(sourceParentPath)
        if (!sourceParent) throw new Error('RUNTIME_TREE_FILE_MOVE_INVALID')
        const snapshot = trackedSnapshot(state)
        const physical = await prepareRuntimePhysicalAdmission({
          ...snapshot,
          roots: [...snapshot.roots, { path: destination, mustBeAbsent: true }]
        })
        try {
          renameRuntimeDirectorySyncAfterAdmission({
            admission: physical,
            source,
            destination,
            assertCallerCurrentSync: () => treeParent.assertCurrentSync(assertCurrentSync)
          })
        } catch (error) {
          await physical.dispose()
          throw error
        }
        try {
          const [movedVersion, sourceParentVersion, destinationParentVersion] = await Promise.all([
            lstat(destination, { bigint: true }),
            lstat(sourceParentPath, { bigint: true }),
            sourceParentPath === destinationParentPath
              ? lstat(sourceParentPath, { bigint: true })
              : lstat(destinationParentPath, { bigint: true })
          ])
          if (
            !sameStableFileVersion(file.version, movedVersion) ||
            !sameStableDirectoryVersion(sourceParent.version, sourceParentVersion) ||
            !sameStableDirectoryVersion(destinationParent.version, destinationParentVersion)
          ) {
            state.accepting = false
            return { status: 'moved-unconfirmed' }
          }
          const expectedSource = sourceParent.children.filter(
            (name) => name !== source.slice(sourceParentPath.length + 1)
          )
          if (sourceParentPath === destinationParentPath)
            expectedSource.push(destination.slice(destinationParentPath.length + 1))
          const actualSource = await readExactDirectoryNames(sourceParentPath, sourceParent.children.length)
          if ([...actualSource].sort().join('\0') !== [...expectedSource].sort().join('\0')) {
            state.accepting = false
            return { status: 'moved-unconfirmed' }
          }
          let actualDestination = actualSource
          if (sourceParentPath !== destinationParentPath) {
            const expectedDestination = [
              ...destinationParent.children,
              destination.slice(destinationParentPath.length + 1)
            ]
            actualDestination = await readExactDirectoryNames(destinationParentPath, expectedDestination.length)
            if ([...actualDestination].sort().join('\0') !== [...expectedDestination].sort().join('\0')) {
              state.accepting = false
              return { status: 'moved-unconfirmed' }
            }
          }
          updateDirectory(state, sourceParentPath, sourceParentVersion, actualSource)
          if (sourceParentPath !== destinationParentPath) {
            updateDirectory(state, destinationParentPath, destinationParentVersion, actualDestination)
          }
          replaceTrackedNode(state, source, destination, movedVersion)
          state.files.delete(source)
          state.files.set(destination, {
            path: destination,
            targetPath: file.targetPath,
            expectedByteLength: file.expectedByteLength,
            expectedSha256: file.expectedSha256,
            version: movedVersion,
            sink: null,
            sha256: file.sha256
          })
          const entry = Object.freeze({
            path: destination
              .slice(rootPath.length + 1)
              .split(sep)
              .join('/'),
            kind: 'file' as const,
            identity: identityRecord(movedVersion),
            sha256: file.sha256
          })
          return { status: 'moved', entry }
        } catch {
          state.accepting = false
          return { status: 'moved-unconfirmed' }
        } finally {
          await physical.dispose()
        }
      })
    },
    removeFile(relativePath: string, assertCurrentSync: () => void): Promise<{ readonly removed: true }> {
      return queueMutation(state, async () => {
        const path = ensureContained(rootPath, relativePath)
        const file = state.files.get(path)
        if (!file?.version || file.sink) throw new Error('RUNTIME_TREE_FILE_REMOVE_INVALID')
        const parentPath = dirname(path)
        const parent = state.directories.get(parentPath)
        if (!parent) throw new Error('RUNTIME_TREE_FILE_REMOVE_INVALID')
        await removeRuntimeOwnedFileAfterAdmission({
          path,
          expected: file.version,
          snapshot: trackedSnapshot(state),
          assertCallerCurrentSync: () => treeParent.assertCurrentSync(assertCurrentSync)
        })
        try {
          const [parentVersion, children] = await Promise.all([
            lstat(parentPath, { bigint: true }),
            readExactDirectoryNames(parentPath, Math.max(0, parent.children.length - 1))
          ])
          const expected = parent.children.filter((name) => name !== path.slice(parentPath.length + 1))
          if (
            !sameStableDirectoryVersion(parent.version, parentVersion) ||
            [...children].sort().join('\0') !== [...expected].sort().join('\0')
          ) {
            state.accepting = false
            throw new Error('RUNTIME_TREE_FILE_REMOVE_UNCONFIRMED')
          }
          updateDirectory(state, parentPath, parentVersion, children)
          removeTrackedNode(state, path)
          state.files.delete(path)
          return { removed: true }
        } catch (error) {
          state.accepting = false
          throw error
        }
      })
    },
    removeEmptyDirectory(relativePath: string, assertCurrentSync: () => void): Promise<{ readonly removed: true }> {
      return queueMutation(state, async () => {
        const path = ensureContained(rootPath, relativePath)
        const directory = state.directories.get(path)
        const parentPath = dirname(path)
        const parent =
          state.directories.get(parentPath) ?? state.snapshot.directories.find((item) => item.path === parentPath)
        if (!directory || directory.children.length || !parent) throw new Error('RUNTIME_TREE_DIRECTORY_REMOVE_INVALID')
        const snapshot = trackedSnapshot(state)
        const admission = await prepareRuntimeEmptyDirectoryRemoval({
          path,
          parentPath,
          snapshot: {
            ...snapshot,
            roots: [...snapshot.roots, { path, identity: directory.version }]
          }
        })
        await removeRuntimeEmptyDirectoryAfterAdmission(admission, () =>
          treeParent.assertCurrentSync(assertCurrentSync)
        )
        try {
          const [parentVersion, children] = await Promise.all([
            lstat(parentPath, { bigint: true }),
            readExactDirectoryNames(parentPath, Math.max(0, parent.children.length - 1))
          ])
          const expected = parent.children.filter((name) => name !== path.slice(parentPath.length + 1))
          if (
            !sameStableDirectoryVersion(parent.version, parentVersion) ||
            [...children].sort().join('\0') !== [...expected].sort().join('\0')
          ) {
            state.accepting = false
            throw new Error('RUNTIME_TREE_DIRECTORY_REMOVE_UNCONFIRMED')
          }
          updateDirectory(state, parentPath, parentVersion, children)
          state.directories.delete(path)
          removeTrackedNode(state, path)
          return { removed: true }
        } catch (error) {
          state.accepting = false
          throw error
        }
      })
    },
    removeRoot(assertCurrentSync: () => void): Promise<{ readonly removed: true }> {
      return queueMutation(state, async () => {
        const root = state.directories.get(rootPath)
        const parentPath = dirname(rootPath)
        const parent = state.snapshot.directories.find((item) => item.path === parentPath)
        if (!root || root.children.length || state.files.size || state.directories.size !== 1 || !parent) {
          throw new Error('RUNTIME_TREE_ROOT_REMOVE_INVALID')
        }
        const admission = await prepareRuntimeEmptyDirectoryRemoval({
          path: rootPath,
          parentPath,
          snapshot: trackedSnapshot(state)
        })
        await removeRuntimeEmptyDirectoryAfterAdmission(admission, () =>
          treeParent.assertCurrentSync(assertCurrentSync)
        )
        try {
          const [parentVersion, children] = await Promise.all([
            lstat(parentPath, { bigint: true }),
            readExactDirectoryNames(parentPath, Math.max(0, parent.children.length - 1))
          ])
          const expected = parent.children.filter((name) => name !== rootPath.slice(parentPath.length + 1))
          const parentVersionBefore = state.snapshot.nodes.find((node) => node.path === parentPath)?.version
          if (
            !parentVersionBefore ||
            !sameStableDirectoryVersion(parentVersionBefore, parentVersion) ||
            [...children].sort().join('\0') !== [...expected].sort().join('\0')
          ) {
            state.accepting = false
            throw new Error('RUNTIME_TREE_ROOT_REMOVE_UNCONFIRMED')
          }
          updateDirectory(state, parentPath, parentVersion, children)
          state.directories.clear()
          state.rootCreated = false
          removeTrackedNode(state, rootPath)
          return { removed: true }
        } catch (error) {
          state.accepting = false
          throw error
        }
      })
    },
    async seal(): Promise<RuntimeOwnedTreeReceipt> {
      if (!state.accepting || state.disposed) throw new Error('RUNTIME_TREE_WRITER_CLOSED')
      state.accepting = false
      await Promise.allSettled([...state.operations])
      await state.queued
      const closeResults = await Promise.allSettled([...state.sinks].map((sink) => sink.close()))
      if (closeResults.some((result) => result.status === 'rejected'))
        throw new Error('RUNTIME_TREE_WRITER_SETTLEMENT_FAILED')
      const planBudget = runtimePayloadPlanBudget(state.plan)
      if (state.files.size !== planBudget.fileCount || state.directories.size !== planBudget.directoryCount + 1) {
        throw new Error('RUNTIME_TREE_PLAN_INCOMPLETE')
      }
      for (const [path, file] of state.files) {
        if (file.sink !== null || !file.version) throw new Error('RUNTIME_TREE_WRITER_INCOMPLETE')
        if (file.path !== path) throw new Error('RUNTIME_TREE_WRITER_INCOMPLETE')
        if (file.version.size !== BigInt(file.expectedByteLength)) throw new Error('RUNTIME_TREE_FILE_SIZE_MISMATCH')
      }
      if (!runtimePayloadPlanComplete(state.plan)) throw new Error('RUNTIME_TREE_PLAN_INCOMPLETE')
      assertTreeReady(state)
      const snapshot = trackedSnapshot(state)
      const fileDigests = new Map(
        [...state.files.values()].map((file) => {
          if (!file.sha256) throw new Error('RUNTIME_TREE_DIGEST_MISSING')
          return [file.path, file.sha256] as const
        })
      )
      const manifest = makeRuntimeOwnedTreeManifest(rootPath, snapshot, fileDigests)
      const physical = await prepareRuntimePhysicalAdmission(snapshot)
      try {
        treeParent.assertCurrentSync()
      } catch (error) {
        await physical.dispose()
        throw error
      }
      const receipt = Object.freeze({ manifest }) as RuntimeOwnedTreeReceipt
      registerRuntimeOwnedTreeReceipt(receipt, {
        rootPath,
        snapshot,
        manifest,
        physical,
        disposed: false,
        consumed: false
      })
      state.receipt = receipt
      return receipt
    },
    async dispose(): Promise<void> {
      if (state.disposed) return
      state.accepting = false
      state.disposed = true
      await Promise.allSettled([...state.operations])
      await Promise.allSettled([...state.sinks].map((sink) => sink.close()))
      if (state.receipt) await disposeRuntimeOwnedTreeReceipt(state.receipt)
    }
  })
  return writer
}

function assertTreeReady(state: TreeWriterState): void {
  if (!state.rootCreated || !state.directories.has(state.rootPath)) throw new Error('RUNTIME_TREE_ROOT_NOT_CREATED')
}

export async function disposeRuntimeOwnedTreeReceipt(receipt: RuntimeOwnedTreeReceipt): Promise<void> {
  const state = runtimeOwnedTreeReceipts.get(receipt as object)
  if (!state || state.disposed) return
  state.disposed = true
  await state.physical.dispose()
}

export async function prepareRuntimeOwnedTreeReopen(input: {
  readonly rootPath: string
  readonly rootBinding: string
  readonly profileBinding: string
  readonly principalBinding: string
  readonly record: AuthenticatedRuntimeOwnedTreeRecord
  readonly assertCurrentSync: () => void
}): Promise<RuntimeOwnedTreeReceipt> {
  const issued = readIssuedRuntimeOwnedTreeRecord(input.record)
  if (
    issued.binding.rootBinding !== input.rootBinding ||
    issued.binding.rootPath !== input.rootPath ||
    issued.binding.profileBinding !== input.profileBinding ||
    issued.binding.principalBinding !== input.principalBinding
  ) {
    throw new Error('RUNTIME_TREE_ROOT_BINDING_INVALID')
  }
  const rootPath = resolve(input.rootPath)
  if (rootPath !== input.rootPath) throw new Error('RUNTIME_TREE_ROOT_PATH_INVALID')
  const rootVersion = await lstat(rootPath, { bigint: true })
  if (
    !rootVersion.isDirectory() ||
    rootVersion.isSymbolicLink() ||
    !sameIdentityRecord(issued.manifest.root, rootVersion)
  ) {
    throw new Error('RUNTIME_TREE_ROOT_CHANGED')
  }
  const nodes: { path: string; version: BigIntStats }[] = [{ path: rootPath, version: rootVersion }]
  const directories: { path: string; version: BigIntStats; children: readonly string[] }[] = [
    { path: rootPath, version: rootVersion, children: [] }
  ]
  const actualChildSets = new Map<string, string[]>([[rootPath, []]])
  for (const entry of issued.manifest.entries) {
    const path = ensureContained(rootPath, entry.path)
    const version = await lstat(path, { bigint: true })
    if (entry.kind === 'directory') {
      if (!version.isDirectory() || version.isSymbolicLink() || !sameIdentityRecord(entry.identity, version)) {
        throw new Error('RUNTIME_TREE_NODE_CHANGED')
      }
      nodes.push({ path, version })
      actualChildSets.set(path, [])
    } else {
      if (
        !version.isFile() ||
        version.isSymbolicLink() ||
        version.nlink !== 1n ||
        !sameIdentityRecord(entry.identity, version)
      ) {
        throw new Error('RUNTIME_TREE_NODE_CHANGED')
      }
      nodes.push({ path, version })
    }
    const parent = dirname(path)
    const names = actualChildSets.get(parent)
    if (!names) throw new Error('RUNTIME_TREE_RECORD_INVALID')
    names.push(path.slice(parent.length + 1))
  }
  for (const entry of issued.manifest.entries) {
    if (entry.kind !== 'directory') continue
    const path = ensureContained(rootPath, entry.path)
    const expected = [...entry.children].sort()
    const actual = [...(actualChildSets.get(path) ?? [])].sort()
    if (expected.join('\0') !== actual.join('\0')) throw new Error('RUNTIME_TREE_RECORD_INVALID')
    directories.push({ path, version: nodes.find((node) => node.path === path)!.version, children: expected })
  }
  const rootChildren = [...(actualChildSets.get(rootPath) ?? [])].sort()
  directories[0] = { ...directories[0], children: rootChildren }
  const parentPath = dirname(rootPath)
  const parentVersion = await lstat(parentPath, { bigint: true })
  if (!sameStableIdentityRecord(issued.manifest.rootParent, parentVersion)) throw new Error('RUNTIME_TREE_ROOT_CHANGED')
  const parentNames = await readExactDirectoryNames(parentPath, MAX_TREE_NODES)
  const rootName = rootPath.slice(parentPath.length + 1)
  if (!parentNames.includes(rootName)) throw new Error('RUNTIME_TREE_ROOT_CHANGED')
  nodes.push({ path: parentPath, version: parentVersion })
  directories.push({ path: parentPath, version: parentVersion, children: parentNames })
  const snapshot: RuntimePhysicalSnapshotInput = {
    roots: [{ path: rootPath, identity: rootVersion }],
    nodes,
    directories
  }
  const physical = await prepareRuntimePhysicalAdmission(snapshot)
  try {
    input.assertCurrentSync()
  } catch (error) {
    await physical.dispose()
    throw error
  }
  const receipt = Object.freeze({ manifest: issued.manifest }) as RuntimeOwnedTreeReceipt
  registerRuntimeOwnedTreeReceipt(receipt, {
    rootPath,
    snapshot,
    manifest: issued.manifest,
    physical,
    disposed: false,
    consumed: false
  })
  return receipt
}

async function readExactDirectoryNames(path: string, maximum: number): Promise<string[]> {
  const handle = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await handle.read()
      if (!entry) return names
      if (names.length >= maximum) throw new Error('RUNTIME_TREE_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await handle.close()
  }
}

function sameStableIdentityRecord(expected: RuntimeOwnedTreeIdentity, actual: BigIntStats): boolean {
  const identity = identityRecord(actual)
  return expected.dev === identity.dev && expected.ino === identity.ino && expected.birthtimeNs === identity.birthtimeNs
}

export { commitRuntimeOwnedTreeMove, prepareRuntimeOwnedTreeMove } from './runtime-owned-tree-move'
export type { RuntimeOwnedTreeMoveAdmission, RuntimeOwnedTreeMoveResult } from './runtime-owned-tree-move'
