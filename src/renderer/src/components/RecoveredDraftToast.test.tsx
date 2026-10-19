import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RecoveredDraftToast } from './RecoveredDraftToast'

describe('RecoveredDraftToast', () => {
  it('shows only the recovered count and an action to open History', () => {
    const html = renderToStaticMarkup(
      <RecoveredDraftToast count={2} onOpenHistory={vi.fn()} onDismiss={vi.fn()} />
    )

    expect(html).toContain('2 interrupted meetings recovered')
    expect(html).toContain('Open History')
    expect(html).not.toContain('transcript text')
    expect(html).not.toContain('speaker name')
  })

  it('does not render for an empty or invalid count', () => {
    expect(renderToStaticMarkup(<RecoveredDraftToast count={0} onOpenHistory={() => {}} onDismiss={() => {}} />)).toBe('')
    expect(renderToStaticMarkup(<RecoveredDraftToast count={1.5} onOpenHistory={() => {}} onDismiss={() => {}} />)).toBe('')
  })
})
