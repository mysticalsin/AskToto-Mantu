import {
  OVERLAY_ORB_COPY,
  OVERLAY_ORB_STYLES,
  parseOverlayOrbStyle,
  type OverlayOrbStyle
} from '@shared/overlay-orb'

function OrbDiagram({ id }: { id: OverlayOrbStyle }): JSX.Element {
  return (
    <div
      className={`overlay-orb-diagram overlay-orb-diagram--${id}`}
      data-orb-diagram={id}
      aria-hidden="true"
    >
      <span className="overlay-orb-diagram__desktop" />
      {id === 'bar' ? <span className="overlay-orb-diagram__bar" /> : null}
      {id === 'jakub' ? <span className="overlay-orb-diagram__jakub" /> : null}
      {id === 'obsidian' ? (
        <span className="overlay-orb-diagram__obsidian">
          <span className="overlay-orb-diagram__spark" />
        </span>
      ) : null}
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
  const selected = parseOverlayOrbStyle(value)
  return (
    <div role="radiogroup" aria-label="Bar rest" className="overlay-chrome-grid">
      {OVERLAY_ORB_STYLES.map((id) => {
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
            <OrbDiagram id={id} />
            <span className="overlay-chrome-card__title">
              {OVERLAY_ORB_COPY[id].title}
              {id === 'bar' ? <span className="overlay-chrome-card__default">Default</span> : null}
            </span>
            <span className="overlay-chrome-card__desc">{OVERLAY_ORB_COPY[id].desc}</span>
          </button>
        )
      })}
    </div>
  )
}
