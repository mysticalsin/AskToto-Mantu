/**
 * The voice turn contract shared by main and the renderer (V02).
 *
 * Main owns the turn. The renderer only renders it and, when main says so, opens the microphone through the
 * ordinary lease path. Nothing here carries audio, a transcript, a title, a query or an app name: a turn is an
 * id, a state, a machine reason and a fixed-copy message.
 */
import { z } from 'zod'

/** Channels live here, not in ipc.ts, so the voice feature adds no lines to that file. */
export const VOICE_ACTIONS_IPC = {
  /** main -> renderer: open the microphone for this turn. */
  begin: 'voiceActions:begin',
  /** main -> renderer: seal (released) or discard (cancelled) this turn. */
  end: 'voiceActions:end',
  /** main -> renderer: the turn state changed. */
  state: 'voiceActions:state',
  /** renderer -> main: the current state snapshot. */
  getState: 'voiceActions:getState',
  /** renderer -> main: the capture started, or failed to. It can only move the current turn toward failure. */
  report: 'voiceActions:report',
  /** main -> renderer: a recognized question to run through the typed Ask router (wired in V03). */
  ask: 'voiceActions:ask',
  /** renderer -> main: the Settings chord recorder opened or closed (pauses the hold; opens no microphone). */
  recorder: 'voiceActions:recorder'
} as const

export const VOICE_STATES = [
  'off',
  'idle',
  'listening',
  'thinking',
  'proposing',
  'confirming',
  'executing',
  'done',
  'failed',
  'uncertain'
] as const
export const VoiceStateSchema = z.enum(VOICE_STATES)
export type VoiceState = z.infer<typeof VoiceStateSchema>

/** Why a turn was refused before any microphone opened, or stopped or failed afterwards. */
export const VOICE_REASONS = [
  'meeting_recording',
  'signed_out',
  'session_ended',
  'speech_unavailable',
  'policy_blocked',
  'onboarding_active',
  'panel_active',
  'window_hidden',
  'not_ready',
  'meeting_started',
  'screen_locked',
  'system_suspend',
  'renderer_reset',
  'microphone_unavailable',
  'activation_required',
  'no_speech',
  'recognition_unavailable',
  'timeout',
  'device_missing',
  'device_lost',
  'device_busy'
] as const
export const VoiceReasonSchema = z.enum(VOICE_REASONS)
export type VoiceReason = z.infer<typeof VoiceReasonSchema>

/** Fixed copy per reason (design section 11). No reason copy interpolates user speech. */
const REASON_COPY: Readonly<Record<VoiceReason, string>> = {
  meeting_recording: 'Voice actions are paused while Métis records a meeting. Type your request instead.',
  signed_out: 'Sign in to Métis to use voice actions.',
  session_ended: 'Stopped because you signed out. Nothing was done.',
  speech_unavailable: "On-device speech isn't available yet.",
  policy_blocked: 'Your organization has turned off on-device speech.',
  onboarding_active: 'Finish setting up Métis to use voice actions.',
  panel_active: 'The voice panel is already listening.',
  window_hidden: 'Show Métis to use voice actions.',
  not_ready: "Voice actions aren't ready. Try again.",
  meeting_started: 'Stopped. A meeting started.',
  screen_locked: 'Stopped because your Mac locked. Nothing was done.',
  system_suspend: 'Stopped because your Mac went to sleep. Nothing was done.',
  renderer_reset: 'Stopped because Métis reloaded. Nothing was done.',
  microphone_unavailable: "Métis can't hear you. Microphone access is off.",
  activation_required: "Voice actions aren't ready. Try again.",
  no_speech: "Didn't catch that. Hold the shortcut and speak.",
  recognition_unavailable: "On-device speech couldn't finish. Try again.",
  timeout: 'Stopped. Nothing was done.',
  device_missing: 'No microphone found. Connect one and try again.',
  device_lost: 'Your microphone was disconnected. Try again.',
  device_busy: 'Another app is using the microphone. Close it and try again.'
}

export function voiceReasonCopy(reason: VoiceReason): string {
  return REASON_COPY[reason]
}

/**
 * The closed taxonomy of interactive voice failures (G18), for the Cmd+Shift+M panel and the hold-to-talk turn
 * alike. It is a subset of VOICE_REASONS, never a second vocabulary, and each member has exactly one fixed
 * message above. No cloud command recognizer exists (commands run on the device), so there is no offline reason.
 *
 * - microphone_unavailable: permission denied or restricted
 * - device_missing: no input device; device_lost: it went away mid-turn; device_busy: another app holds it
 * - speech_unavailable: the speech engine or its model is not there; recognition_unavailable: it failed
 * - timeout, no_speech, policy_blocked
 */
