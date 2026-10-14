import { app } from 'electron'
import { constants } from 'node:fs'
import { mkdir, open, realpath, lstat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { preparePrivateCurrentUserAcl, verifyPrivateCurrentUserAcl } from '../win-security'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SAFE_COMPONENT = /^[A-Za-z0-9_-]{1,128}$/

export interface RootScopeBinding {
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly generation: string
  /** Captured before main applies the legacy macOS boot default. */
  readonly nativeKeyAccess: 'allowed' | 'explicitly-disabled'
  /** Main-owned per-file legacy-origin admission; never inferred from profile decryption. */
  readonly legacyFileKeyAccess: 'authorized' | 'denied'
  /** Resource-policy bound for simultaneously held physical root descriptors. */
  readonly maxHeldRoots: number
  isCurrent(): boolean
}

export type OpaqueOperationScope = object
export type RootOpenMode = 'create' | 'open-existing'

export interface RootVersion {
  readonly canonicalPath: string
  readonly parentDevice: number | bigint
  readonly parentInode: number | bigint
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly ownerUid: number | bigint
  readonly parentOwnerUid: number | bigint
}

/** Opaque main-process lease; the public fields are closed identities, never caller-provided paths. */
export interface OwnedMeetingRoot {
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly ownerGeneration: string
  readonly nativeKeyAccess: RootScopeBinding['nativeKeyAccess']
  readonly legacyFileKeyAccess: RootScopeBinding['legacyFileKeyAccess']
  readonly meetingId: string
  readonly rootPath: string
  readonly meetingPath: string
  readonly legacyProfilePath: string
  readonly rootBinding: object
  readonly version: RootVersion
  assertCurrent(): void
  assertPhysicalCurrent(): Promise<void>
  retire(): void
}

export interface WriterLease {
  readonly root: OwnedMeetingRoot
  readonly lockPath: string
  assertCurrent(): void
  assertPhysicalCurrent(): Promise<void>
  release(): Promise<void>
}

export interface RootRegistryOptions {
  /** App-owned profile base; no renderer or document path is accepted. */
  userDataRoot?: () => string
  /** Accepts only handles minted by the main-owned authority service. */
  resolveScope: (scope: OpaqueOperationScope) => RootScopeBinding | undefined
  /** Rebind the exact physical root into the app-owned storage gateway. Mandatory in production. */
  bindGatewayRoot: (root: OwnedMeetingRoot) => Promise<void>
}

interface PhysicalIdentity {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly size: number | bigint
}

interface HeldRoot {
  readonly scope: OpaqueOperationScope
  readonly binding: RootScopeBinding
  readonly root: OwnedMeetingRoot
  readonly directory: FileHandle
  readonly disposed: { value: boolean }
  closing?: Promise<void>
}

interface HeldWriter {
  readonly held: HeldRoot
  readonly lock: FileHandle
  readonly identity: PhysicalIdentity
  released: boolean
}

const heldRoots = new WeakMap<OwnedMeetingRoot, HeldRoot>()
const heldWriters = new WeakMap<WriterLease, HeldWriter>()

function assertComponent(value: string, label: string): void {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`Invalid ${label}`)
}

function sameIdentity(
  a: { dev: number | bigint; ino: number | bigint },
  b: { dev: number | bigint; ino: number | bigint }
): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function isCurrentProcessOwner(uid: number | bigint): boolean {
  return process.platform === 'win32' || process.getuid?.() === Number(uid)
}

async function secureDirectory(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Persistence root is not a physical directory')
  if (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)
    throw new Error('Persistence root permissions are not owner-only')
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await secureDirectory(path)
}

async function createMeetingDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: PRIVATE_DIR_MODE })
  await secureDirectory(path)
}

/** App-owned private roots and exclusive writer leases for retained meeting journals. */
export class RootRegistry {
  private readonly rootBase: () => string
  private readonly resolveScope: RootRegistryOptions['resolveScope']
  private readonly bindGatewayRoot: (root: OwnedMeetingRoot) => Promise<void>
  private readonly retiredScopes = new WeakSet<object>()
  private heldRootCount = 0

  constructor(options: RootRegistryOptions) {
    if (!options.resolveScope) throw new Error('A main-owned persistence scope resolver is required')
    this.rootBase = options.userDataRoot ?? (() => app.getPath('userData'))
    this.resolveScope = options.resolveScope
    if (typeof options.bindGatewayRoot !== 'function')
      throw new Error('A main-owned storage gateway binder is required')
    this.bindGatewayRoot = options.bindGatewayRoot
  }

  /** Explicit new-generation path. Existing profile paths are verified and never overwritten. */
  create(scope: OpaqueOperationScope, meetingId: string): Promise<OwnedMeetingRoot> {
    return this.open(scope, meetingId, 'create')
  }

