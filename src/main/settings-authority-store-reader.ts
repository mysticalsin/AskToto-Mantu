import {
  beginSettingsAuthorityProducerFrame,
  commitManagedAuthorityDocument,
  endSettingsAuthorityProducerFrame,
  flushSettingsAuthorityInvalidations
} from './settings-authority-history'

type ManagedAuthoritySource = 'user' | 'admin'
type ManagedAuthorityStatus = 'readable' | 'unreadable'
type ManagedRawAuthorityRead = Readonly<{
  sourceIdentity: string
  status: ManagedAuthorityStatus
  raw: string | null
}>
type FreshManagedRead = Readonly<{ status: 'absent' | 'invalid' }> | Readonly<{ status: 'present'; bytes: Uint8Array }>

export type SettingsAuthorityStoreReaderOptions = Readonly<{
  freshUserRead(): FreshManagedRead | null
  freshAdminRead(): FreshManagedRead | null
  adminIdentity(): Readonly<{ path: string }>
  adminPathState(): 'present' | 'absent' | 'unknown'
  readAdminContent(): string | null
  readFile(path: string): string
  setUnreadable(source: ManagedAuthoritySource): void
  noteReadFailure(source: ManagedAuthoritySource, error: unknown): void
  invalidateSettingsCache(): void
}>

export function createSettingsAuthorityStoreReader(options: SettingsAuthorityStoreReaderOptions) {
  let frame: Map<ManagedAuthoritySource, ManagedRawAuthorityRead> | null = null

  function publishManagedAuthority(
    source: ManagedAuthoritySource,
    sourceIdentity: string,
    raw: string | null,
    status: ManagedAuthorityStatus
  ): void {
    if (commitManagedAuthorityDocument(source, sourceIdentity, raw, status)) options.invalidateSettingsCache()
    flushSettingsAuthorityInvalidations()
  }

  function readManagedAuthorityRaw(
    source: ManagedAuthoritySource,
    sourceIdentity: string,
    read: () => ManagedRawAuthorityRead
  ): ManagedRawAuthorityRead {
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

  function adminManagedContent(): string | null {
    const identity = options.adminIdentity()
    return readManagedAuthorityRaw('admin', identity.path, () => {
      if (options.freshAdminRead()?.status === 'invalid') {
        options.setUnreadable('admin')
        publishManagedAuthority('admin', identity.path, null, 'unreadable')
        return Object.freeze({ sourceIdentity: identity.path, status: 'unreadable', raw: null })
      }
      const content = options.readAdminContent()
      const status = options.adminPathState() === 'unknown' ? 'unreadable' : 'readable'
      publishManagedAuthority('admin', identity.path, content, status)
      return Object.freeze({ sourceIdentity: identity.path, status, raw: content })
    }).raw
  }

  function readPolicyFile<T>(path: string, source: ManagedAuthoritySource, fallback: T, parse: (raw: string) => T): T {
    const document = readManagedAuthorityRaw(source, path, () => {
      const fresh = source === 'user' ? options.freshUserRead() : null
      if (fresh?.status === 'absent') return Object.freeze({ sourceIdentity: path, status: 'readable', raw: null })
      if (fresh?.status === 'invalid') return Object.freeze({ sourceIdentity: path, status: 'unreadable', raw: null })
      if (fresh?.status === 'present') {
        return Object.freeze({
          sourceIdentity: path,
          status: 'readable',
          raw: Buffer.from(fresh.bytes).toString('utf8')
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

  return { adminManagedContent, readPolicyFile, publishManagedAuthority, withReadFrame }
}
