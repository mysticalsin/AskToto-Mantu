import { z } from 'zod'
import { LocalVisionEvidenceSchema } from '../local/vision-evidence'
import { ProviderIdSchema } from '../providers'

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
  outputTokens: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cacheUncached: z.number().optional(),
  cacheStatus: z.enum(['hit', 'write', 'n/a', 'not-reported']).optional(),
  cacheTtl: z.enum(['1h', '5m', '30m']).optional()
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
// 'clickup' is a first-class connection: OAuth 2.1 + PKCE (clickupOAuth.ts, PR 73 loopback DCR) and
// post-meeting create-task (docs/design/CLICKUP-PUSH.md). The access token is a bearer key on
