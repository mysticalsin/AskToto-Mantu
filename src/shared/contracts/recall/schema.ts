import { z } from 'zod'
import { RECAP_STATUSES, recapStatusValidationError, type RecapStatus } from '../recap-status'
import { ProviderIdSchema } from '../providers'
import type { TranscriptLine } from '../transcript/schema'

function validateRecapStatus(value: { recap: string; recapStatus?: RecapStatus }, context: z.RefinementCtx): void {
  const message = recapStatusValidationError(value.recap, value.recapStatus)
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['recap'], message })
}

export interface MeetingSummary {
  file: string
  title: string
  date: string
  mode: string
  durationMin: number
  participants: string[]
  topics?: string[]
  /** Task MI-5: frontmatter `confidential: true` — excludes this meeting from every published wiki
   *  surface (note card, entity timelines/current-facts, indexes). Undefined/false = not confidential. */
  confidential?: boolean
  /** True for a real encrypted meeting this device can't decrypt: a locked stub (no preview), never silently dropped. */
  locked?: boolean
  notDownloaded?: boolean // bytes not on this device: listed by name, never read; an explicit open downloads it
  unavailable?: boolean // could not be read right now (a failed read or a non-regular entry): listed by name
}
export interface RecallHit extends MeetingSummary {
  snippet: string
  score: number
}

export const SetApiKeyPayloadSchema = z.object({
  provider: ProviderIdSchema,
  key: z.string()
})

export const ClearApiKeyPayloadSchema = z.object({
  provider: ProviderIdSchema
})

export const TestApiKeyPayloadSchema = z.object({
  provider: ProviderIdSchema,
  key: z.string()
})

export interface TestKeyResponse {
  ok: boolean
  error?: string
}

/** Result of the explicit "create a new local profile" recovery action. */
export interface ProfileRecoveryResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** Hidden archive directory name under Métis's userData folder (never a provider credential). */
  backupName?: string
  movedFiles?: number
}

/** Azure AD (Entra) sign-in. Restricts the app to the org's Microsoft domain and ties users to Dust. */
export interface AuthStatus {
  configured: boolean // true once AZURE_CLIENT_ID/AZURE_TENANT_ID/ASKTOTO_ALLOWED_DOMAIN are set
  signedIn: boolean
  email?: string
  name?: string
  domain?: string
  /** True when sign-in is actually enforced (env/managed-config requireAuth OR sticky-configured), even
   *  if `configured` is false. Mirrors main/auth.ts requireAuth()'s own gate so the SignInWall can never
   *  disagree with what privileged IPC actually blocks. Optional so existing partial consumers still typecheck. */
  enforced?: boolean
}
export interface SignInResult {
  ok: boolean
  configured?: boolean
  email?: string
  error?: string
}

export interface DustAgent {
  sId: string
  name: string
  description: string
  /** Model metadata reported by Dust for a live agent configuration (never a user-supplied model hint). */
  modelProviderId?: string
  modelId?: string
}

/** A single calendar event for today's agenda (read-only, from Microsoft Graph). */
export interface CalendarEvent {
  subject: string
  start: string // ISO datetime in the requested timezone
  end: string
  allDay: boolean
  location?: string
  online: boolean // has an online-meeting join link
  joinUrl?: string
  attendees: number
}

/** Result of pulling today's Outlook/M365 agenda. needsConsent → prompt a one-click connect (sign-in). */
export interface CalendarTodayResult {
  ok: boolean
  needsConsent?: boolean
  error?: string
  events?: CalendarEvent[]
}

/** Payload for recall:rename — fix an auto-generated meeting title after the fact. `file` is a bare
 *  basename (re-basenamed in main for defense); `title` mirrors recall.ts's own RENAME_TITLE_MAX cap. */
export const RenameMeetingPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.'),
  title: z.string().min(1, 'Enter a title.').max(120)
})
export type RenameMeetingPayload = z.infer<typeof RenameMeetingPayloadSchema>

/** Payload for recall:update-recap — edit a saved meeting's recap ("## Notes & follow-ups") after the
 *  fact. `file` is a bare basename (re-basenamed in main for defense); `recap` mirrors recall.ts's own
 *  RECAP_MAX cap. Empty is allowed (clearing the notes / annotating a meeting that had no recap yet). */
