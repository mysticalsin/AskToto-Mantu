import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyPrivateCurrentUserAcl } from '../win-security'
import { type NativeKeyStore, createNativeMeetingKeyStore } from './protected-meeting-keys'
import { type OpaqueOperationScope, type OwnedMeetingRoot, type RootRegistry } from './root-registry'

const LEGACY_FILE = 'secret-key.bin'
const MAX_LEGACY_WRAPPED_KEY_BYTES = 16 * 1024

function ownedByCurrentProcess(uid: number | bigint): boolean {
  return process.platform === 'win32' || process.getuid?.() === Number(uid)
}

export interface LegacyFileKeyLease {
  readonly keyBinding: object
  readonly profileNamespace: string
  withKey<T>(use: (owned32Bytes: Uint8Array) => T | Promise<T>): Promise<T>
  retire(): void
  dispose(): Promise<void>
}

export interface ProfileBoundLegacyFileKeyAccess {
  /** Read only. This never creates, migrates, replaces, or caches a legacy key for another root. */
  open(scope: OpaqueOperationScope, root: OwnedMeetingRoot, allowNativeUnlock?: boolean): Promise<LegacyFileKeyLease>
}

export interface ProfileBoundLegacyFileKeyOptions {
  readonly nativeKeyStore?: NativeKeyStore
  readonly roots: RootRegistry
}

interface LeaseState {
  readonly scope: OpaqueOperationScope
  readonly root: OwnedMeetingRoot
  readonly key: Uint8Array
  readonly binding: object
  readonly pending: Set<Promise<unknown>>
  retired: boolean
  disposed: boolean
  disposal: Promise<void> | undefined
}

const states = new WeakMap<LegacyFileKeyLease, LeaseState>()

function strictBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Legacy protected profile key is malformed')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    decoded.fill(0)
    throw new Error('Legacy protected profile key is invalid')
  }
  return new Uint8Array(decoded)
}

async function readBoundedLegacyKey(
  roots: RootRegistry,
  scope: OpaqueOperationScope,
  root: OwnedMeetingRoot
): Promise<Buffer> {
  roots.assertScopeCurrent(scope, root)
  root.assertCurrent()
  await root.assertPhysicalCurrent()
  const path = join(root.legacyProfilePath, LEGACY_FILE)
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    !ownedByCurrentProcess(before.uid) ||
    before.size <= 0n ||
    before.size > BigInt(MAX_LEGACY_WRAPPED_KEY_BYTES)
  ) {
    throw new Error('Legacy profile key is absent or invalid; original bytes were preserved')
  }
  if (process.platform !== 'win32' && (Number(before.mode) & 0o077) !== 0) {
    throw new Error('Legacy profile key permissions are not private')
  }
  const file: FileHandle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = await file.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.uid !== before.uid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > BigInt(MAX_LEGACY_WRAPPED_KEY_BYTES)
    ) {
      throw new Error('Legacy profile key physical version changed; original bytes were preserved')
    }
    if (process.platform === 'win32') {
      if (!(await verifyPrivateCurrentUserAcl(path)))
        throw new Error('Legacy profile key Windows ACL is not private to the current process owner')
      const [afterAcl, heldAfterAcl] = await Promise.all([lstat(path, { bigint: true }), file.stat({ bigint: true })])
      roots.assertScopeCurrent(scope, root)
      await root.assertPhysicalCurrent()
      if (
        !afterAcl.isFile() ||
        afterAcl.isSymbolicLink() ||
        afterAcl.nlink !== 1n ||
        afterAcl.uid !== opened.uid ||
        afterAcl.dev !== opened.dev ||
        afterAcl.ino !== opened.ino ||
        heldAfterAcl.dev !== opened.dev ||
        heldAfterAcl.ino !== opened.ino
      ) {
        throw new Error('Legacy profile key changed during Windows ACL verification')
      }
    }
    const bounded = Buffer.alloc(MAX_LEGACY_WRAPPED_KEY_BYTES + 1)
    let count = 0
    while (count < bounded.length) {
      const next = await file.read(bounded, count, bounded.length - count, count)
      if (next.bytesRead === 0) break
      count += next.bytesRead
    }
    const [named, final] = await Promise.all([lstat(path, { bigint: true }), file.stat({ bigint: true })])
    root.assertCurrent()
    await root.assertPhysicalCurrent()
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      !ownedByCurrentProcess(named.uid) ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      count !== Number(opened.size) ||
      count > MAX_LEGACY_WRAPPED_KEY_BYTES ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.nlink !== 1n ||
      final.uid !== opened.uid ||
      final.size !== opened.size ||
      final.mtimeNs !== opened.mtimeNs ||
      named.mtimeNs !== opened.mtimeNs
    ) {
      bounded.fill(0)
      throw new Error('Legacy profile key changed during bounded read; original bytes were preserved')
    }
    const bytes = Buffer.from(bounded.subarray(0, count))
    bounded.fill(0)
    return bytes
  } finally {
    await file.close()
  }
}

