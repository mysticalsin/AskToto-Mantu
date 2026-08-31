import { z } from 'zod'
import type { ProviderId } from './providers'
import { LocalVisionEvidenceSchema } from './local-ai'
import { EntityKindSchema } from './brain'

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'nvidia',
  'deepseek',
  'qwen',
  'minimax',
  'kimi',
  'openrouter',
  'groq',
  'mistral',
  'grok',
  'dust',
  'claude-cli',
  'codex-cli',
  'gemini',
  'cloudflare',
  'local',
  'custom'
])

// Compile-time parity guard: ProviderIdSchema (this enum) must match the ProviderId union in
// providers.ts exactly. If either side drifts, this assignment fails to typecheck.
type _ProviderIdEnum = z.infer<typeof ProviderIdSchema>
const _providerIdParity: ([_ProviderIdEnum] extends [ProviderId]
  ? [ProviderId] extends [_ProviderIdEnum]
    ? true
    : never
  : never) = true
void _providerIdParity

/** Single source of truth for every IPC channel name. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsRecoverProfile: 'settings:recoverProfile',
  setApiKey: 'settings:setApiKey',
  clearApiKey: 'settings:clearApiKey',
  testApiKey: 'settings:testApiKey',
  dustListAgents: 'dust:listAgents',
  dustImportCli: 'dust:importCli',
  dustProbeSession: 'dust:probeSession',
  // Native OAuth sign-in (no CLI, no system Node.js) — see main/dust-oauth.ts.
  dustLoginBegin: 'dust:loginBegin',
  dustLoginPoll: 'dust:loginPoll',
  dustLoginPickWorkspace: 'dust:loginPickWorkspace',
  dustInstallCli: 'dust:installCli',
  dustInstallCliProgress: 'dust:installCli:progress',
  graphifyStatus: 'graphify:status',
  graphifyRebuild: 'graphify:rebuild',
  graphifyRelated: 'graphify:related',
  graphifyOpenGraph: 'graphify:openGraph',
  brainStatus: 'brain:status',
  brainBackfill: 'brain:backfill',
  brainRead: 'brain:read',
  brainEntityNames: 'brain:entityNames',
  restoreEmbeddedCloudflareKey: 'settings:restoreEmbeddedCloudflareKey',
  brainOpenDashboard: 'brain:openDashboard',
  brainRebuildAll: 'brain:rebuildAll',
  brainClearJournalCorruption: 'brain:clearJournalCorruption',
  authStatus: 'auth:status',
  authSignIn: 'auth:signIn',
  authSignOut: 'auth:signOut',
  calendarToday: 'calendar:today',
  parakeetStatus: 'parakeet:status',
  parakeetEnsure: 'parakeet:ensure',
  parakeetFeed: 'parakeet:feed',
  parakeetProgress: 'parakeet:progress',
  // Apple Speech (SFSpeechRecognizer, on-device via the mac-helper sidecar) — opt-in third ASR engine.
  // No status/ensure/progress channels: unlike Parakeet there is no bundled model to download: the
  // helper binary either transcribes or the call resolves to '' (see main/apple-speech.ts).
  appleSpeechFeed: 'apple-speech:feed',
  // Speaker Intelligence — Whisper's speaker-embedding tap. echo:true means operator loopback bleed.
  speakerEmbed: 'speaker:embed',
  askStart: 'ask:start',
  askCancel: 'ask:cancel',
  // Explicit "new chat" boundary: clears the main-owned carriers of cross-question state (the server-side
  // Dust conversation + the follow-up-memory idle clock). The renderer clears its own history refs; without
  // this channel that clear was a no-op for Dust users (the contamination lived server-side).
  askResetContext: 'ask:resetContext',
  streamDelta: 'stream:delta',
  streamDone: 'stream:done',
  streamError: 'stream:error',
  streamMeta: 'stream:meta',
  captureScreen: 'capture:screen',
  prewarmCapture: 'capture:prewarm',
  screenContext: 'capture:context',
  armAudio: 'audio:arm',
  saveTranscript: 'transcript:save',
  saveDraftTranscript: 'transcript:saveDraft',
  saveNote: 'note:save',
  importAudioPick: 'import-audio:pick',
  importAudioStart: 'import-audio:start',
  importJobsList: 'import-audio:jobs:list',
  importJobCancel: 'import-audio:job:cancel',
  importJobResume: 'import-audio:job:resume',
  importJobRemove: 'import-audio:job:remove',
  importAudioProgress: 'import-audio:progress',
  // Private channels used only by the sandboxed hidden decoder window. They are never bridged to the
  // interactive overlay preload.
  importDecoderChunk: 'import-decoder:chunk',
  importDecoderComplete: 'import-decoder:complete',
  importDecoderFailed: 'import-decoder:failed',
  importDecoderReady: 'import-decoder:ready',
  importDecoderSourceAck: 'import-decoder:source-ack',
  exportRecapJson: 'recap:export-json',
  pickFolder: 'folder:pick',
  addTeamTranscriptFolder: 'team-folder:add',
  removeTeamTranscriptFolder: 'team-folder:remove',
  openPath: 'path:open',
  openBrainForClaude: 'brain:open-for-claude',
  recallList: 'recall:list',
  recallSearch: 'recall:search',
  recallOpen: 'recall:open',
  recallRead: 'recall:read',
  recallExportPlain: 'recall:export-plain', // user-initiated decrypted md copy of ONE meeting
  recallDelete: 'recall:delete',
  recallRename: 'recall:rename',
  recallUpdateRecap: 'recall:update-recap',
  recallSetConfidential: 'recall:set-confidential',
  // MQA-092: durable "this recap already reached the CRM" marker, so a relaunch cannot re-arm the push
  // and file a byte-identical duplicate record. See recall.ts's setMeetingCrmPushed.
  recallSetCrmPushed: 'recall:set-crm-pushed',
  recallBackfillSpeakers: 'recall:backfillSpeakers',
  recallDeleteAll: 'recall:deleteAll',
  // Support diagnosability: copy the log trail (main + audit + crash dumps + boot sentinel) into a
  // user-chosen folder — the ONLY way that data reaches support, since nothing uploads by design.
  diagnosticsExport: 'diagnostics:export',
  debriefSave: 'debrief:save',
  brainCommitmentSettle: 'brain:commitmentSettle',
  brainSetDealOutcome: 'brain:setDealOutcome',
  // Correction engine (Task MI-2): human fixes for misheard/merged entities and never-made commitments.
  brainEntityRename: 'brain:entityRename',
  brainEntityMerge: 'brain:entityMerge',
  brainEntityUnmerge: 'brain:entityUnmerge',
  brainEntityUpdateField: 'brain:entityUpdateField',
  brainCommitmentReject: 'brain:commitmentReject',
  // Dashboard suggestion accept/dismiss (deferred CRM pattern 3): callable from the Mantu Intelligence
  // window (see assertBrainReader in main/index.ts), not just the main window — the one privileged
  // write that surface gets, narrowly scoped to promoting a single already-extracted field.
  brainFieldDecision: 'brain:field-decision',
  // Task MI-3: read-only channels feeding the CRM record pages, the Review.tsx entity strip, and the
  // needs-attention queue.
  brainMeetingExtraction: 'brain:meetingExtraction',
  brainAttention: 'brain:attention',
  windowResize: 'window:resize',
  windowMode: 'window:mode',
  windowMoveBy: 'window:moveBy',
  windowHide: 'window:hide',
  windowToggle: 'window:toggle',
  windowQuit: 'window:quit',
  windowRelaunch: 'window:relaunch',
  windowMinimize: 'window:minimize',
  // Vibe-Island auto-hide: pin the overlay to the top-center of its current display and re-arm the
  // resizeTo anchor there, so the peek strip / revealed bar grow downward from the top edge. Never
  // shows or focuses the window — a pure setBounds, so the user's foreground app keeps focus.
  windowAnchorTop: 'window:anchorTop',
  // Auto-hide reveal: widen the window back to the full bar width (the peek narrowed it via
  // data-hug-width, and the plain-bar view never reports a width again). Pure setBounds; no show/focus.
  windowRevealWidth: 'window:revealWidth',
  // Main-process cursor watch (darwin / Windows top-edge): menu-bar / Dynamic Island
  // often does not deliver mouseenter. Payload: { hovering: boolean }.
  overlayCursorHover: 'overlay:cursorHover',
  // Renderer finished the hide spring (or 400ms fallback) — now park the rest rect.
  overlayParkAfterHide: 'overlay:parkAfterHide',
  // Renderer ErrorBoundary catch (React render-throw) → persisted crash-*.log, same sink as onFatal's
  // main-process crashes. Distinct from render-process-gone (whole renderer dies): this is a caught JS
  // exception the renderer survives, previously visible only via ASKTOTO_DEBUG_RENDERER console mirroring.
  rendererCrash: 'renderer:crash',
  hotkey: 'hotkey',
  shortcutFailures: 'shortcuts:failures',
  permissionsGet: 'permissions:get',
  permissionsOpenSettings: 'permissions:openSettings',
  permissionsRequestUpfront: 'permissions:requestUpfront',
  listeningState: 'listening:state',
  asrBundled: 'asr:bundled',
  // Métis Local (on-device LLM): read-only readiness metadata for the model bundled in the installer.
  localModelsList: 'localModels:list',
  // MQA-247: the high-accuracy transcription model. Its own pair rather than folded into the LLM
  // channel above — different asset, different size, different consent, and a user may want one
  // and not the other.
  asrModelState: 'asrModel:state',
  asrModelFetch: 'asrModel:fetch',
  asrModelRemove: 'asrModel:remove',
  // Live-meeting pre-warm (PLAN.md §4.4): a debounced transcript tail, fire-and-forget, so the sidecar's
  // per-slot KV cache stays hot between real suggest requests. See LocalPrewarmPayloadSchema.
  localPrewarm: 'local:prewarm',
  cliDetect: 'cli:detect',
  cliSetup: 'cli:setup',
  cliTest: 'cli:test',
  cliInstall: 'cli:install',
  cliInstallProgress: 'cli:install:progress',
  cliLogin: 'cli:login',
  // MQA-062: re-verify the real CLI session behind every `cliConnected` flag (a `claude logout` between
  // launches leaves the flag asserting a session that is gone). Zero-token status probe, throttled in
  // main; returns the refreshed settings snapshot so the caller sees any retired flag immediately.
  cliVerifySessions: 'cli:verify-sessions',
  answerFeedback: 'answer:feedback',
  metricsRead: 'metrics:read',
  updateDownloaded: 'update:downloaded',
  updateProgress: 'update:progress',
  // A download the user started failed mid-flight. Without this the Settings row kept a progress bar that
  // could never finish and hid its own download-page fallback (which only renders in 'blocked'/'idle').
  updateError: 'update:error',
  updateInstall: 'update:install',
  updateDownload: 'update:download', // Settings "Update now" — kick the in-app download (progress/downloaded then stream back)
  updateCheck: 'update:check', // manual Settings-driven check against the public releases feed
  recapPdf: 'recap:pdf',
  openMailDraft: 'mail:openDraft',
  mcpTestConnection: 'mcp:testConnection',
  mcpSaveConnection: 'mcp:saveConnection',
  mcpDisconnect: 'mcp:disconnect',
  mcpPush: 'mcp:push',
  // ClickUp's connection has no endpoint/key form to Test/Save — one button runs the whole OAuth 2.1
  // + PKCE flow (browser consent) and, on success, upserts an mcpConnections entry exactly like
  // mcpSaveConnection does for a pasted key. Reuses mcpDisconnect/mcpPush unchanged.
  mcpClickupConnect: 'mcp:clickupConnect',
  // Plane Connect — same shape as ClickUp: one button, OAuth 2.1 + PKCE + DCR, pinned hosted MCP URL.
  mcpPlaneConnect: 'mcp:planeConnect',
  licenseActivate: 'license:activate',
  licenseStatus: 'license:status',
  licenseGate: 'license:gate',
  identitySnapshot: 'identity:snapshot',
  memberLicenseActivate: 'license:memberActivate',
  memberLicenseDeactivate: 'license:memberDeactivate',
  memberLicenseStatus: 'license:memberStatus',
  memberLicenseVerifyCached: 'license:memberVerifyCached',
  memberLicenseImportFile: 'license:memberImportFile',
  licenseConfig: 'license:config',
  localAiStatus: 'local-ai:status',
  localTranscriptBegin: 'local-ai:transcript:begin',
  localTranscriptAppend: 'local-ai:transcript:append',
  localTranscriptResync: 'local-ai:transcript:resync',
  localTranscriptEnd: 'local-ai:transcript:end',
  timeSavedRead: 'time-saved:read',
  timeSavedRecord: 'time-saved:record',
  outlookWriteStatus: 'outlook:writeStatus',
  outlookCreateDraft: 'outlook:createDraft',
  outlookCreateEvent: 'outlook:createEvent',
  mcpWriteTargets: 'mcp:writeTargets',
  /** Wave 2 — clear the one-shot last-failover chip after the user dismisses it. */
  dismissFailoverNotice: 'settings:dismissFailoverNotice'
} as const

