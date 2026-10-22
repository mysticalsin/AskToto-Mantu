/**
 * review-confirmations.ts — every confirmation Review asks for, kept beside the settings ones
 * (features/settings/settings-confirmations.ts) so the Apple HIG alert rules are checked in one test
 * (review-confirmations.test.ts): the title states the situation as a question, the message adds what happens
 * next in a complete sentence, the action is a short verb in title style, the other button is "Cancel", and a
 * consequence the person did not deliberately choose is styled destructive (HIG A2 and A5).
 */
import type { ConfirmActionInput } from '../../lib/navigation-guard'

/** Regenerate on notes a person edited by hand: the loss is not the part they chose, so it is destructive. */
export const REPLACE_EDITED_NOTES_CONFIRMATION: ConfirmActionInput = {
  title: 'Replace your edited notes?',
  message: "Regenerating replaces the notes you edited with a new summary from the transcript. This can't be undone.",
  confirmLabel: 'Replace Notes',
  destructive: true
}

/** The one copy a failed or rejected push shows; every push card can retry from it. */
export const PUSH_FAILED_COPY = 'Push failed. Try again.'
