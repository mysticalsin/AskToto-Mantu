import { createHash } from 'node:crypto'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import {
  IncrementalMeetingRecordSchema,
  type CanonicalIncrementalRecord,
  type IncrementalMeetingRecord
} from '@shared/incremental-meeting'

const INVALID_LIMITS = 'INVALID_LIMITS' as const
const INVALID_RECORD = 'INVALID_RECORD' as const
const RESOURCE_LIMIT = 'RESOURCE_LIMIT' as const

export type CanonicalIncrementalRecordResult =
  | { ok: true; value: CanonicalIncrementalRecord }
  | { ok: false; reason: typeof INVALID_LIMITS | typeof INVALID_RECORD | typeof RESOURCE_LIMIT }

type Budget = { value: number; nodes: number }

function validLimits(limits: SpeechProvenanceLimits): boolean {
  try {
    const keys = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords']
    return Boolean(
      limits &&
        Object.keys(limits).sort().join(',') === keys.join(',') &&
        Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    )
  } catch {
    return false
  }
}

function utf8(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function displayClock(timestamp: number): string {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (typeof serialized !== 'string') throw new Error(INVALID_RECORD)
  return serialized.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

function charge(budget: Budget, amount: number, maxBytes: number): void {
  budget.value += amount
  if (!Number.isSafeInteger(budget.value) || budget.value > maxBytes) throw new Error(RESOURCE_LIMIT)
}

/** Source-compatible one-record preflight; the fixed depth/node/field limits come from the v1 codec. */
function preflight(
  value: unknown,
  limits: SpeechProvenanceLimits,
  depth = 0,
  budget: Budget = { value: 0, nodes: 0 }
): void {
  if (++budget.nodes > 4_096 || depth > 8) throw new Error(RESOURCE_LIMIT)
  if (typeof value === 'string') {
    if (utf8(value) > limits.maxFieldBytes) throw new Error(RESOURCE_LIMIT)
    charge(budget, utf8(json(value)), limits.maxRecordBytes)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(INVALID_RECORD)
    charge(budget, utf8(String(value)), limits.maxRecordBytes)
    return
  }
  if (value === undefined) return
  if (typeof value === 'boolean') {
    charge(budget, value ? 4 : 5, limits.maxRecordBytes)
    return
  }
  if (value === null) {
    charge(budget, 4, limits.maxRecordBytes)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(RESOURCE_LIMIT)
    charge(budget, 2 + Math.max(0, value.length - 1), limits.maxRecordBytes)
    for (const item of value) preflight(item, limits, depth + 1, budget)
    return
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(INVALID_RECORD)
  }
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error(RESOURCE_LIMIT)
  charge(budget, 2 + Math.max(0, entries.filter(([, child]) => child !== undefined).length - 1), limits.maxRecordBytes)
  for (const [key, child] of entries) {
    if (utf8(key) > 128) throw new Error(RESOURCE_LIMIT)
    if (child !== undefined) charge(budget, utf8(json(key)) + 1, limits.maxRecordBytes)
    preflight(child, limits, depth + 1, budget)
  }
}

/** Worker-side canonicalization for one record; it never builds or returns a meeting-sized collection. */
export function canonicalizeIncrementalMeetingRecord(
  input: unknown,
  limits: SpeechProvenanceLimits,
  maxInputBytes: number
): CanonicalIncrementalRecordResult {
  if (!validLimits(limits) || !Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0)
    return { ok: false, reason: INVALID_LIMITS }
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: INVALID_RECORD }
    const candidate = input as { line?: unknown; identity?: unknown }
    preflight(candidate.line, limits)
    preflight(candidate.identity, { ...limits, maxRecordBytes: maxInputBytes })
    const parsed = IncrementalMeetingRecordSchema.safeParse(input)
    if (!parsed.success) return { ok: false, reason: INVALID_RECORD }
    const record: IncrementalMeetingRecord = parsed.data
    const wordCount = record.line.speech?.words?.length ?? 0
    if (wordCount > limits.maxWords) return { ok: false, reason: RESOURCE_LIMIT }
    const canonicalJson = json(record)
    const linePayloadBytes = utf8(json(record.line))
    const canonicalBuffer = Buffer.from(canonicalJson, 'utf8')
    if (linePayloadBytes > limits.maxRecordBytes || canonicalBuffer.byteLength > maxInputBytes)
      return { ok: false, reason: RESOURCE_LIMIT }
    const canonicalBytes = Uint8Array.from(canonicalBuffer)
    return {
      ok: true,
      value: {
        identityKey: json(record.identity),
        sha256: createHash('sha256').update(canonicalBuffer).digest('hex'),
        canonicalBytes,
        canonicalByteLength: canonicalBytes.byteLength,
        wordCount,
        linePayloadBytes,
        clock: displayClock(record.line.t)
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === RESOURCE_LIMIT) return { ok: false, reason: RESOURCE_LIMIT }
    return { ok: false, reason: INVALID_RECORD }
  }
}
