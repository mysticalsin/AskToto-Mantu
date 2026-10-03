import { z } from 'zod'
import { RENDERER_VIEWS } from '../../renderer-view'

export const LiveMeetingStartedAtSchema = z.number().int().positive().max(8.64e15)
export const ListeningStatePayloadSchema = z.object({
  on: z.boolean(),
  startedAt: LiveMeetingStartedAtSchema.optional()
})
export type ListeningStatePayload = z.infer<typeof ListeningStatePayloadSchema>

export type PreservedBrainIndexCopy = {
  id: string
  createdAt: number
  size: number
  restorable: boolean
}

export type PreservedBrainIndexListResult = {
  copies: PreservedBrainIndexCopy[]
}

export const RendererCrashContextSchema = z.object({ view: z.enum(RENDERER_VIEWS), listening: z.boolean() })
export type RendererCrashContext = z.infer<typeof RendererCrashContextSchema>
export interface RendererCrashReport extends RendererCrashContext {
  message: string
  stack?: string
  componentStack?: string
}
