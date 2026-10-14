import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  createRuntimeDirectoryAfterAdmission,
  prepareRuntimeDirectoryCreation,
  prepareRuntimePhysicalAdmission,
  sameRuntimeFileVersion,
  type RuntimeDirectoryCreationReceipt,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import {
  runtimePayloadPlanIdentity,
  runtimePayloadPlanParentGraph,
  runtimePayloadPlanRoot,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import {
  readIssuedRuntimePackParentAuthority,
  type RuntimePackParentAuthority,
  type RuntimePackParentRecord
} from './runtime-pack-parent-authority'
import {
  runtimeProfileParentAccess,
  type RuntimeProfileBinding,
  type RuntimeProfileParentAccess,
  type RuntimeProfileParentPin,
  type RuntimeStableOwner
} from './runtime-purpose-root'
import { runtimeOwnedTreeReceipts } from './runtime-owned-tree-state'
import type { RuntimeOwnedTreeReceipt } from './runtime-owned-tree-record'
import { sameRuntimeMovedTreeManifest } from './runtime-owned-tree-move'

const MAX_PARENT_CHILDREN = 4096
const FIXED_PURPOSE = 'metis-speech-pack-payload-root/v1'

interface PackNamespaceState {
  readonly parent: RuntimeProfileParentAccess
  readonly path: string
  readonly parentPath: string
  readonly parentFile: FileHandle
  readonly profileVersion: BigIntStats
  parentVersion: BigIntStats
  parentChildren: readonly string[]
  rootVersion: BigIntStats
  rootChildren: readonly string[]
  readonly bindingId: string
  readonly fresh: boolean
  disposed: boolean
  retired: boolean
}

interface TreeParentPinState {
  readonly namespaceHandle: RuntimePackNamespace
  readonly namespace: PackNamespaceState
  readonly plan: RuntimePayloadWritePlan
  readonly treeRootPath: string
  readonly treeParentPath: string
  readonly parentDirectories: ParentDirectoryState[]
  snapshot: RuntimePhysicalSnapshotInput
  disposed: boolean
}

interface ParentDirectoryState {
  readonly relativePath: string
  readonly path: string
  version: BigIntStats
  children: readonly string[]
  created: boolean
}

declare const runtimePackNamespaceBrand: unique symbol
declare const runtimeTreeParentPinBrand: unique symbol
export type RuntimePackNamespace = { readonly [runtimePackNamespaceBrand]: true }
export type RuntimePackTreeParentPin = { readonly [runtimeTreeParentPinBrand]: true }
export type RuntimeTreeParentPin = RuntimePackTreeParentPin

const packNamespaces = new WeakMap<object, PackNamespaceState>()
const treeParentPins = new WeakMap<object, TreeParentPinState>()

function sameStableDirectoryOwner(expected: BigIntStats, actual: BigIntStats): boolean {
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

function stableOwner(version: BigIntStats): RuntimeStableOwner {
  return Object.freeze({
    dev: version.dev.toString(),
    ino: version.ino.toString(),
    birthtimeNs: version.birthtimeNs.toString(),
    mode: version.mode.toString(),
    uid: version.uid.toString(),
    gid: version.gid.toString(),
    rdev: version.rdev.toString()
  })
}

function fullVersionRecord(version: BigIntStats) {
  return Object.freeze({
    ...stableOwner(version),
    size: version.size.toString(),
    blocks: version.blocks.toString(),
    mtimeNs: version.mtimeNs.toString(),
    ctimeNs: version.ctimeNs.toString()
  })
}

function sameFullVersionRecord(expected: ReturnType<typeof fullVersionRecord>, actual: BigIntStats): boolean {
  const version = fullVersionRecord(actual)
  return (
    expected.dev === version.dev &&
    expected.ino === version.ino &&
    expected.birthtimeNs === version.birthtimeNs &&
    expected.mode === version.mode &&
    expected.uid === version.uid &&
    expected.gid === version.gid &&
    expected.rdev === version.rdev &&
    expected.size === version.size &&
    expected.blocks === version.blocks &&
    expected.mtimeNs === version.mtimeNs &&
    expected.ctimeNs === version.ctimeNs
  )
}

function sameStableOwnerRecord(expected: RuntimeStableOwner, actual: RuntimeStableOwner): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs &&
    expected.mode === actual.mode &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid &&
    expected.rdev === actual.rdev
  )
}

