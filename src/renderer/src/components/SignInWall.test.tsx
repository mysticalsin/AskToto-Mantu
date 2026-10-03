import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateDialogFocusTrap } from '../lib/dialog-focus'
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
  afterEach(() => {
    vi.doUnmock('react')
    vi.doUnmock('../lib/dialog-focus')
    vi.resetModules()
  })

  it('renders as a labelled modal dialog', async () => {
    const { SignInWall } = await import('./SignInWall')
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

  it('keeps Tab inside the dialog, lets Escape bubble, and restores focus on cleanup', () => {
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
    expect(escape.preventDefault).not.toHaveBeenCalled()
    expect(escape.stopPropagation).not.toHaveBeenCalled()

    doc.activeElement = outside
    const escapedFromOutside = key('Escape')
    doc.dispatch(escapedFromOutside)
    expect(escapedFromOutside.preventDefault).not.toHaveBeenCalled()
    expect(escapedFromOutside.stopPropagation).not.toHaveBeenCalled()
    expect(doc.activeElement).toBe(first)

    cleanup()
    expect(doc.activeElement).toBe(outside)
  })

  it('activates the focus trap when the wall mounts', async () => {
    const root = element('dialog-root') as unknown as HTMLDivElement
    const cleanup = vi.fn()
    const trap = vi.fn(() => cleanup)

    vi.resetModules()
    vi.doMock('react', async (importOriginal) => {
      const react = await importOriginal<typeof import('react')>()
      return {
        ...react,
        useEffect: (effect: () => void | (() => void)) => effect(),
        useId: () => 'signin-title',
        useRef: () => ({ current: root }),
        useState: <T,>(init: T) => [init, vi.fn()] as const
      }
    })
    vi.doMock('../lib/dialog-focus', () => ({ activateDialogFocusTrap: trap }))

    const { SignInWall } = await import('./SignInWall')
    SignInWall({ status, onSignIn: async () => ({ ok: false, error: 'cancelled' }) })

    expect(trap).toHaveBeenCalledWith(root)
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
