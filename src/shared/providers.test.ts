import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDustReady, isSpotlightRefReady, dustStoredAgentMissing, applyInteractiveGuardrail, parseDustUrl, detectProvider, filterAllowedProviders, migrateRetiredModelId, migrateRetiredModelMap, providerBaseUrl, reasoningEffortFor, requiresUserBaseUrl, resolveModelTier, PROVIDERS, PROVIDER_IDS, dustAgentVision } from './providers'

// MQA-001 (docs/qa/BUG-LEDGER.md): the registry shipped DeepSeek's retired 'deepseek-chat' /
// 'deepseek-reasoner' ids as its defaults after their 2026-07-24 discontinuation date. If these tests
// fail, read that ledger entry before "fixing" them — the ids must stay on the V4 generation.
describe('DeepSeek V4 registry (MQA-001)', () => {
  it('offers only V4 ids — the retired chat/reasoner ids are never suggested', () => {
    // DeepSeek announced 'deepseek-chat'/'deepseek-reasoner' for discontinuation on 2026-07-24. Shipping
    // them as suggestions hands users an id that stops answering with no change on our side.
    expect(PROVIDERS.deepseek.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(PROVIDERS.deepseek.models).not.toContain('deepseek-chat')
    expect(PROVIDERS.deepseek.models).not.toContain('deepseek-reasoner')
  })

  it('resolves V4 Flash for the base tier and V4 Pro for think/deep with no user override', () => {
    expect(resolveModelTier('deepseek', {}, {}, 'base')).toBe('deepseek-v4-flash')
    expect(resolveModelTier('deepseek', {}, {}, 'think')).toBe('deepseek-v4-pro')
    expect(resolveModelTier('deepseek', {}, {}, 'deep', {})).toBe('deepseek-v4-pro')
  })
})

describe('migrateRetiredModelId — provider-retired ids heal on read (MQA-001)', () => {
  it('maps both retired DeepSeek ids to V4 Flash, never to the 3x-pricier Pro', () => {
    // DeepSeek documents chat/reasoner as aliases for V4-Flash's non-thinking/thinking modes, so Flash is
    // the faithful successor for both; silently promoting a user to Pro would triple their token cost.
    expect(migrateRetiredModelId('deepseek', 'deepseek-chat')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('deepseek', 'deepseek-reasoner')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('openrouter', 'deepseek/deepseek-chat')).toBe('deepseek/deepseek-v4-flash')
  })

  it('passes through live ids, custom fine-tunes, other providers, and blanks untouched', () => {
    expect(migrateRetiredModelId('deepseek', 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('deepseek', 'my-org/deepseek-chat-ft-2026')).toBe('my-org/deepseek-chat-ft-2026')
    expect(migrateRetiredModelId('openai', 'deepseek-chat')).toBe('deepseek-chat') // not deepseek's map
    expect(migrateRetiredModelId('deepseek', '')).toBe('')
  })

  it('migrates a whole persisted map and returns the SAME object when nothing changed', () => {
    const stale = { deepseek: 'deepseek-chat', anthropic: 'claude-opus-4-8' }
    expect(migrateRetiredModelMap(stale)).toEqual({ deepseek: 'deepseek-v4-flash', anthropic: 'claude-opus-4-8' })
    const clean = { deepseek: 'deepseek-v4-flash' }
    expect(migrateRetiredModelMap(clean)).toBe(clean) // identity → callers can skip a settings rewrite
  })
})

describe('reasoningEffortFor', () => {
  it('keeps DeepSeek V4 off its default thinking mode at the base tier (live suggest has a 15s budget)', () => {
    expect(reasoningEffortFor('deepseek', 'base', false)).toBe('low')
    expect(reasoningEffortFor('deepseek', 'think', false)).toBe('high')
    expect(reasoningEffortFor('deepseek', 'deep', false)).toBe('high')
    expect(reasoningEffortFor('deepseek', 'base', true)).toBe('high') // user turned Métis thinking on
  })

  it('preserves the original tier-independent Kimi behavior exactly', () => {
    expect(reasoningEffortFor('kimi', 'base', false)).toBe('low')
    expect(reasoningEffortFor('kimi', 'deep', false)).toBe('low')
    expect(reasoningEffortFor('kimi', 'base', true)).toBe('high')
  })

  it('is undefined for every other provider so their request bodies stay byte-identical', () => {
    for (const id of ['anthropic', 'openai', 'nvidia', 'dust', 'local', 'claude-cli', 'grok'] as const) {
      expect(reasoningEffortFor(id, 'base', false)).toBeUndefined()
      expect(reasoningEffortFor(id, 'deep', true)).toBeUndefined()
    }
  })
})

describe('dustAgentVision', () => {
  it('treats every Claude (anthropic) agent as vision-capable', () => {
    expect(dustAgentVision({ modelProviderId: 'anthropic', modelId: 'claude-3-5-sonnet-20241022' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'anthropic', modelId: 'claude-sonnet-4-20250514' })).toBe(true)
  })

  it('treats modern multimodal OpenAI models as vision, legacy text ones as not', () => {
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-4o' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-4.1' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'o3' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-3.5-turbo' })).toBe(false)
  })

  it('treats Gemini as vision and honors explicit vl/vision/pixtral hints', () => {
    expect(dustAgentVision({ modelProviderId: 'google_ai_studio', modelId: 'gemini-1.5-pro' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'mistral', modelId: 'pixtral-large' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'fireworks', modelId: 'qwen-vl-max' })).toBe(true)
  })

  it('is false for text-only providers/models and missing input', () => {
    expect(dustAgentVision({ modelProviderId: 'mistral', modelId: 'mistral-large' })).toBe(false)
    expect(dustAgentVision({ modelProviderId: 'deepseek', modelId: 'deepseek-chat' })).toBe(false)
    expect(dustAgentVision(null)).toBe(false)
    expect(dustAgentVision({})).toBe(false)
  })
})

describe('isDustReady', () => {
  it('is true only when the key, workspace, and base agent are all present', () => {
    expect(isDustReady({ dust: true }, 'ws_123', { dust: 'agent_abc' })).toBe(true)
  })

  it('is false when the Dust API key is missing, even with workspace + agent set', () => {
    expect(isDustReady({}, 'ws_123', { dust: 'agent_abc' })).toBe(false)
    expect(isDustReady({ dust: false }, 'ws_123', { dust: 'agent_abc' })).toBe(false)
  })

  it('is false when the workspace id is missing or blank', () => {
    expect(isDustReady({ dust: true }, '', { dust: 'agent_abc' })).toBe(false)
    expect(isDustReady({ dust: true }, '   ', { dust: 'agent_abc' })).toBe(false)
  })

  it('is false when no base agent is configured for dust', () => {
    expect(isDustReady({ dust: true }, 'ws_123', {})).toBe(false)
    expect(isDustReady({ dust: true }, 'ws_123', { dust: '' })).toBe(false)
  })

  it('is independent of other providers having keys — only dust matters', () => {
    expect(isDustReady({ dust: true, kimi: true, anthropic: true }, 'ws_123', { dust: 'agent_abc' })).toBe(true)
    expect(isDustReady({ kimi: true, anthropic: true }, 'ws_123', { dust: 'agent_abc' })).toBe(false)
  })
})

describe('dustStoredAgentMissing', () => {
  const agents = [{ sId: 'a1' }, { sId: 'a2' }]

  it('true when the stored agent is absent from a loaded, non-empty workspace list', () => {
    expect(dustStoredAgentMissing('gone', agents)).toBe(true)
  })

  it('false when the stored agent is present in the workspace', () => {
    expect(dustStoredAgentMissing('a1', agents)).toBe(false)
  })

  it('false when no agent is selected', () => {
    expect(dustStoredAgentMissing('', agents)).toBe(false)
  })

  it('false before the list has loaded (null) — no false alarm', () => {
    expect(dustStoredAgentMissing('gone', null)).toBe(false)
  })

  it('false for an empty list (restricted/failed load is not proof the agent is gone)', () => {
    expect(dustStoredAgentMissing('gone', [])).toBe(false)
  })

  it('does not false-negative a managed Spotlight Ref agent present on an all/workspace/published list', () => {
    expect(
      dustStoredAgentMissing('GOr913Zr5V', [{ sId: 'personal-list-only' }, { sId: 'GOr913Zr5V' }])
    ).toBe(false)
  })
})

describe('isSpotlightRefReady', () => {
  const keys = { dust: true }
  const pin = { dust: 'GOr913Zr5V' }
  const listOnly = [{ sId: 'user-pickable' }]
  const allViews = [{ sId: 'user-pickable' }, { sId: 'GOr913Zr5V' }]

  it('is true when GOr913Zr5V is in an all/workspace/published list even if view:list omits it', () => {
    expect(isSpotlightRefReady(keys, 'ws_123', pin, listOnly)).toBe(false)
    expect(isSpotlightRefReady(keys, 'ws_123', pin, allViews)).toBe(true)
  })

  it('stays true while the list is inconclusive (null or empty) if Dust credentials and the pin are set', () => {
    expect(isSpotlightRefReady(keys, 'ws_123', pin, null)).toBe(true)
    expect(isSpotlightRefReady(keys, 'ws_123', pin, [])).toBe(true)
  })

  it('is false when Dust is not connected, even if the managed agent appears in a list', () => {
    expect(isSpotlightRefReady({}, 'ws_123', pin, allViews)).toBe(false)
    expect(isSpotlightRefReady(keys, '', pin, allViews)).toBe(false)
    expect(isSpotlightRefReady(keys, 'ws_123', {}, allViews)).toBe(false)
  })
})

describe('applyInteractiveGuardrail', () => {
  it('locks claude-cli to Sonnet for every tier, ignoring the resolved model', () => {
    expect(applyInteractiveGuardrail('claude-cli', 'base', 'haiku')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'think', 'sonnet')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'deep', 'opus')).toBe('sonnet')
  })

  it('pins anthropic base tier to the Haiku id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'base', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.fastModel
    )
  })

  it('pins anthropic think tier to the Sonnet id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'think', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.thinkModel
    )
  })

  it('does NOT lock anthropic deep tier — Opus stays reachable for hard questions', () => {
    expect(applyInteractiveGuardrail('anthropic', 'deep', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('passes every other provider/tier combination through unchanged', () => {
    expect(applyInteractiveGuardrail('openai', 'base', 'gpt-4o-mini')).toBe('gpt-4o-mini')
    expect(applyInteractiveGuardrail('dust', 'think', 'agent_abc')).toBe('agent_abc')
    expect(applyInteractiveGuardrail('codex-cli', 'base', '')).toBe('')
  })
})

describe('parseDustUrl agent-id extraction (only unambiguous agent sources)', () => {
  it('extracts the agent from builder URLs and query params', () => {
    expect(parseDustUrl('https://dust.tt/w/abc123/builder/agents/vJxYHvTRBT').agentId).toBe('vJxYHvTRBT')
    expect(parseDustUrl('https://eu.dust.tt/w/abc123/builder/assistants/GOr913Zr5V').agentId).toBe('GOr913Zr5V')
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/CONV42?assistant=vJxYHvTRBT').agentId).toBe('vJxYHvTRBT')
  })

  it('never mistakes a conversation id for an agent id', () => {
    // A bare /assistant/<id> path is a CONVERSATION on dust.tt — treating it as an agent silently
    // pointed the base agent at garbage when a user pasted a chat link (2026-07-06 review finding).
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/8CzUOZaanQ').agentId).toBeUndefined()
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/new').agentId).toBeUndefined()
    // Workspace/region auto-fill still works on those links.
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/8CzUOZaanQ').workspaceId).toBe('abc123')
  })
})

describe('detectProvider', () => {
  it('resolves an xai- key to grok (xAI)', () => {
    expect(detectProvider('xai-abc123DEF456ghi789')).toBe('grok')
  })

  it('resolves an sk-ant- key to anthropic, beating the generic sk- guess', () => {
    expect(detectProvider('sk-ant-abc123DEF456ghi789')).toBe('anthropic')
  })

  it('never guesses on an ambiguous bare sk- key shared by several providers', () => {
    expect(detectProvider('sk-abc123DEF456ghi789')).toBeNull()
  })

  it('returns null for an empty or blank key', () => {
    expect(detectProvider('')).toBeNull()
    expect(detectProvider('   ')).toBeNull()
  })
})

describe('filterAllowedProviders — org data-residency allowlist', () => {
  it('returns ids unchanged when the allowlist is null/undefined (unrestricted)', () => {
    expect(filterAllowedProviders(['anthropic', 'openai', 'grok'], null)).toEqual(['anthropic', 'openai', 'grok'])
    expect(filterAllowedProviders(['anthropic', 'openai'], undefined)).toEqual(['anthropic', 'openai'])
  })

  it('keeps only ids present in the allowlist, preserving order', () => {
    expect(filterAllowedProviders(['anthropic', 'openai', 'grok', 'kimi'], ['grok', 'anthropic'])).toEqual([
      'anthropic',
      'grok'
    ])
  })

  it('returns empty when the allowlist excludes every candidate', () => {
    expect(filterAllowedProviders(['anthropic', 'openai'], ['dust'])).toEqual([])
    expect(filterAllowedProviders(['anthropic', 'openai'], [])).toEqual([])
  })
})


/**
 * Cloudflare — an OPERATOR-hosted provider.
 *
 * Cloudflare's AI REST API is account-scoped and authenticates with a Cloudflare ACCOUNT token. A packaged
 * Electron app is not a safe place for one: `npx asar extract` recovers any embedded string, which is the
 * whole reason scripts/check-cahe-package.mjs refuses a build with a key in it. So the account token stays
 * a Wrangler secret on a Worker the operator deploys, and Métis holds only that Worker's URL plus a
 * per-user METIS_PROXY_KEY. These tests pin that shape so a later "convenience default" cannot undo it.
 */
describe('Cloudflare provider registry', () => {
  it('ships NO endpoint and NO credential — the operator supplies both', () => {
    expect(PROVIDERS.cloudflare.baseUrl).toBe('')
    expect(requiresUserBaseUrl('cloudflare')).toBe(true)
    // No "get a key" link: the METIS_PROXY_KEY is issued by whoever deployed the Worker, not a signup page.
    expect(PROVIDERS.cloudflare.keyUrl).toBe('')
    // An operator-chosen shared secret has no fixed prefix, so any keyPattern here would be a guess that
    // hijacks a paste meant for another provider.
    expect(PROVIDERS.cloudflare.keyPattern).toBe('')
    expect(detectProvider('an-operator-chosen-shared-secret')).toBeNull()
  })

  it('carries no key-shaped literal anywhere in its entry', () => {
    // The registry entry is exactly where a "just for testing" credential would get pasted, and it would
    // survive into the shipped asar. Assert the recognizable token shapes instead of trusting review.
    const entry = JSON.stringify(PROVIDERS.cloudflare)
    expect(entry).not.toMatch(/sk-[A-Za-z0-9_-]{16}/)
    expect(entry).not.toMatch(/bearer\s+\S/i)
    // Cloudflare account tokens are long opaque strings; no legitimate field here is a 40-char run.
    expect(entry).not.toMatch(/[A-Za-z0-9_-]{40,}/)
  })

  it('ships only ids that a live Cloudflare account actually served', () => {
    // The third-party {provider}/{model} ids that used to be listed here were never reachable on a
    // default install: `openai/gpt-5.5` needs a funded Unified Billing gateway ("Insufficient balance;
    // add money to your gateway or use BYOK") and `anthropic/claude-sonnet-4-5` /
    // `google-ai-studio/gemini-2.5-flash` are not valid ids at this endpoint at all. Suggesting a model
    // the user cannot run is the same defect class as defaulting to one.
    expect(PROVIDERS.cloudflare.defaultModel).toBe('@cf/meta/llama-4-scout-17b-16e-instruct')
    for (const m of PROVIDERS.cloudflare.models) expect(m).toMatch(/^@cf\/.+/)
  })

  it('resolves a cheap base tier, a fast think tier, and a reasoning deep tier with no user override', () => {
    expect(resolveModelTier('cloudflare', {}, {}, 'base')).toBe('@cf/meta/llama-4-scout-17b-16e-instruct')
    // MQA-229: think must stream visible text immediately. gpt-oss-120b used to sit here and spent
    // 3.6-14.2s on hidden reasoning before its first visible token (measured through the live Worker),
    // while routing.ts sends every "why/how/explain/compare" question to this tier — so the app's most
    // common ask shape blew the 2-3s answer budget. The 70B fp8-fast model answers in ~0.4s to first
    // visible token; the reasoning model is reserved for the DEEP tier, where depth is the point.
    expect(resolveModelTier('cloudflare', {}, {}, 'think')).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(resolveModelTier('cloudflare', {}, {}, 'deep', {})).toBe('@cf/openai/gpt-oss-120b')
  })

  it('speaks the OpenAI wire protocol, so it reuses the existing streaming client unchanged', () => {
    // Cloudflare's endpoint is /ai/v1/chat/completions with the same body and SSE framing as OpenAI.
    // Anything other than 'openai' here would mean a second adapter had been written for no reason.
    expect(PROVIDERS.cloudflare.kind).toBe('openai')
  })

  it('MQA-226: every model id is the bare @cf/ form the live endpoint actually accepts', () => {
    // Run against a real Cloudflare account: the `workers-ai/` prefix these ids used to carry is rejected
    // with "No such model", so every ask on the shipped default 404'd. The mock gateway never caught it
    // because it echoes whatever model it is handed — this is a defect only a live endpoint can find.
    // The `{provider}/{model}` form is real, but only for third-party labs behind Unified Billing
    // (`openai/gpt-5.5` answers "Insufficient balance"), so it can never be a default.
    for (const id of [
      ...PROVIDERS.cloudflare.models,
      PROVIDERS.cloudflare.defaultModel,
      PROVIDERS.cloudflare.fastModel,
      PROVIDERS.cloudflare.thinkModel ?? PROVIDERS.cloudflare.defaultModel,
      PROVIDERS.cloudflare.deepModel ?? PROVIDERS.cloudflare.defaultModel
    ]) {
      expect(id, `${id} must be a bare Workers AI id`).toMatch(/^@cf\//)
      expect(id, `${id} must not carry the rejected workers-ai/ prefix`).not.toMatch(/^workers-ai\//)
    }
    const base = resolveModelTier('cloudflare', {}, {}, 'base')
    expect(base).toBe('@cf/meta/llama-4-scout-17b-16e-instruct')
    expect(PROVIDERS.cloudflare.models).toContain(base)
  })

  it('MQA-259 (supersedes MQA-227, which superseded MQA-212): claims vision, because the endpoint now carries an image', () => {
    // The history matters, because this flag has moved twice and each move was evidence-led:
    //   MQA-212 set it TRUE against the MOCK — Scout is multimodal, and false was sending screen-asks to
    //           the on-device floor. Sound reasoning, wrong evidence.
    //   MQA-227 set it FALSE against the LIVE endpoint — every image_url shape returned code 6004,
    //           "Property image_url only supports base64 encoded image data". A transport limit, and it
    //           left instructions: revisit only against a live endpoint, never the mock.
    //   MQA-259 set it TRUE against the LIVE endpoint, following those instructions exactly. Re-probed
    //           2026-08-25 with the shipped embedded key: the nested data-URI shape answers 200 and the
    //           model genuinely reads the image. Two rendered images returned "INVOICE 84213" and
    //           "RECEIPT 90577" verbatim — content it could not guess — and a 2560x1440 screenshot
    //           (0.75 MB base64) returned its banner text in 1.86s, against 12s+ on-device.
    expect(PROVIDERS.cloudflare.vision).toBe(true)
  })

  it('MQA-259: the app builds the ONE image shape the endpoint accepts', () => {
    // Only the nested data-URI form works. Re-probed live on 2026-08-25:
    //   {image_url: {url: 'data:image/jpeg;base64,…'}}  -> 200
    //   {image_url: {url: '<bare base64>'}}             -> 400
    //   {image_url: 'data:image/jpeg;base64,…'}         -> 400
    // So vision:true is only safe while llm/openai.ts keeps building the first form. A refactor to bare
    // base64 would 400 every screen-ask on the default provider, and the flag above would then be a lie.
    const openai = readFileSync(join(__dirname, '..', 'main', 'llm', 'openai.ts'), 'utf8')
    expect(openai).toMatch(/type: 'image_url', image_url: \{ url: `data:\$\{imageMime\(req\.image\)\};base64,\$\{req\.image\}` \}/)
  })

  it('claims no free tier, because requests bill to the operator', () => {
    // Requests bill to the operator's Cloudflare account, so it must never float ahead of a paid provider
    // as a "free backup" when another provider runs out of credit (index.ts pickFailover's preferFree).
    expect(PROVIDERS.cloudflare.freeTier).toBeUndefined()
  })
})

describe('providerBaseUrl / requiresUserBaseUrl', () => {
  const endpoints = {
    customBaseUrl: 'https://my-vllm.internal/v1',
    dustBaseUrl: 'https://eu.dust.tt',
    cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1'
  }

  it("sends each user-configurable provider to ITS OWN setting, never another provider's", () => {
    expect(providerBaseUrl('cloudflare', endpoints)).toBe('https://metis-ai.example.workers.dev/v1')
    expect(providerBaseUrl('custom', endpoints)).toBe('https://my-vllm.internal/v1')
    expect(providerBaseUrl('dust', endpoints)).toBe('https://eu.dust.tt')
  })

  it('returns the registry endpoint for every provider that ships one', () => {
    expect(providerBaseUrl('groq', endpoints)).toBe('https://api.groq.com/openai/v1')
    expect(providerBaseUrl('nvidia', endpoints)).toBe(PROVIDERS.nvidia.baseUrl)
    expect(providerBaseUrl('anthropic', endpoints)).toBe('') // SDK default, unchanged by these settings
  })

  it('returns EMPTY — never a substitute endpoint — when the user configured none', () => {
    // Every caller checks for this empty string before sending. Handing back some default instead is the
    // failure mode the whole helper exists to prevent: the OpenAI SDK's own default base URL is
    // api.openai.com, so a Cloudflare key and prompt would go to OpenAI.
    const blank = { customBaseUrl: '', dustBaseUrl: '', cloudflareBaseUrl: '' }
    expect(providerBaseUrl('cloudflare', blank)).toBe('')
    expect(providerBaseUrl('custom', blank)).toBe('')
  })

  it('flags EVERY OpenAI-kind provider that ships no endpoint, so a new one cannot default to OpenAI', () => {
    // The forward-looking invariant: add another bring-your-own-endpoint provider and forget
    // requiresUserBaseUrl, and this fails instead of shipping a silent redirect to api.openai.com.
    const openAiKindWithoutEndpoint = PROVIDER_IDS.filter(
      (id) => PROVIDERS[id].kind === 'openai' && !PROVIDERS[id].baseUrl
    )
    expect(openAiKindWithoutEndpoint).toEqual(['cloudflare', 'custom'])
    for (const id of openAiKindWithoutEndpoint) expect(requiresUserBaseUrl(id)).toBe(true)
  })
})
