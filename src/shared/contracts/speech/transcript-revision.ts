import { z } from 'zod'

export const TRANSCRIPT_REVISION_SCHEMA = 'metis.transcript-revision.v1' as const
export type SegmentState = 'partial' | 'final' | 'corrected' | 'retracted'
export type SegmentSource = 'provider' | 'user'

export interface TranscriptSegment {
  segmentId: string
  seq: number
  channel: 'mic' | 'system'
  speaker?: string
  startMs: number
  endMs: number
  language: string
  text: string
  state: SegmentState
  source: SegmentSource
  relaySessionId: string
  providerSeq?: number
}

export interface TranscriptRevision {
  schema: typeof TRANSCRIPT_REVISION_SCHEMA
  meetingStartedAt: number
  revision: number
  finalized: boolean
  languages: readonly string[]
  segments: readonly TranscriptSegment[]
}

export type RevisionEvent =
  | {
      kind: 'provider-partial'
      relaySessionId: string
      providerSeq: number
      channel: 'mic' | 'system'
      text: string
      language: string
      startMs: number
      endMs: number
    }
  | {
      kind: 'provider-final'
      relaySessionId: string
      providerSeq: number
      channel: 'mic' | 'system'
      text: string
      language: string
      startMs: number
      endMs: number
      speaker?: string
    }
  | { kind: 'provider-revise'; relaySessionId: string; providerSeq: number; segmentId: string; text: string }
  | { kind: 'provider-retract'; relaySessionId: string; providerSeq: number; segmentId: string }
  | { kind: 'user-correct'; baseRevision: number; segmentId: string; text: string }
  | { kind: 'user-retract'; baseRevision: number; segmentId: string }
  | { kind: 'language-change'; language: string; atMs: number; origin: 'provider' | 'user' }
  | { kind: 'finalize' }

export type RevisionRefusal =
  | 'stale-base'
  | 'unknown-segment'
  | 'finalized'
  | 'duplicate'
  | 'out-of-order'
  | 'over-limit'
  | 'invalid'

export type ApplyResult =
  | { ok: true; next: TranscriptRevision; changed: readonly string[] }
  | { ok: false; reason: RevisionRefusal }

export interface RevisionLimits {
  maxSegments: number
  maxSegmentChars: number
  maxTotalBytes: number
}

export const DEFAULT_REVISION_LIMITS: RevisionLimits = Object.freeze({
  maxSegments: 20_000,
  maxSegmentChars: 4_000,
  maxTotalBytes: 8 * 1024 * 1024
})

const ChannelSchema = z.enum(['mic', 'system'])
const MsSchema = z.number().finite().nonnegative()
const SeqSchema = z.number().int().nonnegative().safe()
const LanguageSchema = z.string().min(2).max(35)
const IdSchema = z.string().min(1).max(64)

export const TranscriptSegmentSchema = z
  .object({
    segmentId: IdSchema,
    seq: SeqSchema,
    channel: ChannelSchema,
    speaker: z.string().max(64).optional(),
    startMs: MsSchema,
    endMs: MsSchema,
    language: LanguageSchema,
    text: z.string(),
    state: z.enum(['partial', 'final', 'corrected', 'retracted']),
    source: z.enum(['provider', 'user']),
    relaySessionId: IdSchema,
    providerSeq: SeqSchema.optional()
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.endMs < segment.startMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'] })
    if (segment.state === 'retracted' && segment.text !== '')
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'] })
  })

export const TranscriptRevisionSchema = z
  .object({
    schema: z.literal(TRANSCRIPT_REVISION_SCHEMA),
    meetingStartedAt: z.number().finite().positive(),
    revision: SeqSchema,
    finalized: z.boolean(),
    languages: z.array(LanguageSchema),
    segments: z.array(TranscriptSegmentSchema)
  })
  .strict()

export const TranscriptRevisionDeltaSchema = z
  .object({
    meetingStartedAt: z.number().int().positive().safe(),
    revision: z.number().int().nonnegative().safe(),
    changed: z.array(TranscriptSegmentSchema).max(200),
    finalized: z.boolean()
  })
  .strict()
export type TranscriptRevisionDelta = z.infer<typeof TranscriptRevisionDeltaSchema>

const providerFields = { relaySessionId: IdSchema, providerSeq: SeqSchema }
const spanFields = {
  ...providerFields,
  channel: ChannelSchema,
  text: z.string(),
  language: LanguageSchema,
  startMs: MsSchema,
  endMs: MsSchema
}

