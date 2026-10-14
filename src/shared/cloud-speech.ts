import { z } from 'zod'
import { CaptureSchema, SpeechSegmentSchema, SpeechStreamRefSchema, TrackSchema } from './contracts/speech'

/** Versioned, fixed channels for the separately gated cloud speech path. */
export const CLOUD_SPEECH_IPC = {
  capability: 'cloud-speech:v1:capability',
  start: 'cloud-speech:v1:start',
  frame: 'cloud-speech:v1:frame',
  finish: 'cloud-speech:v1:finish',
  cancel: 'cloud-speech:v1:cancel',
  status: 'cloud-speech:v1:status',
  transitionAck: 'cloud-speech:v1:transition-ack',
  event: 'cloud-speech:v1:event'
} as const

export const CLOUD_SPEECH_DISCLOSURE_VERSION = 'cloud-speech-v1' as const
export const CLOUD_SPEECH_FULL_FRAME_BYTES = 3_200
export const CLOUD_SPEECH_MAX_PENDING_FRAMES = 20
export const CLOUD_SPEECH_MAX_PENDING_BYTES = 64 * 1024
export const CLOUD_SPEECH_MAX_PENDING_AUDIO_MS = 2_000
export const CLOUD_SPEECH_MAX_PRELOAD_FRAME_INVOKES = 2
export const CLOUD_SPEECH_MAX_EVENT_SUBSCRIPTIONS = 2
export const CLOUD_SPEECH_MAX_EVENT_TEXT = 8_192
export const CLOUD_SPEECH_MAX_WORDS = 256
export const CLOUD_SPEECH_MAX_LANGUAGES = 8

export const CloudSpeechEngineSchema = z.enum(['deepgram-nova3', 'cloudflare-nova3'])
export type CloudSpeechEngine = z.infer<typeof CloudSpeechEngineSchema>

const CaptureIdSchema = z.string().uuid()
const CounterSchema = z.number().int().positive().safe()
const OffsetSchema = z.number().int().nonnegative().safe()
const HandoffNonceSchema = z.string().uuid()
const LanguageSchema = z
  .string()
  .regex(/^(?:auto|multi|[a-z]{2}(?:-[A-Z]{2})?)$/)
  .max(8)
const RefusalCodeSchema = z.enum([
  'DISABLED',
  'AUTH',
  'POLICY',
  'CONSENT',
  'NOT_READY',
  'NOT_CONFIGURED',
  'STALE',
  'CLOSED',
  'ORDER',
  'QUEUE_LIMIT',
  'QUEUE_STALE',
  'TRANSPORT',
  'TIMEOUT',
  'CLOSURE_UNCONFIRMED',
  'INVALID_REQUEST'
])
export type CloudSpeechRefusalCode = z.infer<typeof RefusalCodeSchema>

const RouteSelectionSchema = z
  .object({
    engine: CloudSpeechEngineSchema,
    routeId: z.enum(['deepgram-via-gateway', 'workers-ai-nova3']),
    modelId: z.enum(['nova-3', '@cf/deepgram/nova-3'])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.engine === 'deepgram-nova3' && (value.routeId !== 'deepgram-via-gateway' || value.modelId !== 'nova-3'))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routeId'] })
    if (
      value.engine === 'cloudflare-nova3' &&
      (value.routeId !== 'workers-ai-nova3' || value.modelId !== '@cf/deepgram/nova-3')
    )
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routeId'] })
  })
export type CloudSpeechRouteSelection = z.infer<typeof RouteSelectionSchema>

