export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'nvidia'
  | 'deepseek'
  | 'qwen'
  | 'minimax'
  | 'kimi'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'grok'
  | 'dust'
  | 'claude-cli'
  | 'codex-cli'
  | 'gemini'
  | 'cloudflare'
  | 'local'
  | 'custom'
export type ProviderKind = 'anthropic' | 'openai' | 'dust' | 'cli' | 'local' // wire protocol

export interface ProviderDef {
  id: ProviderId
  label: string
  /** One-line, plain-language reason to pick this provider. Shown under its tile in Settings'
   *  "Experience: more models" section — honest and specific, never marketing language. */
  blurb: string
  kind: ProviderKind
  /** Drives default ordering/visibility in Settings and onboarding — never changes routing.
   *  'cli': shown first, no key needed (Settings' CLI cards row).
   *  'featured': the handful of API providers surfaced as top-level cards (Settings + onboarding).
   *  'more': everything else, tucked into the "Experience: more models" expandable section. */
  tier: 'cli' | 'featured' | 'more'
  baseUrl: string // openai-kind base; '' = sdk default (anthropic) or user-set (custom)
  models: string[] // suggestions for the datalist
  defaultModel: string
  fastModel: string // BASE tier — fast/cheap (e.g. Haiku); used for simple questions
  /** THINKING tier — stronger/reasoning model (e.g. Sonnet) for heavier, analytical questions.
   *  Optional: falls back to defaultModel when unset. See resolveModelTier(). */
  thinkModel?: string
  /** DEEP tier — the deepest model (e.g. Opus) for coding / deep reasoning / the hardest questions.
   *  Optional: falls back to thinkModel when unset, so providers without a distinct deep model still work. */
  deepModel?: string
  keyHint: string
  /** RegExp source matched against a pasted key for auto-detect; '' = not auto-detectable. */
  keyPattern: string
  vision: boolean
  /** Where the user gets a key (shown in the UI). '' = none. */
  keyUrl: string
  /** Offers a usable free tier (no per-token charge for at least some models). Used ONLY when a paid
   *  primary runs out of credit/tokens: routing then floats these ahead of other paid providers as the
   *  "prefer a free backup" policy (index.ts pickFailover, gated on resilience.preferFreeOnExhaustion). It
   *  never changes the normal first-choice order. Honest, not aspirational: set only where a real free tier
   *  exists on the run-date. `local` is always free and is handled separately as the on-device floor. */
  freeTier?: boolean
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude · Anthropic',
    blurb: 'The models Métis is built and tuned for by default.',
    kind: 'anthropic',
    tier: 'featured',
    baseUrl: '',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-opus-4-8',
    fastModel: 'claude-haiku-4-5-20251001', // base tier: Haiku — basic/quick questions
    thinkModel: 'claude-sonnet-4-6', // think tier: Sonnet — heavier, analytical questions
    deepModel: 'claude-opus-4-8', // deep tier: Opus — coding / deep reasoning / the hardest asks
    keyHint: 'sk-ant-…',
    keyPattern: '^sk-ant-',
    vision: true,
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    id: 'openai',
    label: 'GPT · OpenAI',
    blurb: 'Strong general models with wide tool support.',
    kind: 'openai',
    tier: 'featured',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o',
    fastModel: 'gpt-4o-mini',
    keyHint: 'sk-…',
    keyPattern: '', // generic sk- is ambiguous (shared by deepseek/qwen/kimi/mistral)
    vision: true,
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  nvidia: {
    id: 'nvidia',
    freeTier: true,
    label: 'NVIDIA · NIM',
    blurb: 'Open-weight models hosted on NVIDIA infrastructure, including DeepSeek R1.',
    kind: 'openai',
    tier: 'featured',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'meta/llama-3.3-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen2.5-coder-32b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct'
    ],
    defaultModel: 'meta/llama-3.3-70b-instruct',
    fastModel: 'meta/llama-3.1-8b-instruct',
    thinkModel: 'deepseek-ai/deepseek-r1', // thinking tier: reasoning model on NIM
    keyHint: 'nvapi-…',
    keyPattern: '^nvapi-',
    vision: false,
    keyUrl: 'https://build.nvidia.com/'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    blurb: 'Very cheap million-token models; V4 Flash is the low-cost default for everyday use.',
    kind: 'openai',
    tier: 'featured',
    baseUrl: 'https://api.deepseek.com/v1',
    // V4 generation (verified against api-docs.deepseek.com on 2026-08-08). The previous ids
    // 'deepseek-chat' / 'deepseek-reasoner' were announced for discontinuation on 2026-07-24 — a date
    // now PAST — so pinning them shipped a provider that can stop answering with no code change on our
    // side. They are kept only as migration SOURCES (see RETIRED_MODEL_IDS), never as suggestions.
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-v4-flash',
    fastModel: 'deepseek-v4-flash', // base tier: 1M ctx, ~$0.14/1M in — the cheap everyday model
    thinkModel: 'deepseek-v4-pro', // think tier: the reasoning-oriented V4 variant
    deepModel: 'deepseek-v4-pro',
    keyHint: 'sk-…',
    keyPattern: '', // sk- ambiguous
    vision: false,
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen · Alibaba',
    blurb: "Alibaba's models, strong at Chinese-language and vision tasks.",
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max'],
    defaultModel: 'qwen-plus',
    fastModel: 'qwen-turbo',
    keyHint: 'sk-…',
    keyPattern: '', // sk- ambiguous
    vision: false, // default/fast models are text-only (qwen-vl-max is vision but not the resolved model)
    keyUrl: 'https://bailian.console.alibabacloud.com/'
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    blurb: 'A China-market model family with a generous free tier.',
    kind: 'openai',
    tier: 'featured',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    defaultModel: 'MiniMax-Text-01',
    fastModel: 'abab6.5s-chat',
    keyHint: 'eyJ… (JWT)',
    keyPattern: '^eyJ', // MiniMax keys are JWTs
    vision: false,
    keyUrl: 'https://www.minimax.io/platform/user-center/basic-information'
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi · Code (K2.7)',
    blurb: 'A coding-focused reasoning model built for agentic, multi-step work.',
    kind: 'openai',
    tier: 'featured',
    // Kimi Code keys (sk-kimi-…) authenticate against the coding endpoint, NOT Moonshot's api.moonshot.ai
    // (that one 401s for these keys). The single model is reasoning-only: it streams reasoning_content
    // first, then the answer in content — llm.ts pings the watchdog on reasoning so the stream isn't aborted.
    baseUrl: 'https://api.kimi.com/coding/v1',
    models: ['kimi-for-coding'],
    defaultModel: 'kimi-for-coding',
    fastModel: 'kimi-for-coding',
    thinkModel: 'kimi-for-coding',
    keyHint: 'sk-kimi-…',
    keyPattern: '^sk-kimi-',
    vision: true, // kimi-for-coding supports image input
    keyUrl: 'https://www.kimi.com/code/docs/en/'
  },
  openrouter: {
    id: 'openrouter',
    freeTier: true,
    label: 'OpenRouter',
    blurb: 'One key routes to dozens of models from every major lab.',
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-sonnet-5',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-v4-flash',
      'google/gemini-2.0-flash-001'
    ],
    defaultModel: 'openai/gpt-4o-mini',
    fastModel: 'openai/gpt-4o-mini',
    keyHint: 'sk-or-…',
    keyPattern: '^sk-or-',
    vision: true,
    keyUrl: 'https://openrouter.ai/keys'
  },
  groq: {
    id: 'groq',
    freeTier: true,
    label: 'Groq',
    blurb: 'The fastest responses, great for live meetings.',
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct'],
    defaultModel: 'llama-3.3-70b-versatile',
    fastModel: 'llama-3.1-8b-instant',
    keyHint: 'gsk_…',
    keyPattern: '^gsk_',
    vision: false,
    keyUrl: 'https://console.groq.com/keys'
  },
  mistral: {
    id: 'mistral',
    freeTier: true,
    label: 'Mistral',
    blurb: 'European-hosted models, useful where data residency matters.',
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'pixtral-large-latest'],
    defaultModel: 'mistral-large-latest',
    fastModel: 'mistral-small-latest',
    keyHint: 'API key',
    keyPattern: '', // not reliably prefixed
    vision: false, // default/fast models are text-only (pixtral is vision but not the resolved model)
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  grok: {
    id: 'grok',
    label: 'Grok · xAI',
    blurb: "xAI's models, with real-time knowledge from X.",
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    defaultModel: 'grok-4',
    fastModel: 'grok-3-mini',
    thinkModel: 'grok-4',
    keyHint: 'xai-…',
    keyPattern: '^xai-',
    vision: true,
    keyUrl: 'https://console.x.ai/'
  },
  dust: {
    id: 'dust',
    label: 'Dust · your agents',
    blurb: 'Your own Second Brain agents — the deepest integration with your meeting history.',
    kind: 'dust',
    tier: 'more',
    baseUrl: 'https://dust.tt', // EU workspaces: https://eu.dust.tt
    models: [], // "model" here = a Dust agent sId; it's workspace-specific, no suggestions
    defaultModel: '',
    fastModel: '',
    keyHint: 'sk-… (Dust API key)',
    keyPattern: '', // Dust keys are sk- (ambiguous) — never auto-pick Dust
    vision: false, // routed via a Dust agent; screenshots not wired in v1
    keyUrl: 'https://docs.dust.tt/reference/developer-platform-overview'
  },
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude Code · CLI',
    blurb: 'Routes through your existing Claude Code subscription, no separate API key.',
    kind: 'cli',
    tier: 'cli',
    baseUrl: '',
    models: ['sonnet', 'opus', 'haiku'],
    defaultModel: 'sonnet',
    fastModel: 'haiku', // base: Haiku
    thinkModel: 'sonnet', // think: Sonnet — heavier questions
    deepModel: 'opus', // deep: Opus — coding / deep reasoning
    keyHint: '',
    keyPattern: '',
    vision: false,
    keyUrl: ''
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex · OpenAI CLI',
    blurb: 'Routes through your existing ChatGPT or OpenAI Codex CLI subscription.',
    kind: 'cli',
    tier: 'cli',
    baseUrl: '',
    models: [],
    defaultModel: '',
    fastModel: '',
    thinkModel: '',
    keyHint: '',
    keyPattern: '',
    vision: false,
    keyUrl: ''
  },
  gemini: {
    id: 'gemini',
    freeTier: true,
    label: 'Gemini · Google',
    blurb: "Google's models with a very large context window.",
    kind: 'openai',
    tier: 'more',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash',
    thinkModel: 'gemini-2.5-pro',
    keyHint: 'AIza…',
    keyPattern: '^AIza',
    vision: true,
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  cloudflare: {
    id: 'cloudflare',
    label: 'Cloudflare · AI Gateway',
    blurb: "Your company's own Cloudflare Worker — one endpoint reaching Workers AI, OpenAI, Anthropic and Google.",
    kind: 'openai',
    // 'featured', and the default provider (ipc.ts DEFAULT_SETTINGS). It was 'more' while it was an
    // expert option; it is now the route this product is configured around, so burying it behind the
    // collapsed "Experience: more models" drawer would hide the one card most installs need to touch.
    tier: 'featured',
    // Deliberately EMPTY. Cloudflare's REST endpoint is account-scoped
    // (POST /client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions) and authenticates with a Cloudflare
    // ACCOUNT token — a secret that must never ship inside the app, because `npx asar extract` recovers
    // any embedded string (scripts/check-cahe-package.mjs exists to refuse exactly that build). So the
    // account token lives as a Wrangler secret on an operator-deployed Worker, and this provider points at
    // that Worker's URL, held per install in settings.cloudflareBaseUrl. See requiresUserBaseUrl().
    baseUrl: '',
    // MQA-226: Workers AI ids are BARE `@cf/...` at this endpoint. The `workers-ai/` prefix these used to
    // carry is rejected outright — "No such model" — so every ask on the shipped default 404'd. The
    // `{provider}/{model}` form IS real, but only for the third-party labs behind Unified Billing
    // (`openai/gpt-5.5` answers "Insufficient balance; add money to your gateway or use BYOK"), so it
    // needs a funded gateway and cannot be a default. Every id below was run against a live account
    // before being listed; models the Workers Free plan refuses were dropped rather than guessed at.
    models: [
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/openai/gpt-oss-120b'
    ],
    defaultModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    fastModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    // MQA-229: the think tier must still FEEL instant. gpt-oss-120b is a reasoning model that spends its
    // first seconds on hidden reasoning — measured live through the deployed Worker: first VISIBLE token
    // at 3.6-14.2s, against a 2-3s answer budget — and routing.ts sends every "why/how/explain/compare"
    // question to this tier, so most real asks sat behind that dead air. llama-3.3-70b-fp8-fast reaches
    // its first visible token in ~0.4s (same prompt, same Worker) and is the strongest non-reasoning
    // model this plan serves. gpt-oss-120b keeps the DEEP tier below: coding/math/explicit "think deeply"
    // asks are rare and genuinely want the reasoning pass.
    thinkModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    // gpt-oss-120b returns a real `reasoning` field alongside its answer and runs on the free plan.
    // Verified live; the previous `anthropic/claude-sonnet-4-5` was wrong twice over — not a valid id at
    // this endpoint, and a third-party route that needs Unified Billing credit.
    deepModel: '@cf/openai/gpt-oss-120b',
    keyHint: 'METIS_PROXY_KEY from your operator',
    keyPattern: '', // operator-chosen shared secret — no fixed prefix to auto-detect
    // MQA-227: FALSE, and not because of the model. Llama 4 Scout really is multimodal, but Cloudflare's
    // OpenAI-compatible route has no way to carry the image: every `image_url` shape is rejected with
    // "Property image_url only supports base64 encoded image data" (code 6004) — both a
    // `data:image/jpeg;base64,...` URL and bare base64, on Scout AND on the dedicated
    // llama-3.2-11b-vision-instruct. It is a transport limit, not a model one. Claiming vision here would
    // capture the user's screen and upload it for a request that always errors; false sends screen-asks
    // to the on-device model, which works. Revisit only against a live endpoint, never against the mock.
    vision: false,
    keyUrl: '' // issued by whoever deployed the Worker, not by a signup page
  },
  local: {
    id: 'local',
    label: 'Métis Local · on-device',
    blurb:
      'Runs a small Qwen model on this machine — instant, free, private; handles live suggestions, summaries and screenshots.',
    kind: 'local',
    tier: 'featured',
    baseUrl: '', // sidecar's baseURL is a per-session ephemeral loopback port — resolved at request time
    // by main/llm/local.ts (localRuntime.baseURL()), never a fixed constant here.
    models: ['qwen3.5-0.8b'],
    defaultModel: 'qwen3.5-0.8b',
    fastModel: 'qwen3.5-0.8b',
    keyHint: '', // keyless — the sidecar's per-session api key is generated and injected in-process
    keyPattern: '',
    vision: true, // mmproj ships with every manifest model (main/llm/local-models.ts)
    keyUrl: ''
  },
  custom: {
    id: 'custom',
    label: 'Custom · OpenAI-compatible',
    blurb: 'Point at any OpenAI-compatible endpoint you already run.',
    kind: 'openai',
    tier: 'more',
    baseUrl: '',
    models: [],
    defaultModel: '',
    fastModel: '',
    keyHint: 'API key',
    keyPattern: '',
    vision: false,
    keyUrl: ''
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

/** Filter provider ids to an org data-residency allowlist. A null/undefined allowlist = unrestricted
 *  (ids returned unchanged); otherwise only ids present in the allowlist survive. Used by the onboarding
 *  picker + Settings grid so the UI offers only what the main process will actually let answer. */
export function filterAllowedProviders(
  ids: ProviderId[],
  allowed: string[] | null | undefined
): ProviderId[] {
  if (!allowed) return ids
  return ids.filter((id) => allowed.includes(id))
}

/** The endpoint fields a user/operator can set. Narrow on purpose so providerBaseUrl() stays callable
 *  from main, the brain pipeline and the key tester without any of them importing the whole Settings type. */
export interface ProviderEndpointSettings {
  customBaseUrl: string
  dustBaseUrl: string
  cloudflareBaseUrl: string
}

/**
 * True when the registry ships NO endpoint for this provider, so the app cannot send a request until the
 * user supplies one.
 *  - 'custom'     — any OpenAI-compatible endpoint the user already runs.
 *  - 'cloudflare' — the operator's own Cloudflare Worker. Cloudflare's REST endpoint authenticates with a
 *    Cloudflare ACCOUNT token, which a packaged Electron app is not a safe place for (`npx asar extract`
 *    recovers any embedded string; scripts/check-cahe-package.mjs already refuses a build that embeds a
 *    key). The account token therefore stays a Wrangler secret on the Worker, and each install holds only
 *    the per-user METIS_PROXY_KEY plus that Worker's URL.
 * Callers use this to fail LOUDLY on a missing endpoint instead of letting the OpenAI SDK fall through to
 * its own default base URL — which would send the user's key and prompt to api.openai.com.
 */
export function requiresUserBaseUrl(id: ProviderId): boolean {
  return id === 'custom' || id === 'cloudflare'
}

/**
 * The base URL a request to `id` must actually use: the user's endpoint where one is required, the user's
 * Dust region where set, otherwise the registry's built-in. Single source of truth for the four call sites
 * that each repeated this ternary (live ask, import recap, brain ingest, key test) — one of which had
 * already drifted out of sync with the others.
 */
export function providerBaseUrl(id: ProviderId, s: ProviderEndpointSettings): string {
  if (id === 'custom') return s.customBaseUrl
  if (id === 'cloudflare') return s.cloudflareBaseUrl
  if (id === 'dust') return s.dustBaseUrl
  return PROVIDERS[id].baseUrl
}

/**
 * Auto-detect the provider from a pasted key by its unambiguous prefix.
 * Returns null when the key shape is shared by several providers (bare `sk-…`) so the
 * caller leaves the user's current selection alone instead of guessing wrong.
 * Order matters: sk-ant- and sk-or- must beat a generic sk- guess (which we never make).
 */
export function detectProvider(key: string): ProviderId | null {
  const k = key.trim()
  if (!k) return null
  for (const id of PROVIDER_IDS) {
    const pat = PROVIDERS[id].keyPattern
    if (pat && new RegExp(pat).test(k)) return id
  }
  return null
}

/**
 * Pull Dust connection bits out of a pasted Dust URL so the user never has to find an id by hand.
 * Handles workspace (`/w/<id>`), region (dust.tt vs eu.dust.tt), and the agent id from a builder
 * link (`/builder/agents/<id>`), an agent link (`/assistant/<id>`), or a `?assistant=<id>` query.
 */
export function parseDustUrl(input: string): {
  workspaceId?: string
  baseUrl?: string
  agentId?: string
} {
  const out: { workspaceId?: string; baseUrl?: string; agentId?: string } = {}
  const raw = input.trim()
  if (!/dust\.tt/i.test(raw)) return out
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    if (/(^|\.)eu\.dust\.tt$/i.test(u.host)) out.baseUrl = 'https://eu.dust.tt'
    else if (/(^|\.)dust\.tt$/i.test(u.host)) out.baseUrl = 'https://dust.tt'
    const w = u.pathname.match(/\/w\/([^/]+)/)
    if (w) out.workspaceId = w[1]
    // Only unambiguous agent-shaped sources may set agentId. A bare /assistant/<id> path segment on
    // dust.tt is a CONVERSATION id, not an agent — treating it as one silently pointed the app's base
    // agent at garbage when a user pasted a chat link. Agent ids appear in the builder path
    // (/builder/agents|assistants/<sId>) or in the ?assistant=/assistantId=/agentId= query params.
    const a = u.pathname.match(/\/builder\/(?:agents|assistants)\/([^/?#]+)/)
    const qa =
      u.searchParams.get('assistant') ||
      u.searchParams.get('assistantId') ||
      u.searchParams.get('agentId')
    if (a && a[1] && a[1] !== 'new') out.agentId = a[1]
    else if (qa) out.agentId = qa
  } catch {
    /* not a URL — leave empty */
  }
  return out
}

export function resolveModel(
  id: ProviderId,
  providerModels: Partial<Record<string, string>>,
  fast = false
): string {
  const def = PROVIDERS[id]
  const chosen = providerModels[id]
  if (fast) return chosen || def.fastModel || def.defaultModel || ''
  return chosen || def.defaultModel || ''
}

export const MODEL_TIERS = ['base', 'think', 'deep'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * Resolve the model/agent for a routing tier.
 *  - base  → the user's chosen base model, else the provider's fast/cheap model (e.g. Haiku).
 *  - think → the user's chosen thinking model, else the provider's reasoning model (e.g. Sonnet),
 *            else falls back to the base/default so a provider without a distinct think model still works.
 *  - deep  → the user's chosen deep model, else the provider's deepest model (e.g. Opus), else the
 *            think model, so a provider without a distinct deep model degrades to its reasoning model.
 * For Dust the "model" is an agent sId: base/think/deep = providerModels.dust / thinkModels.dust / deepModels.dust.
 */
/**
 * Model ids a PROVIDER retired on its own schedule, mapped to the successor that serves the same slot.
 *
 * A persisted `providerModels` override outlives any registry edit (it is the user's explicit choice and
 * beats every default in resolveModelTier), so a provider sunsetting an id silently turns that user's
 * every request into a 400 that no amount of key-fixing resolves. Migrating on read is the only place
 * that can catch it — the value is already on disk by the time anything else runs.
 *
 * deepseek: 'deepseek-chat' / 'deepseek-reasoner' were announced for discontinuation on 2026-07-24.
 * DeepSeek documents both as aliases for V4-Flash's non-thinking / thinking modes, so V4-Flash is the
 * faithful successor for BOTH — deliberately not V4-Pro, which would silently triple a user's token
 * cost. Users who want the stronger model still get it through the think/deep tier defaults above.
 */
const RETIRED_MODEL_IDS: Partial<Record<ProviderId, Record<string, string>>> = {
  deepseek: {
    'deepseek-chat': 'deepseek-v4-flash',
    'deepseek-reasoner': 'deepseek-v4-flash'
  },
  openrouter: {
    'deepseek/deepseek-chat': 'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-reasoner': 'deepseek/deepseek-v4-flash'
  }
}

/**
 * OpenAI-compatible `reasoning_effort` for providers whose models spend hidden reasoning tokens BY
 * DEFAULT. Undefined for everyone else, so their request bodies stay byte-identical (openai.ts only
 * attaches the param when set, and drops it on the param-rejection retry).
 *
 * - kimi: kimi-for-coding always reasons and burns tokens; keep it light unless the user turned Métis
 *   thinking on. Tier-independent, preserving the original behavior this replaced.
 * - deepseek: V4 Flash/Pro default to THINKING mode. Left alone, a live suggestion — which has only a
 *   15s idle budget in askStart — would sit behind a reasoning pass and time out, so the base tier
 *   explicitly asks for low effort and only think/deep (or thinkingMode 'always') asks for high.
 */
export function reasoningEffortFor(
  id: ProviderId,
  tier: ModelTier,
  thinkingAlways: boolean
): 'low' | 'medium' | 'high' | undefined {
  if (id === 'kimi') return thinkingAlways ? 'high' : 'low'
  if (id === 'deepseek') return thinkingAlways || tier === 'think' || tier === 'deep' ? 'high' : 'low'
  return undefined
}

/** Successor id for a retired model, or the input unchanged. Unknown/custom ids always pass through —
 *  a user pointing at their own fine-tune must never be rewritten. */
export function migrateRetiredModelId(id: ProviderId, model: string): string {
  const trimmed = (model || '').trim()
  if (!trimmed) return model
  return RETIRED_MODEL_IDS[id]?.[trimmed] ?? model
}

/** Whole-map migration for one persisted providerModels-shaped record. Returns the SAME object when
 *  nothing changed, so callers can cheaply detect a no-op and skip a settings rewrite. */
export function migrateRetiredModelMap(
  models: Partial<Record<string, string>>
): Partial<Record<string, string>> {
  let changed = false
  const next: Partial<Record<string, string>> = {}
  for (const [providerId, model] of Object.entries(models)) {
    const migrated = typeof model === 'string' ? migrateRetiredModelId(providerId as ProviderId, model) : model
    if (migrated !== model) changed = true
    next[providerId] = migrated
  }
  return changed ? next : models
}

export function resolveModelTier(
  id: ProviderId,
  providerModels: Partial<Record<string, string>>,
  thinkModels: Partial<Record<string, string>>,
  tier: ModelTier,
  deepModels: Partial<Record<string, string>> = {}
): string {
  const def = PROVIDERS[id]
  const base = (providerModels[id] || '').trim()
  const think = (thinkModels[id] || '').trim() || def.thinkModel || ''
  if (tier === 'deep') {
    const deep = (deepModels[id] || '').trim()
    return deep || def.deepModel || think || base || def.defaultModel || ''
  }
  if (tier === 'think') {
    return think || base || def.defaultModel || ''
  }
  return base || def.fastModel || def.defaultModel || ''
}

/** Cost/safety guardrail (per Tony): the CLI provider only ever answers as Sonnet in the interactive
 *  ask flow, never Haiku, never Opus, regardless of routeTier's escalation (hard/coding questions,
 *  factcheck, or thinkingMode 'always' would otherwise reach Opus here). The direct Anthropic API
 *  key's base/think tiers are pinned to Haiku/Sonnet so a stray providerModels edit can't drift them.
 *  Deep tier is deliberately EXEMPT on both: that's the Graph extraction pipeline's reserved path to
 *  Opus (brain/ingest.ts and graphify.ts call resolveModelTier directly and never reach this function). */
export function applyInteractiveGuardrail(id: ProviderId, tier: ModelTier, model: string): string {
  if (id === 'claude-cli') return PROVIDERS['claude-cli'].thinkModel ?? 'sonnet'
  if (id === 'anthropic' && tier === 'base') return PROVIDERS.anthropic.fastModel
  if (id === 'anthropic' && tier === 'think') return PROVIDERS.anthropic.thinkModel ?? model
  return model
}

/** Is Dust configured with valid credentials right now — independent of whether it's the globally active
 *  `provider`. Used to decide whether a specific task (recap, follow-up email, Spotlight Ref) can cascade
 *  into Dust even while another provider (e.g. Kimi) handles everyday Q&A. */
export function isDustReady(
  hasKeys: Partial<Record<string, boolean>>,
  dustWorkspaceId: string,
  providerModels: Partial<Record<string, string>>
): boolean {
  return !!hasKeys['dust'] && !!dustWorkspaceId.trim() && !!providerModels['dust']
}

/** The saved Dust base-agent sId is not among the workspace's currently-loadable agents — e.g. after
 *  reconnecting to a different workspace, or the agent was deleted. This is the root cause of the raw
 *  "Failed to retrieve agent message" ask failure. Only conclusive once the list has actually loaded
 *  with at least one agent: `null` (not loaded yet) and `[]` (empty/restricted load) both return false
 *  so the UI never raises a false "your agent is gone" alarm before it truly knows. */
export function dustStoredAgentMissing(
  agentId: string,
  agents: readonly { sId: string }[] | null
): boolean {
  if (!agentId) return false
  if (agents === null || agents.length === 0) return false
  return !agents.some((a) => a.sId === agentId)
}

/**
 * Whether a Dust agent's underlying model can read images (screenshots). Dust messages are text-only, so
 * a screenshot is uploaded as a file the AGENT'S model then interprets — which only helps if that model
 * is multimodal. Unlike a provider's static `vision` flag this is per-agent, derived from the model Dust
 * reports (`modelProviderId` + `modelId` — the same signal the agent picker uses). It errs toward the
 * families whose *current* models are multimodal; a rare misclassification degrades gracefully (a
 * text-only agent gets a best-effort answer, or a vision agent is skipped for another vision provider).
 */
export function dustAgentVision(
  agent: { modelProviderId?: string; modelId?: string } | null | undefined
): boolean {
  if (!agent) return false
  const provider = (agent.modelProviderId || '').toLowerCase()
  const model = (agent.modelId || '').toLowerCase()
  // Explicit multimodal hints in the model id win regardless of provider (qwen-vl, pixtral, *-vision).
  if (/vision|pixtral|(^|[^a-z])vl([^a-z]|$)/.test(model)) return true
  switch (provider) {
    case 'anthropic':
      // Every Claude model Dust exposes (Claude 3 and newer) accepts images.
      return true
    case 'openai':
      // GPT-4o / GPT-4.1 / GPT-4-turbo / GPT-5 and the o-series reasoning models are multimodal; the
      // legacy gpt-4 text snapshots and gpt-3.5 are not.
      return /4o|4\.1|4-turbo|gpt-5|(^|[^a-z0-9])o[1-4]([^a-z0-9]|$)/.test(model)
    case 'google_ai_studio':
    case 'google':
    case 'googlevertex':
      // Gemini 1.5 and 2.x are multimodal.
      return /gemini/.test(model)
    default:
      return false
  }
}
