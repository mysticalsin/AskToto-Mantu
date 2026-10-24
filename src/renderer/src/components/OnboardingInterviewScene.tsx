import { useEffect, useReducer, useRef, useState } from 'react'
import {
  INTERVIEW_PROPOSAL_STEP,
  INTERVIEW_QUESTIONS,
  INTERVIEW_ROLE_OTHER_MAX_CHARS,
  INTERVIEW_STEP_COUNT,
  draftPurpose,
  type InterviewAnswers,
  type InterviewView
} from '@shared/onboarding-interview'
import { BUILTIN_MODE_LABELS } from '@shared/ipc'
import {
  INITIAL_INTERVIEW_STATE,
  includedCount,
  interviewReducer,
  saveRequestOf,
  type InterviewUiState
} from '../lib/onboarding-interview'

const SAVE_DEBOUNCE_MS = 300
export const INTERVIEW_CREATE_ERROR = 'Métis couldn’t create these. Try again.'

/**
 * Whether the role interview can run: main answers `ok` only when signed in with a memory partition open. The
 * saved doc it returns is what the scene resumes from after a quit (G56, R005).
 */
export function useInterviewAvailability(): { available: boolean; view: InterviewView | null } {
  const [view, setView] = useState<InterviewView | null>(null)
  useEffect(() => {
    let live = true
    void window.toto.onboardingInterview
      ?.load()
      .then((result) => {
        if (live && result.ok) setView(result.view)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return { available: view !== null, view }
}

const answered = (state: InterviewUiState): boolean => {
  const a = state.answers
  switch (state.step) {
    case 0:
      return a.role !== undefined && (a.role !== 'other' || (a.roleOther ?? '').trim().length > 0)
    case 1:
      return (a.meetings?.length ?? 0) > 0
    case 2:
      return a.outcome !== undefined
    case 3:
      return a.tone !== undefined
    default:
      return true
  }
}

/** The interview's own choice for the current question, kept apart until Continue so Back never loses it. */
function QuestionStep({
  state,
  onAnswer,
  onBack
}: {
  state: InterviewUiState
  onAnswer: (patch: InterviewAnswers) => void
  onBack: () => void
}): JSX.Element {
  const question = INTERVIEW_QUESTIONS[state.step]!
  const [draft, setDraft] = useState<InterviewAnswers>(state.answers)
  const view = { ...state, answers: draft }
  const selected = (id: string): boolean => {
    const value = draft[question.key]
    return Array.isArray(value) ? (value as string[]).includes(id) : value === id
  }
  const pick = (id: string): void => {
    if (question.key === 'meetings') {
      const current = draft.meetings ?? []
      const next = current.includes(id as never)
        ? current.filter((m) => m !== id)
        : [...current, id as (typeof current)[number]].slice(-question.max)
      setDraft({ ...draft, meetings: next.length > 0 ? next : undefined })
      return
    }
    setDraft({ ...draft, [question.key]: id })
  }
  return (
    <div key={`q${state.step}`} className="scene-enter onboard-interview-step flex flex-col items-center gap-5">
      <div className="onboard-act4-heading flex flex-col items-center gap-2">
        <p className="onboard-act4-kicker">
          {state.restored ? 'Picking up where you left off' : 'A few quick questions'}
        </p>
        <h2 className="onboard-act4-title">{question.title}</h2>
        {question.max > 1 && <p className="onboard-act4-lead">Pick up to two.</p>}
      </div>
      <div className="onboard-interview-chips" role="group" aria-label={question.title}>
        {question.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            aria-pressed={selected(choice.id)}
            onClick={() => pick(choice.id)}
            className={'onboard-interview-chip no-drag focus-ring' + (selected(choice.id) ? ' is-selected' : '')}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {question.key === 'role' && draft.role === 'other' && (
        <input
          type="text"
          aria-label="Your work"
          placeholder="Your work, in a few words"
          maxLength={INTERVIEW_ROLE_OTHER_MAX_CHARS}
          value={draft.roleOther ?? ''}
          onChange={(e) => setDraft({ ...draft, roleOther: e.target.value })}
          className="onboard-interview-input no-drag focus-ring"
        />
      )}
      <InterviewProgress step={state.step} />
      <div className="flex items-center gap-4">
        {state.step > 0 && (
          <button type="button" onClick={onBack} className="onboard-interview-text no-drag focus-ring">
            Back
          </button>
        )}
        <button
          type="button"
          disabled={!answered(view)}
          onClick={() => onAnswer(draft)}
          className={'onboard-cta no-drag focus-ring' + (answered(view) ? '' : ' onboard-cta--muted')}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function InterviewProgress({ step }: { step: number }): JSX.Element {
  return (
    <div className="onboard-interview-progress" aria-label={`${step + 1} of ${INTERVIEW_STEP_COUNT}`}>
      <span aria-hidden="true" className="flex gap-1.5">
        {Array.from({ length: INTERVIEW_STEP_COUNT }, (_, i) => (
          <span key={i} className={'onboard-interview-dot' + (i <= step ? ' is-on' : '')} />
        ))}
      </span>
      <span>
        {step + 1} of {INTERVIEW_STEP_COUNT}
      </span>
    </div>
  )
}

/**
 * The role interview (G56, Opus design): four one-line questions, then "Here's your team", three editable
 * assistant cards created only through the G48 propose, exact preview, confirm path. Every transition is saved
 * (debounced, flushed on unmount) so a quit resumes at the same question. A completed interview shows its
 * assistants instead of the questions, so Replay never creates them again.
 */
export function OnboardingInterviewScene({
  initial,
  onContinue
}: {
  initial: InterviewView
  onContinue: (createdCount: number) => void
}): JSX.Element {
  const [state, dispatch] = useReducer(interviewReducer, INITIAL_INTERVIEW_STATE, (s) =>
    interviewReducer(s, { type: 'restore', view: initial })
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [names, setNames] = useState<string[]>([])
  const pendingRef = useRef<{ timer: ReturnType<typeof setTimeout>; flush: () => void } | null>(null)
  const firstRef = useRef(true)

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    if (state.status === 'complete') {
      pendingRef.current = null
      return
    }
    const request = saveRequestOf(state)
    const flush = (): void => void window.toto.onboardingInterview?.save(request).catch(() => undefined)
    const timer = setTimeout(() => {
      pendingRef.current = null
      flush()
    }, SAVE_DEBOUNCE_MS)
    pendingRef.current = { timer, flush }
    return () => clearTimeout(timer)
  }, [state])
  // Unmount (Continue, Skip, quit) flushes the last transition instead of dropping it.
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (pending) {
        clearTimeout(pending.timer)
        pending.flush()
      }
    },
    []
  )

  useEffect(() => {
    if (state.status !== 'complete' || state.createdIds.length === 0) return
    let live = true
    void window.toto.assistants
      ?.list()
      .then((result) => {
        if (!live || !result.ok) return
        const ids = new Set(state.createdIds)
        setNames(result.assistants.filter((a) => ids.has(a.assistantId)).map((a) => a.name))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [state.status, state.createdIds])

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const api = window.toto.onboardingInterview
      // A proposal lives ten minutes in main and is gone after a restart: re-propose once on those refusals.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const proposed = await api.propose(state.drafts)
        if (!proposed.ok) break
        const confirmed = await api.confirm(proposed.proposalId, proposed.previewHash)
        if (confirmed.ok) {
          dispatch({ type: 'confirmed', createdIds: confirmed.view.createdIds })
          onContinue(confirmed.view.createdIds.length)
          return
        }
        if (confirmed.reason !== 'unknown-proposal' && confirmed.reason !== 'expired') break
      }
      setError(INTERVIEW_CREATE_ERROR)
    } catch {
      setError(INTERVIEW_CREATE_ERROR)
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'complete') {
    return (
      <div key="interview-summary" className="scene-enter onboard-interview flex flex-col items-center gap-5">
        <div className="onboard-act4-heading flex flex-col items-center gap-2">
          <p className="onboard-act4-kicker">Already set up</p>
          <h2 className="onboard-act4-title">Your assistants</h2>
          {names.length > 0 && <p className="onboard-act4-lead">{names.join(', ')}</p>}
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => dispatch({ type: 'start-over' })}
            className="onboard-interview-text no-drag focus-ring"
          >
            Start over
          </button>
          <button type="button" onClick={() => onContinue(0)} className="onboard-cta no-drag focus-ring">
            Continue
          </button>
        </div>
      </div>
    )
  }

  if (state.step < INTERVIEW_PROPOSAL_STEP) {
    return (
      <div className="onboard-interview flex flex-col items-center">
        <QuestionStep
          key={state.step}
          state={state}
          onAnswer={(patch) => dispatch({ type: 'answer', patch })}
          onBack={() => dispatch({ type: 'back' })}
        />
      </div>
    )
  }

  const count = includedCount(state)
  return (
    <div key="interview-team" className="scene-enter onboard-interview flex flex-col items-center gap-5">
      <div className="onboard-act4-heading flex flex-col items-center gap-2">
        <p className="onboard-act4-kicker">
          {state.restored ? 'Picking up where you left off' : 'Based on your answers'}
        </p>
        <h2 className="onboard-act4-title">Here’s your team</h2>
        <p className="onboard-act4-lead">Rename any of them, or leave one out. Change them anytime in Settings.</p>
      </div>
      <div className="onboard-persona-row">
        {state.drafts.map((draft, index) => (
          <div key={index} className={'onboard-interview-card' + (draft.include ? ' is-selected' : '')}>
            <input
              type="text"
              aria-label={`Assistant ${index + 1} name`}
              value={draft.name}
              maxLength={60}
              onChange={(e) => dispatch({ type: 'edit', index, patch: { name: e.target.value } })}
              className="onboard-interview-name no-drag focus-ring"
            />
            <p className="onboard-persona-vibe">{BUILTIN_MODE_LABELS[draft.base]}</p>
            <p className="onboard-persona-changes">{draftPurpose(state.answers, index)}</p>
            <label className="onboard-interview-include no-drag">
              <input
                type="checkbox"
                checked={draft.include}
                onChange={(e) => dispatch({ type: 'edit', index, patch: { include: e.target.checked } })}
              />
              Include
            </label>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="onboard-interview-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => dispatch({ type: 'back' })}
          className="onboard-interview-text no-drag focus-ring"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            // Saved directly: the scene unmounts in the same render, before the debounced save could run.
            if (pendingRef.current) clearTimeout(pendingRef.current.timer)
            pendingRef.current = null
            const declined = interviewReducer(state, { type: 'decline' })
            void window.toto.onboardingInterview?.save(saveRequestOf(declined)).catch(() => undefined)
            dispatch({ type: 'decline' })
            onContinue(0)
          }}
          className="onboard-interview-text no-drag focus-ring"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={count === 0 || busy || state.drafts.some((d) => d.include && d.name.trim() === '')}
          onClick={() => void create()}
          className={'onboard-cta no-drag focus-ring' + (count === 0 || busy ? ' onboard-cta--muted' : '')}
        >
          {busy ? 'Creating…' : `Create ${count} assistant${count === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}
