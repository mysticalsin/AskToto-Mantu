import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'
import { ShortcutFailureToast } from './ShortcutFailureToast'

describe('ShortcutFailureToast (D10-5)', () => {
  it('is a non-modal status with the message and an Open Shortcuts action', () => {
    const html = renderToStaticMarkup(
      <ShortcutFailureToast
        message="Show / hide shortcut Ctrl+Shift+H is used by another app. Choose a different one in Settings → Shortcuts."
        onOpenShortcuts={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alertdialog"')
    expect(html).toContain('is used by another app')
    expect(html).toContain('Open Shortcuts')
  })

  it('renders nothing without a message', () => {
    expect(
      renderToStaticMarkup(<ShortcutFailureToast message={null} onOpenShortcuts={vi.fn()} onDismiss={vi.fn()} />)
    ).toBe('')
  })

  it('is mounted by OverlayToasts, which also widens the minimized pill for it', () => {
    const { text } = readModuleSource(__dirname, './OverlayToasts')
    expect(text).toMatch(/<ShortcutFailureToast[\s\S]*onOpenShortcuts=/)
    expect(text).toMatch(/useShortcutFailureToast\(\)/)
    expect(text).toMatch(/shortcutToast\.message/)
  })
})
