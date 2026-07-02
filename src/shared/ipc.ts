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
  'together',
  'fireworks',
  'mistral',
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
  graphifyStatus: 'graphify:status',
  graphifyRebuild: 'graphify:rebuild',
  graphifyRelated: 'graphify:related',
  graphifyOpenGraph: 'graphify:openGraph',
  brainStatus: 'brain:status',
  brainBackfill: 'brain:backfill',
  brainRead: 'brain:read',
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
  captureScreen: 'capture:screen',
  prewarmCapture: 'capture:prewarm',
  armAudio: 'audio:arm',
  saveTranscript: 'transcript:save',
  saveDraftTranscript: 'transcript:saveDraft',
  saveNote: 'note:save',
  exportRecapJson: 'recap:export-json',
  pickFolder: 'folder:pick',
  openPath: 'path:open',
  recallList: 'recall:list',
  recallSearch: 'recall:search',
  recallOpen: 'recall:open',
  recallRead: 'recall:read',
  recallDelete: 'recall:delete',
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
  meetingDetected: 'meeting:detected',
  permissionsGet: 'permissions:get',
  permissionsOpenSettings: 'permissions:openSettings',
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
  mcpCrmPush: 'mcpCrm:push'
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
export const ConversationModeSchema = z.enum(CONVERSATION_MODES)
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
  speaker: z.enum(['them', 'you']),
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

/** Payload for brain:setDealOutcome — the human marks a deal open/won/lost (see DealEntitySchema.outcome
 *  in shared/brain.ts; the LLM never sets it). dealSlug carries the deal's display name, the same
 *  convention brain:commitmentSettle's `deal` field uses — it's slugified in main before the store write. */
export const SetDealOutcomePayloadSchema = z.object({
  dealSlug: z.string().min(1),
  outcome: z.enum(['open', 'won', 'lost'])
})
export type SetDealOutcomePayload = z.infer<typeof SetDealOutcomePayloadSchema>

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
    .default('https://dust.tt'),
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
  // Multilingual. AskToto transcribes any spoken language and assists in the speaker's language live;
  // the final recap/summary + answers are written in this language ('auto' = match the conversation).
  outputLanguage: z.string().max(40).default('auto'),
  summaryLanguage: z.string().max(40).default('auto'), // recap/summary language ('auto' = follow outputLanguage)
  // Encrypt saved transcripts/notes at rest (OS keychain). On by default: recorded third-party speech
  // usually lands in a OneDrive-synced folder, so plaintext should be the opt-out, not the opt-in. Turn
  // this off only if something outside AskToto (a separate Dust/knowledge-graph pipeline pointed directly
  // at the meetings folder) needs to read the raw markdown — AskToto's own recall/search already decrypts
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
  contentProtection: z.boolean(),
  audioSource: z.enum(['mic', 'system', 'both']),
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
  autoStartOnMeeting: z.boolean().default(true), // auto-starts recording directly on meeting detection
  launchAtLogin: z.boolean().default(false),
  onboardingDone: z.boolean().default(false),
  recordingConsent: z.boolean().default(false),
  playListenChime: z.boolean().default(true),
  soundCues: z.boolean().default(true), // subtle answer-ready / error sound cues
  uiSounds: z.boolean().default(true), // master: soft click feedback on buttons (and gates all UI sounds)
  quickActionsRainbow: z.boolean().default(true), // spinning rainbow border on the quick-action chips
  // How see-through the overlay's glass background is. A multiplier on the default glass alpha values
  // (see --glass-fill etc. in styles.css) — 1 = today's default look, lower = more transparent (see more
  // of what's behind), higher = more opaque/solid (easier to read over a busy desktop). Values above 1
  // simply saturate at fully opaque for the most solid backgrounds; nothing errors or clips oddly.
  overlayOpacity: z.number().min(0.3).max(1.5).default(1),
  showFullTranscriptInReview: z.boolean().default(false), // review = summary-first; transcript opt-in
  asrQuality: z.enum(['best', 'fast']).default('fast'), // fast = small model, ready fast (default); best = large, downloads
  asrEngine: z.enum(['whisper', 'parakeet']).default('whisper'), // whisper = ~99 langs (default); parakeet = European, fastest
  // A mid-session Parakeet→Whisper fallback (repeated failures) used to surface as a live error banner
  // during the meeting — distracting for something that's really just a background engine swap. Tracked
  // here instead so it's checkable in Settings after the fact, never shown live. Persists until the user
  // dismisses it (Settings → Speech) — auto-clearing on the next meeting risks it vanishing unseen.
  asrLastFallbackAt: z.number().nullable().default(null),
  // On by default: this reminder is the ONLY consent mechanism AskToto has today — it shows the
  // operator, never the other participants, and is not a substitute for actually telling people
  // they're being recorded. See the Settings copy near this toggle for the honest scope of what it does.
  requireConsentIndicator: z.boolean().default(true),
  // Strip high-confidence secrets (cards, API keys, SSNs, private keys) from the captured transcript
  // before it's sent to a cloud model. On by default; never touches the typed question or the saved file.
  redactSensitive: z.boolean().default(true),
  lastConsentReminderAt: z.number().default(0),
  customMeetingApps: z.array(z.string().min(1).max(80)).max(20).default([]),
  // Words the ASR engine consistently mishears, always corrected in the live transcript (commitLine).
  asrCorrections: z.array(z.object({ from: z.string().min(1).max(80), to: z.string().max(80) })).max(100).default([]),
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
  bidstackTools: z.array(z.string()).default([])
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

