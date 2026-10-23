import { useCallback, useEffect, useState } from 'react'
import { IDLE_WALKTHROUGH_VIEW, type WalkthroughCardAction, type WalkthroughView } from '@shared/walkthrough-view'
import { coachCopy, coachVisible } from '../lib/walkthrough-coach'

/**
 * The walkthrough coach card in the sidecar (G45, DESIGN.md "Transient pointers"). The instruction and status live
 * here; the screen only gets a numbered mark on the target. Main owns every state; a button is a request that main
 * may refuse, and the next pushed view is the answer.
 */
export function WalkthroughCoachCard({
  view,
  onAction
}: {
  view: WalkthroughView
  onAction: (action: WalkthroughCardAction) => void
}): JSX.Element | null {
  if (!coachVisible(view)) return null
  const copy = coachCopy(view)
  return (
    <section className="coach-card" data-coach-tone={copy.tone} aria-labelledby="coach-card-heading">
      <p id="coach-card-heading" className="coach-card__heading">
        {copy.heading}
      </p>
      {copy.instruction ? <p className="coach-card__instruction">{copy.instruction}</p> : null}
      {copy.status ? (
        <p className="coach-card__status" aria-live={copy.tone === 'paused' ? 'assertive' : 'polite'}>
          {copy.status}
        </p>
      ) : null}
      {copy.budgetNote ? <p className="coach-card__budget">{copy.budgetNote}</p> : null}
      {copy.controls.length > 0 ? (
        <div className="coach-card__controls">
          {copy.controls.map((control) => (
            <button
              key={control.action}
              type="button"
              className={`coach-card__control no-drag focus-ring${control.primary ? ' coach-card__control--primary' : ''}`}
              onClick={() => onAction(control.action)}
            >
              {control.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

/**
 * Subscribes the sidecar to main's walkthrough view (G45). Main owns every state; a button is a request main may
 * refuse, and the next pushed view is the answer. With no bridge (or the feature off) the view stays idle: no card.
 */
export function WalkthroughCoachHost(): JSX.Element | null {
  const [view, setView] = useState<WalkthroughView>(IDLE_WALKTHROUGH_VIEW)
  useEffect(() => {
    const api = window.toto?.walkthrough
    if (!api) return
    let live = true
    let receivedPush = false
    const unsubscribe = api.onView((next) => {
      receivedPush = true
      if (live) setView(next)
    })
    void api
      .current()
      .then((initial) => {
        if (live && !receivedPush) setView(initial)
      })
      .catch(() => {})
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  const act = useCallback((action: WalkthroughCardAction) => {
    void window.toto?.walkthrough?.act(action).catch(() => {})
  }, [])
  return <WalkthroughCoachCard view={view} onAction={act} />
}
