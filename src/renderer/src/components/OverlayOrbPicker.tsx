import {
  OVERLAY_ORB_COPY,
  OVERLAY_ORB_PICKER_CARDS,
  overlayOrbPickerSelected,
  parseOverlayOrbStyle,
  type OverlayOrbPickerCard,
  type OverlayOrbStyle
} from '@shared/overlay-orb'
import { JarvisOrbButton } from './JarvisOrbButton'
import { ObsidianOrb } from './ObsidianOrb'

function OrbDiagram({ id, animate }: { id: OverlayOrbPickerCard; animate: boolean }): JSX.Element {
  return (
    <div
      className={`overlay-orb-diagram overlay-orb-diagram--${id}`}
      data-orb-diagram={id}
      data-orb-diagram-animate={animate || undefined}
      aria-hidden="true"
    >
      {id === 'jakub' ? (
        <JarvisOrbButton preview animate={animate} onActivate={() => undefined} title="" ariaLabel="" />
      ) : (
        <ObsidianOrb preview animate={animate} onActivate={() => undefined} title="" ariaLabel="" />
      )}
    </div>
  )
}

export function OverlayOrbPicker({
  value,
  locked,
  onChange
}: {
  value: unknown
  locked: boolean
  onChange: (id: OverlayOrbStyle) => void
}): JSX.Element {
  const selected = overlayOrbPickerSelected(parseOverlayOrbStyle(value))
  return (
    <div role="radiogroup" aria-label="Bar rest" className="overlay-chrome-grid overlay-chrome-grid--two">
      {OVERLAY_ORB_PICKER_CARDS.map((id) => {
        const on = selected === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={locked}
            onClick={() => onChange(id)}
            className={
              'overlay-chrome-card no-drag focus-ring ' +
              (on ? 'overlay-chrome-card--selected' : '') +
              (locked ? ' opacity-60' : '')
            }
          >
            <OrbDiagram id={id} animate={on} />
            <span className="overlay-chrome-card__title">
              {OVERLAY_ORB_COPY[id].title}
              {id === 'jakub' ? <span className="overlay-chrome-card__default">Default</span> : null}
            </span>
            <span className="overlay-chrome-card__desc">{OVERLAY_ORB_COPY[id].desc}</span>
          </button>
        )
      })}
    </div>
  )
}