  /** Read-only reopen. Missing namespace/root components remain missing. */
  openExisting(scope: OpaqueOperationScope, meetingId: string): Promise<OwnedMeetingRoot> {
    return this.open(scope, meetingId, 'open-existing')
  }

  private async open(scope: OpaqueOperationScope, meetingId: string, mode: RootOpenMode): Promise<OwnedMeetingRoot> {
    const binding = this.captureScope(scope)
    if (this.heldRootCount >= binding.maxHeldRoots) throw new Error('Persistence root descriptor limit reached')
    this.heldRootCount += 1
    let reservedRootSlot = true
    let openedDirectory: FileHandle | undefined
    let openedRoot: OwnedMeetingRoot | undefined
    try {
      assertComponent(meetingId, 'meeting identifier')
      const canonicalBase = await realpath(resolve(this.rootBase()))
      this.assertScope(scope, binding)
      const persistencePath = join(canonicalBase, 'persistence-v2')
      const profilePath = join(persistencePath, binding.profileNamespace)
      const meetingsPath = join(profilePath, 'meetings')
      const meetingPath = join(meetingsPath, meetingId)

      if (mode === 'create') {
        await ensureDirectory(persistencePath)
        this.assertScope(scope, binding)
        await ensureDirectory(profilePath)
        this.assertScope(scope, binding)
        await ensureDirectory(meetingsPath)
        this.assertScope(scope, binding)
        await createMeetingDirectory(meetingPath)
      }
      this.assertScope(scope, binding)

      for (const path of [persistencePath, profilePath, meetingsPath, meetingPath]) {
        const component = await lstat(path, { bigint: true })
        const canonicalComponent = await realpath(path)
        if (!component.isDirectory() || component.isSymbolicLink() || resolve(canonicalComponent) !== resolve(path)) {
          throw new Error('Persistence root contains a redirected physical directory')
        }
        if (process.platform !== 'win32' && (Number(component.mode) & 0o077) !== 0) {
          throw new Error('Persistence root permissions are not owner-only')
        }
        if (!isCurrentProcessOwner(component.uid))
          throw new Error('Persistence root owner does not match the current process')
        if (process.platform === 'win32') {
          const aclIdentity = { dev: component.dev, ino: component.ino }
          const privateAclReady =
            mode === 'create' ? await preparePrivateCurrentUserAcl(path) : await verifyPrivateCurrentUserAcl(path)
          if (!privateAclReady)
            throw new Error('Persistence root Windows ACL is not private to the current process owner')
          this.assertScope(scope, binding)
          const afterAcl = await lstat(path, { bigint: true })
          if (!afterAcl.isDirectory() || afterAcl.isSymbolicLink() || !sameIdentity(afterAcl, aclIdentity)) {
            throw new Error('Persistence root changed during Windows ACL verification')
          }
        }
        this.assertScope(scope, binding)
      }

      const canonicalMeetings = await realpath(meetingsPath)
      const canonicalMeeting = await realpath(meetingPath)
      const parent = await lstat(canonicalMeetings, { bigint: true })
      const final = await lstat(canonicalMeeting, { bigint: true })
      if (
        resolve(canonicalMeeting) !== resolve(join(canonicalMeetings, meetingId)) ||
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        !final.isDirectory() ||
        final.isSymbolicLink()
      )
        throw new Error('Persistence root physical identity is invalid')

      const directory = await open(
        canonicalMeeting,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
      )
      openedDirectory = directory
      const opened = await directory.stat({ bigint: true })
      this.assertScope(scope, binding)
      if (!opened.isDirectory() || !sameIdentity(opened, final)) {
        throw new Error('Persistence root changed while opening')
      }
      const version: RootVersion = Object.freeze({
        canonicalPath: canonicalMeeting,
        parentDevice: parent.dev,
        parentInode: parent.ino,
        device: final.dev,
        inode: final.ino,
        ownerUid: final.uid,
        parentOwnerUid: parent.uid
      })
      const rootBinding = Object.freeze({})
      const disposed = { value: false }
      const root: OwnedMeetingRoot = Object.freeze({
        profileNamespace: binding.profileNamespace,
        principalAssociation: binding.principalAssociation,
        ownerGeneration: binding.generation,
        meetingId,
        rootPath: canonicalMeeting,
        meetingPath: canonicalMeeting,
        legacyProfilePath: canonicalBase,
        nativeKeyAccess: binding.nativeKeyAccess,
        legacyFileKeyAccess: binding.legacyFileKeyAccess,
        rootBinding,
        version,
        assertCurrent: () => this.assertRoot(root, scope),
        assertPhysicalCurrent: () => this.assertPhysicalRoot(scope, root),
        retire: () => {
          this.retireScope(scope)
          disposed.value = true
        }
      })
      openedRoot = root
      const held: HeldRoot = { scope, binding, root, directory, disposed }
      heldRoots.set(root, held)
      await this.bindGatewayRoot(root)
      await this.assertPhysicalRoot(scope, root)
      reservedRootSlot = false
      return root
    } catch (error) {
      if (openedRoot) heldRoots.delete(openedRoot)
      if (openedDirectory) await openedDirectory.close().catch(() => undefined)
      if (reservedRootSlot) this.heldRootCount -= 1
      throw error
    }
  }