/** User's verdict on an answer (metadata only — never the answer text). Feeds the audit log + future evals. */
export type AnswerFeedback = { rating: 'up' | 'down'; kind?: string }

/** On-device eval metrics aggregated from the local audit log (no content, never shipped). */
export interface EvalMetrics {
  answers: number
  ttftP50Ms: number | null
  ttftP95Ms: number | null
  answerP50Ms: number | null
  answerP95Ms: number | null
  acceptance: { up: number; down: number; rate: number | null }
  failures: number
  fallbacks: number
  tokensIn: number
  tokensOut: number
  byProvider: Record<string, number>
  /** Wave 3 (docs/qa/QUALITY-SCORECARD.md's "Brain LLM consolidations / active day"): count of
   *  'brain.consolidation' audit events in this window — how many batched extraction passes actually
   *  ran, as opposed to the per-mode provider.request counts above. */
  brainConsolidationPasses: number
}

export type AskMode = 'answer' | 'vision' | 'suggest' | 'summary' | 'recap'

export const CONVERSATION_MODES = [
  'interview',
  'recruiting',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support',
  'general',
  'cold-call'
] as const
/** The 9 built-in modes. */
export type BuiltinMode = (typeof CONVERSATION_MODES)[number]
/** Active mode id: a built-in id OR a user-created custom mode id. The `(string & {})` keeps literal
 *  autocomplete for built-ins while accepting any custom id, so existing consumers compile unchanged. */
export type ConversationMode = BuiltinMode | (string & {})

/** Display labels for the 9 built-in modes (single source of truth, shared by ModePicker + Settings + bar). */
export const BUILTIN_MODE_LABELS: Record<BuiltinMode, string> = {
  general: 'General',
  interview: 'Interview',
  recruiting: 'Recruiting',
  meeting: 'Meeting',
  sales: 'Sales',
  negotiation: 'Negotiation',
  presentation: 'Presentation',
  support: 'Support',
  'cold-call': 'Cold Calling'
}

/** A user-created custom mode (id + display label). Its prompt lives in settings.modePrompts[id] and its
 *  context files in settings.contextDocs[id]. Built-in modes are never stored here. */
export interface CustomMode { id: string; label: string }

/** Cluely-style ordered groups for the modes list (built-ins). Custom modes render under their own group in the UI. */
export const MODE_GROUPS: { label: string; modes: BuiltinMode[] }[] = [
  { label: 'General', modes: ['general'] },
  { label: 'Live assist', modes: ['interview', 'recruiting', 'sales', 'negotiation', 'presentation', 'support', 'cold-call'] },
  { label: 'Meetings', modes: ['meeting'] }
]

/** Resolve a mode id (built-in or custom) to its display label. */
export function modeLabel(id: string, customModes: CustomMode[] = []): string {
  if (id in BUILTIN_MODE_LABELS) return BUILTIN_MODE_LABELS[id as BuiltinMode]
  return customModes.find((m) => m.id === id)?.label ?? id
}

export const ProfileSchema = z.object({
  name: z.string().default(''),
  role: z.string().default(''),
  company: z.string().default(''),
  resume: z.string().default(''),
  jobDescription: z.string().default(''),
  notes: z.string().default('')
})
export type Profile = z.infer<typeof ProfileSchema>

export const TranscriptLineSchema = z.object({
  // Imported recordings have speech but no diarization. `unknown` prevents the UI and recap prompt from
  // inventing that every imported sentence was spoken by the operator.
  speaker: z.enum(['them', 'you', 'unknown']),
  text: z.string(),
  t: z.number(),
  // Speaker Intelligence (Phase A) — the resolved human display name for this line's speaker, backfilled
  // best-effort from the meeting's own Microsoft Teams transcript after the meeting ends (see
  // main/graph-transcript.ts + shared/transcript-align.ts). Additive only: the SIDE (`speaker` — them/
  // you/unknown) is never inferred or changed by this. Optional so every previously saved meeting, and
  // any line no name was ever resolved for, still parses unchanged.
  name: z.string().optional(),
  // Detected spoken language of this line (shared/lang-id.ts display name, e.g. 'Portuguese') — tagged
  // by commitLine so mixed-language meetings render "[conversation switches to …]" markers in the recap
  // prompt and the saved transcript (the LLM otherwise has no way to know a switch happened). Absent
  // when detection wasn't confident, and on every line saved before this field existed.
  lang: z.string().optional(),
  // Streaming first-caption placeholder (docs/asr/QUALITY.md). Never persisted; transcriptToText drops it.
  provisional: z.boolean().optional()
})
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>

/** ASR quality (1B.2b) — strip UI-only provisional placeholders (see TranscriptLineSchema.provisional
 *  above) before a transcript reaches disk or the recap prompt. `transcriptToText` (renderer/lib/
 *  transcript.ts) is the live-text guard; this is the save-path guard, applied once at the IPC boundary
 *  (main/index.ts's saveTranscript/saveDraftTranscript handlers) so every caller is covered even one that
 *  forgot to filter — belt-and-suspenders, since commitLine already removes the placeholder it's
 *  replacing before pushing the real line, so in the common case there is nothing left to strip. Returns
 *  the input array unchanged (same reference) when nothing needed removing, so a save of an ordinary
 *  meeting with no provisional lines never pays a spurious copy. */
export function stripProvisionalLines(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.some((l) => l.provisional) ? lines.filter((l) => !l.provisional) : lines
}

/** Single source of truth for the import pipeline's decode window. Both decoders that turn a recording
 *  into PCM windows — main's ffmpeg sidecar (main/ffmpeg-decoder.ts) and the renderer's Chromium
 *  AudioContext fallback (renderer/lib/import-audio.ts) — chunk at this size, and main/import-jobs.ts
 *  derives each line's display timestamp from it. A renderer lib may only import from shared (never from
 *  main), so this lives here rather than in ffmpeg-decoder.ts. Shorter windows give main/whisper-import.ts's
 *  ported language-follow machine more, smaller chances to notice a mixed-language recording switch than
 *  one slab spanning the whole switch. */
export const IMPORT_CHUNK_SECONDS = 12

export const SaveMeetingSchema = z.object({
  title: z.string().default(''),
  mode: z.string().default('general'),
  startedAt: z.number(),
  lines: z.array(TranscriptLineSchema),
  recap: z.string().default('')
})
export type SaveMeeting = z.infer<typeof SaveMeetingSchema>

export const SaveNoteSchema = z.object({
  title: z.string().default(''),
  mode: z.string().default('general'),
  question: z.string().default(''),
  answer: z.string().min(1)
})
export type SaveNote = z.infer<typeof SaveNoteSchema>

/**
 * Import audio file → on-device transcription (see main/import-audio.ts). The renderer decodes any
 * target format + resamples/mixes down to 16kHz mono locally (Chromium can; main has no ffmpeg), then
 * streams it to main as a sequence of ~30s windows over repeated invoke calls rather than one giant
 * transfer. `samples` is capped well above a real ~30s window at 16kHz mono — same defensive reasoning
 * as parakeetFeed's own cap — so a malicious/malfunctioning renderer can't force a huge synchronous
 * decode. `name`/`mtimeMs` mirror what importAudioPick already handed the renderer (the source file's
 * name + modified time); main only reads them when a chunk starts a NEW session (an unseen sessionId),
 * to derive the saved meeting's title (humanized filename) and startedAt (file mtime) — later chunks in
 * the same session ignore them.
 */
const IMPORT_AUDIO_MAX_CHUNK_SAMPLES = 16_000 * 35
export const ImportAudioChunkSchema = z.object({
  sessionId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive().max(20_000),
  done: z.boolean(),
  name: z.string().max(300),
  mtimeMs: z.number().finite(),
  samples: z
    .instanceof(Float32Array)
    .refine((s) => s.length <= IMPORT_AUDIO_MAX_CHUNK_SAMPLES, 'Audio chunk too large.')
})
export type ImportAudioChunk = z.infer<typeof ImportAudioChunkSchema>

/** Result of import-audio:pick. `token` is an opaque, single-use main-process capability, never a file path. */
export interface ImportAudioPickResult {
  cancelled?: boolean
  error?: string
  token?: string
  name?: string
  sizeBytes?: number
  mtimeMs?: number
}

export const ImportAudioStartSchema = z.object({ token: z.string().min(20).max(200) })
export type ImportAudioStart = z.infer<typeof ImportAudioStartSchema>

export type ImportJobState =
  | 'queued'
  | 'decoding'
  | 'transcribing'
  | 'saving'
  | 'recapping'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Sanitised job state exposed to the overlay. Source paths remain main-process-only. */
export interface ImportJobView {
  jobId: string
  title: string
  state: ImportJobState
  cursor: number
  totalChunks: number
  /** Null means the decoder has not supplied a trustworthy denominator yet. */
  pct: number | null
  error?: string
  recapError?: string
  file?: string
  createdAt: number
  updatedAt: number
  queuePosition?: number
}

export const ImportJobIdSchema = z.object({ jobId: z.string().min(1).max(200) })

/** Result of one import-audio:transcribe call. Only `file`/`title`/`lines` are populated on the final
 *  (done) chunk, once the accumulated transcript has actually been saved. */
export interface ImportAudioChunkResult {
  ok: boolean
  error?: string
  file?: string
  title?: string
  lines?: TranscriptLine[]
}

/** Pushed via webContents.send while a session is transcribing/saving — drives the "Import audio"
 *  button's progress label in RecallView. */
export interface ImportAudioProgress {
  job: ImportJobView
}

/** Main validates every one of these payloads again and accepts them only from the dedicated decoder. */
export const ImportDecoderChunkSchema = z.object({
  jobId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive().max(20_000),
  samples: z.instanceof(Float32Array).refine((s) => s.length <= IMPORT_AUDIO_MAX_CHUNK_SAMPLES, 'Audio chunk too large.')
})
export const ImportDecoderCompleteSchema = z.object({ jobId: z.string().min(1).max(200) })
export const ImportDecoderFailedSchema = z.object({
  jobId: z.string().min(1).max(200),
  error: z.string().min(1).max(800)
})

/** Payload for brain:setDealOutcome — the human marks a deal open/won/lost (see DealEntitySchema.outcome
 *  in shared/brain.ts; the LLM never sets it). dealSlug carries the deal's display NAME, the same
 *  convention brain:commitmentSettle's `deal` field uses. Main resolves it through the correction
 *  journal's alias map (resolveEntitySlug), NOT by slugifying the name: after a rename the display name
 *  no longer slugifies to the entity's stable id, and plain slugify made both channels fail with
 *  "Deal not found." on every renamed deal (MQA-013). */
export const SetDealOutcomePayloadSchema = z.object({
  dealSlug: z.string().min(1),
  outcome: z.enum(['open', 'won', 'lost'])
})

/** Every entity id/slug the correction payloads below carry is a canonical slug (store.ts's slugify()
 *  output: lowercase ascii, digits, and dashes only — see its own doc comment for the two fallback forms,
 *  `x-<hash>` and `<truncated>-<hash>`, both of which also match this charset). MI-2.5 Fix B, defense in
 *  depth: corrections.ts re-slugifies every id before it ever reaches a filesystem call regardless (a
 *  legit slug round-trips unchanged there), but rejecting a non-slug OUTRIGHT here — before the payload
 *  even reaches the handler — means a path-traversal string like '../../../etc/hosts' never gets this
 *  far at all, rather than silently collapsing to a slug that simply won't match anything. */
const SLUG_RE = /^[a-z0-9-]+$/