function sameNames(expected: readonly string[], actual: readonly string[]): boolean {
  return [...expected].sort().join('\0') === [...actual].sort().join('\0')
}

async function readDirectoryNames(path: string): Promise<string[]> {
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= MAX_PARENT_CHILDREN) throw new Error('RUNTIME_PACK_DIRECTORY_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

async function captureDirectory(path: string): Promise<{ version: BigIntStats; children: readonly string[] }> {
  const [canonical, version, children] = await Promise.all([
    realpath(path),
    lstat(path, { bigint: true }),
    readDirectoryNames(path)
  ])
  if (canonical !== path || !version.isDirectory() || version.isSymbolicLink()) {
    throw new Error('RUNTIME_PACK_DIRECTORY_INVALID')
  }
  return { version, children }
}

function snapshotFor(namespace: PackNamespaceState): RuntimePhysicalSnapshotInput {
  return {
    roots: [
      { path: namespace.parent.profilePath, identity: namespace.profileVersion },
      ...(namespace.parentPath === namespace.parent.profilePath
        ? []
        : [{ path: namespace.parentPath, identity: namespace.parentVersion }]),
      { path: namespace.path, identity: namespace.rootVersion }
    ],
    nodes: [
      { path: namespace.parent.profilePath, version: namespace.profileVersion },
      ...(namespace.parentPath === namespace.parent.profilePath
        ? []
        : [{ path: namespace.parentPath, version: namespace.parentVersion }]),
      { path: namespace.path, version: namespace.rootVersion }
    ],
    directories: [
      {
        path: namespace.parent.profilePath,
        version: namespace.profileVersion,
        children: [...namespace.parent.children]
      },
      ...(namespace.parentPath === namespace.parent.profilePath
        ? []
        : [
            {
              path: namespace.parentPath,
              version: namespace.parentVersion,
              children: [...namespace.parentChildren]
            }
          ]),
      { path: namespace.path, version: namespace.rootVersion, children: [...namespace.rootChildren] }
    ]
  }
}

function appendDirectory(
  snapshot: RuntimePhysicalSnapshotInput,
  path: string,
  version: BigIntStats,
  children: readonly string[]
): RuntimePhysicalSnapshotInput {
  return {
    roots: [...snapshot.roots, { path, identity: version }],
    nodes: [...snapshot.nodes.filter((node) => node.path !== path), { path, version }],
    directories: [
      ...snapshot.directories.filter((directory) => directory.path !== path),
      { path, version, children: [...children] }
    ]
  }
}

function replaceDirectory(
  snapshot: RuntimePhysicalSnapshotInput,
  path: string,
  version: BigIntStats,
  children: readonly string[]
): RuntimePhysicalSnapshotInput {
  return {
    roots: snapshot.roots.map((root) => (root.path === path ? { path, identity: version } : root)),
    nodes: snapshot.nodes.map((node) => (node.path === path ? { path, version } : node)),
    directories: snapshot.directories.map((directory) =>
      directory.path === path ? { path, version, children: [...children] } : directory
    )
  }
}

async function refreshTreeParentChain(state: TreeParentPinState): Promise<void> {
  for (const directory of state.parentDirectories) {
    const current = await captureDirectory(directory.path)
    state.namespace.parent.assertCurrentSync()
    if (
      !sameRuntimeFileVersion(directory.version, current.version) ||
      !sameNames(directory.children, current.children)
    ) {
      state.namespace.retired = true
      throw new Error('RUNTIME_TREE_PARENT_CHANGED')
    }
    directory.version = current.version
    state.snapshot = replaceDirectory(state.snapshot, directory.path, current.version, current.children)
  }
}

export async function captureRuntimePackNamespace(input: {
  readonly profile: RuntimeProfileParentPin
  readonly mainPackRootPath: string
  readonly mode: 'open-existing' | 'create-explicit'
}): Promise<RuntimePackNamespace> {
  const profile = runtimeProfileParentAccess(input.profile)
  const path = resolve(input.mainPackRootPath)
  const parentPath = dirname(path)
  if (!path || path !== input.mainPackRootPath || path === parentPath || resolve(parentPath) !== parentPath) {
    throw new Error('RUNTIME_PACK_NAMESPACE_PATH_INVALID')
  }
  profile.assertCurrentSync()
  await profile.assertCurrent()
  const parentCapture =
    parentPath === profile.profilePath
      ? { version: profile.version, children: profile.children }
      : await captureDirectory(parentPath)
  profile.assertCurrentSync()
  const parentFile = await open(
    parentPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const [openedParent, namedParent, canonicalParent, namedChildren] = await Promise.all([
      parentFile.stat({ bigint: true }),
      lstat(parentPath, { bigint: true }),
      realpath(parentPath),
      readDirectoryNames(parentPath)
    ])
    profile.assertCurrentSync()
    await profile.assertCurrent()
    if (
      canonicalParent !== parentPath ||
      !sameRuntimeFileVersion(parentCapture.version, openedParent) ||
      !sameRuntimeFileVersion(parentCapture.version, namedParent) ||
      !sameNames(parentCapture.children, namedChildren)
    ) {
      throw new Error('RUNTIME_PACK_PARENT_CHANGED')
    }
    const rootName = path.slice(parentPath.length + 1)
    let root: { version: BigIntStats; children: readonly string[] }
    let parentVersion = parentCapture.version
    let parentChildren = [...parentCapture.children]
    let fresh = false
    if (!parentChildren.includes(rootName)) {
      if (input.mode !== 'create-explicit') throw new Error('RUNTIME_PACK_NAMESPACE_MISSING')
      const snapshot: RuntimePhysicalSnapshotInput = {
        roots: [
          { path: profile.profilePath, identity: profile.version },
          ...(parentPath === profile.profilePath ? [] : [{ path: parentPath, identity: parentVersion }])
        ],
        nodes: [
          { path: profile.profilePath, version: profile.version },
          ...(parentPath === profile.profilePath ? [] : [{ path: parentPath, version: parentVersion }])
        ],
        directories: [
          { path: profile.profilePath, version: profile.version, children: profile.children },
          ...(parentPath === profile.profilePath
            ? []
            : [{ path: parentPath, version: parentVersion, children: parentChildren }])
        ]
      }
      await profile.assertCurrent()
      const creationAdmission = await prepareRuntimeDirectoryCreation({ path, parentPath, snapshot })
      await profile.assertCurrent()
      const created = await createRuntimeDirectoryAfterAdmission(creationAdmission, () => profile.assertCurrentSync())
      if (created.status !== 'created') throw new Error('RUNTIME_PACK_NAMESPACE_UNCONFIRMED')
      if (parentPath === profile.profilePath) {
        profile.recordParentMutation(parentPath, created.parentVersion, created.parentChildren)
      }
      parentVersion = created.parentVersion
      parentChildren = [...created.parentChildren]
      root = { version: created.version, children: [] }
      fresh = true
    } else {
      root = await captureDirectory(path)
      await profile.assertCurrent()
    }
    const profileVersion = profile.version
    const namespaceState: PackNamespaceState = {
      parent: profile,
      path,
      parentPath,
      parentFile,
      profileVersion,
      parentVersion,
      parentChildren,
      rootVersion: root.version,
      rootChildren: [...root.children],
      bindingId: createHash('sha256')
        .update(`${FIXED_PURPOSE}\0`)
        .update(
          JSON.stringify({
            profile: profile.binding,
            profileOwner: stableOwner(profileVersion),
            parentPath,
            parentOwner: stableOwner(parentVersion),
            path,
            rootOwner: stableOwner(root.version)
          })
        )
        .digest('hex'),
      fresh,
      disposed: false,
      retired: false
    }
    const admission = await prepareRuntimePhysicalAdmission(snapshotFor(namespaceState))
    try {
      profile.assertCurrentSync()
      admission.assertCurrentSync()
    } finally {
      await admission.dispose()
    }
    const namespace = Object.freeze({}) as RuntimePackNamespace
    packNamespaces.set(namespace, namespaceState)
    return namespace
  } catch (error) {
    await parentFile.close().catch(() => undefined)
    throw error
  }
}

export function describeRuntimePackNamespace(namespace: RuntimePackNamespace): Readonly<{
  bindingId: string
  rootPath: string
  profile: RuntimeProfileBinding
  profileOwner: RuntimeStableOwner
  parentOwner: RuntimeStableOwner
  rootOwner: RuntimeStableOwner
  fresh: boolean
}> {
  const state = packNamespaces.get(namespace as object)
  if (!state || state.disposed || state.retired) throw new Error('RUNTIME_PACK_NAMESPACE_INVALID')
  return Object.freeze({
    bindingId: state.bindingId,
    rootPath: state.path,
    profile: state.parent.binding,
    profileOwner: stableOwner(state.profileVersion),
    parentOwner: stableOwner(state.parentVersion),
    rootOwner: stableOwner(state.rootVersion),
    fresh: state.fresh
  })
}

export async function assertRuntimePackNamespaceCurrent(namespace: RuntimePackNamespace): Promise<void> {
  const state = packNamespaces.get(namespace as object)
  if (!state || state.disposed || state.retired) throw new Error('RUNTIME_PACK_NAMESPACE_INVALID')
  try {
    state.parent.assertCurrentSync()
    await state.parent.assertCurrent()
    const [parentOpened, parentNamed, parentCanonical, parentChildren, root] = await Promise.all([
      state.parentFile.stat({ bigint: true }),
      lstat(state.parentPath, { bigint: true }),
      realpath(state.parentPath),
      readDirectoryNames(state.parentPath),
      captureDirectory(state.path)
    ])
    state.parent.assertCurrentSync()
    if (
      parentCanonical !== state.parentPath ||
      !sameStableDirectoryOwner(state.parentVersion, parentOpened) ||
      !sameStableDirectoryOwner(state.parentVersion, parentNamed) ||
      !sameNames(state.parentChildren, parentChildren) ||
      !sameStableDirectoryOwner(state.rootVersion, root.version) ||
      !sameNames(state.rootChildren, root.children)
    ) {
      throw new Error('RUNTIME_PACK_NAMESPACE_CHANGED')
    }
    await state.parent.assertCurrent()
    const admission = await prepareRuntimePhysicalAdmission(snapshotFor(state))
    try {
      state.parent.assertCurrentSync()
      admission.assertCurrentSync()
    } finally {
      await admission.dispose()
    }
  } catch (error) {
    state.retired = true
    throw error
  }
}

export async function prepareRuntimeTreeParent(input: {
  readonly namespace: RuntimePackNamespace
  readonly relativeParent: string
  readonly plan: RuntimePayloadWritePlan
  readonly parentAuthority?: RuntimePackParentAuthority
}): Promise<RuntimePackTreeParentPin> {
  const namespace = packNamespaces.get(input.namespace as object)
  if (!namespace || namespace.disposed || namespace.retired) throw new Error('RUNTIME_PACK_NAMESPACE_INVALID')
  const graph = runtimePayloadPlanParentGraph(input.plan)
  const plannedRoot = runtimePayloadPlanRoot(input.plan)
  if (input.relativeParent !== graph.parentRelativePath || !plannedRoot || plannedRoot.includes('\\')) {
    throw new Error('RUNTIME_TREE_PARENT_NOT_ADMITTED')
  }
  await assertRuntimePackNamespaceCurrent(input.namespace)
  const authorityRecord = input.parentAuthority
    ? readIssuedRuntimePackParentAuthority(input.parentAuthority, input.namespace, input.plan)
    : null
  const parentDirectories: ParentDirectoryState[] = []
  let snapshot = snapshotFor(namespace)
  let parentPath = namespace.path
  for (let index = 0; index < graph.parentChain.length; index += 1) {
    const relativePath = graph.parentChain[index]
    const path = join(namespace.path, ...relativePath.split('/'))
    if (dirname(path) !== parentPath) throw new Error('RUNTIME_TREE_PARENT_NOT_ADMITTED')
    const authorized = authorityRecord?.directories[index]
    const expectedAbsent = authorityRecord !== null && index >= authorityRecord.directories.length
    const currentParent = await captureDirectory(parentPath)
    namespace.parent.assertCurrentSync()
    if (index === 0 && parentPath === namespace.path) {
      if (!sameRuntimeFileVersion(namespace.rootVersion, currentParent.version)) {
        namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CHANGED')
      }
      namespace.rootChildren = [...currentParent.children]
    } else {
      const previous = parentDirectories[index - 1]
      if (!previous || !sameRuntimeFileVersion(previous.version, currentParent.version)) {
        namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CHANGED')
      }
      previous.children = [...currentParent.children]
    }
    if (currentParent.children.includes(path.slice(parentPath.length + 1))) {
      if (expectedAbsent || !authorized) throw new Error('RUNTIME_TREE_PARENT_UNAUTHENTICATED')
      const current = await captureDirectory(path)
      namespace.parent.assertCurrentSync()
      if (
        !sameStableOwnerRecord(authorized.identity, stableOwner(current.version)) ||
        !sameFullVersionRecord(authorized.version, current.version) ||
        !sameNames(authorized.children, current.children)
      ) {
        throw new Error('RUNTIME_TREE_PARENT_RECORD_MISMATCH')
      }
      parentDirectories.push({
        relativePath,
        path,
        version: current.version,
        children: [...current.children],
        created: false
      })
      snapshot = appendDirectory(snapshot, path, current.version, current.children)
    } else {
      if (authorized) throw new Error('RUNTIME_TREE_PARENT_RECORD_MISSING')
      const creationAdmission = await prepareRuntimeDirectoryCreation({ path, parentPath, snapshot })
      namespace.parent.assertCurrentSync()
      const created = await createRuntimeDirectoryAfterAdmission(creationAdmission, () => {
        namespace.parent.assertCurrentSync()
      })
      if (created.status !== 'created') {
        namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CREATE_UNCONFIRMED')
      }
      if (parentPath === namespace.path) {
        namespace.rootVersion = created.parentVersion
        namespace.rootChildren = [...created.parentChildren]
      } else {
        const parent = parentDirectories[index - 1]
        if (!parent || !sameStableDirectoryOwner(parent.version, created.parentVersion)) {
          namespace.retired = true
          throw new Error('RUNTIME_TREE_PARENT_CREATE_UNCONFIRMED')
        }
        parent.version = created.parentVersion
        parent.children = [...created.parentChildren]
        snapshot = replaceDirectory(snapshot, parent.path, parent.version, parent.children)
      }
      const current = await captureDirectory(path)
      namespace.parent.assertCurrentSync()
      if (!sameRuntimeFileVersion(created.version, current.version) || current.children.length !== 0) {
        namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CREATE_UNCONFIRMED')
      }
      parentDirectories.push({
        relativePath,
        path,
        version: current.version,
        children: [...current.children],
        created: true
      })
      snapshot = replaceDirectory(snapshot, parentPath, created.parentVersion, created.parentChildren)
      snapshot = appendDirectory(snapshot, path, current.version, current.children)
    }
    parentPath = path
  }
  if (authorityRecord && authorityRecord.directories.length > parentDirectories.length) {
    throw new Error('RUNTIME_TREE_PARENT_RECORD_INVALID')
  }
  const treeRootPath = join(namespace.path, ...plannedRoot.split('/'))
  if (dirname(treeRootPath) !== parentPath) throw new Error('RUNTIME_TREE_PARENT_NOT_ADMITTED')
  await namespace.parent.assertCurrent()
  const physical = await prepareRuntimePhysicalAdmission(snapshot)
  try {
    namespace.parent.assertCurrentSync()
    physical.assertCurrentSync()
  } finally {
    await physical.dispose()
  }
  const pin = Object.freeze({}) as RuntimePackTreeParentPin
  treeParentPins.set(pin, {
    namespaceHandle: input.namespace,
    namespace,
    plan: input.plan,
    treeRootPath,
    treeParentPath: parentPath,
    parentDirectories,
    snapshot,
    disposed: false
  })
  return pin
}

export function runtimeTreeParentRecord(
  pin: RuntimePackTreeParentPin,
  plan: RuntimePayloadWritePlan
): RuntimePackParentRecord {
  const state = treeParentPins.get(pin as object)
  if (!state || state.disposed || state.plan !== plan) throw new Error('RUNTIME_TREE_PARENT_PIN_INVALID')
  const graph = runtimePayloadPlanParentGraph(plan)
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'metis-speech-pack-tree-parent/v1',
    rootBinding: state.namespace.bindingId,
    profileBinding: state.namespace.parent.binding.profileBinding,
    principalBinding: state.namespace.parent.binding.principalBinding,
    planIdentity: runtimePayloadPlanIdentity(plan),
    lane: graph.lane,
    componentId: graph.componentId,
    componentVersion: graph.componentVersion,
    directories: Object.freeze(
      state.parentDirectories.map((directory) =>
        Object.freeze({
          relativePath: directory.relativePath,
          identity: stableOwner(directory.version),
          version: fullVersionRecord(directory.version),
          children: Object.freeze([...directory.children].sort())
        })
      )
    )
  })
}

