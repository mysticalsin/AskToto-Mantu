import type {
  SpeechAuthLeaseReaders,
  SpeechAuthSession,
  SpeechAuthConfig,
  SpeechAuthSettingsObservation,
  VerifiedSpeechAuthBoundary
} from './auth-speech-lease'
import type { BoundedTextRead } from './auth-speech-boundary-readers'
import {
  assertBoundedTextReadCurrent,
  readBoundedTextFile,
  readTrustedAdminText,
  sameBoundedTextReadSource
} from './auth-speech-boundary-readers'
import { join } from 'node:path'
import { readTrustedAdminManagedBytes } from './win-security'
import type { SettingsPolicyAuthoritySnapshot } from './settings-observation'
import type { AuthEnvironmentSnapshot } from './auth-config'
import {
  assertSettingsAuthAuthorityFrameCurrent,
  readSettingsAuthAuthorityFrame,
  sameSettingsAuthAuthorityFrameSources,
  type SettingsAuthAuthorityFrame
} from './settings-auth-authority-frame'

type Document = Record<string, unknown>
type PersistenceProof = Readonly<{
  frame: SettingsAuthAuthorityFrame
  stickyRead: BoundedTextRead
  lkgRead: BoundedTextRead | null
  externalFenceCurrent: () => boolean
  environmentSnapshot: Readonly<Record<string, string | undefined>>
}>
const persistenceProofs = new WeakMap<object, PersistenceProof>()

export async function assertVerifiedSpeechAuthBoundaryCurrent(boundary: VerifiedSpeechAuthBoundary): Promise<void> {
  const proof = persistenceProofs.get(boundary as object)
  if (!proof) throw new Error('Speech auth boundary has no verified persistence frame')
  await assertSettingsAuthAuthorityFrameCurrent(proof.frame.snapshot)
  await assertBoundedTextReadCurrent(proof.stickyRead)
  if (proof.lkgRead) await assertBoundedTextReadCurrent(proof.lkgRead)
  if (!proof.externalFenceCurrent()) throw new Error('Speech auth external fence changed')
}

export function getVerifiedSpeechAuthBoundaryPersistenceReceipt(boundary: VerifiedSpeechAuthBoundary): object | null {
  return persistenceProofs.get(boundary as object)?.frame.persistenceReceipt ?? null
}

/** Copy the immutable auth environment associated with this exact verified publication proof. */
export function getVerifiedSpeechAuthBoundaryEnvironmentSnapshot(
  boundary: VerifiedSpeechAuthBoundary
): AuthEnvironmentSnapshot | null {
  const snapshot = persistenceProofs.get(boundary as object)?.environmentSnapshot
  return snapshot ? (Object.freeze({ ...snapshot }) as AuthEnvironmentSnapshot) : null
}

export function sameVerifiedSpeechAuthBoundarySources(
  left: VerifiedSpeechAuthBoundary,
  right: VerifiedSpeechAuthBoundary
): boolean {
  const leftProof = persistenceProofs.get(left as object)
  const rightProof = persistenceProofs.get(right as object)
  return (
    !!leftProof &&
    !!rightProof &&
    JSON.stringify(leftProof.environmentSnapshot) === JSON.stringify(rightProof.environmentSnapshot) &&
    sameBoundedTextReadSource(leftProof.stickyRead, rightProof.stickyRead) &&
    ((leftProof.lkgRead === null && rightProof.lkgRead === null) ||
      (!!leftProof.lkgRead &&
        !!rightProof.lkgRead &&
        sameBoundedTextReadSource(leftProof.lkgRead, rightProof.lkgRead))) &&
    sameSettingsAuthAuthorityFrameSources(leftProof.frame.snapshot, rightProof.frame.snapshot)
  )
}

export function isVerifiedSpeechAuthBoundary(boundary: VerifiedSpeechAuthBoundary): boolean {
  return persistenceProofs.has(boundary as object)
}

function parseDocument(read: BoundedTextRead): Document | null {
  if (read.kind === 'absent') return {}
  if (read.kind === 'invalid') return null
  try {
    const value: unknown = JSON.parse(read.text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Document) : null
  } catch {
    return null
  }
}

export interface SpeechAuthBoundarySources {
  readProfilePath: () => string
  readAdminPath: () => string
  readSession: () => SpeechAuthSession | null
  resolveConfig: (
    settings: SpeechAuthSettingsObservation['settings'],
    admin: Document,
    user: Document,
    sticky: boolean,
    lkg: Document
  ) => SpeechAuthConfig | null
  isEnforced: (admin: Document, user: Document) => boolean
  isExternalFenceCurrent?: () => boolean
  readEnvironmentSnapshot?: () => Readonly<Record<string, string | undefined>>
}

