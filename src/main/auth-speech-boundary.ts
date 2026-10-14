import type { SpeechAuthLeaseReaders, SpeechAuthSession, SpeechAuthConfig, SpeechAuthSettingsObservation, VerifiedSpeechAuthBoundary } from './auth-speech-lease'
import { readBoundedTextFile, readTrustedAdminText } from './auth-speech-boundary-readers'
import { join } from 'node:path'
import { readTrustedAdminManagedBytes } from './win-security'

type BoundedTextRead = import('./auth-speech-boundary-readers').BoundedTextRead
type Document = Record<string, unknown>

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
  if (!observation?.readable || !Number.isSafeInteger(observation.epoch)) return null
  if (readers.readSettingsEpoch() !== observation.epoch || pathsRevision !== readers.readPolicyPathsRevision()) return null
  const userData = sources.readProfilePath()
  const [adminRead, userRead, stickyRead] = await Promise.all([
    readTrustedAdminText(sources.readAdminPath(), readers.readTrustedAdminManagedBytes ?? readTrustedAdminManagedBytes),
    readBoundedTextFile(join(userData, 'managed-config.json'), 1_048_576),
    readBoundedTextFile(join(userData, 'auth-configured.flag'), 16)
  ])
  const admin = parseDocument(adminRead)
  const user = parseDocument(userRead)
  if (!admin || !user || stickyRead.kind === 'invalid') return null
  const sticky = stickyRead.kind === 'present'
  let config = sources.resolveConfig(observation.settings, admin, user, false, {})
  if (!config && sticky) {
    const lkgRead = await readBoundedTextFile(join(userData, 'auth-lkg-config.json'), 65_536)
    const lkg = parseDocument(lkgRead)
    if (!lkg) return null
    config = sources.resolveConfig(observation.settings, admin, user, true, lkg)
  }
  const settingsEpoch = readers.readSettingsEpoch()
  const finalPathsRevision = readers.readPolicyPathsRevision()
  if (settingsEpoch !== observation.epoch || finalPathsRevision !== pathsRevision) return null
  return {
    observation,
    settingsEpoch,
    pathsRevision,
    config,
    enforced: sources.isEnforced(admin, user),
    sticky,
    session: sources.readSession()
  }
}
