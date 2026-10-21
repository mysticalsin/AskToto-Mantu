import type { RecapStatus } from '@shared/recap-status'
import type { AnswerState } from '../state'

export interface ReviewRecapInput {
  /** The past meeting open in Review, or null for a just-ended live session. */
  pastMeeting: { file: string; recapStatus?: RecapStatus } | null
  /** The saved-meeting file an in-flight recapGen run will persist its result to. */
  recapGenTargetFile: string | null | undefined
  /** recapGen's current answer. */
  recapGenAnswer: AnswerState | null
  /** The generation token set synchronously when the current recapGen run started. */
  recapGenRunId: string
  /** recapGen's text at the moment the current run started. */
  recapGenPrevText: string
  /** The live session's recap answer (ask.answer). */
  liveAnswer: AnswerState | null
}

export interface ReviewRecap {
  generatingThisPm: boolean
  recapGenDisplay: AnswerState | null
  displayedRecapStatus: RecapStatus | undefined
}

/**
 * What Review shows for the recap of a past meeting mid-generation, plus the recap status it displays.
 * Pure derivation of the inputs: a stale or foreign recapGen answer is replaced by a neutral pending
 * placeholder, and a hollow completion is turned into a readable error with the usual Retry.
 */
export function resolveReviewRecap(input: ReviewRecapInput): ReviewRecap {
  const { pastMeeting: pm, recapGenAnswer, recapGenRunId, recapGenPrevText, liveAnswer } = input
  // A past meeting mid-generation (button click or an import that just landed) shows recapGen's
  // streaming answer in place instead of the still-empty static recap — once it settles and persists,
  // recapGenTarget clears and this falls back to the now-populated pastMeeting.recap on the next render.
  const generatingThisPm = !!pm && input.recapGenTargetFile === pm.file
  // Trust recapGen.answer only once it demonstrably belongs to the CURRENT generation — both its id
  // AND its text (run() keeps the PREVIOUS answer's text on screen until its own first real chunk lands,
  // which for a cross-meeting generation is a DIFFERENT meeting's recap). Until then, render a neutral
  // pending placeholder instead of flashing stale, wrongly-attributed text.
  const recapGenIsCurrent = recapGenAnswer?.id === recapGenRunId
  const recapGenAwaitingFirstToken =
    recapGenIsCurrent && !!recapGenAnswer?.streaming && recapGenAnswer?.text === recapGenPrevText
  const recapGenPending: AnswerState = {
    id: recapGenRunId,
    text: '',
    streaming: true,
    error: null,
    prompt: ''
  }
  const recapGenLive = recapGenIsCurrent && !recapGenAwaitingFirstToken ? recapGenAnswer : recapGenPending
  // A settle with no error and no text (a hollow completion) is functionally a failure — give it the
  // same readable-message + Retry treatment as a real error instead of leaving a dead spinner up.
  const recapGenDisplay: AnswerState | null =
    recapGenLive && !recapGenLive.streaming && !recapGenLive.error && !recapGenLive.text
      ? { ...recapGenLive, error: 'Recap came back empty. Try again.' }
      : recapGenLive
  const displayedRecapStatus: RecapStatus | undefined = generatingThisPm
    ? recapGenDisplay?.completion === 'incomplete'
      ? 'incomplete'
      : undefined
    : (pm?.recapStatus ?? (!pm && liveAnswer?.completion === 'incomplete' ? 'incomplete' : undefined))
  return { generatingThisPm, recapGenDisplay, displayedRecapStatus }
}
