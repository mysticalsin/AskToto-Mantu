import { createHash } from 'node:crypto'
import { readFileSync, statSync, type Stats } from 'node:fs'
import { constants as fsConstants, lstat, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const MAX_TRUSTED_ADMIN_MANAGED_BYTES = 1_048_576
const TRUSTED_ADMIN_READ_CHUNK_BYTES = 64 * 1024

type AclProbe = {
  owner: string
  processOwner?: string
  aces: { sid: string; rights: number; type: string }[]
}

function sameTrustedAdminSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

export type ManagedPolicyAuthorityRead =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'present'; bytes: Uint8Array }

type AuthorityStat = Readonly<{
  kind: 'file' | 'directory'
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  uid: number
  gid: number
  mode: number
}>
type AuthorityPathPinRecord = Readonly<{
  path: string
  target: AuthorityStat | null
  ancestors: readonly Readonly<{ path: string; stat: AuthorityStat }>[]
  missingBase: string
  missing: readonly string[]
}>
declare const authoritySourcePinBrand: unique symbol
export type AuthoritySourcePin = Readonly<{ [authoritySourcePinBrand]: true }>
const authoritySourcePins = new WeakMap<object, AuthorityPathPinRecord>()
const managedReadPins = new WeakMap<object, Readonly<{ pin: AuthoritySourcePin; requireAdminTrust: boolean }>>()

function authorityStat(stats: Stats): AuthorityStat | null {
  if (stats.isSymbolicLink()) return null
  if (!stats.isFile() && !stats.isDirectory()) return null
  return Object.freeze({
    kind: stats.isFile() ? 'file' : 'directory',
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode
  })
}

function sameAuthorityStat(left: AuthorityStat | null, right: AuthorityStat | null): boolean {
  return (
    !!left &&
    !!right &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  )
}

function sameAuthorityPathPinRecord(left: AuthorityPathPinRecord, right: AuthorityPathPinRecord): boolean {
  return (
    left.path === right.path &&
    ((left.target === null && right.target === null) || sameAuthorityStat(left.target, right.target)) &&
    left.missingBase === right.missingBase &&
    JSON.stringify(left.missing) === JSON.stringify(right.missing) &&
    left.ancestors.length === right.ancestors.length &&
    left.ancestors.every((ancestor, index) => {
      const other = right.ancestors[index]
      return !!other && ancestor.path === other.path && sameAuthorityStat(ancestor.stat, other.stat)
    })
  )
}

export function sameAuthoritySourcePinIdentity(left: AuthoritySourcePin, right: AuthoritySourcePin): boolean {
  const leftRecord = authoritySourcePins.get(left as object)
  const rightRecord = authoritySourcePins.get(right as object)
  return !!leftRecord && !!rightRecord && sameAuthorityPathPinRecord(leftRecord, rightRecord)
}

/** Capture a private, non-payload pin for a regular file or a verified missing path. */
export async function captureAuthoritySourcePin(path: string): Promise<AuthoritySourcePin | null> {
  if (!path || typeof path !== 'string') return null
  const absolute = resolve(path)
  const parsed = parse(absolute)
  const root = parsed.root
  // Device namespace paths have different parsing and trust semantics (for example \\?\C:\).
  if (!root || !isAbsolute(absolute) || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) return null
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  if (parts.length > 64) return null
  let current = root
  let missingBase = root
  const ancestors: Array<{ path: string; stat: AuthorityStat }> = []
  let target: AuthorityStat | null = null
  const missing: string[] = []
  try {
    const rootSnapshot = authorityStat(await lstat(root))
    if (!rootSnapshot || rootSnapshot.kind !== 'directory') return null
    ancestors.push(Object.freeze({ path: root, stat: rootSnapshot }))
    for (let i = 0; i < parts.length; i += 1) {
      const parent = current
      current = join(current, parts[i])
      let stats: Stats
      try {
        stats = await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
        // Revalidation must inspect the first missing component from its existing parent.
        // Saving `current` here would append that same component a second time later.
        missingBase = parent
        missing.push(...parts.slice(i))
        break
      }
      const snapshot = authorityStat(stats)
      if (!snapshot) return null
      if (i === parts.length - 1) {
        if (snapshot.kind !== 'file') return null
        target = snapshot
      } else {
        if (snapshot.kind !== 'directory') return null
        ancestors.push(Object.freeze({ path: current, stat: snapshot }))
      }
    }
    const pin = Object.freeze(Object.create(null)) as AuthoritySourcePin
    authoritySourcePins.set(
      pin as object,
      Object.freeze({
        path: absolute,
        target,
        ancestors: Object.freeze(ancestors),
        missingBase,
        missing: Object.freeze(missing)
      })
    )
    return pin
  } catch {
    return null
  }
}