/** Payloads for the five correction-engine channels (Task MI-2) — see src/main/brain/corrections.ts
 *  for the mutations themselves. `kind`/`id`/`fromId`/`intoId` are entity slugs (immutable, the join
 *  key), never display names. `field`/`value` on brain:entityUpdateField are validated per (kind, field)
 *  inside corrections.ts, not here — the zod-valid set differs by kind (deal.velocity is an object,
 *  account.sector is an enum, everything else is a plain string) and is cheaper to check once, in one
 *  place, alongside the mutation itself. */
export const EntityRenamePayloadSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  newName: z.string().min(1).max(200),
  // Also append oldName -> newName to settings.asrCorrections (main-side composition, see index.ts) so
  // the live transcript stops mishearing the old name going forward.
  alsoFixAsr: z.boolean().optional()
})
export const EntityMergePayloadSchema = z.object({
  kind: EntityKindSchema,
  fromId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  intoId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.')
})
export const EntityUnmergePayloadSchema = z.object({
  targetSeq: z.number().int().nonnegative()
})
export const EntityUpdateFieldPayloadSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  field: z.string().min(1).max(60),
  value: z.unknown()
})
/** Payload for brain:field-decision (dashboard suggestion accept/dismiss, deferred CRM pattern 3) — the
 *  human reviews one provenance-bearing field (see ProvenantField/RENDERABLE_PROVENANCE_STATES in
 *  shared/brain.ts) and either accepts or dismisses the extraction. `field` is bounded the same way
 *  brain:entityUpdateField's is; the legal (kind, field) set is validated in corrections.ts, not here.
 *  `decision: 'dismiss'` is accepted by this schema but currently always refused by the handler — there
 *  is no correction-engine mutation that clears/reverts a field's value, only ones that pin a NEW one
 *  (see readFieldProvenance's doc comment in corrections.ts). */
export const FieldDecisionPayloadSchema = z.object({
  entityKind: EntityKindSchema,
  entityId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  field: z.string().min(1).max(60),
  decision: z.enum(['accept', 'dismiss'])
})

/** `dealSlug` is optional — a commitment spoken in a deal-less meeting (x.deal is null) lives ONLY on
 *  the named person's own ledger, so there's nothing to also flip on a deal. */
export const CommitmentRejectPayloadSchema = z.object({
  personSlug: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid person id.'),
  dealSlug: z.string().max(200).regex(SLUG_RE, 'Invalid deal id.').optional(),
  text: z.string().min(1)
})

/** Payload for brain:meetingExtraction (Task MI-3) — `file` is a saved meeting's path or basename (only
 *  the basename is used, mirroring brainCommitmentSettle's convention); the handler slugifies it to the
 *  same key ingestExtraction wrote the extraction under (`.brain/meetings/<slugify(basename(file))>.json`). */
export const MeetingExtractionQuerySchema = z.object({ file: z.string().min(1) })

/** One needs-attention finding (Task MI-3, `brain:attention`) — surfaced in BrainView's Attention section
 *  with a jump action to the named entity's record page.
 *   - 'lint': a lintBrain contradiction (see lintBrainDetailed in main/brain/ingest.ts).
 *   - 'ambiguous': a provenant field whose confidence is 'AMBIGUOUS'.
 *   - 'contradicted_pin': a human-pinned/edited field whose superseded history records a value from a
 *     LATER meeting than the pin itself — recorded (never auto-resolved) per MI-1's supersession rule.
 *   - 'ingest_failed': a source file that durably failed extraction (idx.ingested[file].ok === false,
 *     see main/brain/attention.ts). Not entity-linked — `entityKind` is absent and `id` carries the
 *     source filename instead, so the renderer opens the transcript rather than a record page. */
export const AttentionItemSchema = z.object({
  kind: z.enum(['lint', 'ambiguous', 'contradicted_pin', 'ingest_failed']),
  entityKind: EntityKindSchema.optional(),
  id: z.string().min(1),
  label: z.string(),
  detail: z.string()
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>
export const BrainAttentionResultSchema = z.object({ items: z.array(AttentionItemSchema) })
export type BrainAttentionResult = z.infer<typeof BrainAttentionResultSchema>

/** One settings.asrCorrections entry — the exact shape commitLine's consumer (lib/listen.ts
 *  correctionsRef) compiles into word-boundary regexes. Extracted from SettingsSchema (which arrays it,
 *  capped at 100) so a single pair can be validated on its own BEFORE it joins the array: store.ts's
 *  validKeysOnly drops the ENTIRE asrCorrections array when any one element fails validation, so a
 *  handler that blindly appends an oversized pair wouldn't just lose that pair — it would silently
 *  wipe every correction the user already had. */
export const AsrCorrectionPairSchema = z.object({ from: z.string().min(1).max(80), to: z.string().max(80) })

/** brain:entityRename's `alsoFixAsr` composition (reviewer IMPORTANT 3) — pure so both paths are unit-
 *  testable. Validates the pair per-element FIRST (see AsrCorrectionPairSchema above for why), dedupes,
 *  and enforces the array's own 100-entry cap, so the result can NEVER fail whole-array validation:
 *   - { kind: 'append', pairs } — hand `pairs` to setSettings as the new asrCorrections value
 *   - { kind: 'noop' }          — pair already present; write nothing
 *   - { kind: 'skipped', reason } — pair can't be represented (e.g. a name over the 80-char cap);
 *     the caller performs the rename anyway and surfaces the reason. */
export function appendAsrCorrection(
  existing: ReadonlyArray<{ from: string; to: string }>,
  from: string,
  to: string
): { kind: 'append'; pairs: Array<{ from: string; to: string }> } | { kind: 'noop' } | { kind: 'skipped'; reason: string } {
  const pair = { from, to }
  const parsed = AsrCorrectionPairSchema.safeParse(pair)
  if (!parsed.success) {
    return {
      kind: 'skipped',
      reason:
        'The name pair could not be added as a live-transcript ASR correction (names must be 1-80 characters). The rename itself was applied.'
    }
  }
  if (existing.some((c) => c.from === pair.from && c.to === pair.to)) return { kind: 'noop' }
  return { kind: 'append', pairs: [...existing, pair].slice(-100) }
}

/** Structured export of a meeting recap (decisions + action-items-with-owners) for Jira/Asana/Notion etc.
 *  The full original markdown is always included so nothing is lost if a section heading was reworded. */
export const RecapExportSchema = z.object({
  title24: z.string(),
  tags: z.array(z.string()),
  overview: z.string(),
  topics: z.array(z.string()),
  keyQA: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      text: z.string(),
      owner: z.string().nullable(),
      // Best-effort trailing "by <phrase>" as literally stated (e.g. "Friday", "June 5") — NOT parsed
      // into a date (RECAP_PROMPT only asks the model for "an owner when stated", never a structured
      // date). Shown in the "Book next steps" review UI and folded into the task description; never sent
      // as a structured due-date wire field, since neither ClickUp's nor Plane's exact optional argument
      // names for a due date are confirmed (see main/mcp/mcpClient.ts's header comment).
      dueDateText: z.string().nullable()
    })
  ),
  openQuestions: z.array(z.string()),
  notableQuotes: z.array(z.string()),
  markdown: z.string()
})
export type RecapExport = z.infer<typeof RecapExportSchema>

/** Opted-in follow-up memory expires after this much ask inactivity. Shared so the renderer's screen-ask
 *  fast path (which relies on history carrying the prior screen description) and main's fresh-question
 *  gate (which wipes stale history) can never disagree about what "still fresh" means. */
export const ASK_MEMORY_IDLE_MS = 10 * 60 * 1000

export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  // Bounded for defense-in-depth against a hostile/buggy renderer — same convention as brainContext below.
  content: z.string().max(100_000)
})
export type ChatTurn = z.infer<typeof ChatTurnSchema>

const AskStartBaseSchema = z.object({
  id: z.string(),
  mode: z.enum(['answer', 'vision', 'suggest', 'summary', 'recap']),
  prompt: z.string().default(''),
  /** base64 image (JPEG from screen capture; no data: prefix) for vision mode. Max ~5.5 MB base64. */
  image: z
    .string()
    .refine(
      (v) => !v || (v.length <= 5_500_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(v)),
      'Image must be a base64 string under 5.5 MB'
    )
    .optional(),
  /** UUID of the append-only local transcript session used by eligible local asks. */
  localSessionId: z.string().uuid().optional(),
  /** Bounded evidence from the packaged local vision worker. */
  visionEvidence: LocalVisionEvidenceSchema.optional(),
  /** raw transcript text for suggest mode */
  transcript: z.string().optional(),
  /** 'deeper' = the user tapped "Go deeper" → re-ask for a fuller answer (injected per-turn, never cached) */
  depth: z.enum(['deeper']).optional(),
  /** 'factcheck' = a verification ask → the router sends it to the strongest model (verifier path). */
  kind: z.enum(['answer', 'factcheck']).optional(),
  /** When true, main redacts high-confidence secrets (cards, API keys, SSNs, private keys — same
   *  redactSecrets() used on req.transcript) out of THIS request's `prompt` before it reaches a cloud
   *  model. For prompts built from auto-captured content (e.g. fact-check's transcript fallback), never
   *  from the user's own typed text — the "typed questions are never changed" promise depends on this
   *  staying unset on any typed-claim/typed-question ask. Optional/undefined (not defaulted) like the
   *  other per-turn flags above so every existing caller is unaffected. */
  redactPrompt: z.boolean().optional(),
  /** Pins a specific Dust agent sId regardless of tier routing (e.g. Spotlight Ref). Dust-only; ignored by other providers. */
  agentOverride: z.string().optional(),
  /** Forces this one request to a specific provider regardless of the globally active `provider` setting —
   *  e.g. cascading a recap/follow-up/Spotlight-Ref request into Dust even when Kimi/Anthropic/etc. is active. */
  providerOverride: ProviderIdSchema.optional(),
  /** Receipt Mode: relevant past-meeting knowledge, assembled in main from the brain (never sent by the
   *  renderer — main overwrites it after parse). Injected per-turn into the user text so it never pollutes
   *  or invalidates the cached system prompt. Capped for defense-in-depth against a hostile renderer. */
  brainContext: z.string().max(8000).optional(),
  /** Renderer INTENT flag for a screen-ask fast-path: "answer this using the pre-analyzed screen context you
   *  have cached, instead of me capturing + uploading a fresh image." A boolean only — the renderer never
   *  supplies the description itself. main clears `screenContext` after parse and injects it from its OWN
   *  on-device cache (screen-preprocess.ts) when this is set, exactly like brainContext. */
  wantsScreenContext: z.boolean().optional(),
  /** Pre-analyzed, on-device description of what's currently on the user's screen (plus a short recent-
   *  conversation tail when a meeting is live). Main-assembled ONLY — cleared after parse and set from the
   *  local cache — so a hostile renderer can't smuggle screen text into the prompt. Capped like brainContext. */
  screenContext: z.string().max(8000).optional(),
  // Bounded (defense-in-depth, mirrors brainContext's cap above) — an unbounded array let a hostile/buggy
  // renderer hand main an ever-growing history to serialize/forward per ask.
  history: z.array(ChatTurnSchema).max(50).default([])
})
export const AskStartSchema = AskStartBaseSchema.superRefine((value, context) => {
  if (value.visionEvidence && value.mode !== 'vision') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'visionEvidence is allowed only in vision mode.',
      path: ['visionEvidence']
    })
  }
  if (value.visionEvidence && value.image !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'visionEvidence and image are mutually exclusive.',
      path: ['visionEvidence']
    })
  }
})
export type AskStart = z.infer<typeof AskStartSchema>

export const StreamDeltaSchema = z.object({ id: z.string(), text: z.string() })
export type StreamDelta = z.infer<typeof StreamDeltaSchema>

