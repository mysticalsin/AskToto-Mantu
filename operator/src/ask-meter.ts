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

/** Counts are exact non-negative safe integers or explicitly unknown. Never turn
 * a malformed provider value into zero, round it, or persist NaN/Infinity to D1.
 * The `=== 0` branch is deliberate: it normalizes a provider's `-0` to `0` before
 * it reaches D1 or a JSON response.
 */
export function proxyTokenCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return null
  return raw === 0 ? 0 : raw
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
    /** Seat request id when available — stable across server+client so Overview does not double-count. */
    askId?: string
  }
): Promise<void> {
  // Prefer seat AskStart.id so client ingest + server persistProxyAsk REPLACE the same D1 row
  // (COST_METERING: one Ask must not inflate Overview apiCalls).
  const id =
    typeof input.askId === 'string' && input.askId.trim().length >= 8
      ? input.askId.trim()
      : crypto.randomUUID()
  const row: AskRow = {
    id,
    device_id: input.deviceId,
    ts: input.now,
    mode: 'operator',
    skill_id: null,
    skill_version: null,
    provider: input.provider,
    model: input.model,
    ttft_ms: null,
    total_ms: null,
    input_tokens: proxyTokenCount(input.inputTokens),
    output_tokens: proxyTokenCount(input.outputTokens),
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
