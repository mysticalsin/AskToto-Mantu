import { z } from 'zod'

const VISION_EVIDENCE_BYTES_MAX = 64 * 1024

const utf8ByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length

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