export async function readSpeechAuthBoundary(
  readers: SpeechAuthLeaseReaders,
  sources: SpeechAuthBoundarySources
): Promise<VerifiedSpeechAuthBoundary | null> {
  let pathsRevision: string
  try {
    pathsRevision = readers.readPolicyPathsRevision()
    if (!pathsRevision) return null
  } catch {
    return null
  }
  const observation = await readers.readSettingsAtBoundary()
  const externalFenceCurrent = sources.isExternalFenceCurrent ?? (() => true)
  const environmentSnapshot = Object.freeze({ ...(sources.readEnvironmentSnapshot?.() ?? {}) })
  if (!observation?.readable || !Number.isSafeInteger(observation.epoch)) return null
  if (
    !externalFenceCurrent() ||
    readers.readSettingsEpoch() !== observation.epoch ||
    pathsRevision !== readers.readPolicyPathsRevision()
  )
    return null
  const userData = sources.readProfilePath()
  const frame = observation.authoritySnapshot
    ? readSettingsAuthAuthorityFrame(observation.authoritySnapshot as SettingsPolicyAuthoritySnapshot)
    : null
  if (
    observation.authoritySnapshot &&
    (!frame || frame.profilePath !== userData || frame.adminPath !== sources.readAdminPath())
  )
    return null
  if (frame) {
    await assertSettingsAuthAuthorityFrameCurrent(frame.snapshot)
    if (!externalFenceCurrent()) return null
  }
  const [adminRead, userRead, stickyRead] = frame
    ? [
        managedReadAsText(frame.adminRead),
        managedReadAsText(frame.userRead),
        await readBoundedTextFile(join(userData, 'auth-configured.flag'), 16)
      ]
    : await Promise.all([
        readTrustedAdminText(
          sources.readAdminPath(),
          readers.readTrustedAdminManagedBytes ?? readTrustedAdminManagedBytes
        ),
        readBoundedTextFile(join(userData, 'managed-config.json'), 1_048_576),
        readBoundedTextFile(join(userData, 'auth-configured.flag'), 16)
      ])
  const admin = parseDocument(adminRead)
  const user = parseDocument(userRead)
  if (!admin || !user || stickyRead.kind === 'invalid') return null
  await assertBoundedTextReadCurrent(stickyRead)
  if (frame) await assertSettingsAuthAuthorityFrameCurrent(frame.snapshot)
  if (!externalFenceCurrent()) return null
  const sticky = stickyRead.kind === 'present'
  let config = sources.resolveConfig(observation.settings, admin, user, false, {})
  let lkgRead: BoundedTextRead | null = null
  if (!config && sticky) {
    lkgRead = await readBoundedTextFile(join(userData, 'auth-lkg-config.json'), 65_536)
    await assertBoundedTextReadCurrent(lkgRead)
    if (frame) await assertSettingsAuthAuthorityFrameCurrent(frame.snapshot)
    if (!externalFenceCurrent()) return null
    const lkg = parseDocument(lkgRead)
    if (!lkg) return null
    config = sources.resolveConfig(observation.settings, admin, user, true, lkg)
  }
  const settingsEpoch = readers.readSettingsEpoch()
  const finalPathsRevision = readers.readPolicyPathsRevision()
  if (!externalFenceCurrent() || settingsEpoch !== observation.epoch || finalPathsRevision !== pathsRevision)
    return null
  const boundary: VerifiedSpeechAuthBoundary = Object.freeze({
    observation,
    settingsEpoch,
    pathsRevision,
    config: config ? Object.freeze({ ...config }) : null,
    enforced: sources.isEnforced(admin, user),
    sticky,
    session: sources.readSession()
  })
  if (frame)
    persistenceProofs.set(
      boundary as object,
      Object.freeze({ frame, stickyRead, lkgRead, externalFenceCurrent, environmentSnapshot })
    )
  return boundary
}

function managedReadAsText(read: SettingsAuthAuthorityFrame['userRead']): BoundedTextRead {
  if (read.status === 'absent') return Object.freeze({ kind: 'absent' })
  if (read.status === 'invalid') return Object.freeze({ kind: 'invalid' })
  try {
    return Object.freeze({ kind: 'present', text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}
