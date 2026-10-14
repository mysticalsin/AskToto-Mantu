import type { BigIntStats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  prepareRuntimePhysicalAdmission,
  renameRuntimeDirectorySyncAfterAdmission,
  type RuntimePhysicalAdmission,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import { sameRuntimeFileVersion } from './runtime-file-version'
import {
  makeRuntimeOwnedTreeManifest,
  type RuntimeOwnedTreeManifest,
  type RuntimeOwnedTreeReceipt
} from './runtime-owned-tree-record'
import {
  registerRuntimeOwnedTreeReceipt,
  runtimeOwnedTreeReceipts,
  type RuntimeOwnedTreeReceiptState
} from './runtime-owned-tree-state'

const treeMoves = new WeakMap<object, TreeMoveState>()

interface TreeMoveState {
  readonly receipt: RuntimeOwnedTreeReceiptState
  readonly snapshot: RuntimePhysicalSnapshotInput
  readonly destination: string
  readonly admission: RuntimePhysicalAdmission
  disposed: boolean
  consumed: boolean
}

export interface RuntimeOwnedTreeMoveAdmission {
  dispose(): Promise<void>
}

export type RuntimeOwnedTreeMoveResult =
  | { readonly status: 'moved'; readonly receipt: RuntimeOwnedTreeReceipt }
  | { readonly status: 'moved-unconfirmed' }

export async function prepareRuntimeOwnedTreeMove(input: {
  readonly receipt: RuntimeOwnedTreeReceipt
  readonly destination: string
  readonly destinationParentSnapshot: RuntimePhysicalSnapshotInput
  readonly assertCallerCurrentSync: () => void
}): Promise<RuntimeOwnedTreeMoveAdmission> {
  const sourceState = runtimeOwnedTreeReceipts.get(input.receipt as object)
  if (!sourceState || sourceState.disposed || sourceState.consumed) throw new Error('RUNTIME_TREE_RECEIPT_INVALID')
  const destination = resolve(input.destination)
  if (
    destination !== input.destination ||
    destination === sourceState.rootPath ||
    destination.startsWith(`${sourceState.rootPath}${sep}`)
  ) {
    throw new Error('RUNTIME_TREE_DESTINATION_INVALID')
  }
  const sourceParent = dirname(sourceState.rootPath)
  const destinationParent = dirname(destination)
  const merged = mergeSnapshots(sourceState.snapshot, input.destinationParentSnapshot)
  const sourceParentSnapshot = merged.directories.find((directory) => directory.path === sourceParent)
  const destinationParentSnapshot = merged.directories.find((directory) => directory.path === destinationParent)
  const sourceName = sourceState.rootPath.slice(sourceParent.length + 1)
  const destinationName = destination.slice(destinationParent.length + 1)
  if (
    !sourceParentSnapshot?.children.includes(sourceName) ||
    !destinationParentSnapshot ||
    (sourceParent === destinationParent
      ? destinationParentSnapshot.children.includes(destinationName) && destinationName !== sourceName
      : destinationParentSnapshot.children.includes(destinationName))
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_INVALID')
  }
  const directories = merged.directories.map((directory) => {
    if (directory.path === sourceParent) return { ...directory, children: [...directory.children] }
    return directory
  })
  const target = { ...merged, directories, roots: [...merged.roots, { path: destination, mustBeAbsent: true }] }
  if (
    !target.directories.some((directory) => directory.path === sourceParent) ||
    !target.directories.some((directory) => directory.path === destinationParent)
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_INVALID')
  }
  const admission = await prepareRuntimePhysicalAdmission(target)
  input.assertCallerCurrentSync()
  const state: TreeMoveState = {
    receipt: sourceState,
    destination,
    admission,
    snapshot: target,
    disposed: false,
    consumed: false
  }
  const capability: RuntimeOwnedTreeMoveAdmission = Object.freeze({
    async dispose(): Promise<void> {
      if (state.disposed) return
      state.disposed = true
      await state.admission.dispose()
    }
  })
  treeMoves.set(capability, state)
  return capability
}

export async function commitRuntimeOwnedTreeMove(
  capability: RuntimeOwnedTreeMoveAdmission,
  assertCallerCurrentSync: () => void
): Promise<RuntimeOwnedTreeMoveResult> {
  const state = treeMoves.get(capability as object)
  if (!state || state.disposed || state.consumed) throw new Error('RUNTIME_TREE_MOVE_ADMISSION_INVALID')
  state.consumed = true
  try {
    renameRuntimeDirectorySyncAfterAdmission({
      admission: state.admission,
      source: state.receipt.rootPath,
      destination: state.destination,
      assertCallerCurrentSync
    })
    state.receipt.consumed = true
    state.receipt.disposed = true
    await state.receipt.physical.dispose()
    const moved = await captureMovedTree(state.receipt, state.snapshot, state.destination)
    if (!moved) return { status: 'moved-unconfirmed' }
    let physical: RuntimePhysicalAdmission
    try {
      physical = await prepareRuntimePhysicalAdmission(moved.snapshot)
    } catch {
      return { status: 'moved-unconfirmed' }
    }
    try {
      assertCallerCurrentSync()
    } catch {
      await physical.dispose()
      return { status: 'moved-unconfirmed' }
    }
    const receipt = Object.freeze({ manifest: moved.manifest }) as RuntimeOwnedTreeReceipt
    registerRuntimeOwnedTreeReceipt(receipt, {
      rootPath: state.destination,
      snapshot: moved.snapshot,
      manifest: moved.manifest,
      physical,
      disposed: false,
      consumed: false
    })
    return { status: 'moved', receipt }
  } finally {
    if (state.receipt.consumed) {
      state.receipt.disposed = true
      await state.receipt.physical.dispose()
    }
    await disposeRuntimeOwnedTreeMove(capability)
  }
}

async function captureMovedTree(
  source: RuntimeOwnedTreeReceiptState,
  admitted: RuntimePhysicalSnapshotInput,
  destination: string
): Promise<{
  readonly snapshot: RuntimePhysicalSnapshotInput
  readonly manifest: RuntimeOwnedTreeManifest
} | null> {
  try {
    const oldRoot = source.rootPath
    const newRoot = destination
    const pathMap = (path: string): string =>
      path === oldRoot
        ? newRoot
        : path.startsWith(`${oldRoot}${sep}`)
          ? `${newRoot}${path.slice(oldRoot.length)}`
          : path
    const nodes: { path: string; version: BigIntStats }[] = []
    const oldParent = dirname(oldRoot)
    const newParent = dirname(newRoot)
    for (const node of admitted.nodes) {
      const path = pathMap(node.path)
      const current = await lstat(path, { bigint: true })
      const movedRootOrParent = node.path === oldParent || node.path === newParent
      if (
        !(node.path === oldRoot
          ? stableMovedRootIdentity(node.version, current)
          : movedRootOrParent
            ? stablePhysicalIdentity(node.version, current)
            : sameRuntimeFileVersion(node.version, current))
      ) {
        return null
      }
      nodes.push({ path, version: current })
    }
    const directories: { path: string; version: BigIntStats; children: readonly string[] }[] = []
    for (const directory of admitted.directories) {
      if (directory.path === oldParent || directory.path === newParent) continue
      const path = pathMap(directory.path)
      const current = nodes.find((node) => node.path === path)?.version ?? (await lstat(path, { bigint: true }))
      const expectedChildren = directory.children
      const children = await readExactDirectoryNames(path, expectedChildren.length)
      if ([...children].sort().join('\0') !== [...expectedChildren].sort().join('\0')) return null
      directories.push({ path, version: current, children })
    }
    const sourceParent = admitted.directories.find((directory) => directory.path === oldParent)
    const destinationParent = admitted.directories.find((directory) => directory.path === newParent)
    if (!sourceParent || !destinationParent) return null
    const sourceName = oldRoot.slice(oldParent.length + 1)
    const destinationName = newRoot.slice(newParent.length + 1)
    const expectedSourceNames = sourceParent.children.filter((name) => name !== sourceName)
    const expectedDestinationNames =
      newParent === oldParent
        ? [...expectedSourceNames, destinationName]
        : [...destinationParent.children, destinationName]
    const sourceParentNames = await readExactDirectoryNames(oldParent, sourceParent.children.length)
    let destinationParentNames: string[]
    if (newParent === oldParent) {
      destinationParentNames = sourceParentNames
      if ([...sourceParentNames].sort().join('\0') !== [...expectedDestinationNames].sort().join('\0')) return null
    } else {
      destinationParentNames = await readExactDirectoryNames(newParent, destinationParent.children.length + 1)
      if (
        [...sourceParentNames].sort().join('\0') !== [...expectedSourceNames].sort().join('\0') ||
        [...destinationParentNames].sort().join('\0') !== [...expectedDestinationNames].sort().join('\0')
      ) {
        return null
      }
    }
    directories.push({
      path: oldParent,
      version: await lstat(oldParent, { bigint: true }),
      children: sourceParentNames
    })
    if (newParent !== oldParent) {
      directories.push({
        path: newParent,
        version: await lstat(newParent, { bigint: true }),
        children: destinationParentNames
      })
    }
    const roots = admitted.roots.filter((root) => root.path !== oldRoot && root.path !== newRoot)
    roots.push({ path: newRoot, identity: nodes.find((node) => node.path === newRoot)!.version })
    const snapshot: RuntimePhysicalSnapshotInput = { roots, nodes, directories }
    const fileDigests = new Map(
      source.manifest.entries.flatMap((entry) =>
        entry.kind === 'file' ? [[pathMap(join(oldRoot, entry.path)), entry.sha256] as const] : []
      )
    )
    return { snapshot, manifest: makeRuntimeOwnedTreeManifest(newRoot, snapshot, fileDigests) }
  } catch {
    return null
  }
}

async function readExactDirectoryNames(path: string, maximum: number): Promise<string[]> {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 4096) throw new Error('RUNTIME_TREE_LIMIT')
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

function stablePhysicalIdentity(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isDirectory() &&
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs &&
    expected.mode === actual.mode &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid &&
    expected.rdev === actual.rdev
  )
}