export const UpdateRecapPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.'),
  recap: z.string().max(20000),
  recapStatus: z.enum(RECAP_STATUSES).optional()
}).superRefine(validateRecapStatus)
export type UpdateRecapPayload = z.infer<typeof UpdateRecapPayloadSchema>

/** Payload for recall:set-confidential (Task MI-5) — flags/unflags a saved meeting so the wiki
 *  publisher (main/brain/publish.ts) excludes it from every published surface. `file` is a bare
 *  basename (re-basenamed in main for defense), mirroring RenameMeetingPayloadSchema/UpdateRecapPayloadSchema. */
export const SetConfidentialPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.'),
  confidential: z.boolean()
})
export type SetConfidentialPayload = z.infer<typeof SetConfidentialPayloadSchema>

/** Payload for recall:set-crm-pushed (MQA-092) — records the fingerprint of the CRM payload this
 *  meeting's push actually delivered, so re-opening it after a relaunch does not re-arm "Push to CRM".
 *  `key` is Review's base-36 payload hash; the shape is pinned here AND re-checked in main, because it
 *  is interpolated into a YAML scalar in the meeting's frontmatter. */
export const SetCrmPushedPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.'),
  key: z.string().regex(/^[a-z0-9]{1,32}$/, 'Invalid CRM push key.')
})
export type SetCrmPushedPayload = z.infer<typeof SetCrmPushedPayloadSchema>

/** Payload for recall:backfillSpeakers (Speaker Intelligence) — manually (re)trigger the Teams-transcript
 *  speaker-name backfill for a past meeting (see main/graph-transcript.ts + shared/transcript-align.ts).
 *  `file` is a bare basename (re-basenamed in main for defense), mirroring the other recall:* payloads. */
export const RecallBackfillSpeakersPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.')
})
export type RecallBackfillSpeakersPayload = z.infer<typeof RecallBackfillSpeakersPayloadSchema>

/** Result of reading a saved meeting back for "Resume session" (decoded transcript + recap). */
export interface RecallReadResult {
  ok: boolean
  error?: string
  title?: string
  mode?: string
  startedAt?: number
  durationMs?: number
  recap?: string
  /** Absent on legacy/unspecified notes; text length is not proof of generation completion. */
  recapStatus?: RecapStatus
  lines?: TranscriptLine[]
  /** Task MI-5 — frontmatter `confidential: true`, so a reopened past meeting's toggle reflects its
   *  actual saved state instead of always starting unflagged. */
  confidential?: boolean
  /** MQA-092 — frontmatter `crm_pushed: <payload fingerprint>`. Seeds Review's push state on mount so a
   *  meeting pushed before the last relaunch does not offer to push itself again. Absent = never pushed;
   *  a DIFFERENT fingerprint means the recap was edited since, which correctly re-arms the chip. */
  crmPushedKey?: string
}

/** Result of update:check — the manual Settings-driven check against the public releases feed. Exists
 *  alongside electron-updater's silent flow because unsigned macOS builds can't auto-install; the user
 *  still deserves to SEE a newer version was published (Settings → About → Updates). */
export interface UpdateCheckResult {
  ok: boolean
  /** The running app's version (app.getVersion()), always present so the row can show it. */
  current: string
  latest?: string
  available?: boolean
  /** https release page to download from — feed-provided html_url, or the fixed releases page. */
  url?: string
  error?: string
}

/** Result of IPC.updateDownload — did the in-app download start, or is this a build that must use the
 *  download page (blocked channel / portable / not the installed app)? See main/updater.ts. */
export interface UpdateDownloadStart {
  started: boolean
  reason?: string
}

/** Result of recall:export-plain — a user-initiated decrypted markdown copy of one saved meeting, so
 *  external tools (Claude local ingesting into the second brain, an email, an archive) can read it even
 *  when at-rest encryption is on. Always explicit per meeting; never a bulk decrypt. */
export interface DiagnosticsExportResult {
  ok: boolean
  /** Folder the bundle was written to. */
  path?: string
  /** How many files were copied. */
  files?: number
  cancelled?: boolean
  error?: string
}

export interface RecallExportPlainResult {
  ok: boolean
  /** Absolute path the copy was written to (absent when the user cancelled the save dialog). */
  path?: string
  cancelled?: boolean
  error?: string
}