export const CloudSpeechCapabilitySchema = z
  .object({
    disclosureVersion: z.literal(CLOUD_SPEECH_DISCLOSURE_VERSION),
    selected: RouteSelectionSchema.nullable(),
    allowed: z.array(RouteSelectionSchema).max(2),
    ready: z.boolean(),
    refusal: RefusalCodeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.allowed.map((route) => `${route.engine}:${route.routeId}:${route.modelId}`)
    if (new Set(keys).size !== keys.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['allowed'] })
    const selectedKey = value.selected
      ? `${value.selected.engine}:${value.selected.routeId}:${value.selected.modelId}`
      : null
    if (value.ready && (!selectedKey || value.refusal !== null || !keys.includes(selectedKey)))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['ready'] })
    if (!value.ready && value.refusal === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['refusal'] })
    if (value.refusal !== null && value.ready) context.addIssue({ code: z.ZodIssueCode.custom, path: ['refusal'] })
  })
export type CloudSpeechCapability = z.infer<typeof CloudSpeechCapabilitySchema>

export const CloudSpeechStartRequestSchema = z
  .object({
    captureId: CaptureIdSchema,
    capture: CaptureSchema,
    language: LanguageSchema,
    consent: z
      .object({ accepted: z.literal(true), disclosureVersion: z.literal(CLOUD_SPEECH_DISCLOSURE_VERSION) })
      .strict()
  })
  .strict()
  .superRefine((request, context) => {
    if (!CloudSpeechEngineSchema.safeParse(request.capture.engine).success)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['capture', 'engine'] })
    if (request.capture.capturedTracks.length === 0)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['capture', 'capturedTracks'] })
  })
export type CloudSpeechStartRequest = z.infer<typeof CloudSpeechStartRequestSchema>

/** Built-in ArrayBuffer accessors brand-check the value; own `byteLength` properties are not trusted. */
function fixedArrayBufferByteLength(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return null
  const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
  if (!byteLengthGetter) return null
  try {
    const byteLength = byteLengthGetter.call(value) as number
    const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (resizableGetter?.call(value) === true) return null
    return Number.isSafeInteger(byteLength) && byteLength > 0 ? byteLength : null
  } catch {
    return null
  }
}

const Pcm16ArrayBufferSchema = z.custom<ArrayBuffer>((value): value is ArrayBuffer => {
  const length = fixedArrayBufferByteLength(value)
  return length !== null && length <= CLOUD_SPEECH_FULL_FRAME_BYTES && length % 2 === 0
})

export const CloudSpeechFrameSchema = z
  .object({
    captureId: CaptureIdSchema,
    captureGeneration: CounterSchema,
    track: TrackSchema,
    sequence: CounterSchema,
    sampleOffset: OffsetSchema,
    kind: z.enum(['full', 'sealed-final']),
    pcm16le: Pcm16ArrayBufferSchema
  })
  .strict()
  .superRefine((frame, context) => {
    const byteLength = fixedArrayBufferByteLength(frame.pcm16le)
    if (byteLength === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pcm16le'] })
      return
    }
    if (frame.kind === 'full' && byteLength !== CLOUD_SPEECH_FULL_FRAME_BYTES)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pcm16le'] })
    if (frame.kind === 'sealed-final' && (byteLength < 2 || byteLength >= CLOUD_SPEECH_FULL_FRAME_BYTES))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pcm16le'] })
    if (!Number.isSafeInteger(frame.sequence + 1)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sequence'] })
    if (!Number.isSafeInteger(frame.sampleOffset + byteLength / 2))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sampleOffset'] })
  })
export type CloudSpeechFrame = z.infer<typeof CloudSpeechFrameSchema>

const CaptureIdentitySchema = z.object({ captureId: CaptureIdSchema, captureGeneration: CounterSchema }).strict()
export type CloudSpeechCaptureIdentity = z.infer<typeof CaptureIdentitySchema>

const FinishTrackSchema = z
  .object({ track: TrackSchema, finalSequence: OffsetSchema, finalSampleOffset: OffsetSchema })
  .strict()

export const CloudSpeechFinishRequestSchema = CaptureIdentitySchema.extend({
  tracks: z.array(FinishTrackSchema).min(1).max(2)
})
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.tracks.map((item) => item.track)).size !== request.tracks.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
    if (request.tracks.some((item) => item.finalSequence === 0 && item.finalSampleOffset !== 0))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
  })
