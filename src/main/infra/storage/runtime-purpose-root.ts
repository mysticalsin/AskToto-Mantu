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

const MAX_PARENT_CHILDREN = 4096
const PURPOSE = 'metis-speech-pack-owner-key/v1'
declare const runtimeProfileParentPinBrand: unique symbol
declare const runtimeSpeechPackPurposeRootBrand: unique symbol

export type RuntimeStableOwner = Readonly<{
  dev: string
  ino: string
  birthtimeNs: string
  mode: string
  uid: string
  gid: string
  rdev: string
}>

export type RuntimeStableFileOwner = RuntimeStableOwner & Readonly<{ nlink: '1' }>
export type RuntimeProfileBinding = Readonly<{
  profileBinding: string
  principalBinding: string
  persistentProfileGeneration: string
}>
export type RuntimeProfileParentPin = { readonly [runtimeProfileParentPinBrand]: true }
export type RuntimeSpeechPackPurposeRoot = { readonly [runtimeSpeechPackPurposeRootBrand]: true }

interface ParentPinState {
  readonly profilePath: string
  readonly binding: RuntimeProfileBinding
  readonly file: FileHandle
  version: BigIntStats
  children: readonly string[]
  readonly assertCurrentSync: () => void
  readonly assertProfilePhysicalCurrent: () => Promise<void>
  readonly assertSingleInstanceCurrentSync: () => void
  disposed: boolean
  retired: boolean
}

interface PurposeRootState {
  readonly parent: ParentPinState
  readonly path: string
  readonly ownershipParentPath: string
  readonly profileOwner: RuntimeStableOwner
  readonly ownershipParentOwner: RuntimeStableOwner
  readonly rootOwner: RuntimeStableOwner
  readonly bindingId: string
  readonly fresh: boolean
  readonly physical: RuntimePhysicalSnapshotInput
  admission: Awaited<ReturnType<typeof prepareRuntimePhysicalAdmission>> | null
  disposed: boolean
  retired: boolean
}

const parentPins = new WeakMap<object, ParentPinState>()
const purposeRoots = new WeakMap<object, PurposeRootState>()

function assertParentAuthority(state: ParentPinState): void {
  if (state.disposed || state.retired) throw new Error('RUNTIME_PROFILE_PARENT_RETIRED')
  state.assertCurrentSync()
  state.assertSingleInstanceCurrentSync()
}