export const StreamDoneSchema = z.object({
  id: z.string(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional()
})
export type StreamDone = z.infer<typeof StreamDoneSchema>

export const StreamErrorSchema = z.object({ id: z.string(), message: z.string() })
export type StreamError = z.infer<typeof StreamErrorSchema>

/** Sent once per provider attempt, before any token, so the waiting UI can say WHO is answering
 *  ("Asking your Dust agent…") instead of an anonymous spinner. Re-sent on retry/failover — the display
 *  simply follows the latest attempt. */
export const StreamMetaSchema = z.object({
  id: z.string(),
  provider: ProviderIdSchema,
  tier: z.enum(['base', 'think', 'deep']),
  /** Whether THIS answer is really grounded in the user's screen. Sent only where main is the authority:
   *  a screen fast-path ask (wantsScreenContext) carries an INTENT flag, never the description itself, so
   *  only main knows whether its on-device cache still had one at send time — and Retry/"Go deeper" replay
   *  that flag long after it expired. Absent = main has no verdict (plain text and vision asks), and the
   *  renderer keeps the value it set at run() time. */
  usedScreen: z.boolean().optional()
})
export type StreamMeta = z.infer<typeof StreamMetaSchema>

/**
 * On-device model ids the registry knows (main/llm/local-models.ts owns the URLs, sizes and hashes;
 * this list exists only so the settings schema can validate an id without importing main-only code).
 *
 * The DEFAULT stays the small model on purpose: this file cannot measure RAM, and a fresh profile that
 * defaulted straight to the 4B on an 8 GB machine would persist a model assertRamOk refuses to load —
 * turning Local AI off entirely rather than falling back. Boot owns the upgrade instead, where
 * bestModelForMachine() can actually see the hardware.
 */
const LOCAL_MODEL_IDS = ['qwen3.5-4b', 'qwen3.5-0.8b'] as const
const BUNDLED_LOCAL_MODEL_ID: (typeof LOCAL_MODEL_IDS)[number] = 'qwen3.5-0.8b'
const BundledLocalModelIdSchema = z.preprocess(
  // 'qwen3.5-2b' is a retired id from an earlier swap; it has no weights any more, so it maps to the
  // floor and boot re-upgrades from there if the machine allows.
  (value) => (value === undefined || value === 'qwen3.5-2b' ? BUNDLED_LOCAL_MODEL_ID : value),
  z
    .string()
    .refine((value) => (LOCAL_MODEL_IDS as readonly string[]).includes(value), 'Unknown bundled local model.')
)

// ─── MCP connections (generalized from the single BidStack connection) ──────────────────────────────
// 'clickup' is schema-reserved only: ClickUp's remote MCP server is OAuth-2.1-with-PKCE only (no bearer
// API-key path), a materially different auth shape than mcpClient.ts implements today, so it ships as
// its own scoped follow-up. Keeping the enum member here now means the persisted-settings shape never
// has to change again when that follow-up lands (Build Law rule 7) — there's just no UI/IPC wiring for
// it yet.
export const McpConnectionKindSchema = z.enum(['bidstack', 'clickup', 'plane'])
export type McpConnectionKind = z.infer<typeof McpConnectionKindSchema>

export const McpConnectionSchema = z.object({
  // v1 constraint: exactly one connection per kind, so id === kind. Kept as its own field (not derived)
  // because the id is what secrets/IPC key off — a future multi-workspace case (two Plane workspaces)
  // changes id generation without touching every call site that reads `kind`.
  // TYPED as the kind enum, not a free string: the id is interpolated into mcpSecrets.ts's
  // `key-mcp-<id>.bin`, so letting an arbitrary string reach it is a path-traversal primitive. Widening
  // this later is a deliberate change that must keep that filename safe (mcpSecrets.ts enforces it at
  // runtime too, for any caller that bypasses these types).
  id: McpConnectionKindSchema,
  kind: McpConnectionKindSchema,
  // Display name used in UI copy and classifyError() messages — replaces the hardcoded "Polo Pre-Sales"
  // string literal in mcpClient.ts. Defaults to a per-kind label (e.g. "Plane") but is user-editable.
  label: z.string().min(1).max(60),
  endpointUrl: z.string().default(''),
  connected: z.boolean().default(false),
  tools: z.array(z.string()).default([]),
  // Transport-level extra headers beyond `Authorization: Bearer <key>` — Plane's hosted PAT endpoint
  // requires `X-Workspace-slug` alongside the bearer token. Generic (not `planeWorkspaceSlug`) because
  // it's a mechanical transport concern, not a Plane-specific business field, and BidStack already
  // proves the "zero extra headers" case — two real shapes justify the generalization.
  extraHeaders: z.record(z.string(), z.string()).default({})
})
export type McpConnection = z.infer<typeof McpConnectionSchema>

/**
 * The operator-deployed Worker Métis talks to by default. A URL, never a credential: the Cloudflare
 * account token lives as a Wrangler secret ON this Worker and never ships, which is the whole reason
 * the Worker exists. Shipping the endpoint means a user pastes one string (their METIS_PROXY_KEY)
 * instead of two, and an org can still override it per install through managed config.
 *
 * Verified live before being pinned here: GET /health returns configured:true, an unauthenticated POST
 * returns 401, and an authenticated one streams SSE frames back.
 */
export const METIS_WORKER_URL = 'https://metis-cloudflare-proxy.tony-walteur.workers.dev/v1'

export const BaseSettingsSchema = z.object({
  // Default provider: Cloudflare (Tony, 2026-08-21), replacing NVIDIA NIM (2026-08-14). One endpoint the
  // operator deploys reaches Workers AI, OpenAI, Anthropic and Google on a single account credential, so
  // a fleet is configured once rather than per vendor per user. The build ships the operator's Worker URL
  // as cloudflareBaseUrl's default (a URL is not a secret); the METIS_PROXY_KEY is either
  // installer-embedded (embedded-cloudflare-key.ts) or pasted once in Settings — Cloudflare stays the
  // always-on cloud path. Additional LLMs are additive: paste any featured / "more models" / Custom
  // OpenAI-compatible API key in Settings → AI. Métis Local routing is opt-in (localLlm.enabled defaults
  // off) but the weights still download in the background when the app opens so enabling Local later is
  // instant. Local only preempts Cloudflare when the user turns a useFor toggle on.
  provider: ProviderIdSchema.default('cloudflare'),
  // CLI-vs-API priority. 'api' (default) keeps the explicitly-chosen `provider` as primary. 'cli' makes a
  // connected CLI integration (Claude/Codex) the primary so the user's local subscription is used before
  // any metered API key, and prefers CLI on failover. With no CLI connected, 'cli' behaves like 'api'.
  providerPriority: z.enum(['cli', 'api']).default('api'),
  /** MQA-269: user-authored failover order. Empty (the default) is EXACTLY today's behaviour — PROVIDERS
   *  declaration order shaped by providerPriority/preferFree. Non-empty means "try these, in this order,
   *  first"; providers not listed stay reachable after the chain, because a chain is a preference, not an
   *  allowlist — a user who adds a fourth key later must not silently lose failover to it. Ids are
   *  filtered through PROVIDERS at read time so a registry edit can never crash a stale profile. */
  providerFallbackOrder: z.array(ProviderIdSchema).max(8).default([]),
  providerModels: z.record(z.string(), z.string()).default({}),
  customBaseUrl: z
    .string()
    .refine(
      (v) => v === '' || /^https:\/\//i.test(v),
      'Custom endpoint must be an https:// URL'
    )
    .default(''),
  // The operator-deployed Cloudflare Worker that fronts Cloudflare's AI REST API. Métis never holds the
  // Cloudflare ACCOUNT token — that stays a Wrangler secret on the Worker — so this URL plus the per-user
  // METIS_PROXY_KEY (stored through the same encrypted setApiKey/getApiKey path as every other provider
  // key, never here) is the whole client-side configuration.
  //
  // Deliberately NOT added to SettingsSchema's cross-field refine below, unlike customBaseUrl: that refine
  // makes a bare {provider:'custom'} patch fail the full-object re-parse, which is why Settings.tsx has to
  // seed a placeholder URL when the user picks Custom. Readiness is enforced where it belongs instead —
  // publicSettings().providerReady, the ask-time eligibility chain and pickFailover all require an https
  // endpoint before Cloudflare can answer, so an unconfigured Cloudflare simply never gets a request.
  cloudflareBaseUrl: z
    .string()
    .refine(
      (v) => v === '' || /^https:\/\//i.test(v),
      'Cloudflare Worker endpoint must be an https:// URL'
    )
    .default(METIS_WORKER_URL),
  // Per-provider THINKING-tier model override (parallel to providerModels). For Dust this is the
  // thinking agent sId. Empty → fall back to the provider's built-in think model. See shared/routing.ts.
  providerModelsThinking: z.record(z.string(), z.string()).default({}),
  // Per-provider DEEP-tier model override (parallel to the others). For Dust this is the deep agent sId.
  // Empty → fall back to the provider's built-in deep model (e.g. Opus), then the think model.
  providerModelsDeep: z.record(z.string(), z.string()).default({}),
  // Per-provider Spotlight Ref agent (parallel to the others). For Dust this is the sId of a dedicated
  // agent that checks for sales references — independent of the tier (base/think/deep) routing above.
  providerModelsSpotlightRef: z.record(z.string(), z.string()).default({}),
  // Routing policy: 'auto' = Haiku basic / Sonnet heavier / Opus coding+deep; 'always' = always Opus; 'never' = always Haiku.
  thinkingMode: z.enum(['auto', 'always', 'never']).default('auto'),
  // Carry recent Q&A into the next typed/screen question OUTSIDE a live meeting. Off by default: each
  // fresh question answers on its own, with no contamination from the previous one (main enforces this at
  // the ask choke point AND resets the server-side Dust conversation in the same breath — see IPC.askStart
  // in main/index.ts). Mid-meeting continuity (Copilot, fact-check during Listen) is unaffected either way.
  askFollowUpMemory: z.boolean().default(false),
  // Dust provider config (workspace id + region base; the agent sId lives in providerModels.dust)
  dustWorkspaceId: z.string().default(''),
  dustBaseUrl: z
    .string()
    .refine((v) => v === '' || /^https:\/\//i.test(v), 'Dust URL must be an https:// URL')
    .default('https://dust.tt')
    .transform((v) => v || 'https://dust.tt'),
  // Which login path minted the current Dust session — decides how refreshDustAuth (main/index.ts) renews
  // an expired token. 'oauth' = native device-flow (dust-oauth.ts, refreshDustOAuthSession). 'cli' = the
  // user ran `dust login` themselves and Métis imported that session (dustcli.ts, refreshDustCliSession).
  // Never mix the two refresh paths for one session — see dust-oauth.ts's module doc comment.
  dustSessionOrigin: z.enum(['oauth', 'cli']).default('oauth'),
  // Azure AD (Entra) SSO config. These are PUBLIC identifiers — the PKCE public-client flow uses no
  // client secret — so they live in settings, letting an admin enable Microsoft sign-in in-app without
  // editing env vars or deploying managed-config.json. A machine-wide managed-config still overrides
  // these (org tenant lock can't be loosened from the UI). See main/auth.ts readConfig().
  azureClientId: z.string().default(''),
  azureTenantId: z.string().default(''),
  azureAllowedDomain: z.string().default(''),
  // graphify knowledge-graph of the notes folder. backend 'auto' = local Claude Code CLI → stored
  // Claude key → stored OpenAI key (never Gemini). On by default for new installs; degrades gracefully
  // (shows an install hint, never throws) when graphify isn't installed. See main/graphify.ts.
  graphifyEnabled: z.boolean().default(true),
  graphifyAutoRebuild: z.boolean().default(true),
  graphifyBackend: z.enum(['auto', 'claude', 'openai']).default('auto'),
  // Multilingual. Métis transcribes any spoken language and assists in the speaker's language live;
  // the final recap/summary + answers are written in this language ('auto' = match the conversation).
  outputLanguage: z.string().max(40).default('auto'),
  summaryLanguage: z.string().max(40).default('auto'), // recap/summary language ('auto' = follow outputLanguage)
  // Encrypt saved transcripts/notes at rest (OS keychain). On by default: recorded third-party speech
  // usually lands in a OneDrive-synced folder, so plaintext should be the opt-out, not the opt-in. Turn
  // this off only if something outside Métis (a separate Dust/knowledge-graph pipeline pointed directly
  // at the meetings folder) needs to read the raw markdown — Métis's own recall/search already decrypts
  // transparently either way. See main/transcripts.ts.
  encryptTranscripts: z.boolean().default(true),
  // Task MI-5 — publish a plaintext markdown mirror (entity pages + per-meeting note cards + an
  // llms.txt-shaped index) under `<meetingsFolder>/wiki/` so Dust/graphify/any agent can read the
  // CRM-corrected brain even while encryptTranscripts keeps the raw transcripts locked. First-run
  // default is derived from `!encryptTranscripts` (see main/store.ts's getSettings — computed once,
  // only while the key has never been explicitly chosen); the schema default below only matters for a
  // brand-new BaseSettingsSchema.parse() call site that doesn't go through that derivation (e.g. tests).
  // Every publish.ts entry point re-checks this flag itself, so it's always safe to leave off.
  publishBrainPages: z.boolean().default(false),
  // Auto-delete saved meetings older than N days (GDPR/CCPA storage-limitation control). 0 = off, keep
  // forever (the historical default — an explicit choice, not a silent one, since flipping this on is
  // itself destructive). Swept once per app launch; see sweepExpiredMeetings in main/recall.ts.
  transcriptRetentionDays: z.number().int().min(0).max(3650).default(0),
  systemPrompt: z.string(),
  // Per-mode system prompts (pre-filled from DEFAULT_MODE_PROMPTS; user edits override). Plug-and-play.
  modePrompts: z.record(z.string(), z.string()).default({}),
  // Imported reference documents (Cluely-style "add files for context"), keyed PER MODE so a doc
  // attached for Interview never leaks into Sales/Meeting/General. Text-extracted client-side.
  contextDocs: z
    .record(
      z.string(),
      z.array(z.object({ name: z.string().max(200), text: z.string().max(120000) })).max(25)
    )
    .default({}),
  // User-created custom modes (id + label). Their prompt lives in modePrompts[id], files in contextDocs[id].
  customModes: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(60) }))
    .max(40)
    .default([]),
  // Fire a native notification 1 minute before each calendar meeting starts (gated; off by default).
  meetingNotifications: z.boolean().default(false),
  temperature: z.number().min(0).max(1),
  // Hide the Métis WINDOW from screen capture & sharing (other apps can't see the overlay).
  // Purely about the window — it never blocks Métis's own screen capture.
  contentProtection: z.boolean(),
  // Private View: Métis itself won't look at (or send) YOUR screen while this is on — gates the
  // whole capture pipeline in main. Split from contentProtection on 2026-07-06: one flag carried both
  // promises, and since contentProtection defaults ON, every fresh install had screen-asks dead on
  // arrival ("Couldn't capture your screen") with nothing in the UI explaining why.
  privateView: z.boolean(),
  audioSource: z.enum(['mic', 'system', 'both']),
  // Preferred microphone (MediaDevices deviceId). '' = follow the system default input. A specific id
  // (device mic, AirPods, iPhone, a Windows input) is used when present; if it has gone away, capture
  // falls back to the default so a meeting never loses its mic over a disconnected device.
  micDeviceId: z.string().default(''),
  suggestEverySec: z.number().min(5).max(120),
  mode: z.string().min(1).max(60).default('general'),
  profile: ProfileSchema.default({}),
  // Values may be EMPTY: '' is the codebase's unbind sentinel, not a malformed entry. resolveShortcut
  // (main/index.ts) resolves with `??` so a stored '' survives instead of falling back to the shipped
  // default, and registerShortcuts skips falsy accelerators. A `.min(1)` here made Settings' "Clear"
  // button a silent no-op: store.ts's validKeysOnly drops the WHOLE shortcuts record when one value
  // fails, so the old global accelerator stayed bound with no error shown.
  shortcuts: z.record(z.string(), z.string()).default({}),
  autoSuggest: z.boolean().default(true),
  // Screen asks: when on (and a vision-capable provider exists), the EXPLICIT screen paths — Capture
  // button, its shortcut, quick actions, blank Enter — capture the screen and answer about it. Default
  // on. MQA-236: a TYPED question never captures regardless of this flag; screen intent is always an
  // explicit gesture, never inferred from asking a question.
  screenAsk: z.boolean().default(true),
  showLiveTranscript: z.boolean().default(false),
  meetingsFolder: z.string().default(''),
  // Shared folders (e.g. a team OneDrive folder each member's Métis saves into) whose meeting transcripts
  // are ALSO auto-ingested into this brain, attributed by the folder's own name. Centralizes the team's
  // transcripts without touching the user's own meetings folder. Scanned by the same OneDrive-friendly
  // backfill/reconciliation loop; team files are namespaced in the ingest index so they never collide with
  // the user's own meetings (or another member's file of the same name).
  teamTranscriptFolders: z.array(z.string()).default([]),
  autoSaveTranscripts: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  onboardingDone: z.boolean().default(false),
  // When onboarding finished (ms). Anchors the 10-minute "Add your API key" nudge so it expires on a
  // wall clock instead of nagging forever, and survives relaunch (a per-session timer would reset it). 0
  // = never finished (or a legacy profile that predates this field; the app backfills it once on load).
  onboardingDoneAt: z.number().default(0),
  recordingConsent: z.boolean().default(false),
  playListenChime: z.boolean().default(true),
  soundCues: z.boolean().default(true), // subtle answer-ready / error sound cues
  uiSounds: z.boolean().default(true), // master: soft click feedback on buttons (and gates all UI sounds)
  quickActionsRainbow: z.boolean().default(true), // spinning rainbow border on the quick-action chips
  /** Pre-generate "What to say next" in the background while a meeting is live, so clicking the button
   *  paints instantly instead of waiting a full round trip. Costs roughly one extra base-tier call per
   *  fresh stretch of conversation; the Settings toggle says so ("uses more credits"). */
  instantSuggestions: z.boolean().default(true),
  /** Background screen preprocessing: when the foreground window changes, quietly analyze the screen with
   *  the ON-DEVICE model and cache the description, so "What's on my screen" answers from pre-computed text
   *  instead of a cold capture + full-image round trip. On-device only — nothing extra is sent to the cloud;
   *  Private View hard-blocks it. Default OFF — explicit opt-in. Continuous screen reading is its own
   *  consent decision, and it also requires Local AI to be enabled (itself off by default). (The Cahê
   *  pilot still seeds both true explicitly — cahe-embedded-key.ts — which is an explicit per-edition
   *  choice, not a default.) */
  backgroundScreenContext: z.boolean().default(false),
  // How see-through the overlay's glass background is. A multiplier on the default glass alpha values
  // (see --glass-fill etc. in styles.css) — 1 = today's default look, lower = more transparent (see more
  // of what's behind), higher = more opaque/solid (easier to read over a busy desktop). Values above 1
  // simply saturate at fully opaque for the most solid backgrounds; nothing errors or clips oddly.
  overlayOpacity: z.number().min(0.3).max(1.5).default(1),
  // Vibe-Island-style auto-hide: when on (default), the top-center overlay collapses to a slim peek strip
  // hugging the top edge whenever the pointer isn't over it and nothing important is happening, then
  // reveals the full bar on hover / on a forced event (recording, live suggestion, error toast). Reveal
  // and collapse are pure content resizes of the always-on-top window — they never show/focus it, so the
  // user's foreground app keeps focus (the non-activating notch contract). Off = the bar is always shown.
  autoHideOverlay: z.boolean().default(true),
  /** Overlay chrome: hide (default, fully hidden until top hover), island (visible peek), bar (classic). */
  overlayLayout: z.enum(['hide', 'island', 'bar']).default('hide'),
  showFullTranscriptInReview: z.boolean().default(false), // review = summary-first; transcript opt-in
  asrQuality: z.enum(['best', 'fast']).default('best'), // Best is default; Fast is a Settings power option (docs/asr/QUALITY.md)
  // whisper = ~99 langs (default — safe for any locale; parakeet is European-only, which is why 1fa4d76
  // moved the default off it); parakeet = 25 European languages, fastest; apple = on-device Apple Speech
  // (SFSpeechRecognizer via the mac-helper sidecar), opt-in, macOS 13+ only — see main/apple-speech.ts.
  // NOTE: this zod default is effectively dead — store.ts layers DEFAULT_SETTINGS under the user file
  // before parsing, so the key is always present. Keep both declarations identical so neither lies.
  asrEngine: z.enum(['whisper', 'parakeet', 'apple']).default('whisper'),
  // Spoken-language hint for transcription: 'auto' (per-window detect) or a language display name from
  // Settings' LANGUAGE_OPTIONS ('Portuguese', …). Pins Whisper's decoder and Apple Speech's recognizer
  // locale; Parakeet always auto-detects. Exists because per-window auto-detect on the compact bundled
  // Whisper model routinely misreads short non-English windows and emits English-ish hallucinations.
  asrLanguage: z.string().max(40).default('auto'),
  // A mid-session Parakeet→Whisper fallback (repeated failures) used to surface as a live error banner
  // during the meeting — distracting for something that's really just a background engine swap. Tracked
  // here instead so it's checkable in Settings after the fact, never shown live. Persists until the user
  // dismisses it (Settings → Speech) — auto-clearing on the next meeting risks it vanishing unseen.
  asrLastFallbackAt: z.number().nullable().default(null),
  // Same tracking as asrLastFallbackAt, for a WebGPU→CPU (or other backend) ASR fallback — set by the
  // renderer, surfaced as a Settings → Speech note. Optional: absent on older persisted settings.
  asrWebgpuFallbackAt: z.number().nullable().optional(),
  // MQA-246: an IMPORT that ran on the floor transcription model (the high tier is not in the package,
  // so whisper-asr-host's tier probe always degrades). Same checkable-in-Settings contract as the two
  // notes above — imports previously gave no signal at all, so the weakest model was indistinguishable
  // from the best on a durable transcript the user may act on. Optional: absent on older settings.
  asrImportTierFallbackAt: z.number().nullable().optional(),
  // Same checkable-in-Settings contract as the two ASR notes above, for a CAPTURE degradation: a session
  // that requested system audio ran (in whole or in part) with the microphone only — most commonly the
  // macOS Screen Recording permission being off. Set by the renderer the moment the degraded stretch
  // starts (App.tsx's micOnlyNotifiedRef effect); surfaced in Settings → Audio until dismissed. Optional:
  // absent on older persisted settings.
  micOnlyFallbackAt: z.number().nullable().optional(),
  // On by default: this reminder is the ONLY consent mechanism Métis has today — it shows the
  // operator, never the other participants, and is not a substitute for actually telling people
  // they're being recorded. See the Settings copy near this toggle for the honest scope of what it does.
  requireConsentIndicator: z.boolean().default(true),
  // Strip high-confidence secrets (cards, API keys, SSNs, private keys) from the captured transcript
  // before it's sent to a cloud model. On by default; never touches the typed question or the saved file.
  redactSensitive: z.boolean().default(true),
  lastConsentReminderAt: z.number().default(0),
  // Words the ASR engine consistently mishears, always corrected in the live transcript (commitLine).
  asrCorrections: z.array(AsrCorrectionPairSchema).max(100).default([]),
  // Entity-casing bias (SAFE — exact-match only, never phonetic/fuzzy): spell people/account names the
  // brain already knows with their canonical casing in the live transcript. Names come from
  // brain:entityNames; see main/index.ts and lib/entity-casing.ts. On by default.
  asrEntityBias: z.boolean().default(true),
  // CLI provider connection state. Keyed by ProviderId ('claude-cli', 'codex-cli').
  cliConnected: z.record(z.string(), z.boolean()).default({}),
  // Epoch ms of the last Dust CLI token import. Gates the startup eager refresh: while the ~1h OAuth
  // token is still fresh, launch does NOT touch the Dust CLI keychain item (each `security` read can
  // cost a macOS keychain password prompt on identity-unstable dev builds). 0 = never imported.
  dustTokenMintedAt: z.number().default(0),
  // Whether the user has acknowledged the CLI integration notice banner.
  cliNoticeAck: z.boolean().default(false),
  // Named MCP connections — CRM (BidStack) and task managers (Plane; ClickUp is schema-reserved only,
  // see McpConnectionKindSchema). One connection per kind (id === kind in v1). API keys themselves are
  // NOT stored here; they go through the same encrypted-file mechanism as provider keys, via
  // main/mcp/mcpSecrets.ts (kept out of the ProviderId union — these are push credentials, not LLM
  // providers). Never hardcode a default endpoint: BidStack's own Settings UI warns its local fallback
  // is dev-only, so the user must supply wherever they actually deploy/run their backend. Replaces the
  // old single-connection bidstackEndpointUrl/bidstackConnected/bidstackTools fields — see
  // migrateLegacyBidstackConnection in main/store.ts for how an existing user's data carries forward.
  mcpConnections: z.array(McpConnectionSchema).max(10).default([]),
  // ClickUp's Dynamic Client Registration (RFC 7591) client_id — public, not a secret, so it lives in
  // plain settings rather than mcpSecrets.ts. Registered once (main/mcp/clickupOAuth.ts) and cached here
  // so every later connect/reconnect reuses the same client instead of re-registering.
  clickupClientId: z.string().default(''),
  // Plane DCR client_id — public, like clickupClientId. The matching client_secret is encrypted in
  // mcpSecrets (`key-mcp-plane-client.bin`) because Plane's token endpoint requires client_secret_post.
  planeClientId: z.string().default(''),
  // Métis Local uses a single on-device model. The preprocess is a persisted-settings migration for
  // releases that offered qwen3.5-2b; unknown ids fail validation and fall back safely in
  // main/store.ts instead of pointing llama-server at a file that can never exist.
  localLlm: z
    .object({
      // Default FALSE: Cloudflare (the shipped default provider, with Worker URL + optional embedded
      // METIS_PROXY_KEY) is the always-on cloud path. Métis Local ROUTING is opt-in — turning it on in
      // Settings uses the on-device model. The weights themselves still download in the background whenever
      // the app opens (RAM permitting), so enabling Local later does not wait on a multi-GB transfer.
      // Keeping enabled false means a fresh install never silently routes work on-device ahead of
      // Cloudflare / API providers.
      enabled: z.boolean().default(false),
      modelId: BundledLocalModelIdSchema,
      // All FALSE by default: useFor.X means "local FIRST for X" — it short-circuits even a configured
      // cloud provider (local-routing.ts pickPrimaryProvider) and, for summary, makes local the EXCLUSIVE
      // meeting-extraction route (brain/ingest.ts). Those are explicit per-surface privacy choices the
      // user makes in Settings → Local AI, never defaults: with sparse settings persistence
      // (main/store.ts setSettings), a default of true here would silently reroute every upgrading user
      // who never touched Local AI off their configured cloud provider onto the small bundled model.
      useFor: z
        .object({
          suggest: z.boolean().default(false),
          summary: z.boolean().default(false),
          vision: z.boolean().default(false)
        })
        .default({ suggest: false, summary: false, vision: false }),
      // "Local as safety net", the opposite direction from useFor: when the normal cloud route is
      // exhausted — every configured provider failed, or none is configured at all — in-scope work runs
      // on the on-device model as the strictly-LAST candidate instead of failing with "no provider".
      // Gates BOTH surfaces: the meeting-index waterfall (brain/ingest.ts pickProviderCandidates) and
      // in-scope live asks (suggest/summary/vision — local-routing.ts localFallbackEligibleFor), and
      // beneath that the absolute floor (localAnswerFloorEligibleFor), which drops the mode and tier
      // limits entirely so a plain typed question is answered on-device rather than met with "add an API
      // key" — the alternative there is not a better cloud answer, it is no answer. Only ever reachable
      // when localLlm.enabled is true and the runtime+model are actually provisioned AND the org
      // allowlist permits 'local' (localBaseReady). Defaults OFF with enabled: a safety net that would
      // trigger a ~730 MB download the user never asked for is not a safety net. Settings → Local AI
      // arms fallback when the user turns Local on.
      fallback: z.boolean().default(false)
    })
    .default({
      enabled: false,
      modelId: BUNDLED_LOCAL_MODEL_ID,
      useFor: { suggest: false, summary: false, vision: false },
      fallback: false
    }),
  // Wave 2 (docs/PROVIDER-ROUTING-POLICY.md): a top-level policy choice, separate from localLlm.useFor/
  // fallback (which stay the per-mode mechanics 'auto' actually consults). 'local' prefers Métis Local for
  // every eligible mode and only escalates to cloud on hard failure; 'api' keeps local out of the FIRST-
  // attempt pick entirely (it still applies as the last-resort floor when localLlm.fallback is on — the
  // "never fully stuck" guarantee stays true once Local is opted in); 'auto' (default) is today's
  // health/headroom/useFor-driven behavior. With Local off by default, 'auto' still routes to Cloudflare /
  // pasted API keys first. Legacy installs with no persisted value parse to 'auto'.
  routingMode: z.enum(['local', 'api', 'auto']).default('auto'),
  // Resilience routing (the OmniRoute integration): what to do when a provider runs out of tokens/credit
  // rather than a key being rejected. See main/llm/exhaustion.ts + provider-health.ts. Both default ON —
  // they can only ever KEEP an ask answerable, never expose more than the user already configured.
  resilience: z
    .object({
      // When a PAID primary is exhausted (429/credit/usage-cap), float providers with a free tier
      // (providers.ts freeTier) — and the on-device model — ahead of other paid providers as the backup.
      // Never changes the first-choice order; only the order of rescue after an exhaustion.
      preferFreeOnExhaustion: z.boolean().default(true),
      // Pre-empt a provider BEFORE it 429s, from the live x-ratelimit-remaining headers it returns on
      // successful responses (main/llm/usage-headroom.ts). Fail-open: no data = the provider stays eligible.
      budgetPreempt: z.boolean().default(true),
      // Hedge (main/llm/hedge.ts): for a fresh, base-tier interactive ask (answer/vision/suggest), start
      // a second, backup provider racing the primary if the primary hasn't produced a token within
      // HEDGE_DELAY_MS — whichever answers first wins and the other is cancelled. A true concurrent race,
      // not a timeout-then-switch: a primary that DOES answer just slowly still "wins" if it beats the
      // backup, at the cost of occasionally paying for both when both happen to succeed.
      hedge: z.boolean().default(true)
    })
    .default({ preferFreeOnExhaustion: true, budgetPreempt: true, hedge: true }),
  // Wave 3: batch the brain's LLM extraction into 1-2 passes/day (docs/qa/QUALITY-SCORECARD.md's "Brain
  // LLM consolidations / active day ≤ 2") instead of a network round trip after every single meeting.
  // main/brain/consolidate.ts owns the pass counting and the timer that drives runConsolidationIfDue;
  // this is only the user-facing policy. enabled=true by default (batching reduces cloud calls);
  // preferLocal=false by default so consolidation uses Cloudflare / API providers until Local is opted in.
  // today's per-meeting behavior, never add one.
  brainConsolidation: z
    .object({
      enabled: z.boolean().default(true),
      maxPassesPerDay: z.number().int().min(1).max(4).default(2),
      // Prefer Cloudflare / API providers for consolidation batches unless the user opts Local on.
      preferLocal: z.boolean().default(false)
    })
    .default({ enabled: true, maxPassesPerDay: 2, preferLocal: false }),
  // Speaker Intelligence (docs/SPEAKER-INTELLIGENCE-PLAN.md): live "who's speaking" labels on THEM
  // transcript lines via on-device voice embeddings (sherpa-onnx, same addon as Parakeet). ON by
  // default since 2026-08-21 (MQA-235 / Plaud-parity work): the embedding model ships in every build
  // (runtime-assets-manifest.json pins resources/models/speaker/embedding.onnx; check-packaged-runtime
  // verifies it), the whole pass is on-device, and speaker-id.ts degrades to unlabeled lines when the
  // extractor is unavailable — so the default costs nothing where it cannot work.
  speakerId: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  // Durable "time saved" usage counters (shared/time-saved.ts). Incremented ONCE when a meeting file is
  // first written (main/store.ts recordMeetingSummarized) — a rebuild/re-index never re-counts, and this
  // survives transcriptRetentionDays deleting the meetings a live sum would need, so the lifetime figure
  // is honest even after old transcripts are purged. Metadata only (a count and a minute total), never
  // content. `nextSteps` is deliberately NOT stored here — it is derived live from the brain's open
  // commitments, which stays accurate as entities merge/settle.
  usageStats: z
    .object({
      meetingsSummarized: z.number().int().nonnegative().default(0),
      conversationMinutes: z.number().nonnegative().default(0),
      // 0 = no meeting saved yet (drives the "Summarize your first meeting…" empty state).
      firstMeetingAt: z.number().nonnegative().default(0)
    })
    .default({ meetingsSummarized: 0, conversationMinutes: 0, firstMeetingAt: 0 }),
  // The adjustable write-up-avoided assumption behind the time-saved estimate. Per meeting, the notes you
  // would have written by hand ≈ writeupRatio × meeting length, floored/capped so a 3-minute call and a
  // 3-hour call both land in a sane band. Shown and editable in Settings → Time saved so the number is the
  // user's own, not a magic figure. See shared/time-saved.ts for the formula these feed.
  timeSaved: z
    .object({
      writeupRatio: z.number().min(0).max(2).default(0.2),
      floorMin: z.number().min(0).max(240).default(5),
      capMin: z.number().min(0).max(600).default(30)
    })
    .default({ writeupRatio: 0.2, floorMin: 5, capMin: 30 }),
  // Desk Tap Control (src/renderer/src/lib/tap/): tap the desk near the laptop to fire an app action —
  // on-device DSP on a raw (EC/NS/AGC-off) mic stream, calibrated per desk/mic. `profile` is the
  // calibration output (normalization stats, zone centroids, negative examples, data-derived OOD cap);
  // it is a few KB of floats and nullable — null means "not calibrated yet", which keeps the feature
  // inert even when enabled. zoneActions holds one HotkeyAction string per zone index; dispatch
  // validates against HOTKEY_ACTIONS at fire time so a stale/unknown action is a no-op, never a crash.
  tapControl: z
    .object({
      enabled: z.boolean().default(false),
      // Default true: the tap mic then only runs while a listen session is already live, so the OS
      // mic indicator carries no NEW meaning. "Always armed" (false) is the explicit opt-in that
      // keeps the mic hot to START a session by tap — Settings copy owns that disclosure.
      armOnlyWhileListening: z.boolean().default(true),
      sensitivity: z.number().min(0).max(1).default(0.5),
      zoneActions: z.array(z.string()).max(4).default([]),
      profile: z
        .object({
          version: z.literal(1),
          sampleRate: z.number(),
          micDeviceId: z.string(),
          mean: z.array(z.number()),
          std: z.array(z.number()),
          zones: z.array(z.object({ name: z.string(), centroid: z.array(z.number()) })).min(1).max(4),
          negatives: z.array(z.array(z.number())).max(24),
          dAccept: z.number(),
          levelRange: z.object({ min: z.number(), max: z.number() }),
          createdAt: z.number()
        })
        .nullable()
        .default(null)
    })
    .default({
      enabled: false,
      armOnlyWhileListening: true,
      sensitivity: 0.5,
      zoneActions: [],
      profile: null
    }),
  // Phone-home license activation against a self-hosted license server (see main/license.ts). Gate is
  // OFF by default: Tony has not deployed a server yet, and shipping this on by default would lock him
  // out of his own app at next launch. checkLicenseGrace() IS wired into a real startup gate (App.tsx's
  // LicenseGate, via the license:gate IPC channel, plus a 12h background re-validation in main/index.ts) —
  // turning this on only matters once a license server is deployed and this device has activated.
  licenseServerUrl: z.string().default(''),
  licenseKey: z.string().default(''),
  licenseCompanyName: z.string().default(''),
  licenseSeatCap: z.number().default(0),
  licenseExpiresAt: z.number().nullable().default(null),
  licenseValid: z.boolean().default(false),
  licenseLastValidatedAt: z.number().default(0),
  licenseGateEnabled: z.boolean().default(false),
  // ── Act 5 (License/trial), MQA-281/282 ──────────────────────────────────────────────────────────
  /** Compact Ed25519-signed offline lease from the most recent successful /activate or /heartbeat that
   *  carried one (license-server's lib/lease.mjs wire format). '' = no lease (an unconfigured server,
   *  or a build that never activated at all) — checkLicenseGrace() (main/license.ts) then falls back to
   *  the wall-clock grace exactly as it did before this existed. Server-authoritative: stripped from
   *  any renderer-supplied settings patch, same as the other license fields above (settings:set's strip
   *  list, main/index.ts) — a hostile renderer must not be able to self-issue a lease. */
  licenseLease: z.string().default(''),
  /** Epoch ms of the first QUALIFYING real use — a real suggest/summary/recap result actually delivered
   *  (main/license.ts's noteQualifyingUse, called from main/index.ts's ask pipeline). null = no
   *  qualifying use yet. Deliberately NOT set on install/first launch, and never reachable from Act 2's
   *  onboarding demo (structurally IPC-free — see onboarding-demo.ts). Main-authoritative: stripped
   *  from renderer patches for the same reason as licenseLease — a plain settings patch must not be
   *  able to grant a fresh 14-day trial. */
  trialStartedAt: z.number().nullable().default(null)
})