export type CloudSpeechFinishRequest = z.infer<typeof CloudSpeechFinishRequestSchema>

export const CloudSpeechCancelRequestSchema = CaptureIdentitySchema
export type CloudSpeechCancelRequest = z.infer<typeof CloudSpeechCancelRequestSchema>
export const CloudSpeechStatusRequestSchema = CaptureIdentitySchema
export type CloudSpeechStatusRequest = z.infer<typeof CloudSpeechStatusRequestSchema>

const FailureSchema = z
  .object({
    ok: z.literal(false),
    code: RefusalCodeSchema,
    captureId: CaptureIdSchema.optional(),
    captureGeneration: CounterSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.captureId === undefined) !== (result.captureGeneration === undefined))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureGeneration'] })
  })
export type CloudSpeechFailure = z.infer<typeof FailureSchema>

const StreamEpochSchema = z.object({ track: TrackSchema, streamEpoch: CounterSchema }).strict()
const LimitsSchema = z
  .object({
    frameBytes: z.literal(CLOUD_SPEECH_FULL_FRAME_BYTES),
    maxPendingFrames: z.literal(CLOUD_SPEECH_MAX_PENDING_FRAMES),
    maxPendingBytes: z.literal(CLOUD_SPEECH_MAX_PENDING_BYTES),
    maxPendingAudioMs: z.literal(CLOUD_SPEECH_MAX_PENDING_AUDIO_MS)
  })
  .strict()

export const CloudSpeechStartResultSchema = z
  .union([
    FailureSchema,
    z
      .object({
        ok: z.literal(true),
        captureId: CaptureIdSchema,
        captureGeneration: CounterSchema,
        engine: CloudSpeechEngineSchema,
        streams: z.array(StreamEpochSchema).min(1).max(2),
        limits: LimitsSchema
      })
      .strict()
  ])
  .superRefine((result, context) => {
    if (!result.ok) return
    const tracks = result.streams.map((stream) => stream.track)
    if (new Set(tracks).size !== tracks.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['streams'] })
  })
export type CloudSpeechStartResult = z.infer<typeof CloudSpeechStartResultSchema>

export const CloudSpeechFrameResultSchema = z.union([
  FailureSchema,
  z
    .object({
      ok: z.literal(true),
      captureId: CaptureIdSchema,
      captureGeneration: CounterSchema,
      track: TrackSchema,
      sequence: CounterSchema,
      nextSequence: CounterSchema,
      nextSampleOffset: OffsetSchema
    })
    .strict()
    .superRefine((ack, context) => {
      if (ack.nextSequence !== ack.sequence + 1)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextSequence'] })
    })
])
export type CloudSpeechFrameResult = z.infer<typeof CloudSpeechFrameResultSchema>

const ClosureReasonSchema = z.enum([
  'normal',
  'cancelled',
  'lease-expired',
  'upstream-error',
  'client-disconnected',
  'limit',
  'revoked',
  'unknown'
])
const TrackClosureSchema = z
  .object({
    stream: SpeechStreamRefSchema,
    lastSequence: OffsetSchema,
    closeConfirmed: z.boolean(),
    tail: z.enum(['complete', 'incomplete']),
    reason: ClosureReasonSchema
  })
  .strict()
  .superRefine((track, context) => {
    if (track.tail === 'complete' && !track.closeConfirmed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['closeConfirmed'] })
  })

export const CloudSpeechFinishResultSchema = z.union([
  FailureSchema,
  z
    .object({
      ok: z.literal(true),
      captureId: CaptureIdSchema,
      captureGeneration: CounterSchema,
      complete: z.boolean(),
      tracks: z.array(TrackClosureSchema).min(1).max(2),
      reason: z.enum(['normal', 'incomplete', 'cancelled'])
    })
    .strict()
    .superRefine((result, context) => {
      if (new Set(result.tracks.map((track) => track.stream.track)).size !== result.tracks.length)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.tracks.some((track) => track.stream.generation !== result.captureGeneration))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.complete && result.tracks.some((track) => !track.closeConfirmed || track.tail !== 'complete'))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['complete'] })
      if (result.complete !== (result.reason === 'normal'))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'] })
    })
])
export type CloudSpeechFinishResult = z.infer<typeof CloudSpeechFinishResultSchema>

