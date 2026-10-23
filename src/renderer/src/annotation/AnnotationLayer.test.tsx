import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Mark } from './AnnotationLayer'

describe('Mark (G45, DESIGN.md "Transient pointers")', () => {
  it('draws a box exactly on its target in display points', () => {
    const html = renderToStaticMarkup(<Mark mark={{ markId: 'b', kind: 'box', x: 12, y: 34, width: 56, height: 78 }} />)
    expect(html).toContain('class="annotation-mark annotation-box"')
    expect(html).toContain('left:12px;top:34px;width:56px;height:78px')
  })

  it('a step anchor shows only its number, a bare anchor shows a dot', () => {
    const step = renderToStaticMarkup(<Mark mark={{ markId: 's', kind: 'label-anchor', x: 1, y: 2, stepNumber: 3 }} />)
    expect(step).toContain('annotation-step')
    expect(step).toMatch(/>3<\/div>$/)
    const bare = renderToStaticMarkup(<Mark mark={{ markId: 'd', kind: 'label-anchor', x: 1, y: 2 }} />)
    expect(bare).toContain('annotation-dot')
    expect(bare).not.toMatch(/>\d+</)
  })

  it('rotates an arrow through the CSS variable so the enter animation keeps the rotation', () => {
    const html = renderToStaticMarkup(
      <Mark mark={{ markId: 'a', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 0, y: 20 } }} />
    )
    expect(html).toContain('--mark-rotate:rotate(90deg)')
    expect(html).toContain('width:20px')
  })

  it('marks a leaving mark for its exit and never carries any text but a step number', () => {
    const html = renderToStaticMarkup(<Mark mark={{ markId: 'p', kind: 'point', x: 0, y: 0 }} leaving />)
    expect(html).toContain('data-leaving="true"')
    expect(html.replace(/<[^>]+>/g, '')).toBe('')
  })
})