export const SettingsSchema = BaseSettingsSchema.refine(
  (s) => s.provider !== 'custom' || /^https:\/\//i.test(s.customBaseUrl),
  {
    message: 'Custom provider requires a valid https:// endpoint URL',
    path: ['customBaseUrl']
  }
)
export type Settings = z.infer<typeof BaseSettingsSchema>

/** What the renderer receives (never raw keys). */
export const PublicSettingsSchema = BaseSettingsSchema.extend({
  hasApiKey: z.boolean(),
  /** Active provider is actually usable (key present AND any provider-specific setup done) — drives the
   *  "add your key" CTA so it only shows when the app genuinely can't answer yet. */
  /** MQA-261: this build shipped a Cloudflare key, so a user who removed theirs can get it back.
   *  Reads the packaged bundle only — it says nothing about whether a key is stored right now, which is
   *  `hasKeys.cloudflare`. Both are needed: the restore affordance shows only when a key IS available and
   *  is NOT currently stored. False on every ordinary keyless build, so the affordance never appears
   *  where there is nothing to restore. */
  embeddedCloudflareKeyAvailable: z.boolean().default(false),
  providerReady: z.boolean(),
  /** Active provider is usable AND vision-capable — gates screen-ask so screenshots never route to a
   *  non-vision model. Derived in publicSettings() from providerReady && PROVIDERS[provider].vision. */
  visionReady: z.boolean(),
  /** SOME configured provider can read images (not necessarily the active one). A screen-ask / quick
   *  action routes to capture when this is true even if the active provider is text-only (e.g. Dust) —
   *  the main process fails over to the vision provider. Prevents the Dust-active screenshot dead-end. */
  visionAvailable: z.boolean().default(false),
  /** Métis Local is enabled, the runtime binary and installer-owned model are present,
   *  and the org allowlist (if any) permits 'local' — independent of any specific task. Derived by
   *  main/llm/local-routing.ts's localBaseReady(), the single source of truth this mirrors (see also
   *  localEligibleFor, which layers the per-request mode-scope check on top for live routing). */
  localReady: z.boolean().default(false),
  /** localReady AND the user's "Live suggestions" use-for toggle is on. */
  localSuggestReady: z.boolean().default(false),
  /** localReady AND the user's "Summaries" use-for toggle is on. */
  localSummaryReady: z.boolean().default(false),
  /** localReady AND the user's "Screenshots" use-for toggle is on. */
  localVisionReady: z.boolean().default(false),
  /** localReady AND localLlm.fallback — "local as safety net" is live: with zero cloud/CLI providers
   *  configured (or all of them down), in-scope asks and meeting indexing still run on-device. Lets
   *  renderer readiness gates (index-meetings CTA, screen-ask) match what routing will actually do. */
  localFallbackReady: z.boolean().default(false),
  /** Providers currently DEMOTED because a recent ask failed in a way that will keep failing for a while —
   *  a dead key (401/403), a rate limit (429), spent credit, or a subscription usage-cap — see
   *  main/llm/provider-health.ts. `providerReady` above only means "a key string exists", so without this
   *  the UI reports a provider ready forever while every ask silently degrades to the backup (MQA-004).
   *  `reason` lets the UI distinguish "re-enter your key" from "you hit a limit, resets soon"; `until` is
   *  the epoch-ms the cooldown expires so it can show "retry in 2m" / "resets ~3:40pm". Empty is the
   *  healthy case. Session-scoped: never persisted, cleared the moment the key changes or it answers again. */
  unhealthyProviders: z
    .array(
      z.object({
        provider: z.string(),
        error: z.string(),
        since: z.number(),
        reason: z.enum(['auth', 'rate-limit', 'quota-exhausted', 'usage-cap']).default('auth'),
        until: z.number().default(0)
      })
    )
    .default([]),
  /**
   * Wave 2 / QA — last successful failover hop this session (primary → backup). Session-scoped, never
   * persisted; the renderer shows a one-shot chip then clears via settings:dismissFailoverNotice.
   * null when no failover has fired yet (or the user dismissed the chip).
   */
  lastFailover: z
    .object({
      from: z.string(),
      to: z.string(),
      at: z.number(),
      reason: z.string().default('failover')
    })
    .nullable()
    .default(null),
  /** Background on-device screen pre-analysis can actually run RIGHT NOW, straight from the engine's own
   *  gate (screen-preprocess.ts canRun(), never recomputed renderer-side): session valid, the
   *  `backgroundScreenContext` setting on, an on-device reader available (local model OR the macOS Vision
   *  OCR helper), and a live OS foreground-window signal. Lets Settings say "on" vs the right reason it
   *  is not — pair it with `localReady` to tell "no on-device reader" from "no window signal". */
  backgroundScreenReady: z.boolean().default(false),
  /** Whether the llama-server sidecar process is running RIGHT NOW — distinct from `localReady` (which is
   *  eligibility to route there, not live process state; the sidecar starts lazily on first local request
   *  and idle-stops after 15 min, see local-runtime.ts). Drives the Local AI card's status line only. */
  localRuntimeRunning: z.boolean().default(false),
  /** Precise sidecar lifecycle state — lets the Local AI card distinguish a normal idle 'stopped' from a
   *  session-long 'unavailable' lockout (restart-budget exhausted, cleared only by relaunch). */
  localRuntimeState: z.enum(['stopped', 'starting', 'running', 'unavailable']).default('stopped'),
  hasKeys: z.record(z.string(), z.boolean()),
  hasEncryption: z.boolean(),
  resolvedMeetingsFolder: z.string(),
  managedKeys: z.array(z.string()).default([]),
  /** Providers whose key is set via an environment variable — in-app Remove is a no-op for these. */
  envKeys: z.array(z.string()).default([]),
  loginItemOpenAtLogin: z.boolean().default(false),
  /** App version (e.g. from package.json/app.getVersion()), populated by main for the About screen.
   *  Optional — absent on older callers/tests that construct PublicSettings without it. */
  version: z.string().optional(),
  /** Org data-residency allowlist of provider ids (from managed-config `allowedProviders`). null = no
   *  restriction. The renderer uses it to filter the provider picker to approved vendors and to badge a
   *  blocked provider "restricted by your organization" — the SAME source the main process enforces at
   *  request time, so the UI can't offer a provider that every ask would then reject. */
  allowedProviders: z.array(z.string()).nullable().default(null)
})
export type PublicSettings = z.infer<typeof PublicSettingsSchema>