export const CloudSpeechCancelResultSchema = z.union([
  FailureSchema,
  z
    .object({
      ok: z.literal(true),
      captureId: CaptureIdSchema,
      captureGeneration: CounterSchema,
      closure: z.enum(['confirmed', 'unknown'])
    })
    .strict()
])
export type CloudSpeechCancelResult = z.infer<typeof CloudSpeechCancelResultSchema>

const StatusTrackSchema = z
  .object({
    stream: SpeechStreamRefSchema,
    phase: z.enum(['connecting', 'open', 'closing', 'closed']),
    lastSequence: OffsetSchema,
    closeConfirmed: z.boolean(),
    tail: z.enum(['complete', 'incomplete']).nullable()
  })
  .strict()
  .superRefine((track, context) => {
    if (track.tail === 'complete' && !track.closeConfirmed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['closeConfirmed'] })
    if (track.phase !== 'closed' && track.closeConfirmed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['phase'] })
    if (track.phase === 'closed' && !track.closeConfirmed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['closeConfirmed'] })
    if (track.phase !== 'closed' && track.tail !== null)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['tail'] })
  })

export const CloudSpeechStatusResultSchema = z.union([
  FailureSchema,
  z
    .object({
      ok: z.literal(true),
      captureId: CaptureIdSchema,
      captureGeneration: CounterSchema,
      state: z.enum(['active', 'closing', 'closed', 'unknown']),
      tracks: z.array(StatusTrackSchema).max(2)
    })
    .strict()
    .superRefine((result, context) => {
      if (new Set(result.tracks.map((track) => track.stream.track)).size !== result.tracks.length)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.tracks.some((track) => track.stream.generation !== result.captureGeneration))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.state !== 'unknown' && result.tracks.length === 0)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.state === 'closed' && result.tracks.some((track) => !track.closeConfirmed || track.phase !== 'closed'))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (
        result.state === 'active' &&
        result.tracks.some((track) => track.phase === 'closing' || track.phase === 'closed')
      )
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
      if (result.state === 'closing' && result.tracks.every((track) => track.phase === 'closed'))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
    })
])
export type CloudSpeechStatusResult = z.infer<typeof CloudSpeechStatusResultSchema>

const WordSchema = z
  .object({
    text: z.string().min(1).max(256),
    punctuatedWord: z.string().max(256).optional(),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    language: z
      .string()
      .regex(/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/)
      .max(5)
      .optional(),
    speaker: z.number().int().min(0).max(1_000).optional()
  })
  .strict()
  .superRefine((word, context) => {
    if (word.endMs < word.startMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMs'] })
  })

const SegmentEventSchema = z
  .object({
    type: z.literal('segment'),
    captureId: CaptureIdSchema,
    captureGeneration: CounterSchema,
    sequence: CounterSchema,
    segment: SpeechSegmentSchema,
    languages: z
      .array(
        z
          .string()
          .regex(/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/)
          .max(5)
      )
      .max(CLOUD_SPEECH_MAX_LANGUAGES)
      .optional(),
    words: z.array(WordSchema).max(CLOUD_SPEECH_MAX_WORDS).optional()
  })
  .strict()
  .superRefine((event, context) => {
    if (event.segment.stream.generation !== event.captureGeneration)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segment', 'stream', 'generation'] })
    if (!CloudSpeechEngineSchema.safeParse(event.segment.engine).success)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segment', 'engine'] })
    if (event.segment.text.length > CLOUD_SPEECH_MAX_EVENT_TEXT)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segment', 'text'] })
    if (event.words?.some((word) => word.startMs < event.segment.startMs || word.endMs > event.segment.endMs))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['words'] })
  })

