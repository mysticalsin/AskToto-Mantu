import { useEffect, useRef } from 'react'
import {
  OVERLAY_ORB_COPY,
  OVERLAY_ORB_PICKER_CARDS,
  overlayOrbPickerSelected,
  parseOverlayOrbStyle,
  type OverlayOrbPickerCard,
  type OverlayOrbStyle
} from '@shared/overlay-orb'
import { createJarvisOrb } from '../lib/jarvis-orb'

function OrbDiagram({ id }: { id: OverlayOrbPickerCard }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (id !== 'obsidian') return
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const handle = createJarvisOrb(canvas, { reducedMotion: reduced, state: 'idle' })
    return () => handle?.dispose()
  }, [id])

  return (
    <div
      className={`overlay-orb-diagram overlay-orb-diagram--${id}`}
      data-orb-diagram={id}
      aria-hidden="true"
    >
      <span className="overlay-orb-diagram__desktop" />
      {id === 'bar' ? <span className="overlay-orb-diagram__bar" /> : null}
      {id === 'jakub' ? (
        <span className="overlay-orb-diagram__jakub" data-orb-diagram-engine="thinking-orbs" />
      ) : (
        <span
          className={
            'overlay-orb-diagram__jarvis' + (id === 'obsidian' ? ' overlay-orb-diagram__jarvis--live' : '')
          }
          data-orb-diagram-engine={id === 'obsidian' ? 'jarvis-particles' : undefined}
        >
          {id === 'obsidian' ? (
            <canvas ref={canvasRef} className="overlay-orb-diagram__canvas" width={82} height={82} />
          ) : (
            <>
              <span className="overlay-orb-diagram__dot overlay-orb-diagram__dot--a" />
              <span className="overlay-orb-diagram__dot overlay-orb-diagram__dot--b" />
              <span className="overlay-orb-diagram__dot overlay-orb-diagram__dot--c" />
              <span className="overlay-orb-diagram__link overlay-orb-diagram__link--a" />
              <span className="overlay-orb-diagram__link overlay-orb-diagram__link--b" />
            </>
          )}
        </span>
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
    <div role="radiogroup" aria-label="Bar rest" className="overlay-chrome-grid">
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
            <OrbDiagram id={id} />
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
