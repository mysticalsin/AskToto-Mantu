import { z } from 'zod'
import type { ProviderId } from './providers'

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
  setApiKey: 'settings:setApiKey',
  clearApiKey: 'settings:clearApiKey',
  testApiKey: 'settings:testApiKey',
  dustListAgents: 'dust:listAgents',
  dustImportCli: 'dust:importCli',
  dustSetupCli: 'dust:setupCli',
  dustProbeSession: 'dust:probeSession',
  graphifyStatus: 'graphify:status',
  graphifyRebuild: 'graphify:rebuild',
  graphifyRelated: 'graphify:related',
  graphifyOpenGraph: 'graphify:openGraph',
  brainStatus: 'brain:status',
  brainBackfill: 'brain:backfill',
  brainRead: 'brain:read',
  brainEntityNames: 'brain:entityNames',
  brainOpenDashboard: 'brain:openDashboard',
  brainRebuildAll: 'brain:rebuildAll',
  authStatus: 'auth:status',
  authSignIn: 'auth:signIn',
  authSignOut: 'auth:signOut',
  calendarToday: 'calendar:today',
  parakeetStatus: 'parakeet:status',
  parakeetEnsure: 'parakeet:ensure',
  parakeetFeed: 'parakeet:feed',
  parakeetProgress: 'parakeet:progress',
  askStart: 'ask:start',
  askCancel: 'ask:cancel',
  streamDelta: 'stream:delta',
  streamDone: 'stream:done',
  streamError: 'stream:error',
  streamMeta: 'stream:meta',
  captureScreen: 'capture:screen',
  prewarmCapture: 'capture:prewarm',
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
  openPath: 'path:open',
  recallList: 'recall:list',
  recallSearch: 'recall:search',
  recallOpen: 'recall:open',
  recallRead: 'recall:read',
  recallDelete: 'recall:delete',
  recallRename: 'recall:rename',
  recallUpdateRecap: 'recall:update-recap',
  recallDeleteAll: 'recall:deleteAll',
  debriefSave: 'debrief:save',
  brainCommitmentSettle: 'brain:commitmentSettle',
  brainSetDealOutcome: 'brain:setDealOutcome',
  windowResize: 'window:resize',
  windowMode: 'window:mode',
  windowMoveBy: 'window:moveBy',
  windowHide: 'window:hide',
  windowToggle: 'window:toggle',
  windowQuit: 'window:quit',
  windowMinimize: 'window:minimize',
  hotkey: 'hotkey',
  shortcutFailures: 'shortcuts:failures',
  permissionsGet: 'permissions:get',
  permissionsOpenSettings: 'permissions:openSettings',
  permissionsRequestUpfront: 'permissions:requestUpfront',
  listeningState: 'listening:state',
  asrBundled: 'asr:bundled',
  cliDetect: 'cli:detect',
  cliSetup: 'cli:setup',
  cliTest: 'cli:test',
  cliInstall: 'cli:install',
  cliInstallProgress: 'cli:install:progress',
  cliLogin: 'cli:login',
  answerFeedback: 'answer:feedback',
  metricsRead: 'metrics:read',
  updateDownloaded: 'update:downloaded',
  updateInstall: 'update:install',
  recapPdf: 'recap:pdf',
  openMailDraft: 'mail:openDraft',
  mcpCrmTestConnection: 'mcpCrm:testConnection',
  mcpCrmSaveConnection: 'mcpCrm:saveConnection',
  mcpCrmDisconnect: 'mcpCrm:disconnect',
  mcpCrmPush: 'mcpCrm:push',
  notebookLmDetect: 'notebookLm:detect',
  notebookLmInstall: 'notebookLm:install',
  notebookLmInstallProgress: 'notebookLm:install:progress',
  notebookLmLogin: 'notebookLm:login',
  notebookLmConnect: 'notebookLm:connect',
  notebookLmAsk: 'notebookLm:ask',
  licenseActivate: 'license:activate',
  licenseStatus: 'license:status',
  licenseGate: 'license:gate'
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
}

