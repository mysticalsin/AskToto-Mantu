import { z } from 'zod'

export const OCR_READING_ORDER_ROW_TOLERANCE = 0.025
export const OCR_MAX_LINES = 200
export const OCR_MAX_WORDS = 2_000

const finite = z.number().finite()
export const OcrBoxSchema = z.object({
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
  width: finite.min(0).max(1),
  height: finite.min(0).max(1)
}).strict().superRefine((box, ctx) => {
  if (box.x + box.width > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'box exceeds image width' })
  if (box.y + box.height > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: 'box exceeds image height' })
})

const confidence = finite.min(0).max(1).nullable()

export const OcrLineSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  confidence,
  box: OcrBoxSchema
}).strict()

export const OcrWordSchema = z.object({
  text: z.string().min(1),
  confidence,
  box: OcrBoxSchema,
  lineId: z.string().min(1)
}).strict()

export const OcrResultSchema = z.object({
  image: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict(),
  coverage: z.literal('VISIBLE_ONLY'),
  untrustedContent: z.literal(true),
  truncated: z.object({
    lines: z.boolean(),
    words: z.boolean()
  }).strict(),
  lines: z.array(OcrLineSchema).max(OCR_MAX_LINES),
  words: z.array(OcrWordSchema).max(OCR_MAX_WORDS)
}).strict().superRefine((result, ctx) => {
  const lineIds = new Set<string>()
  for (const [index, line] of result.lines.entries()) {
    if (lineIds.has(line.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', index, 'id'], message: 'duplicate line id' })
    }
    lineIds.add(line.id)
  }
  for (const [index, word] of result.words.entries()) {
    if (!lineIds.has(word.lineId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['words', index, 'lineId'], message: 'word references an unknown line' })
    }
  }
  assertReadingOrder(result.lines, ['lines'], ctx)
  assertReadingOrder(result.words, ['words'], ctx)
})

export type OcrBox = z.infer<typeof OcrBoxSchema>
export type OcrLine = z.infer<typeof OcrLineSchema>
export type OcrWord = z.infer<typeof OcrWordSchema>
export type OcrResult = z.infer<typeof OcrResultSchema>

function readingCompare(a: { box: OcrBox }, b: { box: OcrBox }): number {
  const dy = a.box.y - b.box.y
  if (Math.abs(dy) > OCR_READING_ORDER_ROW_TOLERANCE) return dy
  return a.box.x - b.box.x
}

function assertReadingOrder<T extends { box: OcrBox }>(
  items: T[],
  path: Array<string | number>,
  ctx: z.RefinementCtx
): void {
  for (let i = 1; i < items.length; i++) {
    if (readingCompare(items[i - 1]!, items[i]!) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i],
        message: `items must be sorted in reading order: rows by y within ${OCR_READING_ORDER_ROW_TOLERANCE}, then x`
      })
      return
    }
  }
}

export function parseOcrResult(value: unknown): OcrResult {
  return OcrResultSchema.parse(value)
}
