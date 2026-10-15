import { createHash } from 'node:crypto'
import { constants as fsConstants, lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, resolve, win32 } from 'node:path'
import { app } from 'electron'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import { readPrivateCurrentUserAclReceipt, type PrivateCurrentUserAclReceipt } from '../win-security'
import {
  readVerifiedQaPersistenceLaunch,
  type QaPersistenceLaunchPayload,
  type QaPhysicalDirectoryIdentity,
  type VerifiedQaPersistenceLaunch
} from './qa-run-protocol'
import { assertPersistenceNativeKeyIntentCurrent, PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT } from './native-key-intent'

declare const profileRootBrand: unique symbol
export type QaPersistenceProfileRoot = Readonly<{ [profileRootBrand]: true }>

type PhysicalPin = Readonly<{
  identity: QaPhysicalDirectoryIdentity
  fileHandle: FileHandle
  acl: PrivateCurrentUserAclReceipt | null
}>

type ProfileRecord = {
  readonly launch: VerifiedQaPersistenceLaunch
  readonly claims: QaPersistenceLaunchPayload
  readonly userDataPath: string
  readonly parent: PhysicalPin
  readonly profile: PhysicalPin
  readonly principalSid: string | null
  readonly preparation: PreparationRecord
  disposed: boolean
  retired: boolean
}

type PreparationRecord = {
  readonly launch: VerifiedQaPersistenceLaunch
  readonly descriptors: Set<FileHandle>
  work: Promise<QaPersistenceProfileRoot>
  root: QaPersistenceProfileRoot | null
  settlePromise: Promise<void> | null
}

const roots = new WeakMap<object, ProfileRecord>()
const preparations = new WeakMap<object, PreparationRecord>()
const macPrincipalDomain = 'metis-qa-os-principal/v1\n'

function osPath(path: string): string {
  return process.platform === 'win32' ? win32.normalize(path) : resolve(path)
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
  return resolve(left) === resolve(right)
}

function sameStat(stat: BigIntStats, expected: QaPhysicalDirectoryIdentity): boolean {
  const macOwnerCurrent =
    process.platform !== 'darwin' ||
    (process.getuid?.() !== undefined &&
      process.geteuid?.() === process.getuid?.() &&
      String(stat.uid) === expected.owner &&
      String(process.getuid()) === expected.owner)
  return (
    macOwnerCurrent &&
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    String(stat.dev) === expected.device &&
    String(stat.ino) === expected.inode &&
    Math.round(Number(stat.birthtimeMs)) === expected.birthtimeMs &&
    (Number(stat.mode) & 0o7777) === expected.mode
  )
}

function statPin(stat: BigIntStats, path: string, owner: string): QaPhysicalDirectoryIdentity {
  return Object.freeze({
    path,
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeMs: Math.round(Number(stat.birthtimeMs)),
    owner,
    mode: Number(stat.mode) & 0o7777
  })
}

function privateSidAssociation(sid: string): string {
  return createHash('sha256').update(macPrincipalDomain, 'utf8').update(sid, 'utf8').digest('hex')
}

function signedOriginalIntentMatches(claims: QaPersistenceLaunchPayload): boolean {
  return (
    claims.nativeKeyIntent.present === PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.present &&
    claims.nativeKeyIntent.value === PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.value
  )
}

async function verifyNamedDirectory(
  expected: QaPhysicalDirectoryIdentity,
  platform: 'win32' | 'darwin',
  sidExpected: string | null,
  preparation: PreparationRecord
): Promise<PhysicalPin> {
  if (process.platform !== platform) throw new Error('QA_PROFILE_PLATFORM_MISMATCH')
  const path = osPath(expected.path)
  if (path !== expected.path) throw new Error('QA_PROFILE_PATH_NOT_CANONICAL')
  const [before, canonicalPath] = await Promise.all([lstat(path, { bigint: true }), realpath(path)])
  if (!sameStat(before, expected) || before.isSymbolicLink() || !samePath(path, canonicalPath))
    throw new Error('QA_PROFILE_PATH_REDIRECTED')
  let owner: string
  let acl: PrivateCurrentUserAclReceipt | null = null
  if (platform === 'darwin') {
    const uid = process.getuid?.()
    const effectiveUid = process.geteuid?.()
    if (uid === undefined || effectiveUid === undefined || uid !== effectiveUid || expected.owner !== String(uid))
      throw new Error('QA_PROFILE_MAC_OWNER_INVALID')
    owner = String(uid)
  } else {
    acl = await readPrivateCurrentUserAclReceipt(path)
    if (
      !acl ||
      acl.processSid !== acl.ownerSid ||
      (sidExpected !== null && acl.processSid !== sidExpected) ||
      expected.owner !== acl.ownerSid
    )
      throw new Error('QA_PROFILE_WINDOWS_DACL_INVALID')
    owner = acl.ownerSid
  }
  const afterProbe = await lstat(path, { bigint: true })
  if (!sameStat(afterProbe, expected) || owner !== expected.owner) throw new Error('QA_PROFILE_CHANGED_DURING_PROBE')
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0))
  preparation.descriptors.add(handle)
  try {
    const opened = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (!sameStat(opened, expected) || !sameStat(named, expected)) throw new Error('QA_PROFILE_CHANGED_DURING_OPEN')
    if (platform === 'win32') {
      const afterOpenAcl = await readPrivateCurrentUserAclReceipt(path)
      const openedAgain = await handle.stat({ bigint: true })
      const namedAgain = await lstat(path, { bigint: true })
      if (
        !afterOpenAcl ||
        afterOpenAcl.processSid !== owner ||
        afterOpenAcl.ownerSid !== owner ||
        afterOpenAcl.daclSha256 !== acl?.daclSha256 ||
        !sameStat(openedAgain, expected) ||
        !sameStat(namedAgain, expected)
      )
        throw new Error('QA_PROFILE_WINDOWS_DACL_CHANGED')
      acl = afterOpenAcl
    }
    return Object.freeze({ identity: statPin(opened, path, owner), fileHandle: handle, acl })
  } catch (error) {
    throw error
  }
}