/** Patch type exposed to the renderer. Derived/computed fields are omitted because the main process ignores them. */
export type SettingsPatch = Partial<
  Omit<
    PublicSettings,
    | 'hasApiKey'
    | 'providerReady'
    | 'localReady'
    | 'localSuggestReady'
    | 'localSummaryReady'
    | 'localVisionReady'
    | 'localRuntimeRunning'
    | 'localRuntimeState'
    | 'hasKeys'
    | 'hasEncryption'
    | 'resolvedMeetingsFolder'
    | 'managedKeys'
    | 'envKeys'
    | 'loginItemOpenAtLogin'
    | 'lastFailover'
  >
>

// Dust agent sIds. The BASE agent is a user-editable Settings picker (DustSetup) that DEFAULTS to
// Métis — an empty value always falls back here, and the picker offers a one-click reset. Spotlight
// Ref stays hard-locked (read-only in Settings); rotating IT without a release: hand-edit
// userData/managed-config.json with {"providerModelsSpotlightRef":{"dust":"NEW_ID"}}.
export const DUST_BASE_AGENT_ID = 'vJxYHvTRBT' // Dust agent "Métis" — default base agent (user-changeable in Settings → AI → Dust); also drafts meeting follow-ups (no separate follow-up agent)
export const DUST_SPOTLIGHT_REF_AGENT_ID = 'GOr913Zr5V' // Dust agent "Spotlight Ref"

