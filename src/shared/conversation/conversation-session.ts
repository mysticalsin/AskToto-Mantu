/**
 * The continuous conversation contract shared by main and the renderer (G28).
 *
 * A conversation is an explicit, bounded session of voice turns. Main owns it: only a deliberate user action starts
 * it, it is always visible while it runs (the indicator reads this snapshot), it expires by itself, and it can be
 * stopped from any surface. The renderer only renders the snapshot. Nothing here carries audio, a transcript, a
 * query or an app name: a session is an id, a state, deadlines, a machine reason and a fixed-copy message.
 */
import { z } from 'zod'
import { COMMAND_SPEECH_MAX_SECONDS } from '../command-speech'

/** Channels live here, not in ipc.ts, so the conversation feature adds no lines to that file. */
export const CONVERSATION_IPC = {
  startActivationObserved: 'conversation:startActivationObserved',
  startActivationCancel: 'conversation:startActivationCancel',
  /** renderer (preload, from a trusted click) -> main: start a session. Never exposed to page code. */
  start: 'conversation:start',
  /** renderer -> main: stop the session. Idempotent. Any surface may call it. */
  stop: 'conversation:stop',
  /** renderer -> main: the current snapshot. */
  getState: 'conversation:getState',
  /** main -> renderer: the snapshot changed. */
  state: 'conversation:state',
  captureBegin: 'conversation:captureBegin',
  captureCancel: 'conversation:captureCancel',
  captureStart: 'conversation:capture:start',
  captureFrame: 'conversation:capture:frame',
  captureFinish: 'conversation:capture:finish',
  captureCancelRequest: 'conversation:capture:cancelRequest',
  captureFailure: 'conversation:capture:failure',
  ask: 'conversation:ask',
  replyFinished: 'conversation:replyFinished'
} as const

const Id = z.string().min(1).max(64)
const CaptureBinding = { sessionId: Id, captureToken: z.string().min(1).max(64) }
export const ConversationCaptureBeginSchema = z
  .object({
    ...CaptureBinding,
    maxMs: z
      .number()
      .int()
      .positive()
      .max(COMMAND_SPEECH_MAX_SECONDS * 1_000)
  })
  .strict()
export const ConversationCaptureCancelSchema = z.object(CaptureBinding).strict()
export const ConversationCaptureStartSchema = z
  .object({ ...CaptureBinding, maxSeconds: z.number().int().positive().max(COMMAND_SPEECH_MAX_SECONDS) })
  .strict()
export const CONVERSATION_CAPTURE_MAX_FRAME_SAMPLES = 2_048
export const CONVERSATION_CAPTURE_MAX_SAMPLES = 16_000 * COMMAND_SPEECH_MAX_SECONDS
export const CONVERSATION_CAPTURE_MAX_FRAMES = Math.ceil(
  CONVERSATION_CAPTURE_MAX_SAMPLES / CONVERSATION_CAPTURE_MAX_FRAME_SAMPLES
)
export const ConversationCaptureFrameSchema = z
  .object({
    ...CaptureBinding,
    sequence: z
      .number()
      .int()
      .nonnegative()
      .max(CONVERSATION_CAPTURE_MAX_FRAMES - 1)
      .safe(),
    samples: z.instanceof(Float32Array).refine((frame) => frame.length <= CONVERSATION_CAPTURE_MAX_FRAME_SAMPLES)
  })
  .strict()
export const ConversationCaptureFinishSchema = z
  .object({ ...CaptureBinding, frameCount: z.number().int().nonnegative().max(CONVERSATION_CAPTURE_MAX_FRAMES).safe() })
  .strict()
const CONVERSATION_CAPTURE_FAILURE_REASONS = [
  'microphone_unavailable',
  'device_missing',
  'device_lost',
  'device_busy',
  'speech_unavailable',
  'policy_blocked',
  'not_ready',
  'no_speech',
  'recognition_unavailable'
] as const satisfies readonly ConversationReason[]
export const ConversationCaptureFailureSchema = z
  .object({ ...CaptureBinding, reason: z.enum(CONVERSATION_CAPTURE_FAILURE_REASONS) })
  .strict()
export const ConversationTranscriptSchema = z.string().max(2000)
export const ConversationAskSchema = z
  .object({ sessionId: Id, replyGeneration: z.number().int().nonnegative().safe(), text: ConversationTranscriptSchema })
  .strict()
/** Exact main-owned conversation reply token carried by an Ask; ordinary asks omit it. */
export const ConversationReplySchema = z
  .object({ sessionId: Id, replyGeneration: z.number().int().nonnegative().safe() })
  .strict()
export const ConversationReplyCompleteSchema = ConversationReplySchema
export type ConversationCaptureBegin = z.infer<typeof ConversationCaptureBeginSchema>
export type ConversationCaptureBinding = z.infer<typeof ConversationCaptureCancelSchema>
export type ConversationCaptureFrame = z.infer<typeof ConversationCaptureFrameSchema>
export type ConversationCaptureFinish = z.infer<typeof ConversationCaptureFinishSchema>
export type ConversationCaptureFailure = z.infer<typeof ConversationCaptureFailureSchema>
export type ConversationAsk = z.infer<typeof ConversationAskSchema>
export type ConversationReplyComplete = z.infer<typeof ConversationReplyCompleteSchema>