/**
 * The only profile-root issuer. It accepts a cryptographically verified launch member, obtains
 * signed paths from that private record, compares them to Electron's actual userData path, and
 * retains descriptors for exactly the signed parent/profile pair. It never creates or repairs them.
 */
export function prepareQaProfileRoot(launch: VerifiedQaPersistenceLaunch): Promise<QaPersistenceProfileRoot> {
  const existing = launch && typeof launch === 'object' ? preparations.get(launch as object) : undefined
  if (existing) return existing.work
  if (!readVerifiedQaPersistenceLaunch(launch)) return Promise.reject(new Error('QA_PROFILE_LAUNCH_UNVERIFIED'))
  const preparation: PreparationRecord = {
    launch,
    descriptors: new Set(),
    work: Promise.resolve(null as unknown as QaPersistenceProfileRoot),
    root: null,
    settlePromise: null
  }
  preparations.set(launch as object, preparation)
  preparation.work = prepareQaProfileRootOwned(launch, preparation)
  return preparation.work
}

async function prepareQaProfileRootOwned(
  launch: VerifiedQaPersistenceLaunch,
  preparation: PreparationRecord
): Promise<QaPersistenceProfileRoot> {
  if (!QA_IDENTITY_BUILD) throw new Error('QA_PROFILE_RUNTIME_MISMATCH')
  const claims = readVerifiedQaPersistenceLaunch(launch)
  if (!claims) throw new Error('QA_PROFILE_LAUNCH_UNVERIFIED')
  assertPersistenceNativeKeyIntentCurrent()
  if (!signedOriginalIntentMatches(claims)) throw new Error('QA_PROFILE_NATIVE_INTENT_MISMATCH')
  if (claims.runtime.platform !== process.platform || (process.platform !== 'win32' && process.platform !== 'darwin'))
    throw new Error('QA_PROFILE_PLATFORM_MISMATCH')
  if (!app.isPackaged || app.getName() !== 'asktoto-qa') throw new Error('QA_PROFILE_RUNTIME_MISMATCH')
  const userDataPath = app.getPath('userData')
  if (!samePath(userDataPath, claims.profile.path)) throw new Error('QA_PROFILE_USERDATA_MISMATCH')
  const expectedParent =
    process.platform === 'win32' ? win32.dirname(claims.profile.path) : dirname(claims.profile.path)
  if (!samePath(expectedParent, claims.parent.path)) throw new Error('QA_PROFILE_NOT_EXACT_PARENT_CHILD')

  const principal = claims.osPrincipalAssociation
  let sidExpected: string | null = null
  if (process.platform === 'darwin') {
    if (principal.platform !== 'darwin') throw new Error('QA_PROFILE_PRINCIPAL_MISMATCH')
    if (process.getuid?.() !== principal.uid || process.geteuid?.() !== principal.effectiveUid)
      throw new Error('QA_PROFILE_PRINCIPAL_MISMATCH')
  } else {
    if (principal.platform !== 'win32') throw new Error('QA_PROFILE_PRINCIPAL_MISMATCH')
  }
  if (process.platform === 'win32' && principal.platform !== 'win32') throw new Error('QA_PROFILE_PRINCIPAL_MISMATCH')

  let parent: PhysicalPin | undefined
  let profile: PhysicalPin | undefined
  try {
    parent = await verifyNamedDirectory(claims.parent, process.platform as 'win32' | 'darwin', sidExpected, preparation)
    if (process.platform === 'win32') {
      sidExpected = parent.acl?.processSid ?? null
      if (
        principal.platform !== 'win32' ||
        !sidExpected ||
        privateSidAssociation(sidExpected) !== principal.sidAssociationSha256
      )
        throw new Error('QA_PROFILE_PRINCIPAL_MISMATCH')
    }
    profile = await verifyNamedDirectory(
      claims.profile,
      process.platform as 'win32' | 'darwin',
      sidExpected,
      preparation
    )
    await assertPinCurrent(parent, process.platform as 'win32' | 'darwin', sidExpected)
    await assertPinCurrent(profile, process.platform as 'win32' | 'darwin', sidExpected)
    const record: ProfileRecord = {
      launch,
      claims,
      userDataPath,
      parent,
      profile,
      principalSid: sidExpected,
      preparation,
      disposed: false,
      retired: false
    }
    const root = Object.freeze({})
    roots.set(root, record)
    preparation.root = root as QaPersistenceProfileRoot
    return root as QaPersistenceProfileRoot
  } catch (error) {
    throw error
  }
}

