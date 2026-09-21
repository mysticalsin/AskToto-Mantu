import {
  OVERLAY_PLACEMENTS,
  parseOverlayPlacement,
  type OverlayPlacement
} from '@shared/overlay-placement'

const OVERLAY_PLACEMENT_COPY: Record<OverlayPlacement, { title: string; desc: string }> = {
  'top-center': {
    title: 'Top',
    desc: 'Hide, Island, or Bar at the top of your display.'
  },
  'right-edge': {
    title: 'Right edge',
    desc: 'Dock chat sidecar. Drag it up or down.'
  }
}

function PlacementDiagram({ id }: { id: OverlayPlacement }): JSX.Element {
  return (
    <div
      className={`overlay-placement-diagram overlay-placement-diagram--${id}`}
      data-placement-diagram={id}
      aria-hidden="true"
    >
      <span className="overlay-placement-diagram__desktop" />
      <span className="overlay-placement-diagram__mark" />
    </div>
  )
}

/** Physical location only. Visual chrome remains selected by OverlayChromePicker. */
export function OverlayPlacementPicker({
  value,
  locked,
  onChange
}: {
  value: unknown
  locked: boolean
  onChange: (id: OverlayPlacement) => void
}): JSX.Element {
  const selected = parseOverlayPlacement(value)
  return (
    <div role="radiogroup" aria-label="Overlay position" className="overlay-chrome-grid overlay-chrome-grid--two">
      {OVERLAY_PLACEMENTS.map((id) => {
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
            <PlacementDiagram id={id} />
            <span className="overlay-chrome-card__title">
              {OVERLAY_PLACEMENT_COPY[id].title}
              {id === 'top-center' ? <span className="overlay-chrome-card__default">Default</span> : null}
            </span>
            <span className="overlay-chrome-card__desc">{OVERLAY_PLACEMENT_COPY[id].desc}</span>
          </button>
        )
      })}
    </div>
  )
}
