import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LINK_OPEN_FAILED_NOTICE } from '@shared/links'
import { LinkFailureNoticeView, noticePosition } from './LinkFailureNotice'

describe('link failure notice (G55)', () => {
  it('shows the fixed line near the pointer as an alert', () => {
    const html = renderToStaticMarkup(<LinkFailureNoticeView at={{ x: 100, y: 200 }} />)
    expect(html).toContain(LINK_OPEN_FAILED_NOTICE)
    expect(html).toContain('role="alert"')
    expect(html).toContain('left:100px')
    expect(html).toContain('top:200px')
  })

  it('renders nothing when there is no failure', () => {
    expect(renderToStaticMarkup(<LinkFailureNoticeView at={null} />)).toBe('')
  })

  it('keeps the notice inside the viewport', () => {
    expect(noticePosition({ x: 5000, y: 5000 }, { width: 400, height: 300 })).toEqual({ x: 400 - 220 - 8, y: 300 - 40 })
    expect(noticePosition({ x: -5, y: -5 }, { width: 400, height: 300 })).toEqual({ x: 8, y: 16 })
  })
})
