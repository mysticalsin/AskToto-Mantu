import { AuditEventRecordSchema, type AuditEventRecord } from '@shared/contracts/audit-event'
import type { CloudSpeechFailure } from '@shared/cloud-speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { CloudSpeechIpcOptions, LanguageChangeOutcome } from './cloud-speech-ipc-support'

export const LANGUAGE_CHANGE_AUDIT_EVENT = 'speech.language.change' as const
const SURFACE = 'cloudSpeech.language'
// Total over every failure code, so a new code fails type checking until it is classified.
const FAILURE_OUTCOME: Readonly<Record<CloudSpeechFailure['code'], 'refused' | 'failed'>> = {
  DISABLED: 'refused',
  AUTH: 'refused',
  POLICY: 'refused',
  CONSENT: 'refused',
  NOT_READY: 'refused',
  NOT_CONFIGURED: 'refused',
  STALE: 'refused',
  CLOSED: 'refused',
  INVALID_REQUEST: 'refused',
  ORDER: 'failed',
  QUEUE_LIMIT: 'failed',
  QUEUE_STALE: 'failed',
  TRANSPORT: 'failed',
  TIMEOUT: 'failed',
  CLOSURE_UNCONFIRMED: 'failed'
}

/**
 * Content-free record for one user language change request: who, the outcome and an enum-like reason. The requested
 * and resulting languages are never recorded. Returns null if the record would not satisfy the audit contract.
 */
export function languageChangeAuditRecord(
  ref: OwnerSessionRef | null,
  outcome: LanguageChangeOutcome,
  ts: number
): AuditEventRecord | null {
  const parsed = AuditEventRecordSchema.safeParse({
    v: 1,
    event: LANGUAGE_CHANGE_AUDIT_EVENT,
    ownerKey: ref?.ownerKey ?? null,
    sessionId: ref?.sessionId ?? null,
    surface: SURFACE,
    outcome: outcome.ok ? 'allowed' : FAILURE_OUTCOME[outcome.code],
    reason: outcome.ok
      ? outcome.changed
        ? 'user-selected'
        : 'unchanged'
      : outcome.code.toLowerCase().replaceAll('_', '-'),
    privacyClass: 'P1',
    ts
  })
  return parsed.success ? parsed.data : null
}

export interface LanguageChangeAuditDeps {
  resolveOwner: (frame: { processId: number; routingId: number }) => OwnerSessionRef | null
  audit: (event: typeof LANGUAGE_CHANGE_AUDIT_EVENT, record: AuditEventRecord) => void
  now?: () => number
}

/** The `onLanguageChange` hook for registerCloudSpeechIpc. Best effort: it never throws into the IPC handler. */
export function createLanguageChangeAudit(
  deps: LanguageChangeAuditDeps
): NonNullable<CloudSpeechIpcOptions['onLanguageChange']> {
  const now = deps.now ?? (() => Date.now())
  return (owner, outcome) => {
    try {
      const { processId, routingId } = owner.binding
      const record = languageChangeAuditRecord(deps.resolveOwner({ processId, routingId }), outcome, now())
      if (record) deps.audit(LANGUAGE_CHANGE_AUDIT_EVENT, record)
    } catch {
      // auditing is best effort
    }
  }
}