// Hard-locked Dust agent sIds — Settings shows these read-only (see Settings.tsx DustSetup), not
// user-editable pickers. Rotating an ID without a release: hand-edit userData/managed-config.json with
// {"providerModels":{"dust":"NEW_ID"}} — the managed layer overrides these code defaults.
export const DUST_BASE_AGENT_ID = 'vJxYHvTRBT' // Dust agent "AskToto" — the app's own agent, always the base agent; also drafts meeting follow-ups (no separate follow-up agent)
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
    'You are AskToto, a fast, sharp desktop assistant living in an always-on overlay. ' +
    'Answer concisely and directly in clean markdown. Lead with the answer. Use code blocks ' +
    'with language tags, KaTeX for math ($...$), and tables when they help. No filler.',
  modePrompts: {},
  contextDocs: {},
  customModes: [],
  meetingNotifications: false,
  temperature: 0.4,
  contentProtection: true,
  audioSource: 'both',
  suggestEverySec: 15,
  mode: 'general',
  profile: { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' },
  shortcuts: {}, // empty → built-in DEFAULT_SHORTCUTS apply (merged at hotkey registration)
  autoSuggest: true,
  screenAsk: true,
  showLiveTranscript: false,
  meetingsFolder: '',
  autoSaveTranscripts: false,
  autoStartOnMeeting: true,
  launchAtLogin: false,
  onboardingDone: false,
  recordingConsent: false,
  playListenChime: true,
  soundCues: true,
  uiSounds: true,
  quickActionsRainbow: true,
  overlayOpacity: 1,
  showFullTranscriptInReview: false,
  asrQuality: 'fast',
  asrEngine: 'whisper',
  asrLastFallbackAt: null,
  requireConsentIndicator: true,
  redactSensitive: true,
  lastConsentReminderAt: 0,
  customMeetingApps: [],
  asrCorrections: [],
  cliConnected: {},
  dustTokenMintedAt: 0,
  cliNoticeAck: false,
  bidstackEndpointUrl: '',
  bidstackConnected: false,
  bidstackTools: []
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
  'scroll-up': 'CommandOrControl+Alt+Up',
  'scroll-down': 'CommandOrControl+Alt+Down',
  'scroll-left': 'CommandOrControl+Alt+Left',
  'scroll-right': 'CommandOrControl+Alt+Right',
  settings: '', // no global shortcut by default; opened from bar or tray
  // Agenda is reached from the tray only (the Cluely bar redesign dropped its toolbar button). Kept out
  // of HOTKEY_ACTIONS so it gets no global key / no Settings row, but typed so the tray can trigger it.
  agenda: ''
}

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'
export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
  accessibility: PermissionStatus
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
export type SetApiKeyPayload = z.infer<typeof SetApiKeyPayloadSchema>

export const ClearApiKeyPayloadSchema = z.object({
  provider: ProviderIdSchema
})
export type ClearApiKeyPayload = z.infer<typeof ClearApiKeyPayloadSchema>

export const TestApiKeyPayloadSchema = z.object({
  provider: ProviderIdSchema,
  key: z.string()
})
export type TestApiKeyPayload = z.infer<typeof TestApiKeyPayloadSchema>

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
}

/** Result of kicking off the Dust CLI setup (install + interactive login) when no session exists yet. */
export interface DustCliSetup {
  ok: boolean
  error?: string
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

// ─── BidStack CRM (MCP push) ───────────────────────────────────────────────

export const McpCrmTestConnectionPayloadSchema = z.object({
  endpointUrl: z.string().min(1, 'Enter the BidStack MCP endpoint URL.'),
  apiKey: z.string().min(1, 'Enter the BidStack API key.')
})
export type McpCrmTestConnectionPayload = z.infer<typeof McpCrmTestConnectionPayloadSchema>

export const McpCrmSaveConnectionPayloadSchema = McpCrmTestConnectionPayloadSchema
export type McpCrmSaveConnectionPayload = z.infer<typeof McpCrmSaveConnectionPayloadSchema>

// Push args are always a small, flat object built by Review.tsx (title/date/summary strings) — bound the
// shape so a tampered/buggy caller can't hand the MCP tool call an unbounded or deeply-nested payload.
const McpCrmArgValueSchema = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
export const McpCrmPushPayloadSchema = z.object({
  toolName: z.string().min(1, 'Choose a BidStack tool to push to.'),
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

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Epoch ms when the screenshot was captured or cache-filled; used for real freshness UI. */
  capturedAt: z.number().int().nonnegative()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>
