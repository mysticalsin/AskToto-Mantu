import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TASK_BROWSER_COPY } from '@shared/task-browser'
import { TaskBrowserSection } from './TaskBrowserSection'

describe('TaskBrowserSection', () => {
  const html = renderToStaticMarkup(createElement(TaskBrowserSection))
  const text = html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

  it('tells the person it is a separate profile, where it lives and how to clear it', () => {
    expect(text).toContain('its own browser profile')
    expect(text).toContain('own cookies and sign-ins')
    expect(text).toContain('app data folder')
    expect(text).toContain('clear it here')
    expect(text).toContain(TASK_BROWSER_COPY.clearButton)
  })

  it('says honestly that the current tab is not available and offers no control for it', () => {
    expect(text).toContain("Using your current browser tab isn't available yet.")
    expect(html).not.toMatch(/current tab[^<]*<\/button>/i)
  })
})
