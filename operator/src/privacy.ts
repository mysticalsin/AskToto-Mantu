import { projectOperatorIngestMetadata } from '../../src/shared/operator'
import { normalizeQuestionType, QUESTION_TYPE_LABELS } from '../../src/shared/question-type'
import type { AskRow, EventRow } from './store'

const ASK_PATH_TAGS = new Set(['portal-cf', 'portal-direct', 'cli', 'seat-local'])
const ASK_MODES = new Set([
  'answer', 'vision', 'suggest', 'summary', 'recap', 'operator',
  'interview', 'recruiting', 'meeting', 'sales', 'negotiation', 'presentation', 'support', 'general', 'cold-call'
])

export function projectAskMode(raw: unknown): string | null {
  return typeof raw === 'string' && ASK_MODES.has(raw) ? raw : null
}

export function projectAskModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length <= 120 && !value.includes('://') && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$/.test(value) ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** Positive projection used whenever a stored Ask crosses an application boundary. */
export function projectAskTelemetry(row: AskRow): AskRow {
  const projected = projectOperatorIngestMetadata({
    event: 'ask',
    id: 'stored-ask',
    ts: row.ts,
    mode: row.mode,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    provider: row.provider,
    model: row.model,
    ttftMs: row.ttft_ms,
    totalMs: row.total_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cacheUncached: row.cache_uncached,
    cacheStatus: row.cache_status,
    cacheTtl: row.cache_ttl,
    outcome: row.outcome,
    questionType: row.question_type
  }) ?? {}
  const questionType = row.question_type == null ? null : normalizeQuestionType(projected.questionType)
  const mode = projectAskMode(row.mode)
  const label = questionType ? QUESTION_TYPE_LABELS[questionType] : null
  const preview = label ? `${mode ? `${mode} ask` : 'Ask'} · ${label}` : mode ? `${mode} ask` : 'Ask'

  return {
    id: row.id,
    device_id: row.device_id,
    ts: nullableNumber(projected.ts) ?? row.ts,
    mode,
    skill_id: nullableString(projected.skillId),
    skill_version: nullableString(projected.skillVersion),
    provider: nullableString(projected.provider),
    model: nullableString(projected.model) ?? projectAskModel(row.model),
    ttft_ms: nullableNumber(projected.ttftMs),
    total_ms: nullableNumber(projected.totalMs),
    input_tokens: nullableNumber(projected.inputTokens),
    output_tokens: nullableNumber(projected.outputTokens),
    cache_read: nullableNumber(projected.cacheRead),
    cache_write: nullableNumber(projected.cacheWrite),
    cache_uncached: nullableNumber(projected.cacheUncached),
    cache_status: nullableString(projected.cacheStatus),
    cache_ttl: nullableString(projected.cacheTtl),
    outcome: nullableString(projected.outcome),
    rating: row.rating === 'up' || row.rating === 'down' ? row.rating : null,
    prompt_cipher: null,
    prompt_iv: null,
    preview,
    question_type: questionType,
    path_tag: typeof row.path_tag === 'string' && ASK_PATH_TAGS.has(row.path_tag) ? row.path_tag : null
  }
}

/** Shared by response projection and storage search: hidden text must not influence row selection. */
export const PRIVATE_EVENT_DETAIL_KINDS: readonly string[] = ['ask', 'crm', 'heartbeat']

/** Legacy client event detail was free text. Sensitive event kinds therefore retain only row metadata. */
export function projectEventTelemetry(row: EventRow): EventRow {
  return PRIVATE_EVENT_DETAIL_KINDS.includes(row.kind) ? { ...row, detail: null } : row
}