/**
 * Session limits. PROPOSED defaults (not provided by the owner): 5 minutes without a recognized utterance ends the
 * session, and no session runs longer than 30 minutes in total. Each listening window is 10 seconds because no
 * end-of-speech detector exists yet, so a window is sealed on the clock (see the G28 report).
 */
export const CONVERSATION_LIMITS = {
  idleMs: 5 * 60_000,
  maxMs: 30 * 60_000,
  windowMs: 10_000,
  status: 'PROPOSED'
} as const

export const CONVERSATION_STATES = ['off', 'idle', 'listening', 'thinking', 'replying', 'ended'] as const
export const ConversationStateSchema = z.enum(CONVERSATION_STATES)
export type ConversationState = z.infer<typeof ConversationStateSchema>

/** States in which the session exists, so the indicator must be on screen. */
export const CONVERSATION_ACTIVE_STATES = [
  'listening',
  'thinking',
  'replying'
] as const satisfies readonly ConversationState[]
export const isConversationActive = (state: ConversationState): boolean =>
  (CONVERSATION_ACTIVE_STATES as readonly string[]).includes(state)

/** Why a start was refused, or why a running session ended. Machine reasons only. */
export const CONVERSATION_REASONS = [
  'user_stop',
  'idle_timeout',
  'max_duration',
  'meeting_recording',
  'meeting_started',
  'signed_out',
  'session_ended',
  'screen_locked',
  'system_suspend',
  'renderer_reset',
  'window_hidden',
  'onboarding_active',
  'capture_busy',
  'disabled',
  'speech_unavailable',
  'policy_blocked',
  'microphone_unavailable',
  'device_missing',
  'device_lost',
  'device_busy',
  'no_speech',
  'recognition_unavailable',
  'not_ready',
  'shutdown'
] as const
export const ConversationReasonSchema = z.enum(CONVERSATION_REASONS)
export type ConversationReason = z.infer<typeof ConversationReasonSchema>

/** Fixed copy per reason. No reason copy interpolates user speech. */
const REASON_COPY: Readonly<Record<ConversationReason, string>> = {
  user_stop: 'Conversation stopped.',
  idle_timeout: 'Conversation ended after 5 minutes of silence.',
  max_duration: 'Conversation ended after 30 minutes. Start a new one to keep talking.',
  meeting_recording: 'Conversation is paused while Métis records a meeting.',
  meeting_started: 'Conversation stopped. A meeting started.',
  signed_out: 'Sign in to Métis to start a conversation.',
  session_ended: 'Conversation stopped because you signed out.',
  screen_locked: 'Conversation stopped because your Mac locked.',
  system_suspend: 'Conversation stopped because your Mac went to sleep.',
  renderer_reset: 'Conversation stopped because Métis reloaded.',
  window_hidden: 'Show Métis to start a conversation.',
  onboarding_active: 'Finish setting up Métis to start a conversation.',
  capture_busy: 'Another voice session is listening. Finish it first.',
  disabled: 'Conversation is turned off.',
  speech_unavailable: "On-device speech isn't available yet.",
  policy_blocked: 'Your organization has turned off on-device speech.',
  microphone_unavailable: "Métis can't hear you. Microphone access is off.",
  device_missing: 'No microphone found. Connect one and try again.',
  device_lost: 'Your microphone was disconnected.',
  device_busy: 'Another app is using the microphone.',
  no_speech: 'No speech was heard. Try again.',
  recognition_unavailable: "On-device speech recognition couldn't process that turn.",
  not_ready: "Conversation isn't ready. Try again.",
  shutdown: 'Conversation stopped.'
}

export function conversationReasonCopy(reason: ConversationReason): string {
  return REASON_COPY[reason]
}

/** What the renderer may know. `enabled` is the effective value (QA, release default and managed policy applied). */
export const ConversationSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    state: ConversationStateSchema,
    /** True exactly while the session exists. The indicator is always present while this is true. */
    active: z.boolean(),
    /** Stop is offered whenever a session exists, from any surface. */
    stopAvailable: z.boolean(),
    sessionId: z.string().min(1).max(64).nullable(),
    startedAt: z.number().finite().nullable(),
    /** When silence ends the session. Moves forward on each recognized utterance. */
    idleExpiresAt: z.number().finite().nullable(),
    /** When the hard maximum ends the session. Fixed at start. */
    maxExpiresAt: z.number().finite().nullable(),
    /** The reply generation: bumps on every new input, so a spoken reply of an older generation is stale. */
    replyGeneration: z.number().int().nonnegative().safe(),
    /** The limits in force and their provenance, so the indicator can label them. */
    limits: z
      .object({
        idleMs: z.number().int().positive(),
        maxMs: z.number().int().positive(),
        status: z.literal('PROPOSED')
      })
      .strict(),
    reason: ConversationReasonSchema.nullable(),
    message: z.string().max(200).nullable(),
    enabled: z.boolean()
  })
  .strict()
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotSchema>

/** Start and stop carry nothing from the renderer: who, when and for how long are main's. */
export const ConversationStartResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: ConversationReasonSchema }).strict()
])
export type ConversationStartResult = z.infer<typeof ConversationStartResultSchema>
export const ConversationStopResultSchema = z.object({ ok: z.boolean() }).strict()
export type ConversationStopResult = z.infer<typeof ConversationStopResultSchema>
