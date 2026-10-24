import { z } from 'zod'

/** Longest command or voice-turn capture. Main's sample and frame limits and the renderer worklet derive from this. */
export const COMMAND_SPEECH_MAX_SECONDS = 15

const CommandSpeechSessionIdSchema = z.string().regex(/^[a-f0-9]{48}$/)
export const CommandSpeechStartSchema = z.object({ sessionId: CommandSpeechSessionIdSchema }).strict()
export const CommandSpeechFrameSchema = z
  .object({
    sessionId: CommandSpeechSessionIdSchema,
    sequence: z.number().int().nonnegative(),
    samples: z.instanceof(Float32Array)
  })
  .strict()
export const CommandSpeechFinishSchema = z
  .object({
    sessionId: CommandSpeechSessionIdSchema,
    frameCount: z.number().int().nonnegative()
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
