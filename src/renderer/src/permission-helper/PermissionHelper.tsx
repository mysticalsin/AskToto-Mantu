/**
 * PermissionHelper.tsx — the guided grant helper's window content (C32 Part D; flow in @shared/permission-helper).
 *
 * HIG: one primary action per state, never "Allow"; Cancel always there (Escape cancels, Return takes the
 * default); the app item is a real drag source, with "Show Métis in Finder" as the keyboard path to it; the hint
 * arrow nudges three times and stops, and not at all under Reduce Motion; VoiceOver hears the instruction and
 * every state change (role=status).
 */
import { useEffect, useState } from 'react'
import type { HelperView, PermissionHelperApi } from '@shared/permission-helper'

function Arrow({ towards }: { towards: HelperView['towards'] }): JSX.Element {
  return (
    <span className={`ph__arrow ph__arrow--${towards}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M19 12H5M11 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function Check(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const PANE_APP = { darwin: 'System Settings', win32: 'Settings' } as const

export function PermissionHelperView({
  state,
  api
}: {
  state: HelperView
  api: Pick<PermissionHelperApi, 'startDrag' | 'reveal' | 'cancel' | 'relaunch'>
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void api.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  const where = `${PANE_APP[state.platform]} › ${state.pane}`
  const icon = state.icon ? (
    <img className="ph__icon" src={state.icon} alt="" width={40} height={40} draggable={false} />
  ) : (
    <span className="ph__icon ph__icon--blank" aria-hidden="true" />
  )

  if (state.phase === 'granted') {
    return (
      <main className="ph" data-phase="granted" aria-label={`${state.appName} access`}>
        <div className="ph__row">
          <span className="ph__done">
            <Check />
          </span>
          <p className="ph__title" role="status">
            {state.pane} is on for {state.appName}.
          </p>
        </div>
        <div className="ph__actions">
          <button type="button" className="ph__button" onClick={() => void api.cancel()}>
            Close
          </button>
        </div>
      </main>
    )
  }

  if (state.phase === 'relaunch') {
    return (
      <main className="ph" data-phase="relaunch" aria-label={`${state.appName} access`}>
        <div className="ph__row">
          <span className="ph__done">
            <Check />
          </span>
          <p className="ph__title" role="status">
            {state.pane} is on. macOS turns it on for {state.appName} when it relaunches.
          </p>
        </div>
        <div className="ph__actions">
          <button type="button" className="ph__button" onClick={() => void api.cancel()}>
            Cancel
          </button>
          {/* The one default action of this state: Return relaunches. */}
          <button
            type="button"
            className="ph__button ph__button--primary"
            autoFocus
            onClick={() => void api.relaunch()}
          >
            Relaunch {state.appName}
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="ph" data-phase="waiting" aria-label={`Turn on ${state.appName} in ${where}`}>
      <div className="ph__row">
        {state.drag ? (
          <div
            className="ph__app"
            draggable
            role="img"
            aria-label={`${state.appName}. Drag it into the list in ${where}.`}
            onDragStart={(e) => {
              e.preventDefault()
              api.startDrag()
            }}
          >
            {icon}
            <span className="ph__name">{state.appName}</span>
          </div>
        ) : (
          <div className="ph__app ph__app--static">
            {icon}
            <span className="ph__name">{state.appName}</span>
          </div>
        )}
        {state.drag && <Arrow towards={state.towards} />}
        <div className="ph__text">
          <p className="ph__title" role="status">
            {state.instruction}
          </p>
          <p className="ph__sub">{state.appName} notices as soon as it is on.</p>
        </div>
      </div>
      <div className="ph__actions">
        {state.drag && (
          <button type="button" className="ph__button ph__button--link" onClick={() => void api.reveal()}>
            Show {state.appName} in Finder
          </button>
        )}
        <button type="button" className="ph__button" onClick={() => void api.cancel()}>
          Cancel
        </button>
      </div>
    </main>
  )
}

/** The helper window: follows main's state; renders nothing until the first one arrives or once closed. */
export function PermissionHelperApp({ api }: { api: PermissionHelperApi }): JSX.Element | null {
  const [state, setState] = useState<HelperView | null>(null)
  useEffect(() => {
    const off = api.onState(setState)
    void api.getState().then((first) => {
      if (first) setState((current) => current ?? first)
    })
    return off
  }, [api])
  if (!state || state.phase === 'closed') return null
  return <PermissionHelperView state={state} api={api} />
}
