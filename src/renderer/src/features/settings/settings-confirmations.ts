/**
 * settings-confirmations.ts — every confirmation Settings asks for, in one place so the Apple HIG alert rules are
 * checked once (settings-confirmations.test.ts): the title states the situation as a question, the message adds
 * what happens next in a complete sentence, the action is a short verb in title style, the other button is
 * always "Cancel", and only a consequence the person did not deliberately choose is styled destructive.
 *
 * Common actions that are easy to undo (Quit, switching a toggle) deliberately have no confirmation (HIG A2).
 */
import type { ConfirmActionInput } from '../../lib/navigation-guard'

export const LOG_OUT_CONFIRMATION: ConfirmActionInput = {
  title: 'Log out of Métis?',
  message: "You'll need to sign in again to use Dust and your Mantu Microsoft account.",
  confirmLabel: 'Log Out'
}

export const REPLAY_ONBOARDING_CONFIRMATION: ConfirmActionInput = {
  title: 'Replay onboarding?',
  message: "Start setup again from the beginning. Your settings won't change.",
  confirmLabel: 'Replay'
}

export const OUTLOOK_SIGN_OUT_CONFIRMATION: ConfirmActionInput = {
  title: 'Sign out of your Microsoft account?',
  message:
    'Métis stops reading your Outlook calendar until you sign in again. If your organization requires sign-in, Métis also asks you to sign in before you can use it.',
  confirmLabel: 'Sign Out'
}

export const DUST_DISCONNECT_CONFIRMATION: ConfirmActionInput = {
  title: 'Disconnect Dust?',
  message:
    'Métis removes the saved Dust sign-in from this device and resets the workspace, region and agents. You can connect again at any time.',
  confirmLabel: 'Disconnect'
}

export const DUST_REMOVE_KEY_CONFIRMATION: ConfirmActionInput = {
  title: 'Remove the Dust API key?',
  message: 'Métis deletes the saved key from this device. Your workspace, region and agent choices stay as they are.',
  confirmLabel: 'Remove Key'
}

export const SCREEN_REPAIR_CONFIRMATION: ConfirmActionInput = {
  title: 'Repair screen recording?',
  message:
    'Métis saves any meeting in progress, resets its own Screen Recording permission and relaunches. Afterwards, Métis opens System Settings so you can turn it on again.',
  confirmLabel: 'Repair and Relaunch'
}

/** Shortening retention so that existing meetings fall outside it. Increasing it never asks. */
export function retentionDeleteConfirmation(count: number, windowLabel: string): ConfirmActionInput {
  const meetings = count === 1 ? '1 saved meeting is' : `${count} saved meetings are`
  return {
    title: count === 1 ? 'Delete 1 older meeting?' : `Delete ${count} older meetings?`,
    message: `${meetings} older than ${windowLabel}. Métis will delete ${count === 1 ? 'it' : 'them'} from this device, and this can't be undone.`,
    confirmLabel: 'Delete Meetings',
    destructive: true
  }
}

/** The count could not be read: still ask, without guessing a number. */
export function retentionDeleteUnknownConfirmation(windowLabel: string): ConfirmActionInput {
  return {
    title: 'Delete older meetings?',
    message: `Saved meetings older than ${windowLabel} will be deleted from this device, and this can't be undone.`,
    confirmLabel: 'Delete Meetings',
    destructive: true
  }
}
