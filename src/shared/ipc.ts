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
  saveNote: 'note:save',
  exportRecapJson: 'recap:export-json',
  pickFolder: 'folder:pick',
  openPath: 'path:open',
  recallList: 'recall:list',
  recallSearch: 'recall:search',
  recallOpen: 'recall:open',
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
  listeningState: 'listening:state',
  asrBundled: 'asr:bundled',
  cliDetect: 'cli:detect',
  cliSetup: 'cli:setup',
  cliTest: 'cli:test',
  cliInstall: 'cli:install',
  cliInstallProgress: 'cli:install:progress',
  cliLogin: 'cli:login',
  answerFeedback: 'answer:feedback',
  metricsRead: 'metrics:read'
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
export type ConversationMode = z.infer<typeof ConversationModeSchema>

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
  mode: ConversationModeSchema.default('general'),
  startedAt: z.number(),
  lines: z.array(TranscriptLineSchema),
  recap: z.string().default('')
})
export type SaveMeeting = z.infer<typeof SaveMeetingSchema>

export const SaveNoteSchema = z.object({
  title: z.string().default(''),
  mode: ConversationModeSchema.default('general'),
  question: z.string().default(''),
  answer: z.string().min(1)
})
export type SaveNote = z.infer<typeof SaveNoteSchema>

/** Structured export of a meeting recap (decisions + action-items-with-owners) for Jira/Asana/Notion etc.
 *  The full original markdown is always included so nothing is lost if a section heading was reworded. */
export const RecapExportSchema = z.object({
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
  // Encrypt saved transcripts/notes at rest (OS keychain). Off by default because it stops Dust agents,
  // recall search, and the knowledge graph from reading the markdown. See main/transcripts.ts.
  encryptTranscripts: z.boolean().default(false),
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
  temperature: z.number().min(0).max(1),
  contentProtection: z.boolean(),
  audioSource: z.enum(['mic', 'system', 'both']),
  suggestEverySec: z.number().min(5).max(120),
  mode: ConversationModeSchema.default('general'),
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
  showFullTranscriptInReview: z.boolean().default(false), // review = summary-first; transcript opt-in
  asrQuality: z.enum(['best', 'fast']).default('fast'), // fast = small model, ready fast (default); best = large, downloads
  asrEngine: z.enum(['whisper', 'parakeet']).default('whisper'), // whisper = ~99 langs (default); parakeet = European, fastest
  requireConsentIndicator: z.boolean().default(false),
  lastConsentReminderAt: z.number().default(0),
  customMeetingApps: z.array(z.string().min(1).max(80)).max(20).default([]),
  // CLI provider connection state. Keyed by ProviderId ('claude-cli', 'codex-cli').
  cliConnected: z.record(z.string(), z.boolean()).default({}),
  // Whether the user has acknowledged the CLI integration notice banner.
  cliNoticeAck: z.boolean().default(false)
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

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  providerModels: {},
  providerModelsThinking: {},
  providerModelsDeep: {},
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
  encryptTranscripts: false,
  systemPrompt:
    'You are AskToto, a fast, sharp desktop assistant living in an always-on overlay. ' +
    'Answer concisely and directly in clean markdown. Lead with the answer. Use code blocks ' +
    'with language tags, KaTeX for math ($...$), and tables when they help. No filler.',
  modePrompts: {},
  contextDocs: {},
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
  showFullTranscriptInReview: false,
  asrQuality: 'fast',
  asrEngine: 'whisper',
  requireConsentIndicator: false,
  lastConsentReminderAt: 0,
  customMeetingApps: [],
  cliConnected: {},
  cliNoticeAck: false
}

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  'ask',
  'hide',
  'reset',
  'toggle-listen',
  'capture',
  'factcheck',
  'scroll-up',
  'scroll-down',
  'settings'
]

export type HotkeyAction =
  | 'ask'
  | 'hide'
  | 'reset'
  | 'toggle-listen'
  | 'capture'
  | 'factcheck'
  | 'scroll-up'
  | 'scroll-down'
  | 'settings'
  | 'agenda'

export const DEFAULT_SHORTCUTS: Record<HotkeyAction, string> = {
  ask: 'CommandOrControl+Shift+Return',
  hide: 'CommandOrControl+\\',
  reset: 'CommandOrControl+Shift+R',
  'toggle-listen': 'CommandOrControl+Shift+L',
  capture: 'CommandOrControl+Shift+S',
  factcheck: 'CommandOrControl+Shift+F',
  'scroll-up': 'CommandOrControl+Alt+Up',
  'scroll-down': 'CommandOrControl+Alt+Down',
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

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>