/** Update both parent pins only from the exact receipt produced by a completed owned tree move. */
export function runtimeTreeParentAcknowledgeMove(input: {
  readonly sourcePin: RuntimePackTreeParentPin
  readonly destinationPin: RuntimePackTreeParentPin
  readonly sourcePlan: RuntimePayloadWritePlan
  readonly destinationPlan: RuntimePayloadWritePlan
  readonly sourceReceipt: RuntimeOwnedTreeReceipt
  readonly movedReceipt: RuntimeOwnedTreeReceipt
}): void {
  const sourcePin = treeParentPins.get(input.sourcePin as object)
  const destinationPin = treeParentPins.get(input.destinationPin as object)
  const source = runtimeOwnedTreeReceipts.get(input.sourceReceipt as object)
  const moved = runtimeOwnedTreeReceipts.get(input.movedReceipt as object)
  if (
    !sourcePin ||
    !destinationPin ||
    sourcePin.disposed ||
    destinationPin.disposed ||
    sourcePin.plan !== input.sourcePlan ||
    destinationPin.plan !== input.destinationPlan ||
    sourcePin.namespace !== destinationPin.namespace ||
    sourcePin.namespace.retired ||
    !source ||
    !source.consumed ||
    !source.disposed ||
    !moved ||
    moved.disposed ||
    moved.consumed ||
    source.rootPath !== sourcePin.treeRootPath ||
    moved.rootPath !== destinationPin.treeRootPath ||
    !sameRuntimeMovedTreeManifest(source.manifest, moved.manifest)
  ) {
    throw new Error('RUNTIME_TREE_PARENT_MOVE_RECEIPT_INVALID')
  }
  const sourceParent = dirname(source.rootPath)
  const destinationParent = dirname(moved.rootPath)
  const sourceName = source.rootPath.slice(sourceParent.length + 1)
  const destinationName = moved.rootPath.slice(destinationParent.length + 1)
  const movedDirectories = new Map(moved.snapshot.directories.map((directory) => [directory.path, directory]))
  const updates: {
    state: TreeParentPinState
    directory: ParentDirectoryState
    version: BigIntStats
    children: string[]
  }[] = []
  for (const pin of [sourcePin, destinationPin]) {
    for (const directory of pin.parentDirectories) {
      const actual = movedDirectories.get(directory.path)
      if (!actual || !sameStableDirectoryOwner(directory.version, actual.version)) {
        throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
      }
      const expected = [...directory.children]
      if (directory.path === sourceParent) {
        const index = expected.indexOf(sourceName)
        if (index < 0) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
        expected.splice(index, 1)
      }
      if (directory.path === destinationParent) {
        if (expected.includes(destinationName)) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
        expected.push(destinationName)
      }
      if (!sameNames(expected, actual.children)) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
      updates.push({ state: pin, directory, version: actual.version, children: [...actual.children] })
    }
  }
  const namespace = sourcePin.namespace
  const namespaceDirectory = movedDirectories.get(namespace.path)
  if (namespaceDirectory) {
    if (!sameStableDirectoryOwner(namespace.rootVersion, namespaceDirectory.version)) {
      throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
    }
    const expected = [...namespace.rootChildren]
    if (sourceParent === namespace.path) {
      const index = expected.indexOf(sourceName)
      if (index < 0) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
      expected.splice(index, 1)
    }
    if (destinationParent === namespace.path) {
      if (expected.includes(destinationName)) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
      expected.push(destinationName)
    }
    if (!sameNames(expected, namespaceDirectory.children)) throw new Error('RUNTIME_TREE_PARENT_MOVE_CHANGED')
  }
  namespace.parent.assertCurrentSync()
  for (const update of updates) {
    update.directory.version = update.version
    update.directory.children = update.children
    update.state.snapshot = replaceDirectory(
      update.state.snapshot,
      update.directory.path,
      update.version,
      update.children
    )
  }
  if (namespaceDirectory) {
    namespace.rootVersion = namespaceDirectory.version
    namespace.rootChildren = [...namespaceDirectory.children]
    sourcePin.snapshot = replaceDirectory(
      sourcePin.snapshot,
      namespace.path,
      namespace.rootVersion,
      namespace.rootChildren
    )
    destinationPin.snapshot = replaceDirectory(
      destinationPin.snapshot,
      namespace.path,
      namespace.rootVersion,
      namespace.rootChildren
    )
  }
}