export function createProfileBoundLegacyFileKeyAccess(
  options: ProfileBoundLegacyFileKeyOptions
): ProfileBoundLegacyFileKeyAccess {
  const roots = options.roots
  if (!roots) throw new Error('A main-owned persistence root registry is required')
  const native = options.nativeKeyStore ?? createNativeMeetingKeyStore()

  const retire = (lease: LegacyFileKeyLease): void => {
    const state = states.get(lease)
    if (state) state.retired = true
  }

  const dispose = (lease: LegacyFileKeyLease): Promise<void> => {
    const state = states.get(lease)
    if (!state) return Promise.resolve()
    if (state.disposal) return state.disposal
    if (state.disposed) return Promise.resolve()
    state.retired = true
    const disposal = Promise.allSettled([...state.pending]).then(() => {
      state.key.fill(0)
      state.disposed = true
      states.delete(lease)
    })
    state.disposal = disposal
    return disposal
  }

  const withKey = <T>(lease: LegacyFileKeyLease, use: (owned32Bytes: Uint8Array) => T | Promise<T>): Promise<T> => {
    const state = states.get(lease)
    if (!state || state.retired || state.disposed || state.binding !== lease.keyBinding)
      return Promise.reject(new Error('Legacy profile key lease is retired'))
    try {
      if (typeof use !== 'function') throw new Error('Legacy key callback is required')
      roots.assertScopeCurrent(state.scope, state.root)
      state.root.assertCurrent()
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = Promise.resolve().then(async () => {
      await state.root.assertPhysicalCurrent()
      if (state.retired || state.disposed) throw new Error('Legacy profile key lease is retired')
      const bytes = new Uint8Array(32)
      bytes.set(state.key)
      try {
        const result = await Promise.resolve().then(() => {
          roots.assertScopeCurrent(state.scope, state.root)
          state.root.assertCurrent()
          if (state.retired || state.disposed) throw new Error('Legacy profile key lease is retired')
          return use(bytes)
        })
        roots.assertScopeCurrent(state.scope, state.root)
        state.root.assertCurrent()
        await state.root.assertPhysicalCurrent()
        if (state.retired || state.disposed) throw new Error('Legacy profile key lease was retired during use')
        return result
      } finally {
        bytes.fill(0)
      }
    })
    state.pending.add(operation)
    operation.then(
      () => state.pending.delete(operation),
      () => state.pending.delete(operation)
    )
    return operation
  }

  return {
    async open(scope, root, allowNativeUnlock = false) {
      roots.assertScopeCurrent(scope, root)
      root.assertCurrent()
      if (root.legacyFileKeyAccess !== 'authorized')
        throw new Error('Legacy profile key has no admitted origin; original bytes were not read')
      const bytes = await readBoundedLegacyKey(roots, scope, root)
      let key: Uint8Array | undefined
      try {
        root.assertCurrent()
        if (bytes.byteLength === 32) {
          key = new Uint8Array(bytes)
        } else {
          if (!allowNativeUnlock || root.nativeKeyAccess === 'explicitly-disabled') {
            throw new Error('Legacy protected profile key is locked; original bytes were preserved')
          }
          const backend = native.selectedBackend()
          if (!backend) throw new Error('Legacy native key access is unavailable; original bytes were preserved')
          const plaintext = native.unwrap(bytes)
          roots.assertScopeCurrent(scope, root)
          root.assertCurrent()
          if (native.selectedBackend() !== backend) throw new Error('Legacy key backend changed during explicit unlock')
          key = strictBase64(plaintext)
        }
        await root.assertPhysicalCurrent()
        const binding = Object.freeze({})
        let lease: LegacyFileKeyLease
        lease = Object.freeze({
          keyBinding: binding,
          profileNamespace: root.profileNamespace,
          withKey: <T>(use: (owned32Bytes: Uint8Array) => T | Promise<T>) => withKey(lease, use),
          retire: () => retire(lease),
          dispose: () => dispose(lease)
        })
        states.set(lease, {
          scope,
          root,
          key,
          binding,
          pending: new Set(),
          retired: false,
          disposed: false,
          disposal: undefined
        })
        key = undefined
        return lease
      } finally {
        bytes.fill(0)
        key?.fill(0)
      }
    }
  }
}
