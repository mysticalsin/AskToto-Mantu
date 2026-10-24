import { useEffect, useRef, useState } from 'react'
import type { OnboardingSkipOutcome } from '../lib/onboarding-skip'
import { ONBOARDING_COMPLETION_ERROR } from '../lib/onboarding-completion'

/**
 * Skip setup (D-27, G56, Opus design): a quiet text button at the top right, only after the permissions step and
 * only once consent is given (the host gates the mount with `canSkipOnboarding`). It opens an in-stage sheet;
 * "Keep going" holds the default focus and Escape, so skipping is always a deliberate second click.
 */
export function OnboardingSkip({ onConfirm }: { onConfirm: () => Promise<OnboardingSkipOutcome> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    keepRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const skip = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const outcome = await onConfirm()
    setBusy(false)
    if (outcome === 'failed') setError(ONBOARDING_COMPLETION_ERROR)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="onboard-skip-button no-drag focus-ring"
        aria-haspopup="dialog"
      >
        Skip setup
      </button>
      {open && (
        <div className="onboard-skip-backdrop">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboard-skip-title"
            aria-describedby="onboard-skip-body"
            className="onboard-skip-sheet"
          >
            <h2 id="onboard-skip-title" className="onboard-skip-title">
              Skip the rest of setup?
            </h2>
            <p id="onboard-skip-body" className="onboard-skip-body">
              You can replay it anytime from Settings. Anything you started here is cleared. Assistants you already
              created stay.
            </p>
            {error && (
              <p role="alert" className="onboard-interview-error">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-3">
              <button
                ref={keepRef}
                type="button"
                onClick={() => setOpen(false)}
                className="onboard-cta no-drag focus-ring"
              >
                Keep going
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void skip()}
                className="onboard-interview-text no-drag focus-ring"
              >
                {busy ? 'Skipping…' : 'Skip'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