export function runtimeTreeParentDetails(
  pin: RuntimePackTreeParentPin,
  plan: RuntimePayloadWritePlan,
  assertCallerCurrentSync: () => void
): Readonly<{
  rootPath: string
  parentPath: string
  parentSnapshot: RuntimePhysicalSnapshotInput
  assertCurrentSync(extra?: () => void): void
  assertCurrentAsync(): Promise<void>
  acknowledgeRoot(receipt: Extract<RuntimeDirectoryCreationReceipt, { status: 'created' }>): void
}> {
  const state = treeParentPins.get(pin as object)
  if (!state || state.disposed || state.plan !== plan) throw new Error('RUNTIME_TREE_PARENT_PIN_INVALID')
  return Object.freeze({
    rootPath: state.treeRootPath,
    parentPath: state.treeParentPath,
    parentSnapshot: state.snapshot,
    assertCurrentSync(extra?: () => void): void {
      state.namespace.parent.assertCurrentSync()
      assertCallerCurrentSync()
      extra?.()
    },
    async assertCurrentAsync(): Promise<void> {
      state.namespace.parent.assertCurrentSync()
      assertCallerCurrentSync()
      await assertRuntimePackNamespaceCurrent(state.namespaceHandle)
      await refreshTreeParentChain(state)
      state.namespace.parent.assertCurrentSync()
      assertCallerCurrentSync()
    },
    acknowledgeRoot(receipt): void {
      if (receipt.path !== state.treeRootPath || state.namespace.retired || state.namespace.disposed) {
        state.namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_RECEIPT_INVALID')
      }
      if (state.treeParentPath === state.namespace.path) {
        if (!sameStableDirectoryOwner(state.namespace.rootVersion, receipt.parentVersion)) {
          state.namespace.retired = true
          throw new Error('RUNTIME_TREE_PARENT_CHANGED')
        }
        state.namespace.rootVersion = receipt.parentVersion
        state.namespace.rootChildren = [...receipt.parentChildren]
        state.snapshot = replaceDirectory(
          state.snapshot,
          state.namespace.path,
          receipt.parentVersion,
          receipt.parentChildren
        )
        return
      }
      const parent = state.parentDirectories.at(-1)
      if (
        !parent ||
        parent.path !== state.treeParentPath ||
        !sameStableDirectoryOwner(parent.version, receipt.parentVersion)
      ) {
        state.namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CHANGED')
      }
      parent.version = receipt.parentVersion
      parent.children = [...receipt.parentChildren]
      state.snapshot = replaceDirectory(state.snapshot, parent.path, parent.version, parent.children)
    }
  })
}

export async function disposeRuntimePackNamespace(namespace: RuntimePackNamespace): Promise<void> {
  const state = packNamespaces.get(namespace as object)
  if (!state || state.disposed) return
  state.disposed = true
  await state.parentFile.close().catch(() => undefined)
}

export async function disposeRuntimeTreeParentPin(pin: RuntimePackTreeParentPin): Promise<void> {
  const state = treeParentPins.get(pin as object)
  if (state) state.disposed = true
}
