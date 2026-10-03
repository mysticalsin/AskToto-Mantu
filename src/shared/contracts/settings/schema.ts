import { z } from 'zod'
import { AsrCorrectionPairSchema } from '../brain/ipc'
import { McpConnectionSchema } from '../mcp/connection'
import { ProfileSchema } from '../app/profile'
import { ProviderIdSchema } from '../providers'
import { DEFAULT_PERMISSION_STATE, PermissionStateSchema } from './permission-state'
import {
  SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION,
  type ServerAuthoritativeSettingsKey
} from './server-authoritative'

const OPERATOR_LICENSE_MAX = 200

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
export const BUNDLED_LOCAL_MODEL_ID: (typeof LOCAL_MODEL_IDS)[number] = 'qwen3.5-0.8b'
const BundledLocalModelIdSchema = z.preprocess(
  // 'qwen3.5-2b' is a retired id from an earlier swap; it has no weights any more, so it maps to the
  // floor and boot re-upgrades from there if the machine allows.
  (value) => (value === undefined || value === 'qwen3.5-2b' ? BUNDLED_LOCAL_MODEL_ID : value),
  z
    .string()
    .refine((value) => (LOCAL_MODEL_IDS as readonly string[]).includes(value), 'Unknown bundled local model.')
)

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
  // Ask answer register (JuliusBrussee/caveman, locked like humanizer). Default full. Persists in the
  // existing settings store until "stop caveman" / "normal mode" / `/caveman off`. Live suggest, recap,
  // summary, and fact-check skip it. Not an Operator skill pack.
  askCaveman: z
    .enum(['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra'])
    .default('full'),
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
   *  consent decision, and it also requires Local AI to be enabled (itself off by default). */
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
  /** Bar rest look. Hide/Island ignore this. Default Circle is the Jakub thinking-orb. */
  overlayOrbStyle: z.enum(['bar', 'jakub', 'obsidian']).default('jakub'),
  /** Physical location is separate from the overlay chrome. Legacy profiles stay top-center. */
  overlayPlacement: z.enum(['top-center', 'right-edge']).default('top-center'),
  // Per-display right-edge position, normalized (0..1) to the work area, never a raw desktop coordinate. It
  // remains in the encrypted local profile and is never sent to Operator or a meeting (right-edge-geometry.ts).
  overlayRightEdgeYByDisplay: z.record(z.string(), z.number().finite().min(0).max(1)).default({}), // legacy sidecar Y: migrated once per display, then read-only
  overlayRightEdgeAnchorByDisplay: z.record(z.string(), z.number().finite().min(0).max(1)).default({}), // handle centre (default 0.15); a lock on either key locks it
  showFullTranscriptInReview: z.boolean().default(false), // review = summary-first; transcript opt-in
  asrQuality: z.enum(['best', 'fast']).default('best'), // Best is default; Fast is a Settings power option (docs/asr/QUALITY.md)
  // parakeet = conservative schema/legacy fallback. Fresh incomplete profiles with >8 GiB physical RAM
  // prefer Whisper in main/store.ts; <=8 GiB or unknown RAM stays Parakeet. This is only a preference,
  // not a runtime/language availability guarantee. apple = on-device Apple Speech
  // (SFSpeechRecognizer via the mac-helper sidecar), macOS 13+ only — see main/apple-speech.ts.
  // Completed sparse legacy profiles keep Parakeet; every explicit or managed engine remains authoritative.
  // NOTE: this zod default is effectively dead — store.ts layers DEFAULT_SETTINGS under the user file
  // before parsing, so the key is always present. Keep both declarations identical so neither lies.
  asrEngine: z.enum(['whisper', 'parakeet', 'apple']).default('parakeet'),
  /**
   * Managed enterprise-live profile (1.9.1). Trusted via managed-config defaults / org policy.
   * CLOUD_ONLY disables local STT fallback; summaryOnly omits fresh Full transcript sections.
   */
  enterpriseLive: z
    .object({
      managed: z.boolean().default(false),
      inferenceMode: z.enum(['legacy', 'cloud-only']).default('legacy'),
      summaryOnly: z.boolean().default(false)
    })
    .default({ managed: false, inferenceMode: 'legacy', summaryOnly: false }),
  /**
   * Cloud speech provider for managed enterprise-live Listen.
   * Under CLOUD_ONLY, Settings + Listen treat unconfigured as Cloudflare Nova-3
   * (see shared/cloud-stt-provider.ts). Soniox is selectable when approved.
   * Legacy profiles keep on-device asrEngine; this field stays unconfigured.
   */
  cloudSttProvider: z.enum(['cloudflare-nova3', 'soniox', 'unconfigured']).default('unconfigured'),
  /**
   * Cloudflare AI Gateway id for Nova-3 live WS (Operator verifyDefaultGatewayPrivacy uses `default`).
   * Blank → resolveCloudSttGatewayId falls through env then `default`. Not a secret.
   */
  cfAiGatewayId: z.string().max(128).default(''),
  /**
   * Cloudflare account id (32 hex) when cloudflareBaseUrl is a Worker proxy without /accounts/<id>/.
   * Same honesty as Operator / Portal Keys paste (token + accountId). Not a secret.
   */
  cloudflareAccountId: z
    .string()
    .max(64)
    .default('')
    .refine(
      (v) => v === '' || /^[a-f0-9]{32}$/i.test(v.trim()),
      'Cloudflare account id must be 32 hex characters'
    ),
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
  // Last CLI the user connected or selected. Ask uses this as the primary when both CLIs work.
  // Not a secret. Never a vault row.
  lastClickedCli: z.enum(['claude-cli', 'codex-cli']).nullable().default(null),
  // Epoch ms of the last Dust CLI token import. Gates the startup eager refresh: while the ~1h OAuth
  // token is still fresh, launch does NOT touch the Dust CLI keychain item (each `security` read can
  // cost a macOS keychain password prompt on identity-unstable dev builds). 0 = never imported.
  dustTokenMintedAt: z.number().default(0),
  // Whether the user has acknowledged the CLI integration notice banner.
  cliNoticeAck: z.boolean().default(false),
  // Named MCP connections — CRM (BidStack) and task managers (Plane, ClickUp). One connection per kind
  // see McpConnectionKindSchema). One connection per kind (id === kind in v1). API keys themselves are
  // NOT stored here; they go through the same encrypted-file mechanism as provider keys, via
  // main/mcp/mcpSecrets.ts (kept out of the ProviderId union — these are push credentials, not LLM
  // providers). Never hardcode a default endpoint: BidStack's own Settings UI warns its local fallback
  // is dev-only, so the user must supply wherever they actually deploy/run their backend. Replaces the
  // old single-connection bidstackEndpointUrl/bidstackConnected/bidstackTools fields — see
  // migrateLegacyBidstackConnection in main/store.ts for how an existing user's data carries forward.
  mcpConnections: z.array(McpConnectionSchema).max(10).default([]).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  // ClickUp's Dynamic Client Registration (RFC 7591) client_id — public, not a secret, so it lives in
  // plain settings rather than mcpSecrets.ts. ClickUp binds each client_id to the exact redirect_uri
  // from that registration (no RFC 8252 port flexibility). Each Connect run in clickupOAuth.ts
  // registers a fresh client with this run's loopback URI and stores the new id here for token refresh;
  // a leftover portless/mismatched client_id is never reused for /authorize.
  clickupClientId: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  // Plane DCR client_id — public, like clickupClientId. The matching client_secret is encrypted in
  // mcpSecrets (`key-mcp-plane-client.bin`) because Plane's token endpoint requires client_secret_post.
  planeClientId: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
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
  // Speaker Intelligence (docs/SPEAKER-INTELLIGENCE-PLAN.md): "who's speaking" labels on THEM transcript lines
  // from on-device voice embeddings (sherpa-onnx, same addon as Parakeet).
  // `enabled` (default on) gives session-local labels: "Speaker N" clusters held in memory for one meeting. The
  // embedding model ships in every build and speaker-id.ts degrades to unlabeled lines when the extractor is
  // unavailable, so this default costs nothing where it cannot work.
  // `saveVoiceprints` (default off) is the explicit opt-in for anything that outlives a meeting: only while it is
  // on does speaker-id.ts add to userData/voiceprints.json (named profiles and the operator's own echo-defense
  // voiceprint). A stored speakerId written before this field existed parses with it off.
  speakerId: z
    .object({
      enabled: z.boolean().default(true),
      saveVoiceprints: z.boolean().default(false)
    })
    .default({ enabled: true, saveVoiceprints: false }),
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
  licenseKey: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseCompanyName: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseSeatCap: z.number().default(0).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseExpiresAt: z.number().nullable().default(null).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseValid: z.boolean().default(false).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseLastValidatedAt: z.number().default(0).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  licenseGateEnabled: z.boolean().default(false),
  // ── Act 5 (License/trial), MQA-281/282 ──────────────────────────────────────────────────────────
  /** Compact Ed25519-signed offline lease from the most recent successful /activate or /heartbeat that
   *  carried one (license-server's lib/lease.mjs wire format). '' = no lease (an unconfigured server,
   *  or a build that never activated at all) — checkLicenseGrace() (main/license.ts) then falls back to
   *  the wall-clock grace exactly as it did before this existed. Server-authoritative: stripped from
   *  any renderer-supplied settings patch, same as the other license fields above (settings:set's strip
   *  list, main/index.ts) — a hostile renderer must not be able to self-issue a lease. */
  licenseLease: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Epoch ms of the first QUALIFYING real use — a real suggest/summary/recap result actually delivered
   *  (main/license.ts's noteQualifyingUse, called from main/index.ts's ask pipeline). null = no
   *  qualifying use yet. Deliberately NOT set on install/first launch, and never reachable from Act 2's
   *  onboarding demo (structurally IPC-free — see onboarding-demo.ts). Main-authoritative: stripped
   *  from renderer patches for the same reason as licenseLease — a plain settings patch must not be
   *  able to grant a fresh 14-day trial. */
  trialStartedAt: z.number().nullable().default(null).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  // Operator control plane (Cloudflare Worker `metis-operator`). Empty URL = off. Not the Fly
  // license-server and not cloudflare-proxy. Ingest secret is the HMAC shared with the Worker;
  // it is a Wrangler secret on the server and a Settings power field here. Never commit it.
  operatorUrl: z
    .string()
    .refine((v) => v === '' || /^https:\/\//i.test(v), 'Operator URL must be an https:// URL')
    .default(''),
  operatorIngestSecret: z.string().default(''),
  sendAskText: z.boolean().default(false),
  // Operator-issued seat license (METIS-OP-1, PLAN.md P2.2b). The pasted token is stored verbatim — it
  // rides in the same settings.json blob as operatorIngestSecret above, so it gets the same at-rest
  // encryption (store.ts's ATKENC2/safeStorage backend) without a bespoke secret store. Only the jti
  // (licenseId) and last4 are telemetry. The token authenticates HTTPS requests to the Operator in a
  // dedicated credential header; it must never appear in telemetry, renderer settings, or logs.
  // Empty token = no license activated.
  operatorLicenseToken: z.string().max(OPERATOR_LICENSE_MAX).default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Parsed from operatorLicenseToken at activation time (format-only; the Worker verifies the
   *  signature). 16 lowercase hex chars, or '' when no license is activated. */
  operatorLicenseJti: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  operatorLicenseLast4: z.string().default('').describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Epoch ms, read straight out of the token's own (unsigned) exp claim — informational display only;
   *  the Worker is the actual authority on whether the license is still good. */
  operatorLicenseExpiresAt: z.number().nullable().default(null).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  // ── Everything below is Worker-authoritative (PLAN.md P2.2b #2): written ONLY by operator-ingest.ts
  // after a successful heartbeat, never by a renderer settings patch (stripped in settingsSet, same
  // class as licenseValid/licenseLease above) — a compromised renderer must not be able to self-grant
  // Operator entitlements. Persisted (not just in-memory) so a cold start before the first heartbeat can
  // still honour the last known grant for the grace window (operator-entitlements.ts).
  operatorTier: z.enum(['metis', 'metis-light']).nullable().default(null).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  operatorEntitlements: z
    .object({
      ask: z.boolean(),
      listen: z.boolean(),
      recap: z.boolean(),
      crm_push: z.boolean(),
      operator_keys: z.boolean(),
      intelligence: z.boolean(),
      integrations: z.boolean()
    })
    .nullable()
    .default(null)
    .describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Monotonic; 0 = no Operator integrations delivered yet. Drives operator-integrations.ts's refetch. */
  operatorIntegrationsVersion: z.number().default(0).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Epoch ms of the last successful heartbeat that carried entitlements. 0 = never — grace window
   *  (operator-entitlements.ts) treats this the same as "no snapshot at all". */
  operatorEntitlementsAt: z.number().default(0).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION),
  /** Main-owned Screen Recording history (M2-0429); see shared/screen-permission.ts. */
  permissionState: PermissionStateSchema.default(DEFAULT_PERMISSION_STATE).describe(SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION)
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
  /** Non-secret transport readiness. Raw Operator credentials never reach the renderer. */
  operatorConfigured: z.boolean().optional(),
  operatorLegacyCredentialConfigured: z.boolean().optional(),
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
  allowedProviders: z.array(z.string()).nullable().default(null),
  modelPolicyCapabilities: z.record(z.string(), z.object({ provider: z.string(), model: z.string() })).default({}),
  /** Non-secret managed defaults after main applies its deployment policy. Lets renderer controls compare
   *  against effective defaults without embedding workspace-specific identifiers in shared code. */
  managedConfigDefaults: z
    .object({
      providerModels: z.record(z.string(), z.string()).default({}),
      providerModelsSpotlightRef: z.record(z.string(), z.string()).default({})
    })
    .default({ providerModels: {}, providerModelsSpotlightRef: {} }),
  localSpeechPack: z.enum(['required', 'offered', 'blocked']).default('offered')
})
export type PublicSettings = z.infer<typeof PublicSettingsSchema>

/** Patch type exposed to the renderer. Derived/computed fields are omitted because the main process ignores them. */
export type SettingsPatch = Partial<
  Omit<
    PublicSettings,
    | 'hasApiKey' | 'providerReady' | 'localReady' | 'localSuggestReady' | 'localSummaryReady'
    | 'localVisionReady' | 'localRuntimeRunning' | 'localRuntimeState' | 'hasKeys'
    | 'hasEncryption' | 'resolvedMeetingsFolder' | 'managedKeys' | 'envKeys'
    | 'loginItemOpenAtLogin' | 'lastFailover' | 'managedConfigDefaults' | 'localSpeechPack'
    | ServerAuthoritativeSettingsKey
  >
>

// Dust agent sIds. The BASE agent is a user-editable Settings picker (DustSetup) that DEFAULTS to
// Métis — an empty value always falls back here, and the picker offers a one-click reset. Spotlight
