import { useEffect, useState, type CSSProperties } from 'react'
import type { MarkView } from '@shared/screen-marks'
import { arrowGeometry, MARK_EXIT_MS, nextDrawnMarks, type DrawnMark } from './marks-model'

/**
 * The annotation window's marks (G43 lifecycle, G45 visuals; DESIGN.md "Transient pointers"). Every mark arrives in
 * display points and the window is exactly the display, so a mark sits absolutely on its target. A mark carries no
 * text but a step number. Nothing here is interactive: the window is click-through and never takes focus.
 */
export function AnnotationLayer({
  subscribe
}: {
  subscribe: (listener: (marks: MarkView[]) => void) => () => void
}): React.JSX.Element {
  const [drawn, setDrawn] = useState<DrawnMark[]>([])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribe((live) => {
      setDrawn((before) => nextDrawnMarks(before, live, Date.now()))
      // One timer drops whatever finished its exit; the next list re-arms it.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setDrawn((before) => nextDrawnMarks(before, live, Date.now())), MARK_EXIT_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [subscribe])
  return (
    <div className="annotation-layer" aria-hidden="true">
      {drawn.map(({ view, leaving }) => (
        <Mark key={view.markId} mark={view} leaving={leaving} />
      ))}
    </div>
  )
}

export function Mark({ mark, leaving = false }: { mark: MarkView; leaving?: boolean }): React.JSX.Element {
  const leave = leaving ? 'true' : undefined
  switch (mark.kind) {
    case 'box':
      return (
        <div
          className="annotation-mark annotation-box"
          data-mark="box"
          data-leaving={leave}
          style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
        />
      )
    case 'arrow': {
      const { left, top, length, angle } = arrowGeometry(mark.from, mark.to)
      const style = { left, top, width: length, '--mark-rotate': `rotate(${angle}deg)` } as CSSProperties
      return <div className="annotation-mark annotation-arrow" data-mark="arrow" data-leaving={leave} style={style} />
    }
    case 'label-anchor':
      return mark.stepNumber !== undefined ? (
        <div
          className="annotation-mark annotation-step"
          data-mark="label-anchor"
          data-leaving={leave}
          style={{ left: mark.x, top: mark.y }}
        >
          {mark.stepNumber}
        </div>
      ) : (
        <div
          className="annotation-mark annotation-dot"
          data-mark="label-anchor"
          data-leaving={leave}
          style={{ left: mark.x, top: mark.y }}
        />
      )
    case 'point':
      return (
        <div
          className="annotation-mark annotation-dot"
          data-mark="point"
          data-leaving={leave}
          style={{ left: mark.x, top: mark.y }}
        />
      )
  }
}
