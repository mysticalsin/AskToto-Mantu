import {
  OVERLAY_LAYOUTS,
  OVERLAY_LAYOUT_COPY,
  parseOverlayLayout,
  type OverlayLayout
} from '@shared/overlay-chrome'

function ChromeDiagram({ id }: { id: OverlayLayout }): JSX.Element {
  return (
    <div
      className={`overlay-chrome-diagram overlay-chrome-diagram--${id}`}
      data-chrome-diagram={id}
      aria-hidden="true"
    >
      <span className="overlay-chrome-diagram__desktop" />
      <span className="overlay-chrome-diagram__mark" />
    </div>
  )
}

export function OverlayChromePicker({
  value,
  locked,
  onChange,
  copy = OVERLAY_LAYOUT_COPY
}: {
  value: unknown
  locked: boolean
  onChange: (id: OverlayLayout) => void
  copy?: Record<OverlayLayout, { title: string; desc: string }>
}): JSX.Element {
  const selected = parseOverlayLayout(value)
  return (
    <div role="radiogroup" aria-label="Overlay chrome" className="overlay-chrome-grid">
      {OVERLAY_LAYOUTS.map((id) => {
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
            <ChromeDiagram id={id} />
            <span className="overlay-chrome-card__title">
              {copy[id].title}
              {id === 'hide' ? <span className="overlay-chrome-card__default">Default</span> : null}
            </span>
            <span className="overlay-chrome-card__desc">{copy[id].desc}</span>
          </button>
        )
      })}
    </div>
  )
}