export const VOICE_CAPTURE_FAILURES = [
  'microphone_unavailable',
  'device_missing',
  'device_lost',
  'device_busy',
  'speech_unavailable',
  'recognition_unavailable',
  'timeout',
  'no_speech',
  'policy_blocked'
] as const satisfies readonly VoiceReason[]

/** The one recovery a failure offers: the guided Settings helper, or running the turn again. */
export type VoiceRecovery = 'open_settings' | 'try_again'

const RECOVERY: Partial<Record<VoiceReason, VoiceRecovery>> = {
  microphone_unavailable: 'open_settings',
  device_missing: 'try_again',
  device_lost: 'try_again',
  device_busy: 'try_again',
  recognition_unavailable: 'try_again',
  no_speech: 'try_again'
}

/** The single recovery action for a reason, or null when nothing the person can do here helps. */
export function voiceReasonRecovery(reason: VoiceReason): VoiceRecovery | null {
  return RECOVERY[reason] ?? null
}

/** A command microphone stop reason (renderer) as a voice reason. `cancelled` is not a failure: null. */
export function commandMicReasonToVoice(reason: string | undefined): VoiceReason | null {
  if (reason === undefined || reason === 'cancelled') return null
  if (reason === 'unsupported_engine') return 'speech_unavailable'
  return (VOICE_REASONS as readonly string[]).includes(reason) ? (reason as VoiceReason) : null
}

export const VoiceShortcutSchema = z.enum(['running', 'stopped', 'unavailable'])
export type VoiceShortcut = z.infer<typeof VoiceShortcutSchema>

/** What the renderer may know. `enabled` is the effective value (QA, release default and managed policy applied). */
export const VoiceStateSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    state: VoiceStateSchema,
    turnId: z.string().min(1).max(64).nullable(),
    reason: VoiceReasonSchema.nullable(),
    message: z.string().max(200).nullable(),
    enabled: z.boolean(),
    /** `unavailable` while no hold watcher exists on this platform or build. */
    shortcut: VoiceShortcutSchema
  })
  .strict()
export type VoiceStateSnapshot = z.infer<typeof VoiceStateSnapshotSchema>

export const VoiceBeginSchema = z
  .object({ turnId: z.string().min(1).max(64), maxMs: z.number().int().positive().max(60_000) })
  .strict()
/** The chord recorder flag: one boolean, nothing else. It can only pause a hold, never start a turn. */
export const VoiceRecorderSchema = z.object({ active: z.boolean() }).strict()
export type VoiceRecorder = z.infer<typeof VoiceRecorderSchema>

export type VoiceBegin = z.infer<typeof VoiceBeginSchema>

export const VoiceEndSchema = z.object({ turnId: z.string().min(1).max(64), cancelled: z.boolean() }).strict()
export type VoiceEnd = z.infer<typeof VoiceEndSchema>

/** The renderer-side capture reasons main accepts. Anything else is rejected, never trusted. */
export const VOICE_REPORT_REASONS = [
  'microphone_unavailable',
  'activation_required',
  'policy_blocked',
  'speech_unavailable',
  'recognition_unavailable',
  'no_speech',
  'device_missing',
  'device_lost',
  'device_busy'
] as const
export const VoiceReportSchema = z.discriminatedUnion('phase', [
  z.object({ turnId: z.string().min(1).max(64), phase: z.literal('capturing') }).strict(),
  /**
   * The input device went away after speech was captured (G18). The renderer is sealing what it has and will send
   * it for recognition, so main treats the turn as released instead of failing it. It carries nothing else.
   */
  z
    .object({ turnId: z.string().min(1).max(64), phase: z.literal('device_changed') })
    .strict(),
  z
    .object({
      turnId: z.string().min(1).max(64),
      phase: z.literal('failed'),
      reason: z.enum(VOICE_REPORT_REASONS)
    })
    .strict()
])
export type VoiceReport = z.infer<typeof VoiceReportSchema>

/** A recognized question for the typed Ask router (V03 sends it). Bounded; never an action. */
export const VoiceAskSchema = z
  .object({ turnId: z.string().min(1).max(64), text: z.string().min(1).max(2_000) })
  .strict()
export type VoiceAsk = z.infer<typeof VoiceAskSchema>

/** One hold turn listens for at most this long (matches the 15 s command capture cap). */
export const VOICE_TURN_MAX_MS = 15_000
