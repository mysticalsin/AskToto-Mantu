const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    return el.tabIndex >= 0
  })
}

export function activateDialogFocusTrap(root: HTMLElement): () => void {
  const doc = root.ownerDocument
  const previous =
    doc.activeElement && typeof (doc.activeElement as { focus?: unknown }).focus === 'function'
      ? (doc.activeElement as HTMLElement)
      : null
  const focusFirst = (): void => {
    ;(focusableIn(root)[0] ?? root).focus()
  }
  const focusLast = (): void => {
    const focusables = focusableIn(root)
    ;(focusables[focusables.length - 1] ?? root).focus()
  }

  focusFirst()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Escape stays available to App's window-level collapse/hide handler; the dialog only repairs focus.
      if (!root.contains(doc.activeElement)) focusFirst()
      return
    }
    if (event.key !== 'Tab') return

    const focusables = focusableIn(root)
    if (!focusables.length) {
      event.preventDefault()
      root.focus()
      return
    }
    const active = doc.activeElement
    if (!root.contains(active)) {
      event.preventDefault()
      focusFirst()
      return
    }
    if (event.shiftKey && active === focusables[0]) {
      event.preventDefault()
      focusLast()
    } else if (!event.shiftKey && active === focusables[focusables.length - 1]) {
      event.preventDefault()
      focusFirst()
    }
  }

  doc.addEventListener('keydown', onKeyDown, true)
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    if (previous?.isConnected) previous.focus()
  }
}
