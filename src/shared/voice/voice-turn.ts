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
  'timeout'
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
  timeout: 'Stopped. Nothing was done.'
}

export function voiceReasonCopy(reason: VoiceReason): string {
  return REASON_COPY[reason]
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
  'no_speech'
] as const
export const VoiceReportSchema = z.discriminatedUnion('phase', [
  z.object({ turnId: z.string().min(1).max(64), phase: z.literal('capturing') }).strict(),
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
