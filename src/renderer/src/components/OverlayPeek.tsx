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
  rest?: 'hide' | 'island' | 'dock' | 'dock-hidden'
}): JSX.Element {
  // A hidden dock paints nothing, exactly like Hide. It stays MOUNTED and keeps its hover/click/focus
  // handlers: main's cursor watch is the sensor either way, and the window is still there, so making it
  // unreachable as well as unseen would be a different feature (and a trap).
  const dockHidden = rest === 'dock-hidden'
  const hidden = rest === 'hide' || dockHidden
  const dock = rest === 'dock' || dockHidden
  return (
    <div className={dock ? 'flex w-full justify-end' : 'flex w-full justify-center'}>
      <button
        type="button"
        data-hug-width={hidden ? undefined : true}
        // Hide's pad is click-through by design (the OS cursor watch reveals it). A hidden DOCK keeps its
        // pointer affordance: the sliver's own window is what the pointer lands on at the edge.
        onPointerEnter={rest === 'hide' ? undefined : onReveal}
        onClick={onReveal}
        onFocus={onReveal}
        title="Show Métis"
        aria-label="Show Métis"
        className={[
          dockHidden
            ? 'overlay-dock-peek overlay-dock-peek--invisible no-drag focus-ring'
            : hidden
              ? 'overlay-hide-target no-drag'
              : dock
                ? 'overlay-dock-peek no-drag focus-ring'
                : 'overlay-peek no-drag focus-ring',
          !hidden && stealth ? (dock ? 'overlay-dock-peek--stealth' : 'overlay-peek--stealth') : ''
        ].join(' ')}
      >
        {dock && !dockHidden ? (
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
