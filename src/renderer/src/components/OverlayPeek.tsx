import { memo } from 'react'

/**
 * Auto-hide rest surface. Hide: invisible 1-8px hairline (cursor watch is the sensor).
 * Island: visible peek capsule. Dock: visible right-edge sliver.
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
  /** `hide` is an invisible hairline. `island` is the top peek. `dock` is the edge sliver. */
  rest?: 'hide' | 'island' | 'dock'
}): JSX.Element {
  const hidden = rest === 'hide'
  const dock = rest === 'dock'
  return (
    <div className={dock ? 'flex w-full justify-end' : 'flex w-full justify-center'}>
      <button
        type="button"
        data-hug-width={hidden ? undefined : true}
        onPointerEnter={hidden ? undefined : onReveal}
        onClick={onReveal}
        onFocus={onReveal}
        title="Show Métis"
        aria-label="Show Métis"
        className={[
          hidden ? 'overlay-hide-target no-drag' : dock ? 'overlay-dock-peek no-drag focus-ring' : 'overlay-peek no-drag focus-ring',
          !hidden && stealth ? (dock ? 'overlay-dock-peek--stealth' : 'overlay-peek--stealth') : ''
        ].join(' ')}
      >
        {dock ? (
          <span className="overlay-dock-peek__rail" aria-hidden="true" />
        ) : !hidden ? (
          <span className="overlay-peek__grip" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
    </div>
  )
})
