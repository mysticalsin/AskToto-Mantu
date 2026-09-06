import log from 'electron-log'
import { app } from 'electron'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'

// Only the installed app owns a user profile. electron-log resolves its own file path, and outside an
// Electron main process it silently falls back to NodeExternalApi, whose log directory is
// `<appData>/<package.json name>/logs` — byte for byte the directory the installed app writes to. So a
// vitest worker (or any node script) that imported a main module appended into the real user's
// %APPDATA%/asktoto/logs/main.log, the file support reads to diagnose a field crash. `process.type` is
// electron-log's OWN main/node discriminator (its src/index.js), so reusing it here cannot disagree with
// which path resolver it picked. Anything that is not the app logs to a scratch directory instead.
const isAppMainProcess = process.type === 'browser'

/** Where log files go when this code is NOT the installed app's main process (tests, node scripts). */
const nonAppLogDir = join(tmpdir(), 'asktoto-nonapp-logs')

if (!isAppMainProcess) {
  log.transports.file.resolvePathFn = (): string => join(nonAppLogDir, 'main.log')
}

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

/** How many rotated audit generations to keep (`audit-<stamp>.log`), oldest pruned first. At the 5MB
 *  rotation size this bounds total retained history to ~100MB — a real compliance window, unlike the
 *  previous single `.old` generation (~10MB total, oldest half silently overwritten). Deliberately a
 *  constant, not a setting: retention of the security trail is the operator's policy (docs/AUDIT-LOG.md),
 *  not a per-user preference a compromised session could shrink. */
export const AUDIT_ARCHIVE_GENERATIONS = 20

const auditFilePath = (): string =>
  isAppMainProcess ? join(app.getPath('userData'), 'logs', 'audit.log') : join(nonAppLogDir, 'audit.log')

try {
  audit.transports.console.level = false
  audit.transports.file.level = 'info'
  audit.transports.file.maxSize = 5 * 1024 * 1024
  audit.transports.file.format = '{text}' // we format the whole line as JSON ourselves
  audit.transports.file.resolvePathFn = auditFilePath
  audit.transports.file.writeOptions = { ...audit.transports.file.writeOptions, mode: 0o600 }
  // Generational archives instead of electron-log's single-`.old` overwrite: rotation renames the full
  // file to `audit-<epoch-ms>.log` beside it and prunes past AUDIT_ARCHIVE_GENERATIONS. The hash chain
  // below runs UNBROKEN across generations (seq/prev never reset on rotation), so the verifier walks the
  // archives in order and proves the whole retained window, not just the live file.
  audit.transports.file.archiveLogFn = (file): void => {
    try {
      const oldPath = file.toString()
      const dir = dirname(oldPath)
      renameSync(oldPath, join(dir, `audit-${Date.now()}.log`))
      const archives = readdirSync(dir)
        .filter((f) => /^audit-\d+\.log$/.test(f))
        .sort()
      for (const stale of archives.slice(0, Math.max(0, archives.length - AUDIT_ARCHIVE_GENERATIONS))) {
        unlinkSync(join(dir, stale))
      }
    } catch {
      /* rotation is best-effort; a failed rename falls back to appending past maxSize */
    }
  }
} catch {
  /* best-effort */
}

// --- Tamper evidence -------------------------------------------------------------------------------
// Every record carries `seq` (monotonic across the whole trail, never reset by rotation) and `prev`
// (hex SHA-256 of the previous record's exact line). Editing, deleting, or reordering any line breaks
// the chain at that point, and `node scripts/verify-audit-log.mjs <logs-dir>` finds the break. The
// chain tip is resumed from disk at startup — from the live file's last line, else the newest archive —
// so an app restart continues the chain instead of starting a parallel one. Records written by builds
// that predate the chain simply lack the fields; the verifier reports them as a legacy prefix.
const sha256 = (line: string): string => createHash('sha256').update(line, 'utf8').digest('hex')

let chainSeq = 0
let chainPrev = 'GENESIS'
let chainLoaded = false

function lastAuditLine(p: string): string | null {
  try {
    // electron-log writes CRLF on Windows — resume from the logical line, never with a trailing \r.
    const lines = readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
    return lines.length ? lines[lines.length - 1] : null
  } catch {
    return null
  }
}

