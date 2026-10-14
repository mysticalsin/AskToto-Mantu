import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  prepareRuntimePhysicalAdmission,
  sameRuntimeFileVersion,
  type RuntimePhysicalAdmission,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import {
  ensureContained,
  makeRuntimeOwnedTreeManifest,
  readIssuedRuntimeOwnedTreeMoveIntent,
  sameIdentityRecord,
  type AuthenticatedRuntimeOwnedTreeMoveIntent,
  type RuntimeOwnedTreeManifest,
  type RuntimeOwnedTreeReceipt
} from './runtime-owned-tree-record'
import {
  assertRuntimePackNamespaceCurrent,
  describeRuntimePackNamespace,
  type RuntimePackNamespace
} from './runtime-pack-namespace'
import {
  runtimePayloadPlanBudget,
  runtimePayloadPlanFileClaims,
  runtimePayloadPlanIdentity,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import { registerRuntimeOwnedTreeReceipt } from './runtime-owned-tree-state'

export type RuntimeOwnedTreeRecoveryResult =
  | { readonly status: 'not-moved'; readonly receipt: RuntimeOwnedTreeReceipt }
  | { readonly status: 'moved'; readonly receipt: RuntimeOwnedTreeReceipt }
  | {
      readonly status: 'retained-unknown'
      readonly reason:
        | 'scope-retired'
        | 'binding-mismatch'
        | 'ambiguous-location'
        | 'parent-membership-mismatch'
        | 'tree-membership-mismatch'
        | 'physical-mismatch'
        | 'digest-mismatch'
        | 'resource-limit'
        | 'io-failure'
    }

const MAX_RECOVERY_TREE_NODES = 128
const MAX_RECOVERY_PATH_BYTES = 16_384
const MAX_HASH_BYTES_PER_READ = 64 * 1024
const RECOVERY_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const RECOVERY_NONBLOCK = constants.O_NONBLOCK ?? 0

export async function recoverRuntimeOwnedTreeMove(input: {
  readonly namespace: RuntimePackNamespace
  readonly intent: AuthenticatedRuntimeOwnedTreeMoveIntent
  readonly plan: RuntimePayloadWritePlan
  readonly assertCurrentSync: () => void
}): Promise<RuntimeOwnedTreeRecoveryResult> {
  const openedFiles: FileHandle[] = []
  let admission: RuntimePhysicalAdmission | null = null
  const guard = (): void => {
    try {
      input.assertCurrentSync()
    } catch {
      throw new Error('RUNTIME_TREE_MOVE_SCOPE_RETIRED')
    }
  }
  const guardAsync = async (): Promise<void> => {
    guard()
    await assertRuntimePackNamespaceCurrent(input.namespace)
    guard()
  }
  try {
    guard()
    const record = readIssuedRuntimeOwnedTreeMoveIntent(input.intent)
    const namespace = describeRuntimePackNamespace(input.namespace)
    if (
      record.rootBinding !== namespace.bindingId ||
      record.profileBinding !== namespace.profile.profileBinding ||
      record.principalBinding !== namespace.profile.principalBinding ||
      record.payloadPlanIdentity !== runtimePayloadPlanIdentity(input.plan)
    ) {
      return { status: 'retained-unknown', reason: 'binding-mismatch' }
    }
    const budget = runtimePayloadPlanBudget(input.plan)
    const claims = runtimePayloadPlanFileClaims(input.plan)
    if (
      claims.length > MAX_RECOVERY_TREE_NODES ||
      budget.fileCount + budget.directoryCount > MAX_RECOVERY_TREE_NODES ||
      budget.maximumPathBytes > MAX_RECOVERY_PATH_BYTES ||
      claims.reduce((sum, claim) => sum + claim.byteLength, 0) !== budget.totalBytes
    ) {
      return { status: 'retained-unknown', reason: 'resource-limit' }
    }
    const manifest = record.preMoveManifest
    if (manifest.entries.length + 1 > MAX_RECOVERY_TREE_NODES) {
      return { status: 'retained-unknown', reason: 'resource-limit' }
    }
    const rootPath = namespace.rootPath
    const sourcePath = ensureContained(rootPath, record.source)
    const destinationPath = ensureContained(rootPath, record.destination)
    const sourceParentPath = dirname(sourcePath)
    const destinationParentPath = dirname(destinationPath)
    const [source, destination] = await Promise.all([maybeLstat(sourcePath), maybeLstat(destinationPath)])
    await guardAsync()
    const notMoved = source !== null && destination === null
    const moved = source === null && destination !== null
    if (!notMoved && !moved) return { status: 'retained-unknown', reason: 'ambiguous-location' }
    const treePath = notMoved ? sourcePath : destinationPath
    const treeVersion = notMoved ? source! : destination!
    if (
      !treeVersion.isDirectory() ||
      treeVersion.isSymbolicLink() ||
      !(notMoved
        ? sameIdentityRecord(manifest.root, treeVersion)
        : stableMovedRootIdentityFromRecord(manifest.root, treeVersion))
    ) {
      return { status: 'retained-unknown', reason: 'physical-mismatch' }
    }
    const sourceParentRecord = record.sourceParent
    const destinationParentRecord = record.destinationParent
    const actualSourceParentPath = sourceParentRecord.relativePath
      ? ensureContained(rootPath, sourceParentRecord.relativePath)
      : rootPath
    const actualDestinationParentPath = destinationParentRecord.relativePath
      ? ensureContained(rootPath, destinationParentRecord.relativePath)
      : rootPath
    if (actualSourceParentPath !== sourceParentPath || actualDestinationParentPath !== destinationParentPath) {
      return { status: 'retained-unknown', reason: 'binding-mismatch' }
    }
    const [sourceParent, destinationParent] =
      sourceParentPath === destinationParentPath
        ? await Promise.all([
            captureParent(sourceParentPath, sourceParentRecord.identity, guardAsync),
            Promise.resolve(null)
          ])
        : await Promise.all([
            captureParent(sourceParentPath, sourceParentRecord.identity, guardAsync),
            captureParent(destinationParentPath, destinationParentRecord.identity, guardAsync)
          ])
    await guardAsync()
    if (!sourceParent || (sourceParentPath !== destinationParentPath && !destinationParent)) {
      return { status: 'retained-unknown', reason: 'parent-membership-mismatch' }
    }
    const sourceName = sourcePath.slice(sourceParentPath.length + 1)
    const destinationName = destinationPath.slice(destinationParentPath.length + 1)
    if (notMoved) {
      if (
        !sameNames(sourceParent.names, sourceParentRecord.children) ||
        (destinationParent && !sameNames(destinationParent.names, destinationParentRecord.children))
      ) {
        return { status: 'retained-unknown', reason: 'parent-membership-mismatch' }
      }
    } else {
      const sourceExpected = sourceParentRecord.children.filter((name) => name !== sourceName)
      const destinationExpected =
        sourceParentPath === destinationParentPath
          ? [...sourceExpected, destinationName]
          : [...destinationParentRecord.children, destinationName]
      if (
        !sameNames(sourceParent.names, sourceExpected) ||
        (destinationParent && !sameNames(destinationParent.names, destinationExpected))
      ) {
        return { status: 'retained-unknown', reason: 'parent-membership-mismatch' }
      }
    }

    await guardAsync()
    const tree = await captureAndVerifyTree({
      rootPath: treePath,
      rootVersion: treeVersion,
      moved,
      manifest,
      claims,
      maximumBytes: budget.maximumBytes,
      assertCurrentSync: guard,
      assertCurrentAsync: guardAsync,
      openedFiles
    })
    if (!tree) return { status: 'retained-unknown', reason: 'tree-membership-mismatch' }
    const [currentSourceParent, currentDestinationParent] =
      sourceParentPath === destinationParentPath
        ? [await captureParent(sourceParentPath, sourceParentRecord.identity, guardAsync), null]
        : await Promise.all([
            captureParent(sourceParentPath, sourceParentRecord.identity, guardAsync),
            captureParent(destinationParentPath, destinationParentRecord.identity, guardAsync)
          ])
    await guardAsync()
    const expectedSourceChildren = moved
      ? sourceParentRecord.children.filter((name) => name !== sourceName)
      : sourceParentRecord.children
    const expectedDestinationChildren = moved
      ? sourceParentPath === destinationParentPath
        ? [...expectedSourceChildren, destinationName]
        : [...destinationParentRecord.children, destinationName]
      : destinationParentRecord.children
    if (
      !sameNames(currentSourceParent.names, expectedSourceChildren) ||
      (currentDestinationParent && !sameNames(currentDestinationParent.names, expectedDestinationChildren))
    ) {
      return { status: 'retained-unknown', reason: 'parent-membership-mismatch' }
    }
    const nodes = [
      { path: treePath, version: tree.rootVersion },
      ...tree.nodes,
      { path: sourceParentPath, version: currentSourceParent.version },
      ...(currentDestinationParent ? [{ path: destinationParentPath, version: currentDestinationParent.version }] : [])
    ]
    const directories = [
      { path: treePath, version: tree.rootVersion, children: tree.rootChildren },
      ...tree.directories,
      { path: sourceParentPath, version: currentSourceParent.version, children: currentSourceParent.names },
      ...(currentDestinationParent
        ? [
            {
              path: destinationParentPath,
              version: currentDestinationParent.version,
              children: currentDestinationParent.names
            }
          ]
        : [])
    ]
    const snapshot: RuntimePhysicalSnapshotInput = {
      roots: [{ path: treePath, identity: tree.rootVersion }],
      nodes,
      directories
    }
    admission = await prepareRuntimePhysicalAdmission(snapshot)
    await guardAsync()
    for (const file of tree.fileVersions) {
      const [opened, named] = await Promise.all([
        file.handle.stat({ bigint: true }),
        lstat(file.path, { bigint: true })
      ])
      await guardAsync()
      if (!sameRuntimeFileVersion(file.version, opened) || !sameRuntimeFileVersion(file.version, named)) {
        return { status: 'retained-unknown', reason: 'physical-mismatch' }
      }
    }
    admission.assertCurrentSync()
    guard()
    const digests = new Map(tree.fileVersions.map((file) => [file.path, file.sha256]))
    const refreshed = makeRuntimeOwnedTreeManifest(treePath, snapshot, digests)
    const receipt = Object.freeze({ manifest: refreshed }) as RuntimeOwnedTreeReceipt
    registerRuntimeOwnedTreeReceipt(receipt, {
      rootPath: treePath,
      snapshot,
      manifest: refreshed,
      physical: admission,
      disposed: false,
      consumed: false
    })
    admission = null
    return { status: moved ? 'moved' : 'not-moved', receipt }
  } catch (error) {
    if ((error as Error).message === 'RUNTIME_TREE_MOVE_SCOPE_RETIRED') {
      return { status: 'retained-unknown', reason: 'scope-retired' }
    }
    if ((error as Error).message === 'RUNTIME_TREE_MOVE_DIGEST_MISMATCH') {
      return { status: 'retained-unknown', reason: 'digest-mismatch' }
    }
    if ((error as Error).message === 'RUNTIME_TREE_MOVE_RESOURCE_LIMIT') {
      return { status: 'retained-unknown', reason: 'resource-limit' }
    }
    return { status: 'retained-unknown', reason: 'io-failure' }
  } finally {
    if (admission) await admission.dispose().catch(() => undefined)
    for (const handle of openedFiles) await handle.close().catch(() => undefined)
  }
}

async function captureAndVerifyTree(input: {
  readonly rootPath: string
  readonly rootVersion: BigIntStats
  readonly moved: boolean
  readonly manifest: RuntimeOwnedTreeManifest
  readonly claims: readonly Readonly<{ relativePath: string; byteLength: number; sha256: string }>[]
  readonly maximumBytes: number
  readonly assertCurrentSync: () => void
  readonly assertCurrentAsync: () => Promise<void>
  readonly openedFiles: FileHandle[]
}): Promise<null | {
  readonly rootVersion: BigIntStats
  readonly rootChildren: readonly string[]
  readonly nodes: readonly { path: string; version: BigIntStats }[]
  readonly directories: readonly { path: string; version: BigIntStats; children: readonly string[] }[]
  readonly fileVersions: readonly { path: string; handle: FileHandle; version: BigIntStats; sha256: string }[]
}> {
  const manifest = input.manifest
  const expectedFiles = new Map(input.claims.map((claim) => [claim.relativePath, claim]))
  const pathBytes = manifest.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.path), 0)
  if (
    manifest.entries.length + 1 > MAX_RECOVERY_TREE_NODES ||
    pathBytes > MAX_RECOVERY_PATH_BYTES ||
    expectedFiles.size !== manifest.entries.filter((entry) => entry.kind === 'file').length
  ) {
    throw new Error('RUNTIME_TREE_MOVE_RESOURCE_LIMIT')
  }
  const rootChildren = manifest.entries
    .filter((entry) => !entry.path.includes('/'))
    .map((entry) => entry.path)
    .sort()
  const actualRootChildren = await readExactDirectoryNames(input.rootPath, rootChildren.length)
  input.assertCurrentSync()
  if (!sameNames(actualRootChildren, rootChildren)) return null
  const rootDirectories: { path: string; version: BigIntStats; children: readonly string[] }[] = []
  const nodes: { path: string; version: BigIntStats }[] = []
  const fileVersions: { path: string; handle: FileHandle; version: BigIntStats; sha256: string }[] = []
  for (const entry of manifest.entries) {
    const path = ensureContained(input.rootPath, entry.path)
    input.assertCurrentSync()
    const version = await lstat(path, { bigint: true })
    input.assertCurrentSync()
    if (entry.kind === 'directory') {
      if (!version.isDirectory() || version.isSymbolicLink() || !sameIdentityRecord(entry.identity, version))
        return null
      const children = await readExactDirectoryNames(path, entry.children.length)
      input.assertCurrentSync()
      if (!sameNames(children, entry.children)) return null
      rootDirectories.push({ path, version, children })
      nodes.push({ path, version })
      continue
    }
    const claim = expectedFiles.get(entry.path)
    if (
      !claim ||
      entry.identity.size !== String(claim.byteLength) ||
      entry.sha256 !== claim.sha256 ||
      !version.isFile() ||
      version.isSymbolicLink() ||
      version.nlink !== 1n ||
      !sameIdentityRecord(entry.identity, version)
    ) {
      return null
    }
    const { handle, digest, finalVersion } = await hashRetainedFile({
      path,
      expected: version,
      byteLength: claim.byteLength,
      maximumBytes: input.maximumBytes,
      assertCurrentSync: input.assertCurrentSync
    })
    input.openedFiles.push(handle)
    if (digest !== claim.sha256) throw new Error('RUNTIME_TREE_MOVE_DIGEST_MISMATCH')
    if (!sameIdentityRecord(entry.identity, finalVersion)) return null
    fileVersions.push({ path, handle, version: finalVersion, sha256: digest })
    nodes.push({ path, version: finalVersion })
  }
  if (fileVersions.length !== expectedFiles.size) return null
  await input.assertCurrentAsync()
  const rootVersion = await lstat(input.rootPath, { bigint: true })
  input.assertCurrentSync()
  if (
    !rootVersion.isDirectory() ||
    rootVersion.isSymbolicLink() ||
    !(input.moved
      ? stableMovedRootIdentityFromRecord(manifest.root, rootVersion)
      : sameIdentityRecord(manifest.root, rootVersion)) ||
    !sameRuntimeFileVersion(input.rootVersion, rootVersion)
  ) {
    return null
  }
  return { rootVersion, rootChildren, nodes, directories: rootDirectories, fileVersions }
}