/** Result of recall:backfillSpeakers (Speaker Intelligence) — `named` is how many transcript lines
 *  received a resolved display name; 0 is a normal, non-error outcome (no Teams transcript existed for
 *  this meeting yet, or nothing in it matched). */
export interface RecallBackfillSpeakersResult {
  ok: boolean
  error?: string
  named?: number
}

export interface DustAgentsResponse {
  ok: boolean
  agents?: DustAgent[]
  error?: string
}

/** Result of importing the local Dust CLI session (workspace + token + region) from the OS keychain. */
export interface DustCliImport {
  ok: boolean
  workspaceId?: string
  baseUrl?: string
  error?: string
  /** true when `dust login`'s browser step finished (access_token present) but the separate interactive
   *  terminal workspace-picker step never did (workspace_sid missing) — the user just needs to finish
   *  that step, not re-run the whole install + login. Distinguishes this from "no session at all". */
  incomplete?: boolean
  /** true when the failure was a BLOCKED keychain read (user hasn't allowed Métis to read the Dust CLI
   *  item) — as opposed to no session existing at all. Lets the UI prompt to allow access instead of
   *  wrongly re-running the install/login setup for a session that is actually present. */
  accessDenied?: boolean
}

/** Result of IPC.dustLoginBegin — a device code was minted and the consent page opened in the browser.
 *  The renderer shows userCode/verificationUri and starts calling IPC.dustLoginPoll every intervalSec. */
export interface DustDeviceLoginStart {
  ok: boolean
  error?: string
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  expiresInSec?: number
  intervalSec?: number
}

/** Result of one IPC.dustLoginPoll call. 'ok' carries the workspace list to render a picker from — no
 *  token ever crosses to the renderer (mirrors DustSessionProbe's no-token discipline above). */
export type DustDevicePollStatus = 'pending' | 'slow_down' | 'expired' | 'error' | 'ok'
export interface DustDevicePollResult {
  status: DustDevicePollStatus
  error?: string
  workspaces?: Array<{ sId: string; name: string; role?: string }>
}

/** Read-only probe of the local Dust CLI session — booleans only, never the token. Unlike DustCliImport
 *  this does NOT run `dust status` (no OAuth token rotation) and does NOT persist, so it is safe to call
 *  on Settings-open alongside a concurrent agent-list load. `ok` means a session is present in the
 *  keychain (an expired-but-present token still counts — it is refreshable, not a dead session). */
export interface DustSessionProbe {
  ok: boolean
  accessDenied?: boolean
  /** true when access_token is present but workspace_sid is missing — the user finished the browser
   *  OAuth step of `dust login` but not the separate terminal workspace-picker step. */
  incomplete?: boolean
}

/** Honest CLI session probe. Weekly-limit is signed-in, not disconnected. */
export type CliSessionVerdict = 'missing' | 'signed-out' | 'weekly-limit' | 'live' | 'unknown'

/** Result of a CLI provider detect/test operation (claude-cli, codex-cli). */
export interface CliActionResult {
  ok: boolean
  version?: string
  error?: string
  /** Present on Settings → Connect / session probe. Weekly-limit still has ok: true. */
  session?: CliSessionVerdict
}

/** Result of an in-app CLI install attempt. needsTerminal → EACCES; fall back to setupCli. */
export interface CliInstallResult {
  ok: boolean
  needsTerminal?: boolean
  error?: string
}

/** Status of the graphify knowledge-graph integration (see main/graphify.ts). */
export interface GraphStatus {
  enabled: boolean
  installed: boolean // graphify importable on this machine
  backend: string | null // resolved extraction backend (claude-cli | claude | openai), or null
  building: boolean
  hasGraph: boolean
  lastBuiltAt?: number
  nodes?: number
  edges?: number
  error?: string | null
}

/** Notes + topics connected to a given note, read from graph.json. */
export interface GraphRelated {
  ok: boolean
  error?: string
  topics: string[]
  notes: { file: string; title: string; via: string[] }[]
}

// ─── MCP connections (CRM push + "Book next steps") ────────────────────────
// Generalized from the single BidStack-only mcpCrm:* IPC channels. `connectionId` identifies WHICH
// mcpConnections entry a call targets (id === kind in v1 — see McpConnectionSchema); main looks the
// connection up in settings.mcpConnections rather than trusting an endpoint/key the renderer hands it,
// same defense-in-depth as the old single-connection handlers.
