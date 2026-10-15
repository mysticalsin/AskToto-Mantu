import { join } from 'node:path'
import { statSync } from 'node:fs'
import type { SettingsPolicyAuthoritySnapshot } from './settings-observation'
import {
  beginSettingsAuthorityProducerFrame,
  commitManagedAuthorityDocument,
  endSettingsAuthorityProducerFrame,
  flushSettingsAuthorityInvalidations,
  isSettingsAuthorityCurrent,
  type SettingsAuthorityReceipt
} from './settings-authority-history'
import {
  assertAuthoritySourcePinCurrent,
  assertManagedPolicyAuthorityReadCurrent,
  captureAuthoritySourcePin,
  sameAuthoritySourcePinIdentity,
  sameManagedPolicyAuthorityReadSource,
  type AuthoritySourcePin,
  type ManagedPolicyAuthorityRead
} from './win-security'

type ManagedSource = 'user' | 'admin'
type ManagedRawRead = Readonly<{ sourceIdentity: string; status: 'readable' | 'unreadable'; raw: string | null }>

export type SettingsCacheAuthorityKey = Readonly<{
  userPath: string
  userMtime: number
  managedMtime: number
  adminMtime: number
}>

/** Cache key for the three on-disk inputs that can affect a settings snapshot.
 *  Settings path is part of the key so a change of profile directory always misses the cache.
 *  In production `settingsPath()` is constant; test suites point userData at a fresh temp dir per case,
 *  and all-zero mtimes without this path entry could reuse a prior case's cached Settings.
 */
export function captureSettingsCacheAuthorityKey(
  userPath: string,
  profilePath: string,
  adminPath: string
): SettingsCacheAuthorityKey {
  const mtime = (path: string) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }
  return {
    userPath,
    userMtime: mtime(userPath),
    managedMtime: mtime(join(profilePath, 'managed-config.json')),
    adminMtime: mtime(adminPath)
  }
}

/** Store-owned helper extracted from store.ts to keep settings reads in the original managed frame. */
export function createSettingsAuthorityManagedReader(options: {
  adminIdentity(): Readonly<{ path: string }>
  adminPathState(): 'present' | 'absent' | 'unknown'
  readAdminContent(): string | null
  readFile(path: string): string
  setUnreadable(source: ManagedSource): void
  noteReadFailure(source: ManagedSource, error: unknown): void
  invalidateSettingsCache(): void
}) {
  let freshUserRead: ManagedPolicyAuthorityRead | null = null
  let freshAdminRead: ManagedPolicyAuthorityRead | null = null
  let frame: Map<ManagedSource, ManagedRawRead> | null = null
  const publishManagedAuthority = (
    source: ManagedSource,
    path: string,
    raw: string | null,
    status: ManagedRawRead['status']
  ) => {
    if (commitManagedAuthorityDocument(source, path, raw, status)) options.invalidateSettingsCache()
    flushSettingsAuthorityInvalidations()
  }
  const readManagedAuthorityRaw = (source: ManagedSource, sourceIdentity: string, read: () => ManagedRawRead) => {
    const cached = frame?.get(source)
    if (cached) {
      if (cached.sourceIdentity === sourceIdentity) return cached
      const unreadable = Object.freeze({ sourceIdentity, status: 'unreadable' as const, raw: null })
      frame?.set(source, unreadable)
      publishManagedAuthority(source, sourceIdentity, null, 'unreadable')
      return unreadable
    }
    const result = read()
    frame?.set(source, result)
    return result
  }
  function withReadFrame<T>(read: () => T): T {
    if (frame) return read()
    const prior = frame
    frame = new Map()
    beginSettingsAuthorityProducerFrame()
    try {
      return read()
    } finally {
      frame = prior
      endSettingsAuthorityProducerFrame()
    }
  }
  function setReads(user: ManagedPolicyAuthorityRead | null, admin: ManagedPolicyAuthorityRead | null): void {
    freshUserRead = user
    freshAdminRead = admin
  }
  function adminManagedContent(): string | null {
    const identity = options.adminIdentity()
    return readManagedAuthorityRaw('admin', identity.path, () => {
      if (freshAdminRead?.status === 'invalid') {
        options.setUnreadable('admin')
        publishManagedAuthority('admin', identity.path, null, 'unreadable')
        return Object.freeze({ sourceIdentity: identity.path, status: 'unreadable', raw: null })
      }
      const raw = options.readAdminContent()
      const status = options.adminPathState() === 'unknown' ? 'unreadable' : 'readable'
      publishManagedAuthority('admin', identity.path, raw, status)
      return Object.freeze({ sourceIdentity: identity.path, status, raw })
    }).raw
  }
  function readPolicyFile<T>(path: string, source: ManagedSource, fallback: T, parse: (raw: string) => T): T {
    const document = readManagedAuthorityRaw(source, path, () => {
      if (source === 'user' && freshUserRead) {
        if (freshUserRead.status === 'absent')
          return Object.freeze({ sourceIdentity: path, status: 'readable', raw: null })
        if (freshUserRead.status !== 'present')
          return Object.freeze({ sourceIdentity: path, status: 'unreadable', raw: null })
        return Object.freeze({
          sourceIdentity: path,
          status: 'readable',
          raw: Buffer.from(freshUserRead.bytes).toString('utf8')
        })
      }
      try {
        return Object.freeze({ sourceIdentity: path, status: 'readable', raw: options.readFile(path) })
      } catch (error) {
        return Object.freeze({
          sourceIdentity: path,
          status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'readable' : 'unreadable',
          raw: null
        })
      }
    })
    if (document.status === 'unreadable') {
      options.setUnreadable(source)
      publishManagedAuthority(source, path, null, 'unreadable')
      return fallback
    }
    if (document.raw === null) {
      publishManagedAuthority(source, path, null, 'readable')
      return fallback
    }
    try {
      const value = parse(document.raw)
      publishManagedAuthority(source, path, document.raw, 'readable')
      return value
    } catch (error) {
      options.noteReadFailure(source, error)
      publishManagedAuthority(source, path, null, 'unreadable')
      return fallback
    }
  }
  return {
    adminManagedContent,
    readPolicyFile,
    publishManagedAuthority,
    withReadFrame,
    setReads,
    getFreshAdminRead: () => freshAdminRead
  }
}