function loadChainTip(): void {
  chainLoaded = true
  try {
    const live = auditFilePath()
    let tip = existsSync(live) ? lastAuditLine(live) : null
    if (tip === null) {
      const dir = dirname(live)
      const newest = existsSync(dir)
        ? readdirSync(dir).filter((f) => /^audit-\d+\.log$/.test(f)).sort().pop()
        : undefined
      if (newest) tip = lastAuditLine(join(dir, newest))
    }
    if (tip !== null) {
      const parsed = JSON.parse(tip) as { seq?: unknown }
      chainSeq = typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : 0
      chainPrev = sha256(tip)
    }
  } catch {
    // An unreadable/corrupt tip must never block auditing — the verifier will surface the discontinuity.
    chainSeq = 0
    chainPrev = 'GENESIS'
  }
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
  | 'dust.oauth.login'
  | 'key.set'
  | 'key.removed'
  | 'capture.screen'
  | 'capture.display_mismatch'
  | 'capture.blocked'
  | 'capture.failed'
  | 'capture.check'
  | 'transcript.saved'
  | 'transcript.deleted'
  | 'transcript.renamed'
  | 'transcript.recap_edited'
  | 'transcript.recovered'
  | 'transcript.debrief'
  | 'transcript.imported'
  // Speaker Intelligence (Phases A/B): a Teams-transcript name backfill actually resolved >=1 name.
  | 'transcript.speakers_backfilled'
  // Speaker Intelligence (P2): the auto-enrollment flywheel folded >=1 session cluster's buffered
  // embeddings into a permanent voiceprint under a Teams-VTT-resolved real name (see backfillSpeakerNames).
  | 'speaker.auto_enrolled'
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
  | 'provider.failover'
  | 'provider.blocked'
  | 'net.proxy'
  // Managed egressAllowlist (net/egress-guard.ts): policy armed at boot, and each host it refused (once
  // per host per session, hostname only).
  | 'net.egress.policy'
  | 'net.egress.blocked'
  | 'settings.changed'
  | 'settings.profile_recovered'
  | 'graph.purged'
  | 'calendar.read'
  | 'asr.model.fetch_requested'
  | 'asr.model.removed'
  | 'app.started'
  | 'app.crash'
  // The overlay renderer stopped answering Chromium (event loop wedged, not crashed). Logged so a stuck
  // island is diagnosable from the support bundle; the app does not reload or kill it on this signal.
  | 'app.unresponsive'
  | 'meeting.detect.degraded'
  | 'recall.open'
  | 'recall.export' // user-initiated decrypted md copy of one meeting (recall:export-plain)
  // Generalized MCP push connections (BidStack CRM, Plane, ClickUp, …) — see main/mcp/mcpClient.ts.
  | 'mcp.connected'
  | 'mcp.disconnected'
  | 'mcp.push'
  // ClickUp / Plane OAuth 2.1+PKCE handshake itself (main/mcp/clickupOAuth.ts, planeOAuth.ts) —
  // distinct from the generic mcp.connected above, which fires once the resulting token is actually saved.
  | 'clickup.oauth.state_mismatch'
  | 'clickup.oauth.denied'
  | 'clickup.oauth.failed'
  | 'plane.oauth.state_mismatch'
  | 'plane.oauth.denied'
  | 'plane.oauth.failed'
  | 'dust.conversation'
  | 'brain.ingest'
  | 'brain.backfill.start'
  // Wave 3 (main/brain/consolidate.ts): one batched extraction pass actually ran. Distinct from
  // 'brain.ingest' (per-meeting) — this is the per-PASS marker metrics.ts counts against the
  // maxPassesPerDay budget.
  | 'brain.consolidation'
  | 'brain.intelligence_index'
  | 'brain.intelligencePass.start'
  // Wave 4 (main/mcp/pushQueue.ts): an outbound CRM/task-manager action was queued, retried, sent, or
  // dead-lettered — the audit trail for the push queue's own lifecycle, separate from 'mcp.push' (one
  // live attempt).
  | 'mcp.push.queued'
  | 'mcp.push.retried'
  | 'mcp.push.dead_letter'
  | 'mcp.push.skipped_confidential'
  | 'mcp.push.operator_requeue'
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
  // Support diagnosability: the user exported the log trail to a folder (metadata only — file count).
  | 'diagnostics.export'
  | 'llm.call'
  | 'time-saved.event'
  | 'outlook.draft'
  // Attack-shaped events. Metadata only: bucket/reason, never keys, serials, tokens, or transcripts.
  | 'security.rate_limited'
  | 'security.ipc_denied'

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
    if (!chainLoaded) loadChainTip()
    chainSeq += 1
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: chainSeq,
      prev: chainPrev,
      event,
      ...(actor ? { actor } : {}),
      ...detail
    })
    // Advance the tip BEFORE handing the line to the transport: audit.info is synchronous here
    // (file transport sync:true), but the chain must stay correct even if a future transport buffers.
    chainPrev = sha256(line)
    audit.info(line)
  } catch {
    /* never let auditing break the app */
  }
}

/** Test seam: the current chain tip, so a behavioral test can prove continuity without parsing files. */
export function auditChainTip(): { seq: number; prev: string } {
  if (!chainLoaded) loadChainTip()
  return { seq: chainSeq, prev: chainPrev }
}

/** Test seam: where the audit trail lives for this process (the real userData in the app, tmp in tests). */
export function auditLogPath(): string {
  return auditFilePath()
}

/** Basename pattern of a rotated audit generation — shared with scripts/verify-audit-log.mjs. */
export const AUDIT_ARCHIVE_PATTERN = /^audit-\d+\.log$/
