import {
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type BigIntStats
} from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  MAX_RUNTIME_EXCLUSIVE_FILE_BYTES,
  prepareRuntimeExclusiveFileSink,
  type RuntimeExclusiveFileCreation
} from './runtime-exclusive-file-sink'
import { sameRuntimeFileVersion } from './runtime-file-version'

export { sameRuntimeFileVersion } from './runtime-file-version'
export type {
  RuntimeExclusiveFileCreation,
  RuntimeExclusiveFileReceipt,
  RuntimeExclusiveFileSink
} from './runtime-exclusive-file-sink'

const MAX_RUNTIME_POINTER_BYTES = 64 * 1024
const MAX_RUNTIME_DIRECTORY_ENTRIES = 4096
const MAX_RUNTIME_PHYSICAL_PATH_BYTES = 4 * 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

function readDirectoryNamesSync(directory: string, maxEntries: number): string[] {
  if (maxEntries > MAX_RUNTIME_DIRECTORY_ENTRIES) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  const handle = opendirSync(directory, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = handle.readSync()
      if (entry === null) return names
      if (names.length >= maxEntries) throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
      names.push(entry.name)
    }
  } finally {
    handle.closeSync()
  }
}

export interface RuntimePointerAdmission {
  assertCurrentSync(): void
  dispose(): Promise<void>
}

/** Wait for both pointer preparations and release every capability if either side fails. */
export async function settleRuntimePointerAdmissionPair(
  sourcePreparation: Promise<RuntimePointerAdmission>,
  destinationPreparation: Promise<RuntimePointerAdmission>
): Promise<readonly [RuntimePointerAdmission, RuntimePointerAdmission]> {
  const settled = await Promise.allSettled([sourcePreparation, destinationPreparation])
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    const acquired = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    const disposed = await Promise.allSettled(acquired.map((admission) => admission.dispose()))
    const disposalErrors = disposed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (disposalErrors.length > 0) {
      throw new AggregateError([failure.reason, ...disposalErrors], 'RUNTIME_POINTER_ADMISSION_DISPOSAL_FAILED', {
        cause: failure.reason
      })
    }
    throw failure.reason
  }
  const source = settled[0]
  const destination = settled[1]
  if (source.status !== 'fulfilled' || destination.status !== 'fulfilled') {
    throw new Error('RUNTIME_POINTER_ADMISSION_PREPARATION_INVALID')
  }
  return [source.value, destination.value]
}