export type SettingsAuthAuthorityFrame = Readonly<{
  snapshot: SettingsPolicyAuthoritySnapshot
  profilePath: string
  adminPath: string
  settingsPin: AuthoritySourcePin
  recoveredPin: AuthoritySourcePin
  userRead: ManagedPolicyAuthorityRead
  adminRead: ManagedPolicyAuthorityRead
  persistenceReceipt: SettingsAuthorityReceipt
}>

const frames = new WeakMap<object, SettingsAuthAuthorityFrame>()

/** Capture non-payload profile-file pins before the store reads settings or managed documents. */
export async function captureSettingsAuthAuthorityPins(profilePath: string): Promise<{
  readonly settingsPin: AuthoritySourcePin
  readonly recoveredPin: AuthoritySourcePin
} | null> {
  const [settingsPin, recoveredPin] = await Promise.all([
    captureAuthoritySourcePin(join(profilePath, 'settings.json')),
    captureAuthoritySourcePin(join(profilePath, 'settings.json.recovered'))
  ])
  return settingsPin && recoveredPin ? Object.freeze({ settingsPin, recoveredPin }) : null
}

/** Store-only attachment. The exact returned snapshot and read objects are the membership keys. */
export function attachSettingsAuthAuthorityFrame(
  snapshot: SettingsPolicyAuthoritySnapshot,
  input: Omit<SettingsAuthAuthorityFrame, 'snapshot' | 'persistenceReceipt'>
): void {
  const receipt = snapshot.history.persistence
  if (!receipt || !isSettingsAuthorityCurrent(receipt)) throw new Error('Settings persistence receipt unavailable')
  const frame = Object.freeze({ ...input, snapshot, persistenceReceipt: receipt })
  frames.set(snapshot as object, frame)
}

/** Read only the exact private store association; structural copies never inherit it. */
export function readSettingsAuthAuthorityFrame(
  snapshot: SettingsPolicyAuthoritySnapshot
): SettingsAuthAuthorityFrame | null {
  return frames.get(snapshot as object) ?? null
}

/** Compare the retained physical source identities, not allocation identity or file bytes. */
export function sameSettingsAuthAuthorityFrameSources(
  leftSnapshot: SettingsPolicyAuthoritySnapshot,
  rightSnapshot: SettingsPolicyAuthoritySnapshot
): boolean {
  const left = frames.get(leftSnapshot as object)
  const right = frames.get(rightSnapshot as object)
  return (
    !!left &&
    !!right &&
    left.profilePath === right.profilePath &&
    left.adminPath === right.adminPath &&
    sameAuthoritySourcePinIdentity(left.settingsPin, right.settingsPin) &&
    sameAuthoritySourcePinIdentity(left.recoveredPin, right.recoveredPin) &&
    sameManagedPolicyAuthorityReadSource(left.userRead, right.userRead) &&
    sameManagedPolicyAuthorityReadSource(left.adminRead, right.adminRead)
  )
}

/** Explicit-preparation validation over every source retained by the original frame. */
export async function assertSettingsAuthAuthorityFrameCurrent(
  snapshot: SettingsPolicyAuthoritySnapshot
): Promise<void> {
  const frame = frames.get(snapshot as object)
  if (!frame || frame.snapshot !== snapshot) throw new Error('Unknown settings auth authority frame')
  await Promise.all([
    assertAuthoritySourcePinCurrent(frame.settingsPin),
    assertAuthoritySourcePinCurrent(frame.recoveredPin),
    assertManagedPolicyAuthorityReadCurrent(frame.userRead),
    assertManagedPolicyAuthorityReadCurrent(frame.adminRead)
  ])
  if (!isSettingsAuthorityCurrent(frame.persistenceReceipt)) throw new Error('Settings auth receipt changed')
}