export const RevisionEventSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('provider-partial'), ...spanFields }).strict(),
    z.object({ kind: z.literal('provider-final'), ...spanFields, speaker: z.string().max(64).optional() }).strict(),
    z.object({ kind: z.literal('provider-revise'), ...providerFields, segmentId: IdSchema, text: z.string() }).strict(),
    z.object({ kind: z.literal('provider-retract'), ...providerFields, segmentId: IdSchema }).strict(),
    z
      .object({ kind: z.literal('user-correct'), baseRevision: SeqSchema, segmentId: IdSchema, text: z.string() })
      .strict(),
    z.object({ kind: z.literal('user-retract'), baseRevision: SeqSchema, segmentId: IdSchema }).strict(),
    z
      .object({
        kind: z.literal('language-change'),
        language: LanguageSchema,
        atMs: MsSchema,
        origin: z.enum(['provider', 'user'])
      })
      .strict(),
    z.object({ kind: z.literal('finalize') }).strict()
  ])
  .superRefine((event, context) => {
    if ('startMs' in event && 'endMs' in event && event.endMs < event.startMs)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'] })
  })

export function emptyTranscriptRevision(meetingStartedAt: number): TranscriptRevision {
  return {
    schema: TRANSCRIPT_REVISION_SCHEMA,
    meetingStartedAt,
    revision: 0,
    finalized: false,
    languages: [],
    segments: []
  }
}

type SpanEvent = Extract<RevisionEvent, { kind: 'provider-partial' | 'provider-final' }>
type ProviderEditEvent = Extract<RevisionEvent, { kind: 'provider-revise' | 'provider-retract' }>
type UserEditEvent = Extract<RevisionEvent, { kind: 'user-correct' | 'user-retract' }>
interface Candidate {
  segments: readonly TranscriptSegment[]
  languages: readonly string[]
  changed: string[]
  finalized: boolean
}

const encoder = new TextEncoder()
const utf8Bytes = (text: string): number => encoder.encode(text).length
const isConcrete = (language: string): boolean => language !== 'multi' && language !== 'und'
const currentLanguage = (rev: TranscriptRevision): string => rev.languages[rev.languages.length - 1] ?? 'und'
const freezeSegment = (segment: TranscriptSegment): TranscriptSegment => Object.freeze(segment)

function lastProviderSeq(rev: TranscriptRevision, relaySessionId: string, channel: 'mic' | 'system'): number {
  let last = -1
  for (const segment of rev.segments) {
    if (segment.relaySessionId === relaySessionId && segment.channel === channel && segment.providerSeq !== undefined)
      last = Math.max(last, segment.providerSeq)
  }
  return last
}

function replaceAt(segments: readonly TranscriptSegment[], index: number, next: TranscriptSegment) {
  return segments.map((segment, i) => (i === index ? next : segment))
}

function unchanged(rev: TranscriptRevision): Candidate {
  return { segments: rev.segments, languages: rev.languages, changed: [], finalized: false }
}

function reduceSpan(rev: TranscriptRevision, ev: SpanEvent): Candidate | RevisionRefusal {
  const { relaySessionId, channel } = ev
  if (ev.providerSeq <= lastProviderSeq(rev, relaySessionId, channel)) return 'duplicate'
  let latestFinal: TranscriptSegment | undefined
  let openIndex = -1
  for (let i = 0; i < rev.segments.length; i += 1) {
    const segment = rev.segments[i]
    if (segment.relaySessionId !== relaySessionId || segment.channel !== channel) continue
    if (segment.state === 'final') latestFinal = segment
    if (segment.state === 'partial') openIndex = i
  }
  if (latestFinal && ev.startMs < latestFinal.startMs) return 'out-of-order'
  const language = isConcrete(ev.language) ? ev.language : currentLanguage(rev)
  // `languages` is most-recent-last: a concrete language becomes current again by moving to the end.
  const languages =
    isConcrete(language) && language !== currentLanguage(rev)
      ? [...rev.languages.filter((l) => l !== language), language]
      : rev.languages
  const speaker = ev.kind === 'provider-final' && ev.speaker !== undefined ? { speaker: ev.speaker } : {}
  const open = openIndex >= 0 ? rev.segments[openIndex] : undefined
  let next: TranscriptSegment
  if (open) {
    next = { ...open, text: ev.text, endMs: ev.endMs, language, providerSeq: ev.providerSeq }
    if (ev.kind === 'provider-final') next = { ...next, state: 'final', startMs: ev.startMs, ...speaker }
  } else {
    const seq = rev.segments.reduce((max, segment) => Math.max(max, segment.seq), -1) + 1
    next = {
      segmentId: `seg-${seq}`,
      seq,
      channel,
      startMs: ev.startMs,
      endMs: ev.endMs,
      language,
      text: ev.text,
      state: ev.kind === 'provider-final' ? 'final' : 'partial',
      source: 'provider',
      relaySessionId,
      providerSeq: ev.providerSeq,
      ...speaker
    }
  }
  next = freezeSegment(next)
  const segments = open ? replaceAt(rev.segments, openIndex, next) : [...rev.segments, next]
  return { segments, languages, changed: [next.segmentId], finalized: false }
}

