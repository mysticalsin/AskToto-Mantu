import { useEffect, useState } from 'react'
import type { MarkView } from '@shared/screen-marks'

/**
 * The annotation layer's PLACEHOLDER rendering (G43): plain rectangles, dots, a line and a numbered dot, from tokens.
 * The real visuals are designed in G45. Every mark arrives already in display points, and the window is exactly the
 * display, so a mark is positioned absolutely at its coordinates. Nothing here is interactive (the window is click-through).
 */
export function AnnotationLayer({
  subscribe
}: {
  subscribe: (listener: (marks: MarkView[]) => void) => () => void
}): React.JSX.Element {
  const [marks, setMarks] = useState<MarkView[]>([])
  useEffect(() => subscribe(setMarks), [subscribe])
  return (
    <div className="annotation-layer" aria-hidden="true">
      {marks.map((mark) => {
        if (mark.kind === 'box') {
          return (
            <div
              key={mark.markId}
              className="annotation-box"
              data-mark={mark.kind}
              style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
            />
          )
        }
        if (mark.kind === 'arrow') return <ArrowMark key={mark.markId} mark={mark} />
        return (
          <div key={mark.markId} className="annotation-dot" data-mark={mark.kind} style={{ left: mark.x, top: mark.y }}>
            {mark.kind === 'label-anchor' && mark.stepNumber !== undefined ? mark.stepNumber : null}
          </div>
        )
      })}
    </div>
  )
}

function ArrowMark({ mark }: { mark: Extract<MarkView, { kind: 'arrow' }> }): React.JSX.Element {
  const dx = mark.to.x - mark.from.x
  const dy = mark.to.y - mark.from.y
  const length = Math.hypot(dx, dy)
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  return (
    <div
      className="annotation-arrow"
      data-mark="arrow"
      style={{ left: mark.from.x, top: mark.from.y, width: length, transform: `rotate(${angle}deg)` }}
    />
  )
}
