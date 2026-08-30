import { memo } from 'react'

/**
 * Auto-hide rest surface. Hide: wide top-middle hit pad (opaque to hit-testing, not hug-width).
 * Island: visible peek capsule (hug-width OK). Pointer-enter on the pad itself reveals.
 */
export const OverlayPeek = memo(function OverlayPeek({
  onReveal,
  stealth,
  rest = 'island'
}: {
  /** Reveal on hover/click/focus. Hover must land on this control, not a transparent parent. */
  onReveal: () => void
  /** contentProtection is on — island peek keeps a contained multi-colour hint. */
  stealth: boolean
  /** `hide` is a stealth hit pad. `island` is the always-visible peek. */
  rest?: 'hide' | 'island'
}): JSX.Element {
  const hidden = rest === 'hide'
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        data-hug-width={hidden ? undefined : true}
        onPointerEnter={onReveal}
        onClick={onReveal}
        onFocus={onReveal}
        title="Show Métis"
        aria-label="Show Métis"
        className={[
          hidden ? 'overlay-hide-target no-drag focus-ring' : 'overlay-peek no-drag focus-ring',
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