async function assertParentCurrent(state: ParentPinState): Promise<void> {
  assertParentAuthority(state)
  await state.assertProfilePhysicalCurrent()
  assertParentAuthority(state)
  const [opened, named, canonical, children] = await Promise.all([
    state.file.stat({ bigint: true }),
    lstat(state.profilePath, { bigint: true }),
    realpath(state.profilePath),
    readDirectoryNames(state.profilePath)
  ])
  assertParentAuthority(state)
  if (
    canonical !== state.profilePath ||
    !sameStableDirectoryOwner(state.version, opened) ||
    !sameStableDirectoryOwner(state.version, named) ||
    !sameNames(state.children, children)
  ) {
    state.retired = true
    throw new Error('RUNTIME_PROFILE_PARENT_CHANGED')
  }
}

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
      if (names.length >= MAX_PARENT_CHILDREN) throw new Error('RUNTIME_PROFILE_DIRECTORY_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
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

async function captureDirectory(path: string): Promise<{
  readonly version: BigIntStats
  readonly children: readonly string[]
}> {
  const [canonical, version, children] = await Promise.all([
    realpath(path),
    lstat(path, { bigint: true }),
    readDirectoryNames(path)
  ])
  if (canonical !== path || !version.isDirectory() || version.isSymbolicLink()) {
    throw new Error('RUNTIME_PROFILE_DIRECTORY_INVALID')
  }
  return { version, children }
}

function snapshotWithDirectory(
  snapshot: RuntimePhysicalSnapshotInput,
  path: string,
  version: BigIntStats,
  children: readonly string[]
): RuntimePhysicalSnapshotInput {
  const nodes = snapshot.nodes.filter((node) => node.path !== path)
  nodes.push({ path, version })
  const directories = snapshot.directories.filter((directory) => directory.path !== path)
  directories.push({ path, version, children: [...children] })
  const roots = snapshot.roots.map((root) => (root.path === path ? { path, identity: version } : root))
  return { ...snapshot, nodes, directories, roots }
}

function makeBindingId(input: {
  binding: RuntimeProfileBinding
  profilePath: string
  purposePath: string
  profileOwner: RuntimeStableOwner
  ownershipParentOwner: RuntimeStableOwner
  rootOwner: RuntimeStableOwner
}): string {
  const canonical = JSON.stringify({
    purpose: PURPOSE,
    binding: input.binding,
    profilePath: input.profilePath,
    purposePath: input.purposePath,
    profileOwner: input.profileOwner,
    ownershipParentOwner: input.ownershipParentOwner,
    rootOwner: input.rootOwner
  })
  return createHash('sha256').update('metis-runtime-speech-pack-root/v1\0').update(canonical).digest('hex')
}

export async function captureRuntimeProfileParentPin(input: {
  readonly profilePath: string
  readonly binding: RuntimeProfileBinding
  readonly assertCurrentSync: () => void
  readonly assertProfilePhysicalCurrent: () => Promise<void>
  readonly assertSingleInstanceCurrentSync: () => void
}): Promise<RuntimeProfileParentPin> {
  if (
    !input.binding.profileBinding ||
    !input.binding.principalBinding ||
    !input.binding.persistentProfileGeneration ||
    resolve(input.profilePath) !== input.profilePath
  ) {
    throw new Error('RUNTIME_PROFILE_PARENT_INVALID')
  }
  input.assertCurrentSync()
  input.assertSingleInstanceCurrentSync()
  await input.assertProfilePhysicalCurrent()
  input.assertCurrentSync()
  input.assertSingleInstanceCurrentSync()
  const [canonical, version, children] = await Promise.all([
    realpath(input.profilePath),
    lstat(input.profilePath, { bigint: true }),
    readDirectoryNames(input.profilePath)
  ])
  input.assertCurrentSync()
  input.assertSingleInstanceCurrentSync()
  await input.assertProfilePhysicalCurrent()
  input.assertCurrentSync()
  input.assertSingleInstanceCurrentSync()
  if (canonical !== input.profilePath || !version.isDirectory() || version.isSymbolicLink()) {
    throw new Error('RUNTIME_PROFILE_PARENT_INVALID')
  }
  const file = await open(
    input.profilePath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const [opened, named] = await Promise.all([file.stat({ bigint: true }), lstat(input.profilePath, { bigint: true })])
    input.assertCurrentSync()
    input.assertSingleInstanceCurrentSync()
    await input.assertProfilePhysicalCurrent()
    input.assertCurrentSync()
    input.assertSingleInstanceCurrentSync()
    if (
      !sameRuntimeFileVersion(version, opened) ||
      !sameRuntimeFileVersion(version, named) ||
      !sameNames(children, await readDirectoryNames(input.profilePath))
    ) {
      throw new Error('RUNTIME_PROFILE_PARENT_CHANGED')
    }
    const state: ParentPinState = {
      profilePath: input.profilePath,
      binding: Object.freeze({ ...input.binding }),
      file,
      version,
      children: [...children],
      assertCurrentSync: input.assertCurrentSync,
      assertProfilePhysicalCurrent: input.assertProfilePhysicalCurrent,
      assertSingleInstanceCurrentSync: input.assertSingleInstanceCurrentSync,
      disposed: false,
      retired: false
    }
    const pin = Object.freeze({}) as RuntimeProfileParentPin
    parentPins.set(pin, state)
    return pin
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
}

export async function openRuntimeSpeechPackPurposeRoot(input: {
  readonly parent: RuntimeProfileParentPin
  readonly mode: 'open-existing' | 'create-explicit'
}): Promise<RuntimeSpeechPackPurposeRoot> {
  const parent = parentPins.get(input.parent as object)
  if (!parent) throw new Error('RUNTIME_PROFILE_PARENT_INVALID')
  await assertParentCurrent(parent)
  const ownershipParentPath = join(parent.profilePath, 'component-ownership')
  const rootPath = join(ownershipParentPath, 'speech-packs')
  let parentChildren = [...parent.children]
  let snapshot: RuntimePhysicalSnapshotInput = {
    roots: [{ path: parent.profilePath, identity: parent.version }],
    nodes: [{ path: parent.profilePath, version: parent.version }],
    directories: [{ path: parent.profilePath, version: parent.version, children: parentChildren }]
  }
  let fresh = false
  let ownershipParent: Awaited<ReturnType<typeof captureDirectory>> | null = null
  const ownershipName = 'component-ownership'
  if (!parentChildren.includes(ownershipName)) {
    if (input.mode !== 'create-explicit') throw new Error('RUNTIME_SPEECH_PACK_ROOT_MISSING')
    const receipt = await createDirectoryOwned(parent, snapshot, ownershipParentPath)
    if (receipt.status !== 'created') throw new Error('RUNTIME_SPEECH_PACK_ROOT_UNCONFIRMED')
    parentChildren = [...receipt.parentChildren]
    parent.version = receipt.parentVersion
    parent.children = parentChildren
    snapshot = snapshotWithDirectory(snapshot, parent.profilePath, parent.version, parentChildren)
    ownershipParent = { version: receipt.version, children: [] }
    snapshot = {
      ...snapshot,
      roots: [...snapshot.roots, { path: ownershipParentPath, identity: receipt.version }],
      nodes: [...snapshot.nodes, { path: ownershipParentPath, version: receipt.version }],
      directories: [...snapshot.directories, { path: ownershipParentPath, version: receipt.version, children: [] }]
    }
    fresh = true
  } else {
    ownershipParent = await captureDirectory(ownershipParentPath)
    await assertParentCurrent(parent)
    snapshot = snapshotWithDirectory(snapshot, parent.profilePath, parent.version, parentChildren)
    snapshot = {
      ...snapshot,
      roots: [...snapshot.roots, { path: ownershipParentPath, identity: ownershipParent.version }],
      nodes: [...snapshot.nodes, { path: ownershipParentPath, version: ownershipParent.version }],
      directories: [
        ...snapshot.directories,
        { path: ownershipParentPath, version: ownershipParent.version, children: ownershipParent.children }
      ]
    }
  }
  await assertParentCurrent(parent)
  if (!ownershipParent.children.includes('speech-packs')) {
    if (input.mode !== 'create-explicit') throw new Error('RUNTIME_SPEECH_PACK_ROOT_MISSING')
    const receipt = await createDirectoryOwned(parent, snapshot, rootPath)
    if (receipt.status !== 'created') throw new Error('RUNTIME_SPEECH_PACK_ROOT_UNCONFIRMED')
    ownershipParent = { version: receipt.parentVersion, children: [...receipt.parentChildren] }
    snapshot = snapshotWithDirectory(snapshot, ownershipParentPath, ownershipParent.version, ownershipParent.children)
    snapshot = {
      ...snapshot,
      roots: [...snapshot.roots, { path: rootPath, identity: receipt.version }],
      nodes: [...snapshot.nodes, { path: rootPath, version: receipt.version }],
      directories: [...snapshot.directories, { path: rootPath, version: receipt.version, children: [] }]
    }
    fresh = true
  } else {
    const root = await captureDirectory(rootPath)
    await assertParentCurrent(parent)
    snapshot = snapshotWithDirectory(snapshot, ownershipParentPath, ownershipParent.version, ownershipParent.children)
    snapshot = {
      ...snapshot,
      roots: [...snapshot.roots, { path: rootPath, identity: root.version }],
      nodes: [...snapshot.nodes, { path: rootPath, version: root.version }],
      directories: [...snapshot.directories, { path: rootPath, version: root.version, children: root.children }]
    }
  }
  await assertParentCurrent(parent)
  const rootVersion = snapshot.nodes.find((node) => node.path === rootPath)?.version
  const ownershipVersion = snapshot.nodes.find((node) => node.path === ownershipParentPath)?.version
  if (!rootVersion || !ownershipVersion) throw new Error('RUNTIME_SPEECH_PACK_ROOT_INVALID')
  const profileOwner = stableOwner(parent.version)
  const ownershipParentOwner = stableOwner(ownershipVersion)
  const rootOwner = stableOwner(rootVersion)
  const bindingId = makeBindingId({
    binding: parent.binding,
    profilePath: parent.profilePath,
    purposePath: rootPath,
    profileOwner,
    ownershipParentOwner,
    rootOwner
  })
  const admission = await prepareRuntimePhysicalAdmission(snapshot)
  try {
    await assertParentCurrent(parent)
    admission.assertCurrentSync()
    const root = Object.freeze({}) as RuntimeSpeechPackPurposeRoot
    purposeRoots.set(root, {
      parent,
      path: rootPath,
      ownershipParentPath,
      profileOwner,
      ownershipParentOwner,
      rootOwner,
      bindingId,
      fresh,
      physical: snapshot,
      admission,
      disposed: false,
      retired: false
    })
    return root
  } catch (error) {
    await admission.dispose()
    throw error
  }
}

async function createDirectoryOwned(
  parent: ParentPinState,
  snapshot: RuntimePhysicalSnapshotInput,
  path: string
): Promise<Extract<RuntimeDirectoryCreationReceipt, { readonly status: 'created' | 'created-unconfirmed' }>> {
  await assertParentCurrent(parent)
  const parentPath = dirname(path)
  const admission = await prepareRuntimeDirectoryCreation({ path, parentPath, snapshot })
  await assertParentCurrent(parent)
  const result = await createRuntimeDirectoryAfterAdmission(admission, () => {
    assertParentAuthority(parent)
  })
  if (result.status === 'created') {
    if (parentPath === parent.profilePath) {
      parent.children = [...result.parentChildren]
      parent.version = result.parentVersion
    }
  }
  return result
}

export function describeRuntimeSpeechPackPurposeRoot(root: RuntimeSpeechPackPurposeRoot): Readonly<{
  bindingId: string
  profile: RuntimeProfileBinding
  profileOwner: RuntimeStableOwner
  ownershipParentOwner: RuntimeStableOwner
  rootOwner: RuntimeStableOwner
  rootPath: string
  fresh: boolean
}> {
  const state = purposeRoots.get(root as object)
  if (!state || state.disposed || state.retired) throw new Error('RUNTIME_SPEECH_PACK_ROOT_INVALID')
  return Object.freeze({
    bindingId: state.bindingId,
    profile: state.parent.binding,
    profileOwner: state.profileOwner,
    ownershipParentOwner: state.ownershipParentOwner,
    rootOwner: state.rootOwner,
    rootPath: state.path,
    fresh: state.fresh
  })
}

export async function assertRuntimeSpeechPackPurposeRootCurrent(root: RuntimeSpeechPackPurposeRoot): Promise<void> {
  const state = purposeRoots.get(root as object)
  if (!state || state.disposed || state.retired) throw new Error('RUNTIME_SPEECH_PACK_ROOT_INVALID')
  try {
    await assertParentCurrent(state.parent)
    const [ownershipParent, rootVersion] = await Promise.all([
      captureDirectory(state.ownershipParentPath),
      captureDirectory(state.path)
    ])
    if (
      !sameStableOwnerRecord(state.ownershipParentOwner, stableOwner(ownershipParent.version)) ||
      !sameStableOwnerRecord(state.rootOwner, stableOwner(rootVersion.version))
    ) {
      throw new Error('RUNTIME_SPEECH_PACK_ROOT_CHANGED')
    }
    await assertParentCurrent(state.parent)
    const snapshot: RuntimePhysicalSnapshotInput = {
      roots: [
        { path: state.parent.profilePath, identity: state.parent.version },
        { path: state.ownershipParentPath, identity: ownershipParent.version },
        { path: state.path, identity: rootVersion.version }
      ],
      nodes: [
        { path: state.parent.profilePath, version: state.parent.version },
        { path: state.ownershipParentPath, version: ownershipParent.version },
        { path: state.path, version: rootVersion.version }
      ],
      directories: [
        { path: state.parent.profilePath, version: state.parent.version, children: state.parent.children },
        {
          path: state.ownershipParentPath,
          version: ownershipParent.version,
          children: ownershipParent.children
        },
        { path: state.path, version: rootVersion.version, children: rootVersion.children }
      ]
    }
    const admission = await prepareRuntimePhysicalAdmission(snapshot)
    try {
      await assertParentCurrent(state.parent)
      admission.assertCurrentSync()
    } finally {
      await admission.dispose()
    }
  } catch (error) {
    state.retired = true
    throw error
  }
}

export async function disposeRuntimeProfileParentPin(pin: RuntimeProfileParentPin): Promise<void> {
  const state = parentPins.get(pin as object)
  if (!state || state.disposed) return
  state.disposed = true
  await state.file.close().catch(() => undefined)
}

export async function disposeRuntimeSpeechPackPurposeRoot(root: RuntimeSpeechPackPurposeRoot): Promise<void> {
  const state = purposeRoots.get(root as object)
  if (!state || state.disposed) return
  state.disposed = true
  await state.admission?.dispose()
}

export interface RuntimeProfileParentAccess {
  readonly profilePath: string
  readonly binding: RuntimeProfileBinding
  readonly version: BigIntStats
  readonly children: readonly string[]
  assertCurrentSync(): void
  assertCurrent(): Promise<void>
  recordParentMutation(path: string, version: BigIntStats, children: readonly string[]): void
}

export function runtimeProfileParentAccess(pin: RuntimeProfileParentPin): RuntimeProfileParentAccess {
  const state = parentPins.get(pin as object)
  if (!state || state.disposed || state.retired) throw new Error('RUNTIME_PROFILE_PARENT_INVALID')
  return Object.freeze({
    profilePath: state.profilePath,
    binding: state.binding,
    get version() {
      return state.version
    },
    get children() {
      return state.children
    },
    assertCurrentSync(): void {
      assertParentAuthority(state)
    },
    assertCurrent(): Promise<void> {
      return assertParentCurrent(state)
    },
    recordParentMutation(path: string, version: BigIntStats, children: readonly string[]): void {
      assertParentAuthority(state)
      if (path !== state.profilePath || !sameStableDirectoryOwner(state.version, version)) {
        if (path === state.profilePath) state.retired = true
        throw new Error('RUNTIME_PROFILE_PARENT_MUTATION_INVALID')
      }
      state.version = version
      state.children = [...children]
    }
  })
}