/** Revalidate only the original namespace witness. A mismatch permanently retires that pin. */
export async function assertAuthoritySourcePinCurrent(pin: AuthoritySourcePin): Promise<void> {
  const record = authoritySourcePins.get(pin as object)
  if (!record) throw new Error('Unknown authority source pin')
  try {
    for (const ancestor of record.ancestors) {
      const current = authorityStat(await lstat(ancestor.path))
      if (!sameAuthorityStat(ancestor.stat, current)) throw new Error('Authority parent changed')
    }
    if (record.target) {
      const current = authorityStat(await lstat(record.path))
      if (!sameAuthorityStat(record.target, current)) throw new Error('Authority source changed')
    } else {
      let current = record.missingBase
      for (const component of record.missing) {
        current = join(current, component)
        try {
          await lstat(current)
          throw new Error('Previously absent authority source appeared')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  } catch (error) {
    authoritySourcePins.delete(pin as object)
    throw error
  }
}

/** Report whether this exact private pin proved a missing path at capture time. */
export function isAuthoritySourcePinAbsent(pin: AuthoritySourcePin): boolean {
  const record = authoritySourcePins.get(pin as object)
  return !!record && record.target === null && record.missing.length > 0
}

/** Read bounded regular-file bytes from one verified descriptor; optionally require machine ACL trust. */
export async function readManagedPolicyAuthorityFileImpl(
  path: string,
  maxBytes: number,
  requireAdminTrust: boolean,
  trust: Readonly<{
    readAcl(path: string): AclProbe | null
    evaluateAclTrust(acl: AclProbe): boolean
    warnUntrusted(path: string): void
  }>
): Promise<ManagedPolicyAuthorityRead> {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_TRUSTED_ADMIN_MANAGED_BYTES
  )
    return { status: 'invalid' }

  let beforeOpen: Stats
  try {
    beforeOpen = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'invalid' }
    const pin = await captureAuthoritySourcePin(path)
    if (!pin || !isAuthoritySourcePinAbsent(pin)) return { status: 'invalid' }
    const absent = Object.freeze({ status: 'absent' as const })
    managedReadPins.set(absent, Object.freeze({ pin, requireAdminTrust }))
    return absent
  }
  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isFile() ||
    !Number.isSafeInteger(beforeOpen.size) ||
    beforeOpen.size < 0 ||
    beforeOpen.size > maxBytes
  )
    return { status: 'invalid' }

  const sourcePin = await captureAuthoritySourcePin(path)
  const pinnedSource = sourcePin && authoritySourcePins.get(sourcePin as object)
  const pinStat = pinnedSource?.target
  if (!sourcePin || !pinStat || !sameAuthorityStat(pinStat, authorityStat(beforeOpen))) return { status: 'invalid' }

  let handle: FileHandle
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      // A hostile path replacement with a FIFO must not leave the main process blocked in open().
      (fsConstants.O_NONBLOCK ?? 0)
    handle = await open(path, flags)
  } catch {
    return { status: 'invalid' }
  }

  let verifiedRead: Extract<ManagedPolicyAuthorityRead, { status: 'present' }> | null = null
  let closeFailed = false
  try {
    const opened = await handle.stat()
    const pathAtOpen = await lstat(path)
    if (!sameTrustedAdminSnapshot(beforeOpen, opened) || !sameTrustedAdminSnapshot(beforeOpen, pathAtOpen))
      return { status: 'invalid' }

    if (requireAdminTrust && process.platform === 'win32') {
      // Raw bytes establish fresh policy authority; the legacy path-only helpers keep their short ACL memo.
      const acl = trust.readAcl(path)
      const trusted = acl !== null && trust.evaluateAclTrust(acl)
      if (!trusted) {
        trust.warnUntrusted(path)
        return { status: 'invalid' }
      }
      const pathAfterAcl = await lstat(path)
      const fdAfterAcl = await handle.stat()
      if (!sameTrustedAdminSnapshot(beforeOpen, pathAfterAcl) || !sameTrustedAdminSnapshot(beforeOpen, fdAfterAcl))
        return { status: 'invalid' }
    }

    // One extra byte detects growth beyond the caller's cap without allocating according to file size.
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total <= maxBytes) {
      const length = Math.min(TRUSTED_ADMIN_READ_CHUNK_BYTES, maxBytes + 1 - total)
      const { bytesRead } = await handle.read(buffer, total, length, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) return { status: 'invalid' }

    const afterRead = await handle.stat()
    const pathAfterRead = await lstat(path)
    if (
      !sameTrustedAdminSnapshot(beforeOpen, afterRead) ||
      !sameTrustedAdminSnapshot(beforeOpen, pathAfterRead) ||
      total !== afterRead.size
    )
      return { status: 'invalid' }

    await assertAuthoritySourcePinCurrent(sourcePin)
    verifiedRead = Object.freeze({ status: 'present' as const, bytes: Buffer.from(buffer.subarray(0, total)) })
  } catch {
    return { status: 'invalid' }
  } finally {
    try {
      await handle.close()
    } catch {
      closeFailed = true
    }
  }
  if (!verifiedRead || closeFailed) return { status: 'invalid' }
  managedReadPins.set(verifiedRead, Object.freeze({ pin: sourcePin, requireAdminTrust }))
  return verifiedRead
}

/** Revalidate the original checked source attached to this exact successful managed read object. */
export async function assertManagedPolicyAuthorityReadCurrentImpl(
  read: ManagedPolicyAuthorityRead,
  trust: Readonly<{ readAcl(path: string): AclProbe | null; evaluateAclTrust(acl: AclProbe): boolean }>
): Promise<void> {
  const retained = managedReadPins.get(read as object)
  if (!retained) throw new Error('Unknown managed authority read')
  const record = authoritySourcePins.get(retained.pin as object)
  if (!record) throw new Error('Managed authority source pin retired')
  await assertAuthoritySourcePinCurrent(retained.pin)
  if (retained.requireAdminTrust && process.platform === 'win32' && record.target) {
    const acl = trust.readAcl(record.path)
    if (acl === null || !trust.evaluateAclTrust(acl)) throw new Error('Managed admin source trust changed')
    await assertAuthoritySourcePinCurrent(retained.pin)
  }
}

export function sameManagedPolicyAuthorityReadSource(
  left: ManagedPolicyAuthorityRead,
  right: ManagedPolicyAuthorityRead
): boolean {
  const leftPin = managedReadPins.get(left as object)?.pin
  const rightPin = managedReadPins.get(right as object)?.pin
  return !!leftPin && !!rightPin && sameAuthoritySourcePinIdentity(leftPin, rightPin)
}
