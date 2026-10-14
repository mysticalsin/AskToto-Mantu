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
import { runtimePayloadPlanRoot, type RuntimePayloadWritePlan } from './runtime-payload-plan'
import {
  runtimeProfileParentAccess,
  type RuntimeProfileBinding,
  type RuntimeProfileParentAccess,
  type RuntimeProfileParentPin,
  type RuntimeStableOwner
} from './runtime-purpose-root'

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
  readonly snapshot: RuntimePhysicalSnapshotInput
  disposed: boolean
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
}): Promise<RuntimePackTreeParentPin> {
  const namespace = packNamespaces.get(input.namespace as object)
  if (!namespace || namespace.disposed || namespace.retired) throw new Error('RUNTIME_PACK_NAMESPACE_INVALID')
  const plannedRoot = runtimePayloadPlanRoot(input.plan)
  if (input.relativeParent !== '' || !plannedRoot || plannedRoot.includes('/') || plannedRoot.includes('\\')) {
    throw new Error('RUNTIME_TREE_PARENT_NOT_ADMITTED')
  }
  await assertRuntimePackNamespaceCurrent(input.namespace)
  const pin = Object.freeze({}) as RuntimePackTreeParentPin
  treeParentPins.set(pin, {
    namespaceHandle: input.namespace,
    namespace,
    plan: input.plan,
    treeRootPath: join(namespace.path, plannedRoot),
    snapshot: snapshotFor(namespace),
    disposed: false
  })
  return pin
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
    parentPath: state.namespace.path,
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
      state.namespace.parent.assertCurrentSync()
      assertCallerCurrentSync()
    },
    acknowledgeRoot(receipt): void {
      if (receipt.path !== state.treeRootPath || state.namespace.retired || state.namespace.disposed) {
        state.namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_RECEIPT_INVALID')
      }
      if (!sameStableDirectoryOwner(state.namespace.rootVersion, receipt.parentVersion)) {
        state.namespace.retired = true
        throw new Error('RUNTIME_TREE_PARENT_CHANGED')
      }
      state.namespace.rootVersion = receipt.parentVersion
      state.namespace.rootChildren = [...receipt.parentChildren]
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
