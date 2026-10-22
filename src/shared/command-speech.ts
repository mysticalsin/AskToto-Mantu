import { z } from 'zod'

const CommandSpeechSessionIdSchema = z.string().regex(/^[a-f0-9]{48}$/)
export const CommandSpeechStartSchema = z.object({ sessionId: CommandSpeechSessionIdSchema }).strict()
export const CommandSpeechFrameSchema = z
  .object({
    sessionId: CommandSpeechSessionIdSchema,
    sequence: z.number().int().nonnegative().safe(),
    samples: z.instanceof(Float32Array)
  })
  .strict()
export const CommandSpeechFinishSchema = z
  .object({
    sessionId: CommandSpeechSessionIdSchema,
    frameCount: z.number().int().nonnegative().safe()
  })
  .strict()
export const CommandSpeechCancelSchema = z.object({ sessionId: CommandSpeechSessionIdSchema }).strict()
export type CommandSpeechResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'policy_blocked'
        | 'unsupported_engine'
        | 'busy'
        | 'stale'
        | 'invalid'
        | 'no_speech'
        | 'recognition_unavailable'
    }
export type CommandMicAvailabilityResult =
  | { ok: true }
  | { ok: false; reason: 'policy_blocked' | 'unsupported_engine' | 'unauthorized' }
