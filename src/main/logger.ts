import log from 'electron-log'
import { app } from 'electron'
import { join } from 'node:path'

let initialized = false

/**
 * Route main-process logs to a rotated file (production logs were previously discarded). Best-effort —
 * logging must never throw into app code. Call once, early in app startup.
 */
export function initLogging(): void {
  if (initialized) return
  initialized = true
  try {
    log.transports.file.level = 'info'
    log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB; electron-log rotates the file to *.old past this
    log.transports.file.writeOptions = { ...log.transports.file.writeOptions, mode: 0o600 }
    log.transports.console.level = process.env.NODE_ENV === 'development' ? 'silly' : false
  } catch {
    /* logging is best-effort */
  }
}

/** The shared main logger (file + dev console). Use for diagnostics + crash dumps. */
export const mainLog = log

// A separate, append-only AUDIT log for security-relevant events — one JSON object per line, its own
// rotated file (userData/logs/audit.log), kept distinct from the noisy diagnostic log.
const audit = log.create({ logId: 'audit' })
try {
  audit.transports.console.level = false
  audit.transports.file.level = 'info'
  audit.transports.file.maxSize = 5 * 1024 * 1024
  audit.transports.file.format = '{text}' // we format the whole line as JSON ourselves
  audit.transports.file.resolvePathFn = (): string => join(app.getPath('userData'), 'logs', 'audit.log')
  audit.transports.file.writeOptions = { ...audit.transports.file.writeOptions, mode: 0o600 }
} catch {
  /* best-effort */
}

export type AuditEvent =
  | 'auth.signin'
  | 'auth.signout'
  | 'auth.expired'
  | 'auth.refresh_failed'
  | 'auth.denied'
  | 'auth.state_mismatch'
  | 'auth.signin_failed'
  | 'dust.token.refreshed'
  | 'dust.setup.timeout'
  | 'key.set'
  | 'key.removed'
  | 'capture.screen'
  | 'capture.display_mismatch'
  | 'capture.blocked'
  | 'capture.failed'
  | 'transcript.saved'
  | 'transcript.deleted'
  | 'transcript.renamed'
  | 'transcript.recap_edited'
  | 'transcript.recovered'
  | 'transcript.debrief'
  | 'transcript.imported'
  // Speaker Intelligence (Phases A/B): a Teams-transcript name backfill actually resolved >=1 name.
  | 'transcript.speakers_backfilled'
  | 'brain.commitment.settled'
  | 'brain.deal.outcome'
  | 'brain.entity.renamed'
  | 'brain.entity.field_decision'
  | 'brain.entity.merged'
  | 'brain.entity.unmerged'
  | 'brain.entity.field_updated'
  | 'brain.entity.asr_correction_added'
  | 'brain.commitment.rejected'
  | 'brain.rebuild.aborted'
  | 'brain.corrections.lock_cleared'
  // Task MI-5: the markdown mirror (main/brain/publish.ts).
  | 'transcript.confidential_set'
  | 'brain.publish.consent'
  | 'brain.publish.disabled'
  | 'note.saved'
  | 'answer.feedback'
  | 'provider.request'
  | 'provider.failed'
  | 'provider.retry'
  | 'provider.blocked'
  | 'net.proxy'
  | 'settings.changed'
  | 'settings.profile_recovered'
  | 'graph.purged'
  | 'calendar.read'
  | 'app.crash'
  | 'meeting.detect.degraded'
  | 'recall.open'
  | 'recall.export' // user-initiated decrypted md copy of one meeting (recall:export-plain)
  | 'bidstack.connected'
  | 'bidstack.disconnected'
  | 'bidstack.push'
  | 'dust.conversation'
  | 'brain.ingest'
  | 'brain.backfill.start'
  | 'local.runtime.start'
  | 'local.runtime.stop'
  | 'local.runtime.crash'
  | 'local.runtime.restart'
  | 'local.runtime.missing'
  | 'local.model.checksum_fail'
  // First-run weight download (local-model-download.ts). The weights are no longer bundled, so these
  // are the audit trail for the only network fetch installed code makes for model files.
  | 'local.model.download_start'
  | 'local.model.download_ok'
  | 'local.model.download_fail'
  | 'screen.preprocess.describe'
  | 'cahe.localai.seeded'

// Lazy actor resolver — set once by the main process (wired to authStatus().email) so every audit
// record can carry the signed-in identity without logger.ts importing auth.ts (which would be
// circular: auth.ts already imports mainLog/auditLog from here).
let actorResolver: (() => string | undefined) | null = null

/** Register how to resolve the current actor's identity for audit records. Call once at startup. */
export function setAuditActor(fn: () => string | undefined): void {
  actorResolver = fn
}

/**
 * Append a structured audit record. NEVER pass secrets or message/transcript CONTENT — metadata only
 * (provider id, mode, outcome, byte counts, domain, event type). Best-effort; never throws.
 */
export function auditLog(event: AuditEvent, detail: Record<string, unknown> = {}): void {
  try {
    let actor: string | undefined
    try {
      actor = actorResolver?.()
    } catch {
      /* a broken resolver must never block the audit write */
    }
    audit.info(JSON.stringify({ ts: new Date().toISOString(), event, ...(actor ? { actor } : {}), ...detail }))
  } catch {
    /* never let auditing break the app */
  }
}