/** Public schema for optional persisted final provenance; the event wire contract is unchanged. */
export const CloudSpeechSegmentEventSchema = SegmentEventSchema

const TerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    captureId: CaptureIdSchema,
    captureGeneration: CounterSchema,
    stream: SpeechStreamRefSchema,
    lastSequence: OffsetSchema,
    closeConfirmed: z.boolean(),
    tail: z.enum(['complete', 'incomplete']),
    reason: ClosureReasonSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.stream.generation !== event.captureGeneration)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['stream', 'generation'] })
    if (event.tail === 'complete' && !event.closeConfirmed)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['closeConfirmed'] })
  })

const EpochClosedTrackSchema = z
  .object({ track: TrackSchema, previousEpoch: CounterSchema, lastSequence: OffsetSchema })
  .strict()
const EpochOpenedTrackSchema = z
  .object({
    track: TrackSchema,
    previousEpoch: CounterSchema,
    nextEpoch: CounterSchema,
    lastSequence: OffsetSchema
  })
  .strict()
  .superRefine((track, context) => {
    if (track.nextEpoch <= track.previousEpoch) context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextEpoch'] })
  })

const EpochTransitionIdentitySchema = z
  .object({
    captureId: CaptureIdSchema,
    captureGeneration: CounterSchema,
    transitionId: CounterSchema,
    handoffNonce: HandoffNonceSchema
  })
  .strict()

function refineUniqueEpochTracks(value: { streams: Array<{ track: string }> }, context: z.RefinementCtx): void {
  if (value.streams.length < 1 || value.streams.length > 2)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['streams'] })
  if (new Set(value.streams.map(({ track }) => track)).size !== value.streams.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['streams'] })
}

export const CloudSpeechEpochTransitionEventSchema = z
  .discriminatedUnion('stage', [
    EpochTransitionIdentitySchema.extend({
      type: z.literal('epoch-transition'),
      stage: z.literal('closed'),
      streams: z.array(EpochClosedTrackSchema).min(1).max(2)
    }).strict(),
    EpochTransitionIdentitySchema.extend({
      type: z.literal('epoch-transition'),
      stage: z.literal('opened'),
      streams: z.array(EpochOpenedTrackSchema).min(1).max(2)
    }).strict()
  ])
  .superRefine(refineUniqueEpochTracks)
export type CloudSpeechEpochTransitionEvent = z.infer<typeof CloudSpeechEpochTransitionEventSchema>

export const CloudSpeechEpochTransitionAckSchema = z
  .discriminatedUnion('stage', [
    EpochTransitionIdentitySchema.extend({
      type: z.literal('epoch-transition-ack'),
      stage: z.literal('closed'),
      streams: z.array(EpochClosedTrackSchema).min(1).max(2)
    }).strict(),
    EpochTransitionIdentitySchema.extend({
      type: z.literal('epoch-transition-ack'),
      stage: z.literal('opened'),
      streams: z.array(EpochOpenedTrackSchema).min(1).max(2)
    }).strict()
  ])
  .superRefine(refineUniqueEpochTracks)
export type CloudSpeechEpochTransitionAck = z.infer<typeof CloudSpeechEpochTransitionAckSchema>

export const CloudSpeechEpochTransitionAckResultSchema = z.union([
  FailureSchema,
  EpochTransitionIdentitySchema.extend({
    ok: z.literal(true),
    stage: z.enum(['closed', 'opened'])
  }).strict()
])
export type CloudSpeechEpochTransitionAckResult = z.infer<typeof CloudSpeechEpochTransitionAckResultSchema>

export const CloudSpeechEventSchema = z.union([
  SegmentEventSchema,
  TerminalEventSchema,
  CloudSpeechEpochTransitionEventSchema
])
export type CloudSpeechEvent = z.infer<typeof CloudSpeechEventSchema>

export const CloudSpeechIdentitySchema = CaptureIdentitySchema
