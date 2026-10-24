import {
  INTERVIEW_PROPOSAL_STEP,
  draftsFromAnswers,
  type InterviewAnswers,
  type InterviewDraft,
  type InterviewSaveRequest,
  type InterviewStatus,
  type InterviewView
} from '@shared/onboarding-interview'

/** The interview scene's state (G56). Pure, so resume and back/forward are testable without a render. */
export interface InterviewUiState {
  status: InterviewStatus
  step: number
  answers: InterviewAnswers
  drafts: InterviewDraft[]
  createdIds: string[]
  /** True when the state came back from a saved doc: the kicker says "Picking up where you left off". */
  restored: boolean
}

export const INITIAL_INTERVIEW_STATE: InterviewUiState = {
  status: 'in-progress',
  step: 0,
  answers: {},
  drafts: [],
  createdIds: [],
  restored: false
}

export type InterviewEvent =
  | { type: 'restore'; view: InterviewView }
  | { type: 'answer'; patch: InterviewAnswers }
  | { type: 'back' }
  | { type: 'edit'; index: number; patch: Partial<Pick<InterviewDraft, 'name' | 'include'>> }
  | { type: 'confirmed'; createdIds: string[] }
  | { type: 'decline' }
  | { type: 'start-over' }

export function interviewReducer(state: InterviewUiState, event: InterviewEvent): InterviewUiState {
  switch (event.type) {
    case 'restore': {
      const restored = event.view.step > 0 || Object.keys(event.view.answers).length > 0
      return { ...event.view, restored: restored && event.view.status !== 'complete' }
    }
    case 'answer': {
      const answers = { ...state.answers, ...event.patch }
      const step = Math.min(state.step + 1, INTERVIEW_PROPOSAL_STEP)
      // Answering the last question builds the drafts from the answers; a restored proposal keeps its edits.
      const drafts = step === INTERVIEW_PROPOSAL_STEP ? draftsFromAnswers(answers) : state.drafts
      return { ...state, status: 'in-progress', answers, step, drafts }
    }
    case 'back':
      return { ...state, step: Math.max(0, state.step - 1) }
    case 'edit':
      return {
        ...state,
        drafts: state.drafts.map((draft, index) => (index === event.index ? { ...draft, ...event.patch } : draft))
      }
    case 'confirmed':
      return { ...state, status: 'complete', createdIds: event.createdIds }
    case 'decline':
      return { ...state, status: 'declined' }
    case 'start-over':
      return { ...INITIAL_INTERVIEW_STATE, createdIds: state.createdIds }
  }
}

export const includedCount = (state: InterviewUiState): number => state.drafts.filter((d) => d.include).length

/** What the scene saves after each transition. `complete` is never saved from here: only a confirm completes. */
export function saveRequestOf(state: InterviewUiState): InterviewSaveRequest {
  return {
    status: state.status === 'complete' ? 'in-progress' : state.status,
    step: state.step,
    answers: state.answers,
    drafts: state.drafts
  }
}
