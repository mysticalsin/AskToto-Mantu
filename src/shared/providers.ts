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
  | 'together'
  | 'fireworks'
  | 'mistral'
  | 'dust'
  | 'custom'
export type ProviderKind = 'anthropic' | 'openai' | 'dust' // wire protocol

export interface ProviderDef {
  id: ProviderId
  label: string
  kind: ProviderKind
  baseUrl: string // openai-kind base; '' = sdk default (anthropic) or user-set (custom)
  models: string[] // suggestions for the datalist
  defaultModel: string
  fastModel: string // BASE tier — fast/cheap (e.g. Haiku); used for simple questions
  /** THINKING tier — stronger/reasoning model (e.g. Sonnet) for hard/coding/complex questions.
   *  Optional: falls back to defaultModel when unset. See resolveModelTier(). */
  thinkModel?: string
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
    kind: 'anthropic',
    baseUrl: '',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-opus-4-8',
    fastModel: 'claude-haiku-4-5-20251001', // base tier: Haiku
    thinkModel: 'claude-sonnet-4-6', // thinking tier: Sonnet (per Tony — not Opus)
    keyHint: 'sk-ant-…',
    keyPattern: '^sk-ant-',
    vision: true,
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    id: 'openai',
    label: 'GPT · OpenAI',
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
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA · NIM',
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
    kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max'],
    defaultModel: 'qwen-plus',
    fastModel: 'qwen-turbo',
    keyHint: 'sk-…',
    keyPattern: '', // sk- ambiguous
    vision: false,
    keyUrl: 'https://bailian.console.alibabacloud.com/'
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
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
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
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
  together: {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-72B-Instruct-Turbo'
    ],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fastModel: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    keyHint: 'tgp_v1_…',
    keyPattern: '^tgp_v1_',
    vision: false,
    keyUrl: 'https://api.together.xyz/settings/api-keys'
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/qwen2p5-72b-instruct'
    ],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    fastModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    keyHint: 'fw_…',
    keyPattern: '^fw_',
    vision: false,
    keyUrl: 'https://fireworks.ai/account/api-keys'
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'pixtral-large-latest'],
    defaultModel: 'mistral-large-latest',
    fastModel: 'mistral-small-latest',
    keyHint: 'API key',
    keyPattern: '', // not reliably prefixed
    vision: false,
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  dust: {
    id: 'dust',
    label: 'Dust · your agents',
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
  custom: {
    id: 'custom',
    label: 'Custom · OpenAI-compatible',
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
  if (fast) return def.fastModel || chosen || def.defaultModel || ''
  return chosen || def.defaultModel || ''
}

export type ModelTier = 'base' | 'think'

/**
 * Resolve the model/agent for a routing tier.
 *  - base  → the user's chosen base model, else the provider's fast/cheap model (e.g. Haiku).
 *  - think → the user's chosen thinking model, else the provider's reasoning model (e.g. Sonnet),
 *            else falls back to the base/default so a provider without a distinct think model still works.
 * For Dust the "model" is an agent sId: base = providerModels.dust, think = thinkModels.dust.
 */
export function resolveModelTier(
  id: ProviderId,
  providerModels: Partial<Record<string, string>>,
  thinkModels: Partial<Record<string, string>>,
  tier: ModelTier
): string {
  const def = PROVIDERS[id]
  const base = (providerModels[id] || '').trim()
  if (tier === 'think') {
    const think = (thinkModels[id] || '').trim()
    return think || def.thinkModel || base || def.defaultModel || ''
  }
  return base || def.fastModel || def.defaultModel || ''
}
