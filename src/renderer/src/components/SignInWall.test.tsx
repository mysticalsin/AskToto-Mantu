import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { activateDialogFocusTrap } from '../lib/dialog-focus'
import { SignInWall } from './SignInWall'
import type { AuthStatus } from '@shared/ipc'

const status: AuthStatus = {
  configured: true,
  enforced: true,
  signedIn: false,
  domain: 'example.com',
  email: null,
  source: 'settings'
}

describe('SignInWall dialog accessibility', () => {
  it('renders as a labelled modal dialog', () => {
    const html = renderToStaticMarkup(
      <SignInWall status={status} onSignIn={async () => ({ ok: false, error: 'cancelled' })} />
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const labelId = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(labelId).toBeTruthy()
    expect(html).toContain(`id="${labelId}"`)
    expect(html).toContain('>Sign in to Métis</div>')
    expect(html).toContain('tabindex="-1"')
  })

  it('keeps Tab inside the dialog, consumes Escape, and restores focus on cleanup', () => {
    const outside = element('outside')
    const first = element('first')
    const last = element('last')
    const root = dialog([first, last])
    const doc = fakeDocument(outside)
    root.ownerDocument = doc
    ;[outside, root, first, last].forEach((el) => {
      el.ownerDocument = doc
      el.isConnected = true
    })

    const cleanup = activateDialogFocusTrap(root)
    expect(doc.activeElement).toBe(first)

    doc.activeElement = last
    const forward = key('Tab')
    doc.dispatch(forward)
    expect(forward.preventDefault).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(first)

    doc.activeElement = first
    const backward = key('Tab', true)
    doc.dispatch(backward)
    expect(backward.preventDefault).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(last)

    const escape = key('Escape')
    doc.dispatch(escape)
    expect(escape.preventDefault).toHaveBeenCalledTimes(1)
    expect(escape.stopPropagation).toHaveBeenCalledTimes(1)

    cleanup()
    expect(doc.activeElement).toBe(outside)
  })
})

type FakeElement = {
  id: string
  tabIndex: number
  isConnected: boolean
  ownerDocument: FakeDocument
  focus: () => void
  hasAttribute: (name: string) => boolean
  getAttribute: (name: string) => string | null
}

type FakeRoot = FakeElement & {
  children: FakeElement[]
  querySelectorAll: () => FakeElement[]
  contains: (el: unknown) => boolean
}

type FakeDocument = {
  activeElement: FakeElement | FakeRoot | null
  listeners: Array<(event: KeyboardEvent) => void>
  addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => void
  removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => void
  dispatch: (event: KeyboardEvent) => void
}

function fakeDocument(activeElement: FakeElement): FakeDocument {
  return {
    activeElement,
    listeners: [],
    addEventListener(type, listener) {
      if (type === 'keydown') this.listeners.push(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'keydown') this.listeners = this.listeners.filter((item) => item !== listener)
    },
    dispatch(event) {
      this.listeners.forEach((listener) => listener(event))
    }
  }
}

function element(id: string): FakeElement {
  return {
    id,
    tabIndex: 0,
    isConnected: false,
    ownerDocument: null as unknown as FakeDocument,
    focus() {
      this.ownerDocument.activeElement = this
    },
    hasAttribute: () => false,
    getAttribute: () => null
  }
}

function dialog(children: FakeElement[]): FakeRoot {
  const root: FakeRoot = {
    ...element('root'),
    tabIndex: -1,
    children,
    querySelectorAll: () => children,
    contains: (el) => el === root || children.includes(el as FakeElement)
  }
  return root
}

function key(value: string, shiftKey = false): KeyboardEvent {
  return {
    key: value,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as KeyboardEvent
}
