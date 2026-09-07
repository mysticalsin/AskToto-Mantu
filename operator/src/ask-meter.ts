/**
 * Path-tagged Ask metering for Portal-proxied LLM spend (FRAME G9).
 * Worker-written rows only. Seats never receive a vault secret.
 */
import type { AskRow, OperatorStore } from './store'

export const ASK_PATH_TAGS = ['portal-cf', 'portal-direct', 'cli', 'seat-local'] as const
export type AskPathTag = (typeof ASK_PATH_TAGS)[number]

export function isAskPathTag(raw: unknown): raw is AskPathTag {
  return typeof raw === 'string' && (ASK_PATH_TAGS as readonly string[]).includes(raw)
}

export function pathTagForProvider(provider: string): AskPathTag {
  return provider === 'cloudflare' ? 'portal-cf' : 'portal-direct'
}

export function parseAskPathTag(raw: unknown): AskPathTag | null {
  return isAskPathTag(raw) ? raw : null
}

export async function persistProxyAsk(
  store: OperatorStore,
  input: {
    deviceId: string
    now: number
    provider: string
    model: string
    inputTokens?: number
    outputTokens?: number
    outcome: string
  }
): Promise<void> {
  const row: AskRow = {
    id: crypto.randomUUID(),
    device_id: input.deviceId,
    ts: input.now,
    mode: 'operator',
    skill_id: null,
    skill_version: null,
    provider: input.provider,
    model: input.model,
    ttft_ms: null,
    total_ms: null,
    input_tokens: typeof input.inputTokens === 'number' ? input.inputTokens : null,
    output_tokens: typeof input.outputTokens === 'number' ? input.outputTokens : null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: input.outcome,
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: `operator ask · ${input.provider}`,
    question_type: null,
    path_tag: pathTagForProvider(input.provider)
  }
  await store.insertAsk(row)
}
