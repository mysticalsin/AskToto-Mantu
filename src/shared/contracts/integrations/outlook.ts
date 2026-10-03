import { z } from 'zod'

export const TimeSavedRecordPayloadSchema = z.object({
  kind: z.literal('email-summary')
})
export type TimeSavedRecordPayload = z.infer<typeof TimeSavedRecordPayloadSchema>

export const OutlookDraftPayloadSchema = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default('')
})
export type OutlookDraftPayload = z.infer<typeof OutlookDraftPayloadSchema>

export const OutlookEventPayloadSchema = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default(''),
  startIso: z.string().max(40).optional(),
  endIso: z.string().max(40).optional()
})
export type OutlookEventPayload = z.infer<typeof OutlookEventPayloadSchema>
