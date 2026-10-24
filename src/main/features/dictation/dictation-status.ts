import { DICTATION_STATUS_MESSAGE_MAX, type DictationStatus } from '@shared/dictation-status'
import type { DictationReason, DictationSnapshot } from './dictation-session'

/**
 * Fixed, sentence-case copy for each machine reason. This table is the only source of the status `message`: no
 * speech, transcript or field text ever reaches it, and the renderer cannot supply any.
 */
export const DICTATION_REASON_COPY: Readonly<Record<DictationReason, string>> = {
  meeting_recording: 'Dictation is off while Métis records a meeting.',
  signed_out: 'Sign in to Métis to dictate.',
  session_ended: 'Your session ended, so dictation stopped.',
  onboarding_active: 'Finish setting up Métis to dictate.',
  speech_unavailable: 'Speech recognition is not available right now.',
  policy_blocked: 'Your organization has turned dictation off.',
  window_hidden: 'Métis is hidden, so dictation did not start.',
  capture_busy: 'The microphone is in use, so dictation did not start.',
  busy: 'Métis is busy with another dictation.',
  target_unsupported: "Métis can't type into this app yet.",
  no_target: 'Click where you want to type, then hold the keys again.',
  target_not_editable: "This isn't a text field, so Métis didn't type.",
  secure_field: "This field is a password, so Métis didn't type into it.",
  permission_needed: 'Métis needs permission to type into other apps.',
  target_changed: "The window changed, so Métis didn't type.",
  reconcile_required: "The text changed while you spoke, so Métis didn't type.",
  not_ready: 'Dictation is not ready yet. Try again in a moment.',
  microphone_unavailable: 'The microphone is not available.',
  device_missing: 'No microphone was found.',
  device_lost: 'The microphone was disconnected.',
  device_busy: 'The microphone is in use by another app.',
  no_speech: "Métis didn't hear anything.",
  recognition_unavailable: "Métis couldn't recognize that. Try again.",
  meeting_started: 'A meeting started, so dictation stopped.',
  screen_locked: 'The screen locked, so dictation stopped.',
  system_suspend: 'The Mac went to sleep, so dictation stopped.',
  renderer_reset: 'Métis restarted its window, so dictation stopped.',
  timeout: 'Dictation ran too long and stopped.',
  insertion_unsupported: "Métis can't type into this field, so your words were kept.",
  insertion_failed: "Métis couldn't type that, so your words were kept."
}

/** The renderer-facing status for a session snapshot. The turn id and the raw reason stay in main. */
export function toDictationStatus(snapshot: DictationSnapshot): DictationStatus {
  const copy = snapshot.reason === null ? null : (DICTATION_REASON_COPY[snapshot.reason] ?? null)
  return {
    revision: snapshot.revision,
    state: snapshot.state,
    message: copy !== null && copy.length <= DICTATION_STATUS_MESSAGE_MAX ? copy : null,
    enabled: snapshot.enabled
  }
}