async function hashRetainedFile(input: {
  readonly path: string
  readonly expected: BigIntStats
  readonly byteLength: number
  readonly maximumBytes: number
  readonly assertCurrentSync: () => void
}): Promise<{ handle: FileHandle; digest: string; finalVersion: BigIntStats }> {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    input.byteLength > input.maximumBytes ||
    input.byteLength > 100_000_000_000
  ) {
    throw new Error('RUNTIME_TREE_MOVE_RESOURCE_LIMIT')
  }
  input.assertCurrentSync()
  const handle = await open(input.path, constants.O_RDONLY | RECOVERY_NOFOLLOW | RECOVERY_NONBLOCK)
  input.assertCurrentSync()
  try {
    const before = await handle.stat({ bigint: true })
    input.assertCurrentSync()
    const namedBefore = await lstat(input.path, { bigint: true })
    input.assertCurrentSync()
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size !== BigInt(input.byteLength) ||
      !sameRuntimeFileVersion(input.expected, before) ||
      !sameRuntimeFileVersion(input.expected, namedBefore)
    ) {
      throw new Error('RUNTIME_TREE_MOVE_FILE_CHANGED')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(Math.min(MAX_HASH_BYTES_PER_READ, input.byteLength))
    let offset = 0
    while (offset < input.byteLength) {
      input.assertCurrentSync()
      const length = Math.min(buffer.byteLength, input.byteLength - offset)
      const result = await handle.read(buffer, 0, length, offset)
      input.assertCurrentSync()
      if (result.bytesRead <= 0) throw new Error('RUNTIME_TREE_MOVE_FILE_READ_SHORT')
      hash.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
      const current = await handle.stat({ bigint: true })
      input.assertCurrentSync()
      const named = await lstat(input.path, { bigint: true })
      input.assertCurrentSync()
      if (!sameRuntimeFileVersion(before, current) || !sameRuntimeFileVersion(before, named)) {
        throw new Error('RUNTIME_TREE_MOVE_FILE_CHANGED')
      }
    }
    const probe = Buffer.alloc(1)
    const overflow = await handle.read(probe, 0, 1, offset)
    input.assertCurrentSync()
    if (overflow.bytesRead !== 0) throw new Error('RUNTIME_TREE_MOVE_FILE_GROWN')
    const [finalVersion, finalNamed] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(input.path, { bigint: true })
    ])
    input.assertCurrentSync()
    if (!sameRuntimeFileVersion(before, finalVersion) || !sameRuntimeFileVersion(before, finalNamed)) {
      throw new Error('RUNTIME_TREE_MOVE_FILE_CHANGED')
    }
    return { handle, digest: hash.digest('hex'), finalVersion }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function captureParent(
  path: string,
  expected: RuntimeOwnedTreeManifest['root'],
  assertCurrentAsync: () => Promise<void>
): Promise<{
  readonly version: BigIntStats
  readonly names: readonly string[]
}> {
  await assertCurrentAsync()
  const version = await lstat(path, { bigint: true })
  await assertCurrentAsync()
  if (!version.isDirectory() || version.isSymbolicLink() || !sameStableDirectoryRecord(expected, version)) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_CHANGED')
  }
  const names = await readExactDirectoryNames(path, MAX_RECOVERY_TREE_NODES)
  await assertCurrentAsync()
  return { version, names }
}

function sameStableDirectoryRecord(expected: RuntimeOwnedTreeManifest['root'], actual: BigIntStats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev.toString() &&
    expected.ino === actual.ino.toString() &&
    expected.birthtimeNs === actual.birthtimeNs.toString() &&
    expected.mode === actual.mode.toString() &&
    expected.uid === actual.uid.toString() &&
    expected.gid === actual.gid.toString() &&
    expected.rdev === actual.rdev.toString()
  )
}

function stableMovedRootIdentityFromRecord(expected: RuntimeOwnedTreeManifest['root'], actual: BigIntStats): boolean {
  return (
    sameStableDirectoryRecord(expected, actual) &&
    expected.nlink === actual.nlink.toString() &&
    expected.size === actual.size.toString() &&
    expected.blocks === actual.blocks.toString() &&
    expected.mtimeNs === actual.mtimeNs.toString()
  )
}

async function maybeLstat(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
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
