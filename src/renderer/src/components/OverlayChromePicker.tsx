import { useRef, type KeyboardEvent } from 'react'
import {
  OVERLAY_LAYOUT_COPY,
  parseOverlayLayout,
  type OverlayLayout
} from '@shared/overlay-chrome'
import {
  allowedOverlayLayouts,
  resolveOverlayPresentation
} from '@shared/overlay-presentation'
import type { OverlayPlacement } from '@shared/overlay-placement'

function ChromeDiagram({ id }: { id: OverlayLayout }): JSX.Element {
  return (
    <div
      className={`overlay-chrome-diagram overlay-chrome-diagram--${id}`}
      data-chrome-diagram={id}
      aria-hidden="true"
    >
      <span className="overlay-chrome-diagram__desktop" />
      <span className="overlay-chrome-diagram__mark" />
      {id === 'bar' ? <span className="overlay-chrome-diagram__orb" /> : null}
    </div>
  )
}

export function OverlayChromePicker({
  value,
  placement,
  locked,
  onChange,
  copy = OVERLAY_LAYOUT_COPY
}: {
  value: unknown
  placement: OverlayPlacement
  locked: boolean
  onChange: (id: OverlayLayout) => void
  copy?: Record<OverlayLayout, { title: string; desc: string }>
}): JSX.Element {
  const layouts = allowedOverlayLayouts(placement)
  const parsedLayout = parseOverlayLayout(value)
  const selected = resolveOverlayPresentation({ layout: parsedLayout, placement }).layout
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % layouts.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + layouts.length) % layouts.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = layouts.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    onChange(layouts[nextIndex])
    radioRefs.current[nextIndex]?.focus()
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Overlay chrome" className={'overlay-chrome-grid' + (layouts.length === 2 ? ' overlay-chrome-grid--two' : '')}>
      {layouts.map((id, index) => {
        const on = selected === id
        return (
          <button
            key={id}
            ref={(element) => { radioRefs.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={locked}
            onClick={() => onChange(id)}
            onKeyDown={(event) => moveSelection(event, index)}
            className={
              'overlay-chrome-card no-drag focus-ring min-h-11 ' +
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
      <p aria-live="polite" className="mt-2 mb-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        {placement === 'right-edge' ? 'Bar is available only at Top center.' : 'Choose how Métis rests at the top center.'}
      </p>
    </div>
  )
}
