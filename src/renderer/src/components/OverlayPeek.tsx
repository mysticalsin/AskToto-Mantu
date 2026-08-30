import { memo } from 'react'

/**
 * Auto-hide peek strip (MQA-274) — the slim, top-hugging capsule the overlay collapses to when the
 * pointer isn't over it and nothing important is happening (the Vibe-Island "notch" resting state).
 * Hovering it (the parent container's pointer-enter drives the reveal) grows the full bar back; this
 * component only paints the resting affordance and offers a click fallback to reveal.
 *
 * data-hug-width: like the collapsed control pill, this makes useAutoResize report the capsule's own
 * shrink-to-fit width so the always-on-top window narrows to hug it — otherwise the transparent margin
 * around a slim strip would silently swallow clicks meant for whatever app is behind it. The window then
 * sits as a small strip at the top-center anchor, growing downward on reveal.
 */
export const OverlayPeek = memo(function OverlayPeek({
  onReveal,
  stealth,
  rest = 'island'
}: {
  /** Reveal on an explicit click (keyboard/click fallback to the hover reveal the container handles). */
  onReveal: () => void
  /** contentProtection is on (overlay hidden from screen capture) — carry a contained multi-colour hint
   *  so the "invisible" cue survives into the peek without the full halo the wide bar can afford. */
  stealth: boolean
  /** `hide` is a fully hidden hit target. `island` is the always-visible peek. */
  rest?: 'hide' | 'island'
}): JSX.Element {
  const hidden = rest === 'hide'
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        data-hug-width
        onClick={onReveal}
        onFocus={onReveal}
        title="Show Métis"
        aria-label="Show Métis"
        className={[
          hidden ? 'overlay-hide-target no-drag focus-ring' : 'overlay-peek no-drag focus-ring',
          !hidden && stealth ? 'overlay-peek--stealth' : ''
        ].join(' ')}
      >
        {/* Three-dot grip reads as a pull-down handle without any text or icon weight. */}
        <span className="overlay-peek__grip" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>
    </div>
  )
})