function stableMovedRootIdentity(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    stablePhysicalIdentity(expected, actual) &&
    expected.nlink === actual.nlink &&
    expected.size === actual.size &&
    expected.blocks === actual.blocks &&
    expected.mtimeNs === actual.mtimeNs
  )
}

function mergeSnapshots(
  first: RuntimePhysicalSnapshotInput,
  second: RuntimePhysicalSnapshotInput
): RuntimePhysicalSnapshotInput {
  const nodes = new Map(first.nodes.map((node) => [node.path, node]))
  for (const node of second.nodes) {
    const prior = nodes.get(node.path)
    if (prior && !sameRuntimeFileVersion(prior.version, node.version))
      throw new Error('RUNTIME_TREE_MOVE_SNAPSHOT_CONFLICT')
    nodes.set(node.path, node)
  }
  const directories = new Map(first.directories.map((directory) => [directory.path, directory]))
  for (const directory of second.directories) {
    const prior = directories.get(directory.path)
    if (
      prior &&
      (!sameRuntimeFileVersion(prior.version, directory.version) ||
        [...prior.children].sort().join('\0') !== [...directory.children].sort().join('\0'))
    ) {
      throw new Error('RUNTIME_TREE_MOVE_SNAPSHOT_CONFLICT')
    }
    directories.set(directory.path, directory)
  }
  const roots = new Map(first.roots.map((root) => [root.path, root]))
  for (const root of second.roots) {
    const previous = roots.get(root.path)
    if (previous) {
      if (
        !!previous.mustBeAbsent !== !!root.mustBeAbsent ||
        (previous.identity &&
          root.identity &&
          (previous.identity.dev !== root.identity.dev || previous.identity.ino !== root.identity.ino))
      )
        throw new Error('RUNTIME_TREE_MOVE_SNAPSHOT_CONFLICT')
      if (previous.identity && !root.identity) continue
    }
    roots.set(root.path, root)
  }
  return {
    roots: [...roots.values()],
    nodes: [...nodes.values()],
    directories: [...directories.values()],
    pointers: [...(first.pointers ?? []), ...(second.pointers ?? [])]
  }
}

async function disposeRuntimeOwnedTreeMove(capability: RuntimeOwnedTreeMoveAdmission): Promise<void> {
  const state = treeMoves.get(capability as object)
  if (!state || state.disposed) return
  state.disposed = true
  await state.admission.dispose()
}

export { recoverRuntimeOwnedTreeMove } from './runtime-owned-tree-recovery'
