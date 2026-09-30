import log from 'electron-log'
import { app } from 'electron'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import {
  isObservabilityEvent,
  projectEvent,
  type ObservabilityDetail,
  type ObservabilityEvent
} from './infra/observability/projection'

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

// app.*, sidecar.*, history.* and reveal events are observability events: each needs an allowlist in
// infra/observability/projection.ts (tsc enforces it) and is written without an actor.
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
  | 'writeup.span'
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
  // M2-0003: index.json exists but cannot be used on this device this session (io / undecryptable /
  // unsupported / corrupt-kept), and a decoded-but-invalid index was set aside. Content-free: cause/
  // counts only, never a path, decode reason, or filename.
  | 'brain.index.unavailable'
  | 'brain.index.quarantined'
  | 'brain.index.preserved_restore'
  | 'brain.index.preserved_delete'
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
  | 'app.renderer.ready'
  // FITO-185-U: live Act1 DOM probe summary (userData/logs/act1-dom.json).
  | 'app.act1.dom'
  | 'app.crash'
  // M2-0215: a handled boot-step failure; boot continues without that step's work.
  | 'app.error.boot_step'
  // M2-0215: a handled window-create failure; the next reveal retries creation.
  | 'app.error.window_create'
  // M2-0215: safe-start skipped brain resume after repeated early deaths.
  | 'app.error.early_death'
  // M2-0037/M2-0215: the automatic reload after render-process-gone itself failed to load; the overlay
  // is left as-is with no further automatic retry.
  | 'app.error.reload_failed'
  // M2-0006: the clean-shutdown marker — written at the end of will-quit, so the NEXT app.started can
  // report a real prevShutdown classification instead of no evidence at all (see boot-sentinel.ts).
  | 'app.shutdown.clean'
  // M2-0006: a 1s heartbeat timer fired at least 1s late (main-thread stall — see
  // infra/observability/stall-monitor.ts and its orchestrator run-observability.ts), plus its periodic
  // p99 summary.
  | 'app.stall'
  | 'app.stall.summary'
  // M2-0192: the out-of-process stall sampler (infra/observability/stall-sampler.ts). `sampled` names a
  // content-free bundle in userData/diagnostics/stalls/ by file name; `sample_failed` carries only a
  // reason ("sample" | "bundle" | "watcher") — double-quoted so audit-event-coverage.contract.test.ts's
  // single-quote scan for declared event names does not mistake them for members of this union.
  // bootId is the boot that stalled.
  | 'app.stall.sampled'
  | 'app.stall.sample_failed'
  // M2-0006: pairs app.unresponsive with how long the renderer stayed wedged before it recovered.
  | 'app.responsive'
  // A main-process, state-checked repair completed a renderer handoff after durable setup save.
  | 'app.recovery'
  // FITO-185-E: 15s MQA-175 callback closed the boot watch (finally), whether brain resume ran or threw.
  | 'app.boot.watch_cleared'
  // M2-0515: one native boot stage's own main-thread duration (tray stages, window construction and first show).
  | 'app.boot.stage'
  // FITO-185-F: menu-bar Tray create succeeded/failed — hardprove AXExtrasMenuBar needs a diagnosable trail.
  | 'tray.created'
  | 'tray.failed'
  // The overlay renderer stopped answering Chromium (event loop wedged, not crashed). Logged so a stuck
  // island is diagnosable from the support bundle; the app does not reload or kill it on this signal.
  | 'app.unresponsive'
  // M2-0215: user-visible reveal attempt and outcome.
  | 'reveal'
  // M2-0215: long-lived local sidecar process started.
  | 'sidecar.spawn'
  // M2-0215: long-lived local sidecar process exited.
  | 'sidecar.exit'
  // M2-0028: a supervised sidecar launch fell back to direct spawn because the wrapper was unavailable.
  | 'sidecar.unsupervised'
  // M2-0215: History list request timing across renderer and main.
  | 'history.request'
  // M2-0037 (B3-RC2): render-process-gone's reload budget was exhausted (>=3 reloads within 60s with no
  // recovered 30s-alive window) — auto-reload stops and a recovery dialog is shown instead.
  | 'app.render_loop_halted'
  | 'meeting.detect.degraded'
  | 'recall.open'
  | 'recall.export' // user-initiated decrypted md copy of one meeting (recall:export-plain)
  // A cloud-placeholder probe could not classify a batch of meeting files, so they were treated as
  // cloud-only and not read. Once per failure streak; reason and file count only.
  | 'storage.dataless_probe_failed'
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
  // M2-0033: scheduler decisions (backfill scan counts, deferrals, maintenance window) — counts and enums only, never paths or names.
  | 'scheduler.job'
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
  | 'sidecar.reaped'
  | 'sidecar.reap.skipped'
  // M2-0028: content-free markers from the packaged HK-M proof (main/qa-hk-m.ts), written only when
  // METIS_HK_M_SCENARIO selects a row on an isolated QA profile.
  | 'hk-m.active-inference'
  | 'hk-m.ffmpeg-import'
  | 'hk-m.registry-write'
  // M2-0460: a row's setup threw ({ row, error: <Error class name> }, never the message), and the advertised-RAM
  // floor was lifted during an HK-M row ({ modelId, advertisedGB, requiredGB, totalmemBytes }).
  | 'hk-m.setup-failed'
  | 'hk-m.ram-floor-override'
  // M2-0431: an overlay reveal parked within 2 s with no click or keypress (island/overlay-reveal-log.ts).
  // Projected to { visibleMs, zone, placement, layout } only (infra/observability/projection.ts).
  | 'overlay.flash'
  // M2-0494: the packaged QA build is feeding a WAV from its isolated profile as the microphone
  // (main/qa-capture-source.ts). { active: true } only — never the path or file name.
  | 'qa.capture.file_source'
  // M2-0482: the packaged, isolated-profile QA gate (qa-hk-m.ts qaHostFloorOverride) first lifted a RAM floor in this
  // process. Once per floor: { floor: "prewarm-available-ram" | "advertised-ram", hostTotalBytes, hostAvailableBytes }.
  | 'local.host-floor-override'
  | 'local.model.checksum_fail'
  // First-run weight download (local-model-download.ts). The weights are no longer bundled, so these
  // are the audit trail for the only network fetch installed code makes for model files.
  | 'local.model.download_start'
  | 'local.model.download_ok'
  | 'local.model.download_fail'
  | 'screen.preprocess.describe'
  // M2-0429: the background screen reader stopped retrying a failing capture (one line per failure streak).
  | 'screen.preprocess.suspended'
  // M2-0429: the user ran Repair, which resets only this app's Screen Recording entry ({ ok, exitCode }).
  | 'permission.repair'
  // Support diagnosability: the user exported the log trail to a folder (metadata only — file count).
  | 'diagnostics.export'
  | 'llm.call'
  | 'time-saved.event'
  | 'outlook.draft'
  // Attack-shaped events. Metadata only: bucket/reason, never keys, serials, tokens, or transcripts.
  | 'security.rate_limited'
  | 'security.ipc_denied'
  // Operator seat license (METIS-OP-1) pairing and entitlement gating (PLAN.md P2.2b). jti only, never
  // the full token; 'operator.gate.blocked' carries the feature name only, never any request content.
  | 'operator.license.activated'
  | 'operator.license.cleared'
  | 'operator.gate.blocked'

/** What an event may carry: an observability event only its allowlisted fields. */
export type AuditDetail<E extends AuditEvent> = E extends ObservabilityEvent ? ObservabilityDetail<E> : Record<string, unknown>
export type AuditSink = typeof auditLog

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
export function auditLog<E extends AuditEvent>(event: E, detail?: AuditDetail<E>): void {
  try {
    const observability = isObservabilityEvent(event)
    const rawDetail: Readonly<Record<string, unknown>> = detail ?? {}
    const fields = observability ? projectEvent(event, rawDetail) : rawDetail
    let actor: string | undefined
    if (!observability) {
      try {
        actor = actorResolver?.()
      } catch {
        /* a broken resolver must never block the audit write */
      }
    }
    if (!chainLoaded) loadChainTip()
    chainSeq += 1
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: chainSeq,
      prev: chainPrev,
      event,
      ...(actor ? { actor } : {}),
      ...fields
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

/** Where the audit trail lives for this process (userData/logs in the app, a scratch directory otherwise). */
export function auditLogPath(): string {
  return auditFilePath()
}

/** Basename pattern of a rotated audit generation — shared with scripts/verify-audit-log.mjs. */
export const AUDIT_ARCHIVE_PATTERN = /^audit-\d+\.log$/