export const DEFAULT_SETTINGS: Settings = {
  provider: 'cloudflare', // keep in lockstep with BaseSettingsSchema's ProviderIdSchema default above
  providerPriority: 'api',
  providerFallbackOrder: [],
  providerModels: { dust: DUST_BASE_AGENT_ID },
  providerModelsThinking: {},
  providerModelsDeep: {},
  providerModelsSpotlightRef: DUST_SPOTLIGHT_REF_AGENT_ID ? { dust: DUST_SPOTLIGHT_REF_AGENT_ID } : {},
  routingMode: 'auto',
  resilience: { preferFreeOnExhaustion: true, budgetPreempt: true, hedge: true },
  thinkingMode: 'auto',
  askFollowUpMemory: false,
  customBaseUrl: '',
  cloudflareBaseUrl: METIS_WORKER_URL,
  dustWorkspaceId: '',
  dustBaseUrl: 'https://dust.tt',
  dustSessionOrigin: 'oauth',
  azureClientId: '',
  azureTenantId: '',
  azureAllowedDomain: '',
  graphifyEnabled: true,
  graphifyAutoRebuild: true,
  graphifyBackend: 'auto',
  outputLanguage: 'auto',
  summaryLanguage: 'auto',
  encryptTranscripts: true,
  publishBrainPages: false,
  transcriptRetentionDays: 0,
  systemPrompt:
    'You are Métis, a fast, sharp desktop assistant living in an always-on overlay. ' +
    'Answer concisely and directly in clean markdown. Lead with the answer. Use code blocks ' +
    'with language tags, KaTeX for math ($...$), and tables when they help. No filler.',
  modePrompts: {},
  contextDocs: {},
  customModes: [],
  meetingNotifications: false,
  temperature: 0.4,
  contentProtection: true,
  privateView: false,
  audioSource: 'both',
  micDeviceId: '',
  suggestEverySec: 8,
  mode: 'general',
  profile: { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' },
  shortcuts: {}, // empty → built-in DEFAULT_SHORTCUTS apply (merged at hotkey registration)
  autoSuggest: true,
  screenAsk: true,
  showLiveTranscript: false,
  meetingsFolder: '',
  teamTranscriptFolders: [],
  autoSaveTranscripts: false,
  launchAtLogin: false,
  onboardingDone: false,
  onboardingDoneAt: 0,
  recordingConsent: false,
  playListenChime: true,
  soundCues: true,
  uiSounds: true,
  quickActionsRainbow: true,
  instantSuggestions: true,
  backgroundScreenContext: false,
  overlayOpacity: 1,
  autoHideOverlay: true,
  overlayLayout: 'hide',
  showFullTranscriptInReview: false,
  asrQuality: 'best',
  asrEngine: 'whisper',
  asrLanguage: 'auto',
  asrLastFallbackAt: null,
  asrWebgpuFallbackAt: null,
  micOnlyFallbackAt: null,
  requireConsentIndicator: true,
  redactSensitive: true,
  lastConsentReminderAt: 0,
  asrCorrections: [],
  asrEntityBias: true,
  cliConnected: {},
  dustTokenMintedAt: 0,
  cliNoticeAck: false,
  mcpConnections: [],
  clickupClientId: '',
  planeClientId: '',
  localLlm: {
    enabled: false,
    modelId: BUNDLED_LOCAL_MODEL_ID,
    useFor: { suggest: false, summary: false, vision: false },
    fallback: false
  },
  speakerId: { enabled: true },
  brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: false },
  usageStats: { meetingsSummarized: 0, conversationMinutes: 0, firstMeetingAt: 0 },
  timeSaved: { writeupRatio: 0.2, floorMin: 5, capMin: 30 },
  tapControl: {
    enabled: false,
    armOnlyWhileListening: true,
    sensitivity: 0.5,
    zoneActions: [],
    profile: null
  },
  licenseServerUrl: '',
  licenseKey: '',
  licenseCompanyName: '',
  licenseSeatCap: 0,
  licenseExpiresAt: null,
  licenseValid: false,
  licenseLastValidatedAt: 0,
  licenseGateEnabled: false,
  licenseLease: '',
  trialStartedAt: null
}

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  'ask',
  'hide',
  'reset',
  'toggle-listen',
  'capture',
  'factcheck',
  'whatnext',
  'explain',
  'summarize',
  'spotlight-ref',
  'scroll-up',
  'scroll-down',
  'scroll-left',
  'scroll-right',
  'settings'
]

export type HotkeyAction =
  | 'ask'
  | 'hide'
  | 'reset'
  | 'toggle-listen'
  | 'capture'
  | 'factcheck'
  // The remaining Quick Action chips (QuickActions.tsx's QuickKind) + Spotlight Ref — previously only
  // 'factcheck' had a hotkey slot even though all four chips + Spotlight Ref are equally reachable by click.
  | 'whatnext'
  | 'explain'
  | 'summarize'
  | 'spotlight-ref'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right'
  | 'settings'
  | 'agenda'

