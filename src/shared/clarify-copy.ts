import type { DesktopAdapterId } from './desktop-actions'

/** The two requests that can be incomplete in the catalog today: a note with no title, a search with no query. */
export type ClarifyAction = Extract<DesktopAdapterId, 'desktop.create_note' | 'desktop.google_search'>
export type ClarifyMissing = 'title' | 'query' | 'too_long'
export type ClarifyEndReason = 'gave_up' | 'expired' | 'cancelled'

/**
 * The one question Métis asks (G35). Sentence case, specific, never "Error". It names what is missing and promises
 * nothing beyond it: nothing is created or sent until the answer arrives and the normal confirm path runs.
 */
export function clarifyQuestionCopy(action: ClarifyAction, missing: ClarifyMissing): string {
  if (action === 'desktop.create_note') {
    return missing === 'too_long'
      ? 'That title was too long. What should the note be called, in a few words?'
      : 'What should the note be called?'
  }
  return missing === 'too_long'
    ? 'That search was too long. What should Métis search for, in a few words?'
    : 'What should Métis search for?'
}

/** What is said when the one question did not lead anywhere. Never a second question. */
export function clarifyEndCopy(action: ClarifyAction, reason: ClarifyEndReason): string {
  const what = action === 'desktop.create_note' ? 'create the note' : 'run the search'
  switch (reason) {
    case 'gave_up':
      return `Métis still couldn't ${what}. Nothing was done.`
    case 'expired':
      return 'Timed out. Nothing was done.'
    case 'cancelled':
      return 'Okay. Nothing was done.'
  }
}
