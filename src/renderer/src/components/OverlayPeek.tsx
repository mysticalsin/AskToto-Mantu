import { memo } from 'react'

/**
 * Auto-hide rest surface. Hide: invisible 1–8px hairline (cursor watch is the sensor).
 * Island: visible peek capsule (hug-width OK).
 */
export const OverlayPeek = memo(function OverlayPeek({
  onReveal,
  stealth,
  rest = 'island'
}: {
  /** Reveal on hover/click/focus. Hide relies on main-process cursor watch, not this pad. */
  onReveal: () => void
  /** contentProtection is on — island peek keeps a contained multi-colour hint. */
  stealth: boolean
  /** `hide` is an invisible hairline. `island` is the always-visible peek. */
  rest?: 'hide' | 'island'
}): JSX.Element {
  const hidden = rest === 'hide'
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        data-hug-width
        onPointerEnter={hidden ? undefined : onReveal}
        onClick={onReveal}
        onFocus={onReveal}
        title="Show Métis"
        aria-label="Show Métis"
        className={[
          hidden ? 'overlay-hide-target no-drag' : 'overlay-peek no-drag focus-ring',
          !hidden && stealth ? 'overlay-peek--stealth' : ''
        ].join(' ')}
      >
        {!hidden && (
          <span className="overlay-peek__grip" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </button>
    </div>
  )
})
