export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'grok'
  | 'nvidia'
  | 'deepseek'
  | 'qwen'
  | 'minimax'
  | 'kimi'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'dust'
  | 'claude-cli'
  | 'codex-cli'
  | 'gemini'
  | 'custom'
export type ProviderKind = 'anthropic' | 'openai' | 'dust' | 'cli' // wire protocol

export interface ProviderDef {
  id: ProviderId
  label: string
  /** One-line, plain-language reason to pick this provider. Shown under its tile in Settings'
   *  "Experience: more models" section — honest and specific, never marketing language. */
  blurb: string
  kind: ProviderKind
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
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude · Anthropic',
    blurb: 'The models AskToto is built and tuned for by default.',
    kind: 'anthropic',
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
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o',
    fastModel: 'gpt-4o-mini',
    keyHint: 'sk-…',
    keyPattern: '', // generic sk- is ambiguous (shared by deepseek/qwen/kimi/mistral)
    vision: true,
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  grok: {
    id: 'grok',
    label: 'Grok · xAI',
    blurb: "xAI's models with strong reasoning and live-search grounding.",
    kind: 'openai',
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
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA · NIM',
    blurb: 'Open-weight models hosted on NVIDIA infrastructure, including DeepSeek R1.',
    kind: 'openai',
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
    blurb: 'Cheap, capable models with a dedicated step-by-step reasoning mode.',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    fastModel: 'deepseek-chat',
    thinkModel: 'deepseek-reasoner', // thinking tier: DeepSeek's reasoning model
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
    label: 'OpenRouter',
    blurb: 'One key routes to dozens of models from every major lab.',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-sonnet-5',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
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
    label: 'Groq',
    blurb: 'The fastest responses, great for live meetings.',
    kind: 'openai',
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
    label: 'Mistral',
    blurb: 'European-hosted models, useful where data residency matters.',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'pixtral-large-latest'],
    defaultModel: 'mistral-large-latest',
    fastModel: 'mistral-small-latest',
    keyHint: 'API key',
    keyPattern: '', // not reliably prefixed
    vision: false, // default/fast models are text-only (pixtral is vision but not the resolved model)
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  dust: {
    id: 'dust',
    label: 'Dust · your agents',
    blurb: 'Your own Second Brain agents — the deepest integration with your meeting history.',
    kind: 'dust',
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
    label: 'Gemini · Google',
    blurb: "Google's models with a very large context window.",
    kind: 'openai',
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
  custom: {
    id: 'custom',
    label: 'Custom · OpenAI-compatible',
    blurb: 'Point at any OpenAI-compatible endpoint you already run.',
    kind: 'openai',
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
    const a = u.pathname.match(/\/(?:agents|assistant)\/([^/?#]+)/)
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

export type ModelTier = 'base' | 'think' | 'deep'

/**
 * Resolve the model/agent for a routing tier.
 *  - base  → the user's chosen base model, else the provider's fast/cheap model (e.g. Haiku).
 *  - think → the user's chosen thinking model, else the provider's reasoning model (e.g. Sonnet),
 *            else falls back to the base/default so a provider without a distinct think model still works.
 *  - deep  → the user's chosen deep model, else the provider's deepest model (e.g. Opus), else the
 *            think model, so a provider without a distinct deep model degrades to its reasoning model.
 * For Dust the "model" is an agent sId: base/think/deep = providerModels.dust / thinkModels.dust / deepModels.dust.
 */
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
