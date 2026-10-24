import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LINK_OPEN_FAILED_NOTICE } from '@shared/links'
import { LinkFailureNoticeView, anchorFromRect, noticePosition } from './LinkFailureNotice'

describe('link failure notice (G55)', () => {
  it('shows the fixed line near the pointer as an alert', () => {
    const html = renderToStaticMarkup(<LinkFailureNoticeView at={{ x: 100, y: 200 }} />)
    expect(html).toContain(LINK_OPEN_FAILED_NOTICE)
    expect(html).toContain('role="alert"')
    expect(html).toContain('left:100px')
    expect(html).toContain('top:200px')
  })

  it('keeps an empty live region mounted while idle, so the alert is announced when text arrives (G91)', () => {
    const idle = renderToStaticMarkup(<LinkFailureNoticeView at={null} />)
    expect(idle).toContain('role="alert"')
    expect(idle).toContain('sr-only')
    expect(idle).not.toContain(LINK_OPEN_FAILED_NOTICE)
  })

  it('the positioned visual box is aria-hidden so the line is announced once (G91)', () => {
    const html = renderToStaticMarkup(<LinkFailureNoticeView at={{ x: 1, y: 2 }} />)
    expect(html).toMatch(/aria-hidden="true" style="[^"]*left:1px/)
    expect(html.split(LINK_OPEN_FAILED_NOTICE)).toHaveLength(3)
  })

  it('anchorFromRect places the notice below a keyboard-focused link (G91)', () => {
    expect(anchorFromRect({ left: 40, bottom: 120 })).toEqual({ x: 40, y: 120 })
    expect(noticePosition(anchorFromRect({ left: 5000, bottom: 10 }), { width: 400, height: 300 })).toEqual({
      x: 172,
      y: 26
    })
  })

  it('keeps the notice inside the viewport', () => {
    expect(noticePosition({ x: 5000, y: 5000 }, { width: 400, height: 300 })).toEqual({ x: 400 - 220 - 8, y: 300 - 40 })
    expect(noticePosition({ x: -5, y: -5 }, { width: 400, height: 300 })).toEqual({ x: 8, y: 16 })
  })
})
