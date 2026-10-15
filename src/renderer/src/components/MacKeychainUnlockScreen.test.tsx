import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MacKeychainUnlockScreen } from './MacKeychainUnlockScreen'

describe('MacKeychainUnlockScreen', () => {
  it('explains Keychain access and that denial leaves profile files unchanged', () => {
    const html = renderToStaticMarkup(
      createElement(MacKeychainUnlockScreen, { setRoot: () => undefined, onUnlock: async () => undefined })
    )

    expect(html).toContain('Unlock secure storage')
    expect(html).toContain('Continue to Keychain')
    expect(html).toContain('Denying access leaves your files unchanged.')
  })
})