// This file is bundled into main (real Node `process`), preload (same), and the sandboxed renderer
// (no Node globals — falls back to the `navigator.platform` check already used elsewhere for
// renderer-side platform branching). `typeof` guards are required: referencing a bare undeclared
// global throws in the renderer, but `typeof x !== 'undefined'` never does.
function isWindowsPlatform(): boolean {
  if (typeof process !== 'undefined' && process.platform) return process.platform === 'win32'
  if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform.toLowerCase().includes('win')
  return false
}

export const DEFAULT_SHORTCUTS: Record<HotkeyAction, string> = {
  ask: 'CommandOrControl+Shift+Return',
  hide: 'CommandOrControl+\\',
  reset: 'CommandOrControl+Shift+R',
  'toggle-listen': 'CommandOrControl+Shift+L',
  capture: 'CommandOrControl+Shift+S',
  factcheck: 'CommandOrControl+Shift+F',
  // Unassigned by default (no free, uncontested global combo obviously reads as "what to say next" /
  // "explain" / "summarize" / "spotlight ref") — the Settings row still lets a user bind one.
  whatnext: '',
  explain: '',
  summarize: '',
  'spotlight-ref': '',
  // Ctrl+Alt+Arrow is the long-standing Intel iGPU control-panel hotkey for rotating the display on
  // Windows — Windows gets a different modifier set to avoid that collision; mac/Linux are unaffected
  // and keep Cmd/Ctrl+Alt+Arrow.
  'scroll-up': isWindowsPlatform() ? 'Alt+Shift+Up' : 'CommandOrControl+Alt+Up',
  'scroll-down': isWindowsPlatform() ? 'Alt+Shift+Down' : 'CommandOrControl+Alt+Down',
  'scroll-left': isWindowsPlatform() ? 'Alt+Shift+Left' : 'CommandOrControl+Alt+Left',
  'scroll-right': isWindowsPlatform() ? 'Alt+Shift+Right' : 'CommandOrControl+Alt+Right',
  settings: '', // no global shortcut by default; opened from bar or tray
  // Agenda is reached from the tray only (the Cluely bar redesign dropped its toolbar button). Kept out
  // of HOTKEY_ACTIONS so it gets no global key / no Settings row, but typed so the tray can trigger it.
  agenda: ''
}

/** A hotkey main failed to bind (combo already held by another app, or OS-reserved) — IPC.shortcutFailures. */
export interface ShortcutFailure {
  action: string
  accel: string
}

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'
export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
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
  /** True for a real encrypted meeting that failed to decrypt on this device — listed as a locked
   *  stub (no preview) so it's visible with a lock affordance instead of silently vanishing. */
  locked?: boolean
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
  recap: z.string().max(20000)
})
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
  recap?: string
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

/** Result of brain:entityNames — canonical people/account names ONLY (never quotes, roles, deal data,
 *  or anything else from the entity files), for the ASR entity-casing bias feature. See
 *  lib/entity-casing.ts and the brainEntityNames handler in main/index.ts. */
export interface BrainEntityNamesResult {
  names: string[]
}

// ─── MCP connections (CRM push + "Book next steps") ────────────────────────
// Generalized from the single BidStack-only mcpCrm:* IPC channels. `connectionId` identifies WHICH
// mcpConnections entry a call targets (id === kind in v1 — see McpConnectionSchema); main looks the
// connection up in settings.mcpConnections rather than trusting an endpoint/key the renderer hands it,
// same defense-in-depth as the old single-connection handlers.

export const McpTestConnectionPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema,
  endpointUrl: z.string().min(1, 'Enter the MCP endpoint URL.'),
  apiKey: z.string().min(1, 'Enter the API key.'),
  extraHeaders: z.record(z.string(), z.string()).default({})
})
export type McpTestConnectionPayload = z.infer<typeof McpTestConnectionPayloadSchema>

export const McpSaveConnectionPayloadSchema = McpTestConnectionPayloadSchema.extend({
  label: z.string().min(1, 'Name this connection.').max(60)
})
export type McpSaveConnectionPayload = z.infer<typeof McpSaveConnectionPayloadSchema>

// connectionId is the KIND enum, never a free string: main feeds it straight into
// mcpSecrets.ts's `key-mcp-<id>.bin` path, so an unconstrained value ('../../secret-key') would let a
// compromised renderer rmSync an arbitrary .bin — including secret-key.bin, the AES file key that every
// stored provider credential is encrypted under. mcpSecrets.ts rejects such an id on its own too; this
// is the outer half of that pair. v1 keeps id === kind (see McpConnectionSchema).
export const McpDisconnectPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema
})
export type McpDisconnectPayload = z.infer<typeof McpDisconnectPayloadSchema>

// Push args are always a small, flat object built by Review.tsx (title/date/summary strings, or a task
// title/description) — bound the shape so a tampered/buggy caller can't hand the MCP tool call an
// unbounded or deeply-nested payload.
const McpArgValueSchema = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
export const McpPushPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema,
  toolName: z.string().min(1, 'Choose an MCP tool to push to.'),
  args: z
    .record(z.string(), McpArgValueSchema)
    .refine((a) => Object.keys(a).length <= 20, { message: 'Too many fields in the push payload.' }),
  /** Basename of the saved meeting markdown — main re-reads frontmatter for confidential (never trust UI alone). */
  meetingFile: z.string().min(1).max(260).optional()
})
export type McpPushPayload = z.infer<typeof McpPushPayloadSchema>

/** Result of testing or saving an MCP connection — mirrors the SDK's listTools() discovery. */
export interface McpConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
}

/** Result of pushing to an MCP tool. */
export interface McpPushResult {
  ok: boolean
  error?: string
  result?: unknown
}

/** Renderer may only record an email-summary. Main owns note-taking, second-brain, and mcp-push. */
export const TimeSavedRecordPayloadSchema = z.object({
  kind: z.literal('email-summary')
})
export type TimeSavedRecordPayload = z.infer<typeof TimeSavedRecordPayloadSchema>

export const OutlookDraftPayloadSchema = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default('')
})
export type OutlookDraftPayload = z.infer<typeof OutlookDraftPayloadSchema>

export const OutlookEventPayloadSchema = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default(''),
  startIso: z.string().max(40).optional(),
  endIso: z.string().max(40).optional()
})
export type OutlookEventPayload = z.infer<typeof OutlookEventPayloadSchema>

// ─── Métis Local (on-device LLM) — bundled model readiness (see main/llm/local-models.ts) ─────────────
// ipc.ts is bundled into the renderer too, so it cannot import local-models.ts (touches node:fs/electron
// at module scope), so this structurally mirrors its renderer-safe summary. `.strict()` prevents a future
// path, port, or session key from silently crossing the main-to-renderer boundary.

/** Renderer-safe metadata for the on-device model. The weights are NOT in the installer (see
 *  main/llm/local-models.ts): they are fetched once on first run, so "not ready" has to distinguish
 *  downloading / failed / never-attempted — the renderer told users to reinstall for all three
 *  (MQA-187/191), which no installer can satisfy. */
export const LocalModelSummarySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    minTotalRamGB: z.number(),
    ready: z.boolean(),
    unavailableReason: z
      .enum(['insufficient-ram', 'downloading', 'download-failed', 'not-downloaded'])
      .nullable(),
    /** 0..1 while `unavailableReason === 'downloading'`, 0 otherwise. */
    downloadProgress: z.number().min(0).max(1)
  })
  .strict()
export type LocalModelSummary = z.infer<typeof LocalModelSummarySchema>

/** Payload for local:prewarm — a debounced live-meeting transcript tail (PLAN.md §4.4's pre-warm path),
 *  sent fire-and-forget from the renderer's instant-suggestions effect so the sidecar's per-slot KV cache
 *  stays hot between real suggest requests. The renderer already clips this to the same ~6000-char tail
 *  the suggest mode itself sends (llm/shared.ts's `.slice(-6000)`) before it ever reaches IPC; the 24000
 *  cap here is defense-in-depth against a compromised/malfunctioning renderer, not the real bound. */
export const LocalPrewarmPayloadSchema = z.object({ text: z.string().min(1).max(24_000) })
export type LocalPrewarmPayload = z.infer<typeof LocalPrewarmPayloadSchema>


// ─── Licensing (phone-home activation against a self-hosted license server; see main/license.ts) ──────
export const LicenseActivatePayloadSchema = z.object({
  serverUrl: z.string().min(1, 'Enter the license server URL.'),
  licenseKey: z.string().min(1, 'Enter a license key.')
})
export type LicenseActivatePayload = z.infer<typeof LicenseActivatePayloadSchema>

export const LicenseConfigPayloadSchema = z.object({
  serverUrl: z.string().min(1, 'Enter the license server URL.')
})
export type LicenseConfigPayload = z.infer<typeof LicenseConfigPayloadSchema>

/** Result of an activate/heartbeat call. `error` carries either the server's own code ('invalid' |
 *  'revoked' | 'expired' | 'seat_limit_reached') or a client-side code for cases the server never sees:
 *  'network' (unreachable or a malformed response) and 'not_activated' (heartbeat with no activation on
 *  file yet). Settings.tsx maps every code to plain-language copy. */
export interface LicenseActivateResult {
  ok: boolean
  error?: string
  companyName?: string
  seatCap?: number
  expiresAt?: number | null
  /** Compact signed offline lease (MQA-282), when this server has lease signing configured. Absent on
   *  an unconfigured/older server — additive-only, see license-server/README.md. */
  lease?: string
}

/** Cached license state for display — read straight from settings, no network call (see the
 *  license:status handler). Deliberately excludes seatsUsed: that's only a point-in-time snapshot from
 *  the last activate/heartbeat response, not a live count, so the UI shows seatCap only. */
export interface LicenseStatusResult {
  licenseServerUrl: string
  licenseCompanyName: string
  licenseSeatCap: number
  licenseExpiresAt: number | null
  licenseValid: boolean
  licenseLastValidatedAt: number
  licenseGateEnabled: boolean
  /** Act 5 (MQA-281/282) — live-verified lease/trial status, independent of licenseGateEnabled (see
   *  main/license.ts's licenseDisplayStatus). null/false/0 whenever neither applies. */
  leaseExpiresAt: number | null
  trialActive: boolean
  trialDaysRemaining: number
}

/** Startup-gate verdict for App.tsx's boot gate, derived by calling checkLicenseGrace() fresh on every
 *  call (see the license:gate handler in main/index.ts). Deliberately its own small shape rather than a
 *  field on LicenseStatusResult: license:status is gated behind requireAuth() (an SSO-signed-in check),
 *  but this channel must be reachable even when signed out — a revoked or unlicensed device has to learn
 *  that BEFORE burning an SSO round trip, not after (license outranks SSO in App.tsx's gate order). */
export interface LicenseGateVerdict {
  gateEnabled: boolean
  allowed: boolean
  reason?: 'not_activated' | 'expired_grace' | 'trial_expired'
  leaseExpiresAt?: number
  trialActive?: boolean
  trialDaysRemaining?: number
}

/** GET /license/config's declared-intent pair (license-server's lib/license-gate.mjs) — informational
 *  only, read by the ActLicense onboarding scene. `error` mirrors LicenseActivateResult's client-side
 *  codes ('network' for unreachable/malformed; the server route itself never returns a business error). */
export interface LicenseConfigResult {
  ok: boolean
  error?: string
  licenseEnforcement?: boolean
  licenseUiEnabled?: boolean
  drift?: boolean
}

export {
  LICENSE_ACTIVATION_OPEN,
  MemberActivatePayloadSchema,
  emptyLicenseStatus,
  type IdentitySnapshot,
  type MemberActivatePayload,
  type MemberActivateResult,
  type MemberLicenseStatus
} from './license-types'

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Epoch ms when the screenshot was captured or cache-filled; used for real freshness UI. */
  capturedAt: z.number().int().nonnegative(),
  /** True when the captured monitor didn't match the cursor's display (fell back to sources[0]);
   *  the renderer surfaces a soft "captured a different monitor" notice. */
  displayMismatch: z.boolean().optional()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>

/** Result of the screen:context IPC — a pre-analyzed, on-device description of the current screen, or null
 *  when none is fresh (window changed / too old / feature off). The renderer uses a non-null result to take
 *  the no-capture fast-path; the description text itself is only ever re-derived by main at ask time. */
export const ScreenContextResultSchema = z
  .object({
    description: z.string(),
    capturedAt: z.number().int().nonnegative()
  })
  .nullable()
export type ScreenContextResult = z.infer<typeof ScreenContextResultSchema>
