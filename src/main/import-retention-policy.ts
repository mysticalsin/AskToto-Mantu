import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'

export type ImportRetentionState = 'allowed' | 'summary-only' | 'unavailable'

/** Fixed, content-free refusal shown while the trusted enterprise profile forbids transcript retention. */
export const SUMMARY_ONLY_IMPORT_REFUSAL =
  'Recording import currently requires retaining a full transcript. Your organization’s summary-only policy prevents import. Your original recording is unchanged.'

/** Resolve only the already-trusted settings/profile input; renderer-supplied policy flags are never accepted. */
export function canRetainImportedTranscript(settings: unknown): boolean {
  const profile = resolveEnterpriseLiveProfile(settings)
  return !isSummaryOnlyProfile(profile)
}

export class ImportRetentionBlockedError extends Error {
  readonly code = 'IMPORT_RETENTION_BLOCKED'

  constructor() {
    super(SUMMARY_ONLY_IMPORT_REFUSAL)
    this.name = 'ImportRetentionBlockedError'
  }
}

/** Fixed refusal used when the current managed-policy boundary cannot be proven readable. */
export class ImportRetentionAuthorityUnavailableError extends Error {
  readonly code = 'IMPORT_RETENTION_AUTHORITY_UNAVAILABLE'

  constructor() {
    super('The recording import policy could not be verified. Try again when organization settings are available.')
    this.name = 'ImportRetentionAuthorityUnavailableError'
  }
}

export function assertImportTranscriptRetentionAllowed(settings: unknown): void {
  if (!canRetainImportedTranscript(settings)) throw new ImportRetentionBlockedError()
}

export function isImportRetentionBlocked(error: unknown): error is ImportRetentionBlockedError {
  return error instanceof ImportRetentionBlockedError
}

export function isImportRetentionRefusal(error: unknown): boolean {
  return error instanceof ImportRetentionBlockedError || error instanceof ImportRetentionAuthorityUnavailableError
}

/** Main-owned policy boundary shared by admission, persistence, and held-reason decisions. */
export class ImportJobRetentionPolicy {
  constructor(
    private readonly currentStatus?: () => ImportRetentionState,
    private readonly legacyCanRetain?: () => boolean
  ) {}

  status(): ImportRetentionState {
    if (this.currentStatus) {
      try {
        const value = this.currentStatus()
        return value === 'allowed' || value === 'summary-only' || value === 'unavailable' ? value : 'unavailable'
      } catch {
        return 'unavailable'
      }
    }
    try {
      return this.legacyCanRetain?.() === false ? 'summary-only' : 'allowed'
    } catch {
      return 'unavailable'
    }
  }

  allowed(): boolean {
    return this.status() === 'allowed'
  }

  assertAllowed(): void {
    const state = this.status()
    if (state !== 'allowed') throw this.error(state)
  }

  error(state: ImportRetentionState): Error {
    return state === 'unavailable' ? new ImportRetentionAuthorityUnavailableError() : new ImportRetentionBlockedError()
  }

  holdReason(): 'policy' | 'restart' {
    return this.status() === 'summary-only' ? 'policy' : 'restart'
  }
}