export type AskMode = 'answer' | 'vision' | 'suggest' | 'summary' | 'recap'

export const CONVERSATION_MODES = [
  'interview',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support',
  'general'
] as const
/** The 7 built-in modes. */
export type BuiltinMode = (typeof CONVERSATION_MODES)[number]
/** Active mode id: a built-in id OR a user-created custom mode id. The `(string & {})` keeps literal
 *  autocomplete for built-ins while accepting any custom id, so existing consumers compile unchanged. */
export type ConversationMode = BuiltinMode | (string & {})

/** Display labels for the 7 built-in modes (single source of truth, shared by ModePicker + Settings + bar). */
export const BUILTIN_MODE_LABELS: Record<BuiltinMode, string> = {
  general: 'General',
  interview: 'Interview',
  meeting: 'Meeting',
  sales: 'Sales',
  negotiation: 'Negotiation',
  presentation: 'Presentation',
  support: 'Support'
}

/** A user-created custom mode (id + display label). Its prompt lives in settings.modePrompts[id] and its
 *  context files in settings.contextDocs[id]. Built-in modes are never stored here. */
export interface CustomMode { id: string; label: string }

/** Cluely-style ordered groups for the modes list (built-ins). Custom modes render under their own group in the UI. */
export const MODE_GROUPS: { label: string; modes: BuiltinMode[] }[] = [
  { label: 'General', modes: ['general'] },
  { label: 'Live assist', modes: ['interview', 'sales', 'negotiation', 'presentation', 'support'] },
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
  t: z.number()
})
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>

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
  pct: number
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
 *  in shared/brain.ts; the LLM never sets it). dealSlug carries the deal's display name, the same
 *  convention brain:commitmentSettle's `deal` field uses — it's slugified in main before the store write. */
export const SetDealOutcomePayloadSchema = z.object({
  dealSlug: z.string().min(1),
  outcome: z.enum(['open', 'won', 'lost'])
})

/** Structured export of a meeting recap (decisions + action-items-with-owners) for Jira/Asana/Notion etc.
 *  The full original markdown is always included so nothing is lost if a section heading was reworded. */
export const RecapExportSchema = z.object({
  title24: z.string(),
  tags: z.array(z.string()),
  overview: z.string(),
  topics: z.array(z.string()),
  keyQA: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(z.object({ text: z.string(), owner: z.string().nullable() })),
  openQuestions: z.array(z.string()),
  notableQuotes: z.array(z.string()),
  markdown: z.string()
})
export type RecapExport = z.infer<typeof RecapExportSchema>

export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string()
})
export type ChatTurn = z.infer<typeof ChatTurnSchema>

export const AskStartSchema = z.object({
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
  /** raw transcript text for suggest mode */
  transcript: z.string().optional(),
  /** 'deeper' = the user tapped "Go deeper" → re-ask for a fuller answer (injected per-turn, never cached) */
  depth: z.enum(['deeper']).optional(),
  /** 'factcheck' = a verification ask → the router sends it to the strongest model (verifier path). */
  kind: z.enum(['answer', 'factcheck']).optional(),
  /** Pins a specific Dust agent sId regardless of tier routing (e.g. Spotlight Ref). Dust-only; ignored by other providers. */
  agentOverride: z.string().optional(),
  /** Forces this one request to a specific provider regardless of the globally active `provider` setting —
   *  e.g. cascading a recap/follow-up/Spotlight-Ref request into Dust even when Kimi/Anthropic/etc. is active. */
  providerOverride: ProviderIdSchema.optional(),
  /** Receipt Mode: relevant past-meeting knowledge, assembled in main from the brain (never sent by the
   *  renderer — main overwrites it after parse). Injected per-turn into the user text so it never pollutes
   *  or invalidates the cached system prompt. Capped for defense-in-depth against a hostile renderer. */
  brainContext: z.string().max(8000).optional(),
  history: z.array(ChatTurnSchema).default([])
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
  tier: z.enum(['base', 'think', 'deep'])
})
export type StreamMeta = z.infer<typeof StreamMetaSchema>

