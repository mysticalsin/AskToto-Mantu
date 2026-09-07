/**
 * Proves "applied immediately to the live document" (plan 6.11 Appearance), not just "saved" -
 * `applyDensityLocal`/`syncAppearanceFromSettings` touch `document`/`localStorage` directly, so
 * this drives them against a hand-built minimal DOM stub, the same style
 * `operator/src/spa/router.test.ts` already uses for client behaviour (this repo has no jsdom
 * dependency, and vitest's operator config runs in the plain `node` environment).
 *
 * `./settings` transitively imports `../main`, a top-level IIFE (`metisOperatorSpa()`) that wires
 * the whole page router the instant the module loads and reaches for `self`/`window`/`document`
 * unconditionally - none of that boot sequence is under test here (`rerender()` is never called by
 * the two functions this file exercises), so the globals it touches are stubbed to inert no-ops
 * BEFORE the module graph loads. Static `import` is hoisted above plain statements by the ES module
 * spec (unlike `vi.mock`, `vi.stubGlobal` is not specially hoisted by vitest), so the module under
 * test is loaded with a real dynamic `import()` inside `beforeAll`, after the stubs are in place.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPERATOR_SETTINGS, type OperatorSettingsValue } from '../../src/routes/settings-store'

// operator/client/map.ts reads an esbuild `define`-injected global (__SHOEY_LAND_SVG__) that only
// exists inside the real bundle (operator/scripts/build-client.mjs); mocked so importing
// ./settings under plain vitest (no esbuild define step) does not throw at module load. vi.mock
// calls ARE hoisted by vitest's transform, so both are safe at the top of the file.
vi.mock('../map', () => ({ paintShoeyMap: vi.fn() }))
// operator/client/main.ts is a top-level IIFE (metisOperatorSpa()) that boots the ENTIRE page
// router the instant it is imported (every page's init*, live polling, keyboard shortcuts...) -
// none of that is under test here (neither function this file exercises calls `rerender`), so the
// whole module is replaced rather than letting its boot sequence run under plain Node.
vi.mock('../main', () => ({ rerender: vi.fn() }))

let applyDensityLocal: (choice: 'comfortable' | 'compact') => void
let syncAppearanceFromSettings: (section: HTMLElement, settings: OperatorSettingsValue) => void

beforeAll(async () => {
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  })
  vi.stubGlobal('document', {
    documentElement: { setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    body: { querySelectorAll: () => [] },
    getElementById: () => null,
    fonts: undefined
  })
  vi.stubGlobal('location', { hash: '#settings', pathname: '/settings' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('setTimeout', () => 0)
  vi.stubGlobal('clearTimeout', () => {})
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('clearInterval', () => {})
  vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({ ok: false }), text: async () => '', headers: { get: () => null } }))
  const mod = await import('./settings')
  applyDensityLocal = mod.applyDensityLocal
  syncAppearanceFromSettings = mod.syncAppearanceFromSettings
})

function fakeSegmentedButton(id: string) {
  const attrs: Record<string, string> = { 'data-segmented': id }
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value
    },
    classList: { toggle: vi.fn() }
  }
}

function fakeSegmentedWrap(ids: string[]) {
  const buttons = ids.map(fakeSegmentedButton)
  return { querySelectorAll: (sel: string) => (sel === '[data-segmented]' ? buttons : []), buttons }
}

function fakeDocument() {
  const attrs: Record<string, string> = {}
  return {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attrs[name] = value
      },
      getAttribute: (name: string) => attrs[name] ?? null,
      removeAttribute: (name: string) => {
        delete attrs[name]
      }
    },
    querySelectorAll: () => [],
    _attrs: attrs
  }
}

function fakeLocalStorage() {
  const store: Record<string, string> = {}
  return { setItem: (k: string, v: string) => (store[k] = v), getItem: (k: string) => store[k] ?? null, _store: store }
}

describe('applyDensityLocal', () => {
  it('sets data-density on document.documentElement and persists it to localStorage', () => {
    const doc = fakeDocument()
    const ls = fakeLocalStorage()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('localStorage', ls)
    try {
      applyDensityLocal('compact')
      expect(doc.documentElement.getAttribute('data-density')).toBe('compact')
      expect(ls._store['metis-operator-density']).toBe('compact')

      applyDensityLocal('comfortable')
      expect(doc.documentElement.getAttribute('data-density')).toBe('comfortable')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('syncAppearanceFromSettings', () => {
  it('applies the stored density to the live document and marks the matching segmented buttons active', () => {
    const doc = fakeDocument()
    const ls = fakeLocalStorage()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('localStorage', ls)
    try {
      const densityWrap = fakeSegmentedWrap(['comfortable', 'compact'])
      const motionWrap = fakeSegmentedWrap(['system', 'reduce'])
      const section = {
        querySelector: (sel: string) => (sel === '[data-density-seg]' ? densityWrap : sel === '[data-motion-seg]' ? motionWrap : null)
      } as unknown as HTMLElement

      const settings: OperatorSettingsValue = { ...DEFAULT_OPERATOR_SETTINGS, density: 'compact', reducedMotion: 'reduce' }
      syncAppearanceFromSettings(section, settings)

      // The document attribute is real, not just an in-memory flag: this is what
      // operator/src/spa/css-settings.ts's `:root[data-density="compact"]` rule selects on.
      expect(doc.documentElement.getAttribute('data-density')).toBe('compact')

      // Segmented controls corrected to the stored value.
      const compactBtn = densityWrap.buttons.find((b) => b.getAttribute('data-segmented') === 'compact')!
      const comfortableBtn = densityWrap.buttons.find((b) => b.getAttribute('data-segmented') === 'comfortable')!
      expect(compactBtn.classList.toggle).toHaveBeenCalledWith('on', true)
      expect(comfortableBtn.classList.toggle).toHaveBeenCalledWith('on', false)
      expect(compactBtn.getAttribute('aria-checked')).toBe('true')

      const reduceBtn = motionWrap.buttons.find((b) => b.getAttribute('data-segmented') === 'reduce')!
      expect(reduceBtn.classList.toggle).toHaveBeenCalledWith('on', true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reverts data-density to comfortable when the stored setting is comfortable', () => {
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('localStorage', fakeLocalStorage())
    try {
      const section = { querySelector: () => null } as unknown as HTMLElement
      syncAppearanceFromSettings(section, { ...DEFAULT_OPERATOR_SETTINGS, density: 'comfortable', reducedMotion: 'system' })
      expect(doc.documentElement.getAttribute('data-density')).toBe('comfortable')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