  /** New-journal single-writer ownership; a stale lock after process death fails closed. */
  async acquireWriter(scope: OpaqueOperationScope, root: OwnedMeetingRoot): Promise<WriterLease> {
    const held = this.requireRoot(scope, root)
    await this.assertPhysicalRoot(scope, root)
    const lockPath = join(root.meetingPath, '.journal-writer.lock')
    const lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE
    )
    let identity: PhysicalIdentity | undefined
    try {
      const createdLock = await lock.stat({ bigint: true })
      identity = { dev: createdLock.dev, ino: createdLock.ino, size: createdLock.size }
      if (process.platform === 'win32' && !(await preparePrivateCurrentUserAcl(lockPath)))
        throw new Error('Persistence writer-lock Windows ACL could not be made private')
      this.assertRoot(root, scope)
      const [preparedPath, preparedHandle] = await Promise.all([
        lstat(lockPath, { bigint: true }),
        lock.stat({ bigint: true })
      ])
      if (
        !preparedPath.isFile() ||
        preparedPath.isSymbolicLink() ||
        preparedPath.nlink !== 1n ||
        !sameIdentity(preparedPath, createdLock) ||
        !sameIdentity(preparedHandle, createdLock) ||
        preparedPath.size !== 0n ||
        preparedHandle.size !== 0n
      ) {
        throw new Error('Persistence writer lock changed during ACL preparation')
      }
      const marker = Buffer.from(`${root.ownerGeneration}:${randomBytes(12).toString('hex')}`, 'utf8')
      await lock.writeFile(marker)
      await lock.sync()
      marker.fill(0)
      const stat = await lock.stat({ bigint: true })
      identity = { dev: stat.dev, ino: stat.ino, size: stat.size }
      const lease: WriterLease = Object.freeze({
        root,
        lockPath,
        assertCurrent: () => {
          this.assertRoot(root, scope)
          const owner = heldWriters.get(lease)
          if (!owner || owner.released || !sameIdentity(owner.identity, identity!))
            throw new Error('Persistence writer lease changed')
        },
        assertPhysicalCurrent: async () => {
          this.assertRoot(root, scope)
          const owner = heldWriters.get(lease)
          if (!owner || owner.released) throw new Error('Persistence writer lease changed')
          const [opened, named] = await Promise.all([
            owner.lock.stat({ bigint: true }),
            lstat(lockPath, { bigint: true })
          ])
          this.assertRoot(root, scope)
          if (
            !opened.isFile() ||
            !named.isFile() ||
            named.isSymbolicLink() ||
            !sameIdentity(opened, owner.identity) ||
            !sameIdentity(named, owner.identity)
          ) {
            throw new Error('Persistence writer lock physical version changed')
          }
        },
        release: () => this.releaseWriter(lease)
      })
      heldWriters.set(lease, { held, lock, identity, released: false })
      await this.assertPhysicalRoot(scope, root)
      lease.assertCurrent()
      return lease
    } catch (error) {
      await lock.close().catch(() => undefined)
      if (identity) {
        const current = await lstat(lockPath, { bigint: true }).catch(() => undefined)
        if (current && sameIdentity(current, identity) && current.isFile() && !current.isSymbolicLink())
          await unlink(lockPath).catch(() => undefined)
      }
      throw error
    }
  }

  /** Synchronous revocation blocks new work immediately; descriptor close waits for owned work. */
  retire(root: OwnedMeetingRoot): void {
    const held = heldRoots.get(root)
    if (held) {
      this.retireScope(held.scope)
      held.disposed.value = true
    }
  }

  /** Monotonic synchronous retirement; restoring old settings cannot renew this operation. */
  retireScope(scope: OpaqueOperationScope): void {
    if (scope && typeof scope === 'object') this.retiredScopes.add(scope)
  }

  async closeRoot(scope: OpaqueOperationScope, root: OwnedMeetingRoot): Promise<void> {
    const held = heldRoots.get(root)
    if (!held) return
    if (held.scope !== scope || held.root !== root) throw new Error('Persistence root capability unavailable')
    if (held.closing) return held.closing
    held.disposed.value = true
    // Retirement denies new operations but disposal remains available to settle the held descriptor.
    held.closing = (async () => {
      await held.directory.close()
      heldRoots.delete(root)
      this.heldRootCount -= 1
    })()
    return held.closing
  }

  /** Assert that the exact captured operation token owns this root, including on read-only paths. */
  assertScopeCurrent(scope: OpaqueOperationScope, root: OwnedMeetingRoot): void {
    this.requireRoot(scope, root)
  }

  secureOwnedPath(scope: OpaqueOperationScope, root: OwnedMeetingRoot, path: string): void {
    this.assertRoot(root, scope)
    if (
      dirname(resolve(path)) !== root.meetingPath ||
      !basename(path) ||
      basename(path) === '.' ||
      basename(path) === '..'
    ) {
      throw new Error('Persistence file escaped its owned root')
    }
  }

  async syncDirectory(scope: OpaqueOperationScope, root: OwnedMeetingRoot): Promise<void> {
    const held = this.requireRoot(scope, root)
    await this.assertPhysicalRoot(scope, root)
    await held.directory.sync()
    await this.assertPhysicalRoot(scope, root)
  }

  async assertPhysicalRoot(scope: OpaqueOperationScope, root: OwnedMeetingRoot): Promise<void> {
    const held = this.requireRoot(scope, root)
    const [fd, named, parent] = await Promise.all([
      held.directory.stat({ bigint: true }),
      lstat(root.meetingPath, { bigint: true }),
      lstat(dirname(root.meetingPath), { bigint: true })
    ])
    this.assertRoot(root, scope)
    if (
      !fd.isDirectory() ||
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      fd.dev !== root.version.device ||
      fd.ino !== root.version.inode ||
      named.dev !== root.version.device ||
      named.ino !== root.version.inode ||
      parent.dev !== root.version.parentDevice ||
      parent.ino !== root.version.parentInode ||
      named.uid !== root.version.ownerUid ||
      parent.uid !== root.version.parentOwnerUid ||
      !isCurrentProcessOwner(named.uid) ||
      !isCurrentProcessOwner(parent.uid) ||
      (process.platform !== 'win32' && ((Number(named.mode) & 0o077) !== 0 || (Number(parent.mode) & 0o077) !== 0))
    )
      throw new Error('Persistence root physical version changed')
  }

  private requireRoot(scope: OpaqueOperationScope, root: OwnedMeetingRoot): HeldRoot {
    const held = heldRoots.get(root)
    if (!held || held.scope !== scope || held.root !== root) throw new Error('Persistence root capability unavailable')
    this.assertScope(scope, held.binding)
    if (held.disposed.value) throw new Error('Persistence root retired')
    return held
  }

  private assertRoot(root: OwnedMeetingRoot, scope: OpaqueOperationScope): void {
    const held = heldRoots.get(root)
    if (!held || held.scope !== scope || held.disposed.value) throw new Error('Persistence root retired')
    this.assertScope(scope, held.binding)
  }

  private captureScope(scope: OpaqueOperationScope): RootScopeBinding {
    if (!scope || typeof scope !== 'object' || this.retiredScopes.has(scope))
      throw new Error('Persistence owner unavailable')
    const binding = this.resolveScope(scope)
    if (!binding || typeof binding.isCurrent !== 'function') throw new Error('Persistence owner unavailable')
    this.assertScope(scope, binding)
    return binding
  }

  private assertScope(scope: OpaqueOperationScope, original: RootScopeBinding): void {
    if (this.retiredScopes.has(scope)) throw new Error('Persistence owner permanently retired')
    const current = this.resolveScope(scope)
    if (
      current !== original ||
      !current?.isCurrent() ||
      current.profileNamespace !== original.profileNamespace ||
      current.principalAssociation !== original.principalAssociation ||
      current.generation !== original.generation ||
      current.nativeKeyAccess !== original.nativeKeyAccess ||
      current.legacyFileKeyAccess !== original.legacyFileKeyAccess ||
      current.maxHeldRoots !== original.maxHeldRoots
    )
      throw new Error('Persistence owner retired or changed')
    assertComponent(current.profileNamespace, 'profile namespace')
    assertComponent(current.principalAssociation, 'principal association')
    assertComponent(current.generation, 'owner generation')
    if (
      !['allowed', 'explicitly-disabled'].includes(current.nativeKeyAccess) ||
      !['authorized', 'denied'].includes(current.legacyFileKeyAccess)
    ) {
      throw new Error('Persistence owner key policy is invalid')
    }
    if (!Number.isSafeInteger(current.maxHeldRoots) || current.maxHeldRoots < 1) {
      throw new Error('Persistence root-handle policy limit is invalid')
    }
  }

  private async releaseWriter(lease: WriterLease): Promise<void> {
    const owner = heldWriters.get(lease)
    if (!owner || owner.released) return
    owner.released = true
    try {
      const current = await lstat(lease.lockPath, { bigint: true })
      if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, owner.identity))
        await unlink(lease.lockPath)
    } finally {
      await owner.lock.close()
      heldWriters.delete(lease)
    }
  }
}