async function assertPinCurrent(
  pin: PhysicalPin,
  platform: 'win32' | 'darwin',
  sidExpected: string | null
): Promise<void> {
  const [held, named, canonicalPath] = await Promise.all([
    pin.fileHandle.stat({ bigint: true }),
    lstat(pin.identity.path, { bigint: true }),
    realpath(pin.identity.path)
  ])
  if (!sameStat(held, pin.identity) || !sameStat(named, pin.identity) || !samePath(canonicalPath, pin.identity.path))
    throw new Error('QA_PROFILE_PHYSICAL_IDENTITY_CHANGED')
  if (platform === 'darwin') {
    const uid = process.getuid?.()
    const effectiveUid = process.geteuid?.()
    if (
      uid === undefined ||
      effectiveUid !== uid ||
      String(uid) !== pin.identity.owner ||
      (Number(named.mode) & 0o7777) !== 0o700
    )
      throw new Error('QA_PROFILE_MAC_OWNER_CHANGED')
  } else {
    const acl = await readPrivateCurrentUserAclReceipt(pin.identity.path)
    const heldAfter = await pin.fileHandle.stat({ bigint: true })
    const namedAfter = await lstat(pin.identity.path, { bigint: true })
    if (
      !acl ||
      acl.processSid !== sidExpected ||
      acl.ownerSid !== pin.identity.owner ||
      acl.daclSha256 !== pin.acl?.daclSha256 ||
      !sameStat(heldAfter, pin.identity) ||
      !sameStat(namedAfter, pin.identity)
    )
      throw new Error('QA_PROFILE_WINDOWS_DACL_CHANGED')
  }
}

function recordFor(root: QaPersistenceProfileRoot): ProfileRecord {
  const record = root && typeof root === 'object' ? roots.get(root as object) : undefined
  if (!record || record.disposed || record.retired) throw new Error('QA_PROFILE_OWNER_UNAVAILABLE')
  if (
    !QA_IDENTITY_BUILD ||
    !app.isPackaged ||
    app.getName() !== 'asktoto-qa' ||
    !samePath(app.getPath('userData'), record.userDataPath) ||
    !app.hasSingleInstanceLock()
  ) {
    record.retired = true
    throw new Error('QA_PROFILE_RUN_CONTEXT_CHANGED')
  }
  try {
    assertPersistenceNativeKeyIntentCurrent()
  } catch {
    record.retired = true
    throw new Error('QA_PROFILE_RUN_CONTEXT_CHANGED')
  }
  if (!signedOriginalIntentMatches(record.claims)) {
    record.retired = true
    throw new Error('QA_PROFILE_RUN_CONTEXT_CHANGED')
  }
  return record
}

export function assertQaProfileCurrent(root: QaPersistenceProfileRoot): void {
  recordFor(root)
}

export async function assertQaProfilePhysicalCurrent(root: QaPersistenceProfileRoot): Promise<void> {
  const record = recordFor(root)
  try {
    const expectedParent =
      process.platform === 'win32' ? win32.dirname(record.profile.identity.path) : dirname(record.profile.identity.path)
    if (!samePath(expectedParent, record.parent.identity.path)) throw new Error('QA_PROFILE_PARENT_CHANGED')
    await assertPinCurrent(record.parent, process.platform as 'win32' | 'darwin', record.principalSid)
    assertQaProfileCurrent(root)
    await assertPinCurrent(record.profile, process.platform as 'win32' | 'darwin', record.principalSid)
    assertQaProfileCurrent(root)
  } catch (error) {
    record.retired = true
    throw error
  }
}

export function settleQaProfileRootPreparation(launch: VerifiedQaPersistenceLaunch): Promise<void> {
  const preparation = launch && typeof launch === 'object' ? preparations.get(launch as object) : undefined
  if (!preparation) return Promise.reject(new Error('QA_PROFILE_PREPARATION_UNAVAILABLE'))
  if (preparation.settlePromise) return preparation.settlePromise

  preparation.settlePromise = (async () => {
    await preparation.work.catch(() => undefined)
    const closes = await Promise.allSettled([...preparation.descriptors].map((handle) => handle.close()))
    const failure = closes.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const root = preparation.root
    const record = root ? roots.get(root as object) : undefined
    if (record) record.disposed = true
  })()
  return preparation.settlePromise
}

export function disposeQaProfileRoot(root: QaPersistenceProfileRoot): Promise<void> {
  const record = root && typeof root === 'object' ? roots.get(root as object) : undefined
  if (!record) return Promise.reject(new Error('QA_PROFILE_OWNER_UNAVAILABLE'))
  record.retired = true
  return settleQaProfileRootPreparation(record.launch)
}

export function retireQaProfileRoot(root: QaPersistenceProfileRoot): void {
  const record = roots.get(root as object)
  if (record) record.retired = true
}
