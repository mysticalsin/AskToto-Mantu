/**
 * What the walkthrough coach card says and which controls it offers (G45, DESIGN.md "Transient pointers"). Pure.
 * Instructions and status live here, in the sidecar, never on the screen beside the target. A control is offered only
 * when main says it works now, so the card never shows a button that cannot do anything.
 */
import type { WalkthroughCardAction, WalkthroughView } from '@shared/walkthrough-view'

export interface CoachControl {
  action: WalkthroughCardAction
  label: string
  primary: boolean
}

export interface CoachCopy {
  /** "Step 2 of 6", or the phase when no step is current. */
  heading: string
  instruction: string | null
  status: string
  /** Shown only when the budget matters: the last step Métis can guide. */
  budgetNote: string | null
  controls: CoachControl[]
  tone: 'active' | 'paused' | 'ended'
}

/** Whether the card is drawn at all: idle shows nothing. */
export const coachVisible = (view: WalkthroughView): boolean => view.phase !== 'idle'

export function coachCopy(view: WalkthroughView): CoachCopy {
  const tone: CoachCopy['tone'] =
    view.phase === 'paused' ? 'paused' : view.phase === 'completed' || view.phase === 'abandoned' ? 'ended' : 'active'
  const heading =
    view.step !== null && view.stepCount > 0
      ? `Step ${view.step} of ${view.stepCount}`
      : view.phase === 'planning'
        ? 'Getting the steps ready'
        : view.phase === 'completed'
          ? 'All done'
          : view.phase === 'abandoned'
            ? 'Walkthrough stopped'
            : 'Walkthrough'
  const budgetNote =
    view.step !== null && view.step === view.budget ? `This is the last step Métis can guide (${view.budget}).` : null
  const controls: CoachControl[] = []
  if (view.canCheck) controls.push({ action: 'check', label: 'I did it', primary: true })
  if (view.canResume) controls.push({ action: 'resume', label: 'Resume', primary: !view.canCheck })
  else if (view.canPause) controls.push({ action: 'pause', label: 'Pause', primary: false })
  if (view.canStop) controls.push({ action: 'stop', label: 'Stop', primary: false })
  return {
    heading,
    instruction: tone === 'ended' ? null : view.instruction,
    status: view.status,
    budgetNote,
    controls,
    tone
  }
}
