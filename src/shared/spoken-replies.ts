/**
 * The spoken replies contract shared by main, the preload bridge and the renderer (G27).
 *
 * Channels live here, not in ipc.ts, so the feature adds no lines to that file. Nothing in this contract carries
 * reply text or a transcript: the renderer can ask for a preview or a stop, and it can read a state snapshot and the
 * approved voice list. It can never hand main text to speak.
 */
import { z } from 'zod'

export const SPOKEN_REPLIES_IPC = {
  /** renderer -> main: the current state snapshot. */
  getState: 'spokenReplies:getState',
  /** main -> renderer: the state changed. */
  state: 'spokenReplies:state',
  /** renderer -> main: the approved voice list (installed system voices only). */
  voices: 'spokenReplies:voices',
  /** renderer -> main: play the fixed preview sentence; a second call or a stop interrupts it. */
  preview: 'spokenReplies:preview',
  /** renderer -> main: stop whatever is playing. */
  stop: 'spokenReplies:stop'
} as const

/** The fixed preview sentence. It is the only text the renderer can cause to be spoken, and it is not typed by anyone. */
export const SPOKEN_REPLIES_PREVIEW_TEXT = 'This is how Métis will sound when it reads an answer aloud.'

export const TtsVoiceSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    /** BCP-47 tag as the platform reports it, for example `en-US`. */
    language: z.string().max(35)
  })
  .strict()
export type TtsVoice = z.infer<typeof TtsVoiceSchema>

export const MAX_APPROVED_VOICES = 100
export const TtsVoiceListSchema = z.array(TtsVoiceSchema).max(MAX_APPROVED_VOICES)

/** `voiceId` and `rate` are the pending choice in Settings, so the preview can play before it is saved. */
export const PreviewRequestSchema = z
  .object({
    voiceId: z.string().max(200).nullable().optional(),
    rate: z.number().optional()
  })
  .strict()
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>

export const SPOKEN_REPLIES_PLAYBACK = ['idle', 'reply', 'preview'] as const
/** Why a reply will not be heard. The text is on screen in every one of these cases. */
export const SPOKEN_REPLIES_MUTED = ['off', 'unavailable', 'meeting'] as const

export const SpokenRepliesStateSchema = z
  .object({
    revision: z.number().int().min(0),
    /** A platform voice engine exists and has not failed. */
    available: z.boolean(),
    playback: z.enum(SPOKEN_REPLIES_PLAYBACK),
    /** null while a reply would be spoken. */
    muted: z.enum(SPOKEN_REPLIES_MUTED).nullable(),
    /** The playback generation. It rises with every new input and is never reused. */
    generation: z.number().int().min(0)
  })
  .strict()
export type SpokenRepliesState = z.infer<typeof SpokenRepliesStateSchema>
