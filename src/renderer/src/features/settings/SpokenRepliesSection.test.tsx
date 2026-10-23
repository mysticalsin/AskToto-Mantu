import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { SpokenRepliesSection } from './SpokenRepliesSection'

function render(managedKeys: string[] = []) {
  const patch = vi.fn()
  const settings = {
    spokenReplies: { speakReplies: false, voiceId: null, rate: 1 },
    managedKeys
  } as unknown as PublicSettings
  const html = renderToStaticMarkup(createElement(SpokenRepliesSection, { settings, patch }))
  return { html, patch }
}

describe('spoken replies preview settings (G27)', () => {
  it('keeps the fixed preview available while automatic replies are off without enabling the saved setting', () => {
    const { html, patch } = render()
    const preview = html.match(/<button\b[^>]*>Preview voice<\/button>/)?.[0]

    expect(html).toContain('Automatic replies are off. The fixed preview remains available')
    expect(preview).toBeDefined()
    expect(preview).not.toMatch(/\sdisabled(?:=|>)/)
    expect(html).toContain('data-spoken-sub-rows="enabled"')
    expect(patch).not.toHaveBeenCalled()
  })

  it('keeps Preview disabled when the voice setting is managed', () => {
    const { html } = render(['spokenReplies'])
    const preview = html.match(/<button\b[^>]*>Preview voice<\/button>/)?.[0]

    expect(preview).toMatch(/\sdisabled(?:=|>)/)
    expect(html).toContain('Your organization sets this. You can&#x27;t change it here.')
  })
})