export const BaseSettingsSchema = z.object({
  provider: ProviderIdSchema.default('anthropic'),
  // CLI-vs-API priority. 'api' (default) keeps the explicitly-chosen `provider` as primary. 'cli' makes a
  // connected CLI integration (Claude/Codex) the primary so the user's local subscription is used before
  // any metered API key, and prefers CLI on failover. With no CLI connected, 'cli' behaves like 'api'.
  providerPriority: z.enum(['cli', 'api']).default('api'),
  providerModels: z.record(z.string(), z.string()).default({}),
  customBaseUrl: z
    .string()
    .refine(
      (v) => v === '' || /^https:\/\//i.test(v),
      'Custom endpoint must be an https:// URL'
    )
    .default(''),
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
  // Dust provider config (workspace id + region base; the agent sId lives in providerModels.dust)
  dustWorkspaceId: z.string().default(''),
  dustBaseUrl: z
    .string()
    .refine((v) => v === '' || /^https:\/\//i.test(v), 'Dust URL must be an https:// URL')
    .default('https://dust.tt')
    .transform((v) => v || 'https://dust.tt'),
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
  shortcuts: z.record(z.string(), z.string().min(1)).default({}),
  autoSuggest: z.boolean().default(true),
  // Cluely "Uses Screen": when on (and the active provider is vision-capable), a hero ask captures the
  // screen and answers about it. Default on. Gated by the derived `visionReady` flag in PublicSettings.
  screenAsk: z.boolean().default(true),
  showLiveTranscript: z.boolean().default(false),
  meetingsFolder: z.string().default(''),
  autoSaveTranscripts: z.boolean().default(false),
  // Gates the (popup-free) meeting watcher. OFF by default per Tony: detection is opt-in — the popup
  // it once fed was removed as too intrusive; Listen is manual-only (Bar button, ControlPill mic, hotkey).
  autoStartOnMeeting: z.boolean().default(false),
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
  // How see-through the overlay's glass background is. A multiplier on the default glass alpha values
  // (see --glass-fill etc. in styles.css) — 1 = today's default look, lower = more transparent (see more
  // of what's behind), higher = more opaque/solid (easier to read over a busy desktop). Values above 1
  // simply saturate at fully opaque for the most solid backgrounds; nothing errors or clips oddly.
  overlayOpacity: z.number().min(0.3).max(1.5).default(1),
  showFullTranscriptInReview: z.boolean().default(false), // review = summary-first; transcript opt-in
  asrQuality: z.enum(['best', 'fast']).default('fast'), // fast = small model, ready fast (default); best = large, downloads
  asrEngine: z.enum(['whisper', 'parakeet']).default('parakeet'), // parakeet = European, fastest (default); whisper = ~99 langs
  // A mid-session Parakeet→Whisper fallback (repeated failures) used to surface as a live error banner
  // during the meeting — distracting for something that's really just a background engine swap. Tracked
  // here instead so it's checkable in Settings after the fact, never shown live. Persists until the user
  // dismisses it (Settings → Speech) — auto-clearing on the next meeting risks it vanishing unseen.
  asrLastFallbackAt: z.number().nullable().default(null),
  // On by default: this reminder is the ONLY consent mechanism Métis has today — it shows the
  // operator, never the other participants, and is not a substitute for actually telling people
  // they're being recorded. See the Settings copy near this toggle for the honest scope of what it does.
  requireConsentIndicator: z.boolean().default(true),
  // Strip high-confidence secrets (cards, API keys, SSNs, private keys) from the captured transcript
  // before it's sent to a cloud model. On by default; never touches the typed question or the saved file.
  redactSensitive: z.boolean().default(true),
  lastConsentReminderAt: z.number().default(0),
  // deprecated — kept so persisted settings/managed-config still parse (was only used by the removed
  // auto-start-on-meeting-detected popup's app-name matching).
  customMeetingApps: z.array(z.string().min(1).max(80)).max(20).default([]),
  // Words the ASR engine consistently mishears, always corrected in the live transcript (commitLine).
  asrCorrections: z.array(z.object({ from: z.string().min(1).max(80), to: z.string().max(80) })).max(100).default([]),
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
  // BidStack 360° CRM — MCP push (Settings → CLI Integration). The API key itself is NOT stored here;
  // it goes through the same encrypted-file mechanism as provider keys, via main/mcp/bidstackSecrets.ts
  // (kept out of the ProviderId union — a CRM credential, not an LLM provider). Never hardcode a default
  // endpoint: BidStack's own Settings UI warns its local fallback is dev-only, so the user must supply
  // wherever they actually deploy/run BidStack's backend.
  bidstackEndpointUrl: z.string().default(''),
  bidstackConnected: z.boolean().default(false),
  // Tool names BidStack's MCP discovery returned at the last successful connect/save — populates the
  // "Push to CRM" tool picker in Review.tsx so we never guess/hardcode BidStack's tool names.
  bidstackTools: z.array(z.string()).default([]),
  // NotebookLM research (MCP, stdio; Settings → Mantu Intelligence). No endpoint or key to persist — auth
  // lives entirely in the nlm CLI's own state under the user's home dir — only connected-status + the
  // tool names discovered at connect time.
  notebookLmConnected: z.boolean().default(false),
  notebookLmTools: z.array(z.string()).default([]),
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
  licenseGateEnabled: z.boolean().default(false)
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
  providerReady: z.boolean(),
  /** Active provider is usable AND vision-capable — gates screen-ask so screenshots never route to a
   *  non-vision model. Derived in publicSettings() from providerReady && PROVIDERS[provider].vision. */
  visionReady: z.boolean(),
  /** SOME configured provider can read images (not necessarily the active one). A screen-ask / quick
   *  action routes to capture when this is true even if the active provider is text-only (e.g. Dust) —
   *  the main process fails over to the vision provider. Prevents the Dust-active screenshot dead-end. */
  visionAvailable: z.boolean().default(false),
  hasKeys: z.record(z.string(), z.boolean()),
  hasEncryption: z.boolean(),
  resolvedMeetingsFolder: z.string(),
  managedKeys: z.array(z.string()).default([]),
  /** Providers whose key is set via an environment variable — in-app Remove is a no-op for these. */
  envKeys: z.array(z.string()).default([]),
  loginItemOpenAtLogin: z.boolean().default(false)
})
export type PublicSettings = z.infer<typeof PublicSettingsSchema>

/** Patch type exposed to the renderer. Derived/computed fields are omitted because the main process ignores them. */
export type SettingsPatch = Partial<
  Omit<
    PublicSettings,
    | 'hasApiKey'
    | 'providerReady'
    | 'hasKeys'
    | 'hasEncryption'
    | 'resolvedMeetingsFolder'
    | 'managedKeys'
    | 'envKeys'
    | 'loginItemOpenAtLogin'
  >
>

// Dust agent sIds. The BASE agent is a user-editable Settings picker (DustSetup) that DEFAULTS to
// Métis — an empty value always falls back here, and the picker offers a one-click reset. Spotlight
// Ref stays hard-locked (read-only in Settings); rotating IT without a release: hand-edit
// userData/managed-config.json with {"providerModelsSpotlightRef":{"dust":"NEW_ID"}}.
export const DUST_BASE_AGENT_ID = 'vJxYHvTRBT' // Dust agent "Métis" — default base agent (user-changeable in Settings → AI → Dust); also drafts meeting follow-ups (no separate follow-up agent)
export const DUST_SPOTLIGHT_REF_AGENT_ID = 'GOr913Zr5V' // Dust agent "Spotlight Ref"

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  providerPriority: 'api',
  providerModels: { dust: DUST_BASE_AGENT_ID },
  providerModelsThinking: {},
  providerModelsDeep: {},
  providerModelsSpotlightRef: DUST_SPOTLIGHT_REF_AGENT_ID ? { dust: DUST_SPOTLIGHT_REF_AGENT_ID } : {},
  thinkingMode: 'auto',
  customBaseUrl: '',
  dustWorkspaceId: '',
  dustBaseUrl: 'https://dust.tt',
  azureClientId: '',
  azureTenantId: '',
  azureAllowedDomain: '',
  graphifyEnabled: true,
  graphifyAutoRebuild: true,
  graphifyBackend: 'auto',
  outputLanguage: 'auto',
  summaryLanguage: 'auto',
  encryptTranscripts: true,
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
  suggestEverySec: 15,
  mode: 'general',
  profile: { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' },
  shortcuts: {}, // empty → built-in DEFAULT_SHORTCUTS apply (merged at hotkey registration)
  autoSuggest: true,
  screenAsk: true,
  showLiveTranscript: false,
  meetingsFolder: '',
  autoSaveTranscripts: false,
  autoStartOnMeeting: false, // meeting detection is opt-in (gates the popup-free watcher)
  launchAtLogin: false,
  onboardingDone: false,
  onboardingDoneAt: 0,
  recordingConsent: false,
  playListenChime: true,
  soundCues: true,
  uiSounds: true,
  quickActionsRainbow: true,
  instantSuggestions: true,
  overlayOpacity: 1,
  showFullTranscriptInReview: false,
  asrQuality: 'fast',
  asrEngine: 'parakeet',
  asrLastFallbackAt: null,
  requireConsentIndicator: true,
  redactSensitive: true,
  lastConsentReminderAt: 0,
  customMeetingApps: [], // deprecated — kept so persisted settings/managed-config still parse
  asrCorrections: [],
  asrEntityBias: true,
  cliConnected: {},
  dustTokenMintedAt: 0,
  cliNoticeAck: false,
  bidstackEndpointUrl: '',
  bidstackConnected: false,
  bidstackTools: [],
  notebookLmConnected: false,
  notebookLmTools: [],
  licenseServerUrl: '',
  licenseKey: '',
  licenseCompanyName: '',
  licenseSeatCap: 0,
  licenseExpiresAt: null,
  licenseValid: false,
  licenseLastValidatedAt: 0,
  licenseGateEnabled: false
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

/** Azure AD (Entra) sign-in. Restricts the app to the org's Microsoft domain and ties users to Dust. */
export interface AuthStatus {
  configured: boolean // true once AZURE_CLIENT_ID/AZURE_TENANT_ID/ASKTOTO_ALLOWED_DOMAIN are set
  signedIn: boolean
  email?: string
  name?: string
  domain?: string
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

/** Result of reading a saved meeting back for "Resume session" (decoded transcript + recap). */
export interface RecallReadResult {
  ok: boolean
  error?: string
  title?: string
  mode?: string
  startedAt?: number
  recap?: string
  lines?: TranscriptLine[]
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
  /** true when the failure was a BLOCKED keychain read (user hasn't allowed Métis to read the Dust CLI
   *  item) — as opposed to no session existing at all. Lets the UI prompt to allow access instead of
   *  wrongly re-running the install/login setup for a session that is actually present. */
  accessDenied?: boolean
}

/** Result of kicking off the Dust CLI setup (install + interactive login) when no session exists yet. */
export interface DustCliSetup {
  ok: boolean
  error?: string
}

/** Read-only probe of the local Dust CLI session — booleans only, never the token. Unlike DustCliImport
 *  this does NOT run `dust status` (no OAuth token rotation) and does NOT persist, so it is safe to call
 *  on Settings-open alongside a concurrent agent-list load. `ok` means a session is present in the
 *  keychain (an expired-but-present token still counts — it is refreshable, not a dead session). */
export interface DustSessionProbe {
  ok: boolean
  accessDenied?: boolean
}

/** Result of a CLI provider detect/test operation (claude-cli, codex-cli). */
export interface CliActionResult {
  ok: boolean
  version?: string
  error?: string
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

// ─── BidStack CRM (MCP push) ───────────────────────────────────────────────

export const McpCrmTestConnectionPayloadSchema = z.object({
  endpointUrl: z.string().min(1, 'Enter the Polo Pre-Sales MCP endpoint URL.'),
  apiKey: z.string().min(1, 'Enter the Polo Pre-Sales API key.')
})
export type McpCrmTestConnectionPayload = z.infer<typeof McpCrmTestConnectionPayloadSchema>

export const McpCrmSaveConnectionPayloadSchema = McpCrmTestConnectionPayloadSchema
export type McpCrmSaveConnectionPayload = z.infer<typeof McpCrmSaveConnectionPayloadSchema>

// Push args are always a small, flat object built by Review.tsx (title/date/summary strings) — bound the
// shape so a tampered/buggy caller can't hand the MCP tool call an unbounded or deeply-nested payload.
const McpCrmArgValueSchema = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
export const McpCrmPushPayloadSchema = z.object({
  toolName: z.string().min(1, 'Choose a Polo Pre-Sales tool to push to.'),
  args: z
    .record(z.string(), McpCrmArgValueSchema)
    .refine((a) => Object.keys(a).length <= 20, { message: 'Too many fields in the push payload.' })
})
export type McpCrmPushPayload = z.infer<typeof McpCrmPushPayloadSchema>

/** Result of testing or saving a BidStack MCP connection — mirrors the SDK's listTools() discovery. */
export interface McpCrmConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
}

/** Result of pushing to a BidStack MCP tool. */
export interface McpCrmPushResult {
  ok: boolean
  error?: string
  result?: unknown
}

// --- NotebookLM research (MCP, stdio) --- ipc.ts cannot import from main/mcp/*, so these structurally
// mirror notebooklm.ts's own exported shapes rather than reuse them.
export const NotebookLmAskPayloadSchema = z.object({
  question: z.string().min(1, 'Enter a question for NotebookLM first.').max(4_000),
  notebookId: z.string().max(200).optional()
})
export type NotebookLmAskPayload = z.infer<typeof NotebookLmAskPayloadSchema>

export interface NotebookLmDetectResult { ok: boolean; version?: string; error?: string }
export interface NotebookLmInstallResult { ok: boolean; error?: string; needsTerminal?: boolean }
export interface NotebookLmLoginResult { ok: boolean; error?: string }
export interface NotebookLmConnectResult { ok: boolean; error?: string; tools?: string[]; needsSignIn?: boolean }
export interface NotebookLmAskResult { ok: boolean; error?: string; text?: string; needsSignIn?: boolean }

// ─── Licensing (phone-home activation against a self-hosted license server; see main/license.ts) ──────
export const LicenseActivatePayloadSchema = z.object({
  serverUrl: z.string().min(1, 'Enter the license server URL.'),
  licenseKey: z.string().min(1, 'Enter a license key.')
})
export type LicenseActivatePayload = z.infer<typeof LicenseActivatePayloadSchema>

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
}

/** Startup-gate verdict for App.tsx's boot gate, derived by calling checkLicenseGrace() fresh on every
 *  call (see the license:gate handler in main/index.ts). Deliberately its own small shape rather than a
 *  field on LicenseStatusResult: license:status is gated behind requireAuth() (an SSO-signed-in check),
 *  but this channel must be reachable even when signed out — a revoked or unlicensed device has to learn
 *  that BEFORE burning an SSO round trip, not after (license outranks SSO in App.tsx's gate order). */
export interface LicenseGateVerdict {
  gateEnabled: boolean
  allowed: boolean
  reason?: 'not_activated' | 'expired_grace'
}

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Epoch ms when the screenshot was captured or cache-filled; used for real freshness UI. */
  capturedAt: z.number().int().nonnegative()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>
