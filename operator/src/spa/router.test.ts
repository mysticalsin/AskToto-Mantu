import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PATHNAME_STRIP_JS } from './client'
import { SPA_CSS, SPA_JS } from './manifest'

const PAGES = [
  'overview',
  'realtime',
  'events',
  'sessions',
  'notifications',
  'keys',
  'settings'
] as const

function pathnameStripNeedle(): string {
  return ['location.pathname.replace(', '/', '^', '\\', '/', '/', ", '')"].join('')
}

describe('hashed SPA router (#104)', () => {
  it('compiles: shipped JS parses and keeps the pathname strip that will parse', () => {
    expect(pathnameStripNeedle()).toBe(PATHNAME_STRIP_JS)
    expect(SPA_JS).toContain(PATHNAME_STRIP_JS)
    expect(() => new Function(SPA_JS)).not.toThrow()
    expect(SPA_JS).toContain('window.route = route')
    expect(SPA_JS).toContain("requested === 'map' ? 'realtime'")

    const open = PATHNAME_STRIP_JS.indexOf('(')
    const comma = PATHNAME_STRIP_JS.lastIndexOf(',')
    const literal = PATHNAME_STRIP_JS.slice(open + 1, comma)
    expect(literal.charAt(0)).toBe('/')
    expect(literal.charAt(1)).toBe('^')
    expect(literal.charAt(2)).toBe('\\')
    expect(literal.charAt(3)).toBe('/')
    expect(literal.charAt(4)).toBe('/')
    expect(literal.length).toBe(5)
    const re = new Function(`return ${literal}`)() as RegExp
    expect('/keys'.replace(re, '')).toBe('keys')
    expect('realtime'.replace(re, '')).toBe('realtime')
  })

  it('window.route is a function and swaps the main body for every KEEP page', () => {
    const pages = PAGES.map((id) => {
      const el = {
        hidden: id !== 'overview',
        getAttribute(name: string) {
          return name === 'data-page' ? id : null
        }
      }
      return el
    })
    const navs = PAGES.map((id) => {
      const el = {
        on: id === 'overview',
        getAttribute(name: string) {
          return name === 'data-nav' ? id : null
        },
        classList: {
          toggle(_name: string, on: boolean) {
            el.on = on
          }
        }
      }
      return el
    })
    const title = { textContent: 'Overview' }
    const location = { hash: '#overview', pathname: '/' }
    const listeners: Array<(ev?: unknown) => void> = []
    const windowObj: {
      route?: (to?: string) => void
      addEventListener: (type: string, fn: (ev?: unknown) => void) => void
    } = {
      addEventListener(type, fn) {
        if (type === 'hashchange') listeners.push(fn)
      }
    }
    const document = {
      documentElement: {
        theme: 'light',
        setAttribute(name: string, value: string) {
          if (name === 'data-theme') this.theme = value
        },
        getAttribute(name: string) {
          return name === 'data-theme' ? this.theme : null
        }
      },
      querySelectorAll(sel: string) {
        if (sel === '[data-page]') return pages
        if (sel === '[data-nav]') return navs
        return []
      },
      querySelector() {
        return null
      },
      addEventListener() {},
      getElementById(id: string) {
        return id === 'page-title' ? title : null
      }
    }
    const ctx = createContext({
      window: windowObj,
      self: windowObj,
      document,
      location,
      fetch: async () => ({ json: async () => ({ ok: false }) })
    })
    runInContext(SPA_JS, ctx)
    expect(typeof windowObj.route).toBe('function')

    const visible = () => pages.filter((p) => !p.hidden).map((p) => p.getAttribute('data-page'))

    expect(visible()).toEqual(['overview'])

    windowObj.route?.('/')
    expect(location.hash).toBe('#overview')
    expect(visible()).toEqual(['overview'])
    expect(title.textContent).toBe('Overview')

    for (const id of PAGES) {
      windowObj.route?.(id)
      expect(location.hash, id).toBe('#' + id)
      expect(visible(), id).toEqual([id])
      expect(navs.find((n) => n.getAttribute('data-nav') === id)?.on, id).toBe(true)
      expect(
        navs.filter((n) => n.on).map((n) => n.getAttribute('data-nav')),
        id
      ).toEqual([id])
    }

    windowObj.route?.('realtime')
    expect(visible()).toEqual(['realtime'])
    expect(title.textContent).toBe('Realtime')
    expect(pages.find((p) => p.getAttribute('data-page') === 'overview')?.hidden).toBe(true)
  })

  it('THEME is two-state light↔dark and Events/Notifications filters are wired', () => {
    expect(SPA_JS).toContain("var next = cur === 'dark' ? 'light' : 'dark'")
    expect(SPA_JS).not.toContain("cur === 'light' ? ''")
    expect(SPA_JS).toContain('events-empty')
    expect(SPA_JS).toContain('function applyEventsFilter')
    expect(SPA_JS).toContain("evSearch.addEventListener('search', applyEventsFilter)")
    expect(SPA_JS).toContain("e.key === 'Enter'")
    expect(SPA_JS).toContain('applyNtFilter')
    expect(SPA_JS).toContain('function applySessionsFilter')
    expect(SPA_JS).toContain('function fillSeatOverlay')
    expect(SPA_JS).toContain('Heartbeat bars')
    expect(SPA_CSS).toContain('.sess-avatar')
    expect(SPA_CSS).toContain('.seat-hbars')
    expect(SPA_JS).toContain('key-msg-settings')
    expect(SPA_JS).toContain("accept: 'application/json'")
    expect(SPA_JS).toContain("credentials: 'include'")
    expect(SPA_JS).toContain("headers.authorization = 'Bearer ' + sessionBearer")
    expect(SPA_JS).toContain("fetch('/session'")
    expect(SPA_JS).toContain('function ensureSession')
    expect(SPA_JS).toContain('Access required. Sign in with Cloudflare Access and retry Add.')
    expect(SPA_JS).toContain("classList.toggle('is-hidden', !hit)")
    expect(SPA_CSS).toContain('.event[hidden]')
    expect(SPA_CSS).toContain('.event.is-hidden')
    expect(SPA_CSS).toContain('display: none !important')
  })

  it('applyEventsFilter hides non-matching heartbeat rows and shows empty state', () => {
    const rows = [
      {
        hidden: false,
        classList: { toggle() {} },
        style: { display: '' },
        setAttribute() {},
        removeAttribute() {},
        getAttribute(name: string) {
          return name === 'data-q' ? 'heartbeat / tonys-macbook-pro longueuil ca darwin path /' : null
        }
      },
      {
        hidden: false,
        classList: { toggle() {} },
        style: { display: '' },
        setAttribute() {},
        removeAttribute() {},
        getAttribute(name: string) {
          return name === 'data-q' ? 'heartbeat / other-pc toronto ca windows path /' : null
        }
      }
    ]
    const empty = { hidden: true }
    const listeners: Record<string, Array<(ev?: { preventDefault: () => void; key: string }) => void>> = {}
    const evSearch = {
      value: '',
      addEventListener(type: string, fn: (ev?: { preventDefault: () => void; key: string }) => void) {
        ;(listeners[type] ||= []).push(fn)
      }
    }
    const document = {
      documentElement: {
        theme: 'light',
        setAttribute() {},
        getAttribute() {
          return null
        }
      },
      querySelectorAll(sel: string) {
        if (sel === '#events-list .event[data-q]') return rows
        return []
      },
      querySelector(sel: string) {
        return sel === 'meta[name="metis-session"]' ? null : null
      },
      addEventListener() {},
      getElementById(id: string) {
        if (id === 'events-search') return evSearch
        if (id === 'events-empty') return empty
        return null
      }
    }
    const windowObj = {
      addEventListener() {},
      route: undefined as undefined | ((to?: string) => void)
    }
    const ctx = createContext({
      window: windowObj,
      self: windowObj,
      document,
      location: { hash: '#events', pathname: '/' },
      fetch: async () => ({ json: async () => ({ ok: false }), text: async () => '' }),
      localStorage: { getItem: () => null, setItem: () => {} }
    })
    runInContext(SPA_JS, ctx)
    evSearch.value = 'zzzznomatch'
    for (const fn of listeners.input || []) fn()
    expect(rows.every((row) => row.hidden)).toBe(true)
    expect(empty.hidden).toBe(false)

    evSearch.value = 'darwin'
    for (const fn of listeners.input || []) fn()
    expect(rows[0].hidden).toBe(false)
    expect(rows[1].hidden).toBe(true)
    expect(empty.hidden).toBe(true)

    evSearch.value = 'zzzznomatch'
    for (const fn of listeners.keydown || []) fn({ preventDefault() {}, key: 'Enter' })
    expect(rows.every((row) => row.hidden)).toBe(true)
    expect(empty.hidden).toBe(false)
  })

  it('hashed SPA embeds world land so theme restyle can paint path[data-iso]', () => {
    expect(SPA_JS.length).toBeGreaterThan(8611)
    expect(SPA_JS).toContain('ensureShoeyLand')
    expect(SPA_JS).toContain('paintShoeyMap')
    expect(SPA_JS).toContain('#E5E7EB')
    expect(SPA_JS).toMatch(/data-iso=\\?"CA\\?"/)
    expect(SPA_JS).toMatch(/world-ocean/)
    expect((SPA_JS.match(/data-iso=/g) || []).length).toBeGreaterThan(50)
  })
})
