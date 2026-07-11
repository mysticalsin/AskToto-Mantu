import { z } from 'zod'
import { MODEL_TIERS, PROVIDER_IDS, type ProviderId } from './providers'

export type LocalTask = 'suggest' | 'summary' | 'answer' | 'title' | 'classify' | 'cleanup'
export type LocalPriority = 'visible' | 'automatic' | 'speculative' | 'background'
export type LocalAiUnavailableReason =
  | 'missing-model'
  | 'hash-mismatch'
  | 'native-addon'
  | 'load-failed'
  | 'unsupported-platform'

export interface LocalAiStatus {
  ready: boolean
  model: string
  modelSha256: string
  backend?: 'metal' | 'vulkan' | 'cpu'
  reason?: LocalAiUnavailableReason
}

const SIGNED_INT32_MAX = 2_147_483_647
const APPEND_LINES_MAX = 64
const APPEND_BYTES_MAX = 64 * 1024
const RESYNC_LINES_MAX = 20_000
const RESYNC_BYTES_MAX = 2 * 1024 * 1024
const VISION_EVIDENCE_BYTES_MAX = 64 * 1024

const utf8ByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length
const RevisionSchema = z.number().int().nonnegative().max(SIGNED_INT32_MAX)

export const LocalTranscriptLineSchema = z
  .object({
    id: z.string().uuid(),
    speaker: z.enum(['them', 'you', 'unknown']),
    text: z.string().min(1).max(4000),
    t: z.number().int().nonnegative()
  })
  .strict()
export type LocalTranscriptLine = z.infer<typeof LocalTranscriptLineSchema>

export const LocalTranscriptBeginSchema = z
  .object({
    sessionId: z.string().uuid(),
    revision: z.literal(0),
    lines: z.array(LocalTranscriptLineSchema).max(APPEND_LINES_MAX)
  })
  .strict()
  .refine((value) => utf8ByteLength(value) <= APPEND_BYTES_MAX, {
    message: 'Transcript begin payload exceeds 64 KiB UTF-8.'
  })
export type LocalTranscriptBegin = z.infer<typeof LocalTranscriptBeginSchema>

export const LocalTranscriptAppendSchema = z
  .object({
    sessionId: z.string().uuid(),
    baseRevision: RevisionSchema,
    revision: RevisionSchema,
    lines: z.array(LocalTranscriptLineSchema).max(APPEND_LINES_MAX)
  })
  .strict()
  .refine((value) => value.revision === value.baseRevision + 1, {
    message: 'revision must equal baseRevision + 1',
    path: ['revision']
  })
  .refine((value) => utf8ByteLength(value) <= APPEND_BYTES_MAX, {
    message: 'Transcript append payload exceeds 64 KiB UTF-8.'
  })
export type LocalTranscriptAppend = z.infer<typeof LocalTranscriptAppendSchema>

export const LocalTranscriptResyncSchema = z
  .object({
    sessionId: z.string().uuid(),
    revision: RevisionSchema,
    lines: z.array(LocalTranscriptLineSchema).max(RESYNC_LINES_MAX)
  })
  .strict()
  .refine((value) => utf8ByteLength(value) <= RESYNC_BYTES_MAX, {
    message: 'Transcript resync payload exceeds 2 MiB UTF-8.'
  })
export type LocalTranscriptResync = z.infer<typeof LocalTranscriptResyncSchema>

export const LocalTranscriptEndSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict()
export type LocalTranscriptEnd = z.infer<typeof LocalTranscriptEndSchema>

export const LocalTranscriptAckSchema = z
  .object({
    revision: RevisionSchema,
    resyncRequired: z.boolean(),
    expectedRevision: RevisionSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.resyncRequired
        ? value.expectedRevision !== undefined
        : value.expectedRevision === undefined,
    {
      message: 'expectedRevision is required exactly when resyncRequired is true',
      path: ['expectedRevision']
    }
  )
export type LocalTranscriptAck = z.infer<typeof LocalTranscriptAckSchema>

const LocalVisionRegionSchema = z
  .object({
    text: z.string().min(1).max(1000),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()])
  })
  .strict()
  .refine((region) => region.box.every((coordinate) => coordinate >= 0 && coordinate <= 1), {
    message: 'Region coordinates must be normalized between 0 and 1.',
    path: ['box']
  })
  .refine((region) => region.box[2] >= region.box[0], {
    message: 'Region x2 must be greater than or equal to x1.',
    path: ['box']
  })
  .refine((region) => region.box[3] >= region.box[1], {
    message: 'Region y2 must be greater than or equal to y1.',
    path: ['box']
  })

export const LocalVisionEvidenceSchema = z
  .object({
    version: z.literal(1),
    modelId: z.string().min(1).max(128),
    modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
    capturedAt: z.number().int().nonnegative(),
    backend: z.enum(['wasm', 'webgpu']),
    capabilities: z
      .array(z.enum(['caption', 'text', 'ocr', 'regions']))
      .min(1)
      .max(4)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
        message: 'Vision capabilities must be unique.'
      }),
    caption: z.string().max(8000),
    text: z.string().max(32000),
    regions: z.array(LocalVisionRegionSchema).max(200)
  })
  .strict()
  .refine((value) => utf8ByteLength(value) <= VISION_EVIDENCE_BYTES_MAX, {
    message: 'Vision evidence payload exceeds 64 KiB UTF-8.'
  })
export type LocalVisionEvidence = z.infer<typeof LocalVisionEvidenceSchema>

const FutureProviderIdSchema = z.custom<ProviderId>(
  (value): value is ProviderId =>
    typeof value === 'string' && PROVIDER_IDS.includes(value as ProviderId),
  'Unknown provider.'
)

/** Task 6 migrates the current renderer StreamMeta contract to this union atomically. */
export const FutureStreamMetaSchema = z.discriminatedUnion('executor', [
  z
    .object({
      id: z.string(),
      executor: z.literal('local'),
      tier: z.literal('base'),
      model: z.string()
    })
    .strict(),
  z
    .object({
      id: z.string(),
      executor: z.literal('provider'),
      tier: z.enum(MODEL_TIERS),
      provider: FutureProviderIdSchema
    })
    .strict()
])
export type FutureStreamMeta = z.infer<typeof FutureStreamMetaSchema>
