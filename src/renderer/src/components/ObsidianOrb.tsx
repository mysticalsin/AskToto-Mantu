import { useWindowDrag } from '../lib/window-drag'
import { useRef } from 'react'
import { BAR_PILL_VISIBLE_PX, pillClickShouldExpand } from '../lib/bar-pill-orb'

/**
 * Obsidian Graph View orb: dark disc, cyan spark, purple rings.
 * Same 41 host as the Jakub circle. CSS only. No WebGL.
 */
export function ObsidianOrb({
  onActivate,
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false
}: {
  onActivate: () => void
  title: string
  ariaLabel: string
  enableDrag?: boolean
  hugWidth?: boolean
}): JSX.Element {
  const dragMovedRef = useRef(false)
  const drag = useWindowDrag(
    () => {
      dragMovedRef.current = true
    },
    { armOnControls: true, deadZonePx: 14 }
  )

  return (
    <button
      {...(enableDrag ? drag : {})}
      type="button"
      data-hug-width={hugWidth || undefined}
      data-bar-pill-orb
      data-orb-style="obsidian"
      data-orb-visible={BAR_PILL_VISIBLE_PX}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragMovedRef.current = false
        if (enableDrag) drag.onPointerDown(e)
      }}
      onClick={() => {
        if (enableDrag && !pillClickShouldExpand(dragMovedRef.current)) return
        onActivate()
      }}
      className="aw-orb aw-orb--obsidian no-drag focus-ring"
    >
      <span className="obsidian-orb" aria-hidden="true">
        <span className="obsidian-orb__ring obsidian-orb__ring--outer" />
        <span className="obsidian-orb__ring obsidian-orb__ring--mid" />
        <span className="obsidian-orb__disc">
          <span className="obsidian-orb__spark" />
          <span className="obsidian-orb__mark" />
        </span>
      </span>
    </button>
  )
}
