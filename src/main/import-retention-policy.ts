import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'

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

export function assertImportTranscriptRetentionAllowed(settings: unknown): void {
  if (!canRetainImportedTranscript(settings)) throw new ImportRetentionBlockedError()
}

export function isImportRetentionBlocked(error: unknown): error is ImportRetentionBlockedError {
  return error instanceof ImportRetentionBlockedError
}