/** Prepare a bounded, retained pointer descriptor for the final no-yield ownership check. */
export async function prepareRuntimePointerAdmission(
  path: string,
  expected: BigIntStats | null,
  expectedBytes: Buffer | null,
  maxBytes = MAX_RUNTIME_POINTER_BYTES
): Promise<RuntimePointerAdmission> {
  if (expectedBytes !== null && expectedBytes.byteLength > maxBytes) {
    throw new Error('RUNTIME_INSTALL_POINTER_INVALID')
  }
  if ((expected === null) !== (expectedBytes === null)) throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
  let handle: FileHandle | null = null
  try {
    if (expected !== null) handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  } catch (error) {
    throw error
  }
  if (handle) {
    try {
      const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.size < 0n ||
        opened.size > BigInt(maxBytes) ||
        opened.size !== BigInt(expectedBytes?.byteLength ?? -1) ||
        !sameRuntimeFileVersion(expected, opened) ||
        !sameRuntimeFileVersion(expected, named)
      )
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      const bytes = Buffer.alloc(Number(opened.size) + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
      if (bytesRead !== expectedBytes?.byteLength || !bytes.subarray(0, bytesRead).equals(expectedBytes)) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  } else {
    try {
      await lstat(path)
      throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  let disposed = false
  let consumed = false
  return Object.freeze({
    assertCurrentSync(): void {
      if (disposed || consumed) throw new Error('RUNTIME_INSTALL_POINTER_ADMISSION_INVALID')
      consumed = true
      let namedBefore: BigIntStats
      try {
        namedBefore = lstatSync(path, { bigint: true })
      } catch (error) {
        if (expected === null && expectedBytes === null && (error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (expected === null || expectedBytes === null || !handle) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
      const openedBefore = fstatSync(handle.fd, { bigint: true })
      if (
        !openedBefore.isFile() ||
        openedBefore.nlink !== 1n ||
        openedBefore.size < 0n ||
        openedBefore.size > BigInt(maxBytes) ||
        openedBefore.size !== BigInt(expectedBytes.byteLength) ||
        !sameRuntimeFileVersion(expected, namedBefore) ||
        !sameRuntimeFileVersion(expected, openedBefore)
      )
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      const bytes = Buffer.alloc(Number(expectedBytes.byteLength) + 1)
      const bytesRead = readSync(handle.fd, bytes, 0, bytes.byteLength, 0)
      const openedAfter = fstatSync(handle.fd, { bigint: true })
      const namedAfter = lstatSync(path, { bigint: true })
      if (
        bytesRead !== expectedBytes.byteLength ||
        !bytes.subarray(0, bytesRead).equals(expectedBytes) ||
        !sameRuntimeFileVersion(expected, openedAfter) ||
        !sameRuntimeFileVersion(expected, namedAfter)
      )
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await handle?.close().catch(() => undefined)
    }
  })
}

export function assertRuntimeDirectoryIdentitySync(input: {
  readonly storeRoot: string
  readonly activeRoot: string
  readonly storeRootIdentity: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
  readonly activeRootIdentity: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
}): void {
  assertRuntimeRootVectorSync([
    { path: input.storeRoot, identity: input.storeRootIdentity },
    { path: join(input.storeRoot, 'active'), identity: input.activeRootIdentity }
  ])
}

function assertRuntimeRootVectorSync(
  roots: readonly {
    readonly path: string
    readonly identity?: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
    readonly mustBeAbsent?: boolean
  }[]
): void {
  for (const root of roots) {
    let current: BigIntStats
    try {
      current = lstatSync(root.path, { bigint: true })
    } catch (error) {
      if (root.mustBeAbsent && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (root.mustBeAbsent) throw new Error('RUNTIME_PHYSICAL_DESTINATION_EXISTS')
    if (
      !root.identity ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      root.identity.dev !== current.dev ||
      root.identity.ino !== current.ino ||
      root.identity.birthtimeNs !== current.birthtimeNs ||
      realpathSync(root.path) !== root.path
    ) {
      throw new Error('RUNTIME_INSTALL_ACTIVE_ROOT_CHANGED')
    }
  }
}

export interface RuntimePhysicalAdmission {
  assertCurrentSync(): void
  dispose(): Promise<void>
}

export interface RuntimePhysicalSnapshotInput {
  readonly roots: readonly {
    readonly path: string
    readonly identity?: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
    readonly mustBeAbsent?: boolean
  }[]
  readonly nodes: readonly { readonly path: string; readonly version: BigIntStats }[]
  readonly directories: readonly {
    readonly path: string
    readonly version: BigIntStats
    readonly children: readonly string[]
  }[]
  readonly pointers?: readonly {
    readonly path: string
    readonly version: BigIntStats | null
    readonly bytes: Buffer | null
  }[]
}

export interface RuntimeDirectoryCreationAdmission {
  dispose(): Promise<void>
}

export interface RuntimeExclusiveFileCreationAdmission {
  dispose(): Promise<void>
}

export interface RuntimeEmptyDirectoryRemovalAdmission {
  dispose(): Promise<void>
}

export type RuntimeDirectoryCreationReceipt =
  | {
      readonly status: 'created'
      readonly path: string
      readonly version: BigIntStats
      readonly parentVersion: BigIntStats
      readonly parentChildren: readonly string[]
    }
  | { readonly status: 'created-unconfirmed'; readonly path: string }

export interface RuntimeEmptyDirectoryRemovalReceipt {
  readonly removed: true
  readonly path: string
}

interface PreparedRuntimeMutation {
  readonly path: string
  readonly parentPath: string
  readonly parentVersion: BigIntStats
  readonly parentChildren: readonly string[]
  readonly physical: RuntimePhysicalAdmission
  disposed: boolean
  consumed: boolean
}

const runtimeDirectoryCreationPlans = new WeakMap<object, PreparedRuntimeMutation>()
const runtimeExclusiveFileCreationPlans = new WeakMap<object, PreparedRuntimeMutation>()
const runtimeEmptyDirectoryRemovalPlans = new WeakMap<object, PreparedRuntimeMutation>()

async function readDirectoryNames(path: string, maxEntries: number): Promise<string[]> {
  if (maxEntries > MAX_RUNTIME_DIRECTORY_ENTRIES) throw new Error('RUNTIME_PHYSICAL_LIMIT')
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= maxEntries) throw new Error('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

function sameDirectoryMembers(expected: readonly string[], actual: readonly string[]): boolean {
  return [...expected].sort().join('\0') === [...actual].sort().join('\0')
}

/** Prepare a bounded per-action descriptor vector, then revalidate it in one no-yield pass. */
export async function prepareRuntimePhysicalAdmission(
  input: RuntimePhysicalSnapshotInput
): Promise<RuntimePhysicalAdmission> {
  const nodes = [...input.nodes, ...input.directories.map(({ path, version }) => ({ path, version }))]
  const totalEntries = input.directories.reduce((total, directory) => total + directory.children.length, 0)
  const pointerBytes = (input.pointers ?? []).reduce((total, pointer) => total + (pointer.bytes?.byteLength ?? 0), 0)
  const pathBytes =
    nodes.reduce((total, node) => total + Buffer.byteLength(node.path), 0) +
    input.roots.reduce((total, root) => total + Buffer.byteLength(root.path), 0) +
    input.directories.reduce(
      (total, directory) => total + directory.children.reduce((sum, child) => sum + Buffer.byteLength(child), 0),
      0
    ) +
    (input.pointers ?? []).reduce((total, pointer) => total + Buffer.byteLength(pointer.path), 0)
  if (
    nodes.length + input.roots.length + (input.pointers?.length ?? 0) > MAX_RUNTIME_DIRECTORY_ENTRIES ||
    totalEntries > MAX_RUNTIME_DIRECTORY_ENTRIES ||
    pathBytes > MAX_RUNTIME_PHYSICAL_PATH_BYTES ||
    input.roots.length > 16 ||
    pointerBytes > 2 * (MAX_RUNTIME_POINTER_BYTES + 1)
  ) {
    throw new Error('RUNTIME_PHYSICAL_LIMIT')
  }
  const handles: FileHandle[] = []
  const pointers: RuntimePointerAdmission[] = []
  try {
    if ((input.pointers?.length ?? 0) > 2) throw new Error('RUNTIME_PHYSICAL_LIMIT')
    for (const pointer of input.pointers ?? []) {
      pointers.push(await prepareRuntimePointerAdmission(pointer.path, pointer.version, pointer.bytes))
    }
    for (const node of nodes) {
      const directory = node.version.isDirectory()
      const handle = await open(
        node.path,
        constants.O_RDONLY | NOFOLLOW | NONBLOCK | (directory ? (constants.O_DIRECTORY ?? 0) : 0)
      )
      handles.push(handle)
      const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(node.path, { bigint: true })])
      if (
        (directory ? !opened.isDirectory() : !opened.isFile() || opened.nlink !== 1n) ||
        !sameRuntimeFileVersion(node.version, opened) ||
        !sameRuntimeFileVersion(node.version, named)
      ) {
        throw new Error('RUNTIME_PHYSICAL_NODE_CHANGED')
      }
    }
    for (const directory of input.directories) {
      const names = await readDirectoryNames(directory.path, directory.children.length)
      if (!sameDirectoryMembers(directory.children, names)) throw new Error('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
    }
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()))
    await Promise.allSettled(pointers.map((pointer) => pointer.dispose()))
    throw error
  }
  let disposed = false
  let consumed = false
  const assertRoots = (): void => assertRuntimeRootVectorSync(input.roots)
  const assertNodes = (): void => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      const named = lstatSync(node.path, { bigint: true })
      const opened = fstatSync(handles[index].fd, { bigint: true })
      if (!sameRuntimeFileVersion(node.version, named) || !sameRuntimeFileVersion(node.version, opened)) {
        throw new Error('RUNTIME_PHYSICAL_NODE_CHANGED')
      }
    }
  }
  return Object.freeze({
    assertCurrentSync(): void {
      if (disposed || consumed) throw new Error('RUNTIME_PHYSICAL_ADMISSION_INVALID')
      consumed = true
      assertRoots()
      for (const pointer of pointers) pointer.assertCurrentSync()
      assertNodes()
      for (const directory of input.directories) {
        const actual = readDirectoryNamesSync(directory.path, directory.children.length)
        if (!sameDirectoryMembers(directory.children, actual)) throw new Error('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
      }
      assertNodes()
      assertRoots()
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await Promise.allSettled([
        ...handles.map((handle) => handle.close()),
        ...pointers.map((pointer) => pointer.dispose())
      ])
    }
  })
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

function parentSnapshotForChild(
  path: string,
  parentPath: string,
  snapshot: RuntimePhysicalSnapshotInput,
  childMustExist: boolean
): { readonly version: BigIntStats; readonly children: readonly string[]; readonly name: string } {
  const absolutePath = resolve(path)
  const absoluteParent = resolve(parentPath)
  const name = absolutePath.slice(absoluteParent.length + 1)
  if (
    absolutePath !== path ||
    absoluteParent !== parentPath ||
    !name ||
    name.includes(sep) ||
    dirname(absolutePath) !== absoluteParent
  ) {
    throw new Error('RUNTIME_PHYSICAL_MUTATION_PATH_INVALID')
  }
  const node = snapshot.nodes.find((candidate) => candidate.path === parentPath)
  const directory = snapshot.directories.find((candidate) => candidate.path === parentPath)
  if (!node || !directory || !sameRuntimeFileVersion(node.version, directory.version) || !node.version.isDirectory()) {
    throw new Error('RUNTIME_PHYSICAL_PARENT_SNAPSHOT_INVALID')
  }
  const occurrences = directory.children.filter((child) => child === name).length
  if (childMustExist ? occurrences !== 1 : occurrences !== 0) {
    throw new Error('RUNTIME_PHYSICAL_PARENT_CLOSURE_INVALID')
  }
  return { version: node.version, children: directory.children, name }
}

function preparedMutation(
  map: WeakMap<object, PreparedRuntimeMutation>,
  input: {
    readonly path: string
    readonly parentPath: string
    readonly parent: { readonly version: BigIntStats; readonly children: readonly string[] }
    readonly physical: RuntimePhysicalAdmission
  }
): RuntimeDirectoryCreationAdmission {
  const state: PreparedRuntimeMutation = {
    path: input.path,
    parentPath: input.parentPath,
    parentVersion: input.parent.version,
    parentChildren: [...input.parent.children],
    physical: input.physical,
    disposed: false,
    consumed: false
  }
  const capability = Object.freeze({
    async dispose(): Promise<void> {
      if (state.disposed) return
      state.disposed = true
      await state.physical.dispose()
    }
  })
  map.set(capability, state)
  return capability
}

function consumePreparedMutation(
  map: WeakMap<object, PreparedRuntimeMutation>,
  capability: object
): PreparedRuntimeMutation {
  const state = map.get(capability)
  if (!state || state.disposed || state.consumed) throw new Error('RUNTIME_PHYSICAL_MUTATION_ADMISSION_INVALID')
  state.consumed = true
  return state
}

async function disposePreparedMutation(state: PreparedRuntimeMutation): Promise<void> {
  if (state.disposed) return
  state.disposed = true
  await state.physical.dispose()
}

function assertCreationSnapshot(
  path: string,
  parentPath: string,
  snapshot: RuntimePhysicalSnapshotInput
): {
  readonly version: BigIntStats
  readonly children: readonly string[]
  readonly name: string
} {
  const parent = parentSnapshotForChild(path, parentPath, snapshot, false)
  if (
    snapshot.roots.some((root) => root.path === path) ||
    snapshot.nodes.some((node) => node.path === path) ||
    snapshot.directories.some((directory) => directory.path === path)
  ) {
    throw new Error('RUNTIME_PHYSICAL_MUTATION_TARGET_ALREADY_TRACKED')
  }
  return parent
}

export async function prepareRuntimeDirectoryCreation(input: {
  readonly path: string
  readonly parentPath: string
  readonly snapshot: RuntimePhysicalSnapshotInput
}): Promise<RuntimeDirectoryCreationAdmission> {
  const parent = assertCreationSnapshot(input.path, input.parentPath, input.snapshot)
  const physical = await prepareRuntimePhysicalAdmission({
    ...input.snapshot,
    roots: [...input.snapshot.roots, { path: input.path, mustBeAbsent: true }]
  })
  return preparedMutation(runtimeDirectoryCreationPlans, { ...input, parent, physical })
}

async function captureCreatedDirectory(input: {
  readonly path: string
  readonly parentPath: string
  readonly name: string
  readonly parentVersion: BigIntStats
  readonly expectedParentChildren: readonly string[]
}): Promise<RuntimeDirectoryCreationReceipt> {
  try {
    const [created, parentVersion] = await Promise.all([
      lstat(input.path, { bigint: true }),
      lstat(input.parentPath, { bigint: true })
    ])
    if (
      !created.isDirectory() ||
      created.isSymbolicLink() ||
      !sameStableDirectoryIdentity(input.parentVersion, parentVersion)
    ) {
      return { status: 'created-unconfirmed', path: input.path }
    }
    const parentChildren = await readDirectoryNames(input.parentPath, input.expectedParentChildren.length + 1)
    const expected = [...input.expectedParentChildren, input.name].sort()
    if (!sameDirectoryMembers(expected, parentChildren)) return { status: 'created-unconfirmed', path: input.path }
    return { status: 'created', path: input.path, version: created, parentVersion, parentChildren }
  } catch {
    return { status: 'created-unconfirmed', path: input.path }
  }
}

export async function createRuntimeDirectoryAfterAdmission(
  capability: RuntimeDirectoryCreationAdmission,
  assertCallerCurrentSync: () => void
): Promise<RuntimeDirectoryCreationReceipt> {
  const state = consumePreparedMutation(runtimeDirectoryCreationPlans, capability as object)
  try {
    state.physical.assertCurrentSync()
    assertCallerCurrentSync()
    mkdirSync(state.path, 0o700)
    return await captureCreatedDirectory({
      path: state.path,
      parentPath: state.parentPath,
      name: state.path.slice(state.parentPath.length + 1),
      parentVersion: state.parentVersion,
      expectedParentChildren: state.parentChildren
    })
  } finally {
    await disposePreparedMutation(state)
  }
}

export async function prepareRuntimeExclusiveFileCreation(input: {
  readonly path: string
  readonly parentPath: string
  readonly snapshot: RuntimePhysicalSnapshotInput
}): Promise<RuntimeExclusiveFileCreationAdmission> {
  const parent = assertCreationSnapshot(input.path, input.parentPath, input.snapshot)
  const physical = await prepareRuntimePhysicalAdmission({
    ...input.snapshot,
    roots: [...input.snapshot.roots, { path: input.path, mustBeAbsent: true }]
  })
  return preparedMutation(runtimeExclusiveFileCreationPlans, { ...input, parent, physical })
}

export async function createRuntimeExclusiveFileAfterAdmission(
  capability: RuntimeExclusiveFileCreationAdmission,
  maximumBytes: number,
  assertCallerCurrentSync: () => void
): Promise<RuntimeExclusiveFileCreation> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_RUNTIME_EXCLUSIVE_FILE_BYTES) {
    throw new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT')
  }
  const state = consumePreparedMutation(runtimeExclusiveFileCreationPlans, capability as object)
  try {
    state.physical.assertCurrentSync()
    assertCallerCurrentSync()
    const fd = openSync(
      state.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK,
      0o600
    )
    return await prepareRuntimeExclusiveFileSink({
      fd,
      path: state.path,
      parentPath: state.parentPath,
      parentVersion: state.parentVersion,
      expectedParentChildren: state.parentChildren,
      name: state.path.slice(state.parentPath.length + 1),
      maximumBytes,
      readDirectoryNames
    })
  } finally {
    await disposePreparedMutation(state)
  }
}

export async function prepareRuntimeEmptyDirectoryRemoval(input: {
  readonly path: string
  readonly parentPath: string
  readonly snapshot: RuntimePhysicalSnapshotInput
}): Promise<RuntimeEmptyDirectoryRemovalAdmission> {
  const parent = parentSnapshotForChild(input.path, input.parentPath, input.snapshot, true)
  const targetNode = input.snapshot.nodes.find((node) => node.path === input.path)
  const targetDirectory = input.snapshot.directories.find((directory) => directory.path === input.path)
  const targetRoot = input.snapshot.roots.find((root) => root.path === input.path)
  if (
    !targetNode?.version.isDirectory() ||
    !targetDirectory ||
    targetDirectory.children.length !== 0 ||
    !targetRoot?.identity
  ) {
    throw new Error('RUNTIME_EMPTY_DIRECTORY_SNAPSHOT_INVALID')
  }
  const physical = await prepareRuntimePhysicalAdmission(input.snapshot)
  return preparedMutation(runtimeEmptyDirectoryRemovalPlans, {
    ...input,
    parent,
    physical
  })
}

export async function removeRuntimeEmptyDirectoryAfterAdmission(
  capability: RuntimeEmptyDirectoryRemovalAdmission,
  assertCallerCurrentSync: () => void
): Promise<RuntimeEmptyDirectoryRemovalReceipt> {
  const state = consumePreparedMutation(runtimeEmptyDirectoryRemovalPlans, capability as object)
  try {
    state.physical.assertCurrentSync()
    assertCallerCurrentSync()
    rmdirSync(state.path)
    return { removed: true, path: state.path }
  } finally {
    await disposePreparedMutation(state)
  }
}

export async function removeRuntimeFileAfterAdmission(
  path: string,
  expected: BigIntStats,
  bytes: Buffer,
  assertCallerCurrentSync: () => void = () => undefined
): Promise<boolean> {
  let admission: RuntimePointerAdmission
  try {
    admission = await prepareRuntimePointerAdmission(path, expected, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    admission.assertCurrentSync()
    assertCallerCurrentSync()
    unlinkOwnedSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  } finally {
    await admission.dispose()
  }
}

export async function removeRuntimeOwnedFileAfterAdmission(input: {
  readonly path: string
  readonly expected: BigIntStats
  readonly snapshot: RuntimePhysicalSnapshotInput
  readonly assertCallerCurrentSync: () => void
}): Promise<boolean> {
  const target = input.snapshot.nodes.find((node) => node.path === input.path)
  if (
    !target ||
    !sameRuntimeFileVersion(target.version, input.expected) ||
    !input.expected.isFile() ||
    input.expected.nlink !== 1n
  ) {
    throw new Error('RUNTIME_OWNED_FILE_SNAPSHOT_INVALID')
  }
  const admission = await prepareRuntimePhysicalAdmission(input.snapshot)
  try {
    admission.assertCurrentSync()
    input.assertCallerCurrentSync()
    unlinkOwnedSync(input.path)
    return true
  } finally {
    await admission.dispose()
  }
}

function unlinkOwnedSync(path: string): void {
  unlinkSync(path)
}

export async function renameRuntimeFileAfterAdmission(input: {
  readonly source: string
  readonly destination: string
  readonly sourceVersion: BigIntStats
  readonly sourceBytes: Buffer
  readonly destinationVersion: BigIntStats | null
  readonly destinationBytes: Buffer | null
  readonly assertDestinationSync: () => void
  readonly assertCallerCurrentSync?: () => void
  readonly awaitAdmission: () => Promise<void | (() => void)>
}): Promise<void> {
  const [sourceAdmission, destinationAdmission] = await settleRuntimePointerAdmissionPair(
    prepareRuntimePointerAdmission(input.source, input.sourceVersion, input.sourceBytes),
    prepareRuntimePointerAdmission(input.destination, input.destinationVersion, input.destinationBytes)
  )
  try {
    const finalGuard = await input.awaitAdmission()
    input.assertDestinationSync()
    if (typeof finalGuard === 'function') finalGuard()
    destinationAdmission.assertCurrentSync()
    sourceAdmission.assertCurrentSync()
    input.assertDestinationSync()
    input.assertCallerCurrentSync?.()
    renameOwnedSync(input.source, input.destination)
  } finally {
    await Promise.all([sourceAdmission.dispose(), destinationAdmission.dispose()])
  }
}

export function renameRuntimeDirectorySyncAfterAdmission(input: {
  readonly admission: RuntimePhysicalAdmission
  readonly source: string
  readonly destination: string
  readonly assertCallerCurrentSync: () => void
}): void {
  input.admission.assertCurrentSync()
  input.assertCallerCurrentSync()
  renameOwnedSync(input.source, input.destination)
}

function renameOwnedSync(source: string, destination: string): void {
  renameSync(source, destination)
}

export async function retainRuntimeTreeIfOwnershipIsUnproven(input: {
  readonly root: string
  readonly rootExpected: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
  readonly path: string
  readonly expected: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
}): Promise<boolean> {
  const canonicalRoot = await realpath(input.root)
  const rootStat = await lstat(input.root, { bigint: true })
  if (
    canonicalRoot !== resolve(input.root) ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    input.rootExpected.dev !== rootStat.dev ||
    input.rootExpected.ino !== rootStat.ino ||
    input.rootExpected.birthtimeNs !== rootStat.birthtimeNs
  ) {
    throw new Error('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
  }
  let canonical: string
  try {
    canonical = await realpath(input.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const rel = relative(canonicalRoot, canonical)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(input.path) !== canonical) {
    throw new Error('RUNTIME_INSTALL_CLEANUP_ESCAPE')
  }
  const current = await lstat(canonical, { bigint: true })
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    input.expected.dev !== current.dev ||
    input.expected.ino !== current.ino ||
    input.expected.birthtimeNs !== current.birthtimeNs
  ) {
    throw new Error('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
  }
  // Node has no descriptor-relative recursive unlink API; retain the named tree without chmod/rm.
  return true
}