function reduceProviderEdit(rev: TranscriptRevision, ev: ProviderEditEvent): Candidate | RevisionRefusal {
  const index = rev.segments.findIndex((segment) => segment.segmentId === ev.segmentId)
  if (index < 0) return 'unknown-segment'
  const target = rev.segments[index]
  if (ev.providerSeq <= lastProviderSeq(rev, ev.relaySessionId, target.channel)) return 'duplicate'
  if (target.state === 'retracted') return ev.kind === 'provider-retract' ? 'duplicate' : 'invalid'
  if (target.source === 'user') return 'invalid'
  // Only the producing relay session may advance its own dedupe cursor.
  const seqPatch = target.relaySessionId === ev.relaySessionId ? { providerSeq: ev.providerSeq } : {}
  const next = freezeSegment(
    ev.kind === 'provider-revise'
      ? { ...target, text: ev.text, ...seqPatch }
      : { ...target, state: 'retracted', text: '', ...seqPatch }
  )
  return { ...unchanged(rev), segments: replaceAt(rev.segments, index, next), changed: [next.segmentId] }
}

function reduceUserEdit(rev: TranscriptRevision, ev: UserEditEvent): Candidate | RevisionRefusal {
  if (ev.baseRevision !== rev.revision) return 'stale-base'
  const index = rev.segments.findIndex((segment) => segment.segmentId === ev.segmentId)
  if (index < 0) return 'unknown-segment'
  const target = rev.segments[index]
  if (target.state === 'retracted') return 'invalid'
  const next = freezeSegment(
    ev.kind === 'user-correct'
      ? { ...target, state: 'corrected', source: 'user', text: ev.text }
      : { ...target, state: 'retracted', source: 'user', text: '' }
  )
  return { ...unchanged(rev), segments: replaceAt(rev.segments, index, next), changed: [next.segmentId] }
}

function reduce(rev: TranscriptRevision, ev: RevisionEvent): Candidate | RevisionRefusal {
  switch (ev.kind) {
    case 'provider-partial':
    case 'provider-final':
      return reduceSpan(rev, ev)
    case 'provider-revise':
    case 'provider-retract':
      return reduceProviderEdit(rev, ev)
    case 'user-correct':
    case 'user-retract':
      return reduceUserEdit(rev, ev)
    case 'language-change': {
      if (!isConcrete(ev.language)) return 'invalid'
      if (ev.language === currentLanguage(rev)) return 'duplicate'
      return { ...unchanged(rev), languages: [...rev.languages.filter((l) => l !== ev.language), ev.language] }
    }
    case 'finalize':
      return { ...unchanged(rev), finalized: true }
  }
}

function withinLimits(candidate: Candidate, limits: RevisionLimits): boolean {
  if (candidate.segments.length > limits.maxSegments) return false
  const changed = new Set(candidate.changed)
  let units = 0
  for (const segment of candidate.segments) {
    if (changed.has(segment.segmentId) && segment.text.length > limits.maxSegmentChars) return false
    units += segment.text.length
  }
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so most events skip the exact count.
  if (units * 3 <= limits.maxTotalBytes) return true
  let total = 0
  for (const segment of candidate.segments) {
    total += utf8Bytes(segment.text)
    if (total > limits.maxTotalBytes) return false
  }
  return true
}

/** Pure reducer: never mutates its inputs and returns a frozen next revision. */
export function applyRevisionEvent(rev: TranscriptRevision, ev: RevisionEvent, limits: RevisionLimits): ApplyResult {
  if (!RevisionEventSchema.safeParse(ev).success) return { ok: false, reason: 'invalid' }
  if (rev.finalized) return { ok: false, reason: 'finalized' }
  const candidate = reduce(rev, ev)
  if (typeof candidate === 'string') return { ok: false, reason: candidate }
  if (!withinLimits(candidate, limits)) return { ok: false, reason: 'over-limit' }
  const next: TranscriptRevision = Object.freeze({
    schema: TRANSCRIPT_REVISION_SCHEMA,
    meetingStartedAt: rev.meetingStartedAt,
    revision: rev.revision + 1,
    finalized: candidate.finalized,
    languages: Object.freeze([...candidate.languages]),
    segments: Object.freeze([...candidate.segments])
  })
  return { ok: true, next, changed: candidate.changed }
}
