import {
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  readSync,
  renameSync,
  realpathSync,
  unlinkSync,
  type BigIntStats
} from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const MAX_RUNTIME_POINTER_BYTES = 64 * 1024
const MAX_RUNTIME_DIRECTORY_ENTRIES = 4096
const MAX_RUNTIME_PHYSICAL_PATH_BYTES = 4 * 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

export function sameRuntimeFileVersion(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return a === null || b === null
    ? a === b
    : a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.uid === b.uid &&
        a.gid === b.gid &&
        a.rdev === b.rdev &&
        a.size === b.size &&
        a.blocks === b.blocks &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs &&
        a.birthtimeNs === b.birthtimeNs
}

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
    unlinkSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  } finally {
    await admission.dispose()
  }
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
