import { z } from 'zod'

export const RELAY_RESULT_MAX_TEXT = 8_192
export const RELAY_RESULT_MAX_WORDS = 256
export const RELAY_RESULT_MAX_LANGUAGES = 8

const TrackSchema = z.enum(['microphone', 'system'])
const LanguageSchema = z
  .string()
  .regex(/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/)
  .max(5)
const WordSchema = z
  .object({
    text: z.string().min(1).max(256),
    punctuatedWord: z.string().max(256).optional(),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    language: LanguageSchema.optional(),
    speaker: z.number().int().min(0).max(1000).optional()
  })
  .strict()
  .superRefine((word, context) => {
    if (word.endMs < word.startMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'] })
  })

const IdentitySchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: z.string().uuid(),
  captureGeneration: z.number().int().positive().safe(),
  track: TrackSchema,
  streamEpoch: z.number().int().positive().safe()
})

const TranscriptSchema = IdentitySchema.extend({
  type: z.literal('transcript'),
  sequence: z.number().int().positive().safe(),
  segmentIndex: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  text: z.string().max(RELAY_RESULT_MAX_TEXT),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  final: z.boolean(),
  languages: z.array(LanguageSchema).max(RELAY_RESULT_MAX_LANGUAGES).optional(),
  words: z.array(WordSchema).max(RELAY_RESULT_MAX_WORDS).optional()
})
  .strict()
  .superRefine((event, context) => {
    if (event.endMs < event.startMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'] })
    if (event.words?.some((word) => word.startMs < event.startMs || word.endMs > event.endMs))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['words'] })
  })

const TerminalSchema = IdentitySchema.extend({
  type: z.literal('terminal'),
  lastSequence: z.number().int().nonnegative().safe(),
  closeConfirmed: z.literal(true),
  tail: z.enum(['complete', 'incomplete']),
  reason: z.enum([
    'normal',
    'cancelled',
    'lease-expired',
    'upstream-error',
    'client-disconnected',
    'limit',
    'revoked',
    'unknown'
  ])
}).strict()

const ErrorSchema = IdentitySchema.extend({
  type: z.literal('error'),
  code: z.literal('UPSTREAM_UNAVAILABLE')
}).strict()

const RelayEventSchema = z.union([TranscriptSchema, TerminalSchema, ErrorSchema])

export type RelayIdentity = z.infer<typeof IdentitySchema>
export type RelayTranscript = z.infer<typeof TranscriptSchema>
export type RelayTerminal = z.infer<typeof TerminalSchema>
export type RelayEvent = z.infer<typeof RelayEventSchema>
export type RelayResultFailureCode =
  | 'MALFORMED'
  | 'IDENTITY'
  | 'SEQUENCE'
  | 'REVISION'
  | 'AFTER_FINAL'
  | 'TERMINAL_MISMATCH'
  | 'AFTER_TERMINAL'

export type RelayResultAcceptance = { ok: true; event: RelayEvent } | { ok: false; code: RelayResultFailureCode }

type SegmentState = { revision: number; final: boolean; startMs: number }

/**
 * Strictly validates relay messages and their stream ordering. Status recovery never calls this class:
 * it cannot supply a lost transcript event and therefore cannot repair a sequence gap.
 */
export class RelayResultSequence {
  private readonly segments = new Map<number, SegmentState>()
  private lastSequence = 0
  private terminal = false

  constructor(
    private readonly expected: RelayIdentity,
    private readonly maxStreamMs: number
  ) {}

  accept(value: unknown): RelayResultAcceptance {
    if (this.terminal) return { ok: false, code: 'AFTER_TERMINAL' }
    const parsed = RelayEventSchema.safeParse(value)
    if (!parsed.success) return { ok: false, code: 'MALFORMED' }
    const event = parsed.data
    if (
      event.protocolVersion !== this.expected.protocolVersion ||
      event.sessionId !== this.expected.sessionId ||
      event.captureGeneration !== this.expected.captureGeneration ||
      event.track !== this.expected.track ||
      event.streamEpoch !== this.expected.streamEpoch
    )
      return { ok: false, code: 'IDENTITY' }

    if (event.type === 'transcript') {
      if (event.endMs > this.maxStreamMs) return { ok: false, code: 'MALFORMED' }
      if (event.sequence !== this.lastSequence + 1) return { ok: false, code: 'SEQUENCE' }
      const prior = this.segments.get(event.segmentIndex)
      if (prior?.final) return { ok: false, code: 'AFTER_FINAL' }
      if (prior) {
        if (event.revision !== prior.revision + 1 || event.startMs !== prior.startMs)
          return { ok: false, code: 'REVISION' }
      } else if (event.revision !== 1 || event.segmentIndex !== this.segments.size + 1) {
        return { ok: false, code: 'REVISION' }
      }
      this.segments.set(event.segmentIndex, {
        revision: event.revision,
        final: event.final,
        startMs: event.startMs
      })
      this.lastSequence = event.sequence
      return { ok: true, event }
    }

    if (event.type === 'terminal') {
      if (event.lastSequence !== this.lastSequence) return { ok: false, code: 'TERMINAL_MISMATCH' }
      this.terminal = true
    }
    return { ok: true, event }
  }
}
