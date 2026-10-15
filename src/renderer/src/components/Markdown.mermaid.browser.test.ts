import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CasePage } from './__tests__/renderer-security-browser-harness'
import {
  closeHarnessPage,
  expectNoUnexpectedEffects,
  openHarnessPage,
  startRendererSecurityHarness
} from './__tests__/renderer-security-browser-harness'

let harness: Awaited<ReturnType<typeof startRendererSecurityHarness>>
let current: CasePage | undefined
beforeAll(async () => {
  harness = await startRendererSecurityHarness()
})
afterEach(async () => {
  if (current) {
    await closeHarnessPage(current)
    current = undefined
  }
})
afterAll(async () => {
  await harness?.close()
})
async function page(): Promise<CasePage> {
  current = await openHarnessPage(harness)
  return current
}
async function diagram(test: CasePage, source: string, config: Record<string, unknown> = {}): Promise<string> {
  return test.page.evaluate(({ value, options }) => (window as any).__rendererSecurity.renderMermaid(value, options), {
    value: source,
    options: config
  })
}
async function diagramDom(
  test: CasePage
): Promise<{ text: string; svg: number; badAttributes: string[]; badLinks: string[]; hasViewBox: boolean }> {
  return test.page.evaluate(() => {
    const root = document.getElementById('diagram')!
    const svg = root.querySelector('svg')
    return {
      text: root.textContent || '',
      svg: root.querySelectorAll('svg').length,
      badAttributes: Array.from(root.querySelectorAll('*')).flatMap((node) =>
        Array.from(node.attributes)
          .filter((attribute) => /^on/iu.test(attribute.name))
          .map((attribute) => attribute.name)
      ),
      badLinks: Array.from(root.querySelectorAll('[href],[xlink\\:href]'))
        .map((node) => node.getAttribute('href') || node.getAttribute('xlink:href') || '')
        .filter((href) => href && !/^(?:#|https?:|mailto:)/iu.test(href)),
      hasViewBox: Boolean(svg?.getAttribute('viewBox'))
    }
  })
}

describe('actual Mermaid core and production CSP browser regressions', () => {
  it('D1 imports Mermaid core and renders a real math flowchart through the exact shared KaTeX module', async () => {
    const test = await page()
    expect(harness.origins.mermaidCore.replace(/\\/gu, '/')).toMatch(/\/mermaid\/dist\/mermaid\.core\.mjs$/u)
    expect(harness.origins.katexDirect).toBeTruthy()
    expect(harness.origins.katexFromMermaid).toBe(harness.origins.katexDirect)
    expect(harness.origins.browserVersion).toMatch(/^\d+\.\d+\.\d+$/u)
    const version = await test.page.evaluate(() => (window as any).__rendererSecurity.katexVersion)
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u)
    const svg = await diagram(test, 'flowchart TD\nA[Start] --> B["Formula $$x^2$$"]')
    const dom = await diagramDom(test)
    expect(svg).toContain('<svg')
    expect(dom.svg).toBe(1)
    expect(dom.text).toContain('Start')
    expect(dom.text).toContain('Formula')
    expect(dom.text).toContain('x')
    expect(await test.page.locator('#diagram math').count()).toBeGreaterThan(0)
    expect(await test.page.locator('#diagram svg path.flowchart-link[id^="L_A_B_"]').count()).toBeGreaterThan(0)
    expect(dom.badAttributes).toEqual([])
    expect(dom.badLinks).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('D2 keeps Mermaid legacy MathML labels styled by local KaTeX CSS and fonts', async () => {
    const test = await page()
    const svg = await diagram(test, 'flowchart LR\nA["Legacy $$\\frac{1}{2}$$"] --> B[Done]', {
      forceLegacyMathML: true
    })
    await test.page.evaluate(() => document.fonts.load('16px KaTeX_Main'))
    const result = await test.page.evaluate(() => {
      const label = document.querySelector('#diagram math')
      const font = document.fonts.check('16px KaTeX_Main')
      return {
        mathml: Boolean(label),
        styled: Boolean(document.querySelector('#diagram .katex-html, #diagram .katex-mathml')),
        font,
        localFonts: performance
          .getEntriesByType('resource')
          .filter((entry) => /KaTeX.*woff2/u.test(entry.name))
          .map((entry) => entry.name)
      }
    })
    expect(svg).toContain('<svg')
    expect(result.mathml).toBe(true)
    expect(result.styled).toBe(true)
    expect(result.localFonts.length).toBeGreaterThan(0)
    expect(result.localFonts.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true)
    await expectNoUnexpectedEffects(test)
  })

  it('D3 keeps existing Mermaid sequence and class diagram relationships', async () => {
    const test = await page()
    const sequence = await diagram(test, 'sequenceDiagram\nparticipant Ada\nparticipant Grace\nAda->>Grace: review')
    let dom = await diagramDom(test)
    expect(sequence).toContain('<svg')
    expect(dom.text).toContain('Ada')
    expect(dom.text).toContain('Grace')
    expect(dom.text).toContain('review')
    expect(await test.page.locator('#diagram svg path').count()).toBeGreaterThan(0)
    expect(await test.page.locator('#diagram svg .messageLine0').count()).toBeGreaterThan(0)
    const classSvg = await diagram(test, 'classDiagram\nclass Renderer\nclass KaTeX\nRenderer --> KaTeX')
    dom = await diagramDom(test)
    expect(classSvg).toContain('<svg')
    expect(dom.text).toContain('Renderer')
    expect(dom.text).toContain('KaTeX')
    expect(await test.page.locator('#diagram svg path.relation').count()).toBeGreaterThan(0)
    await expectNoUnexpectedEffects(test)
  })

  it('D4 sanitizes hostile Mermaid URLs and directives under strict security with polluted inherited settings', async () => {
    const test = await page()
    const outcome = await test.page.evaluate(async () => {
      const keys = ['trust', 'default', 'processor']
      const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]))
      try {
        Object.defineProperty(Object.prototype, 'trust', { configurable: true, value: true })
        Object.defineProperty(Object.prototype, 'default', { configurable: true, value: true })
        Object.defineProperty(Object.prototype, 'processor', { configurable: true, value: () => true })
        ;(window as any).__rendererCallbackCount = 0
        ;(window as any).rendererSecurityCallback = () => {
          ;(window as any).__rendererCallbackCount++
        }
        const api = (window as any).__rendererSecurity
        const source = `%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA["<img src=x onerror=alert(1)>"] --> B["javascript:alert(1)"]\nclick A rendererSecurityCallback "unsafe"\nclick A "javascript:alert(1)" "unsafe"`
        const svg = await api.renderMermaid(source, { securityLevel: 'strict' })
        const root = document.getElementById('diagram')!
        const node = root.querySelector('[id^="flowchart-A"]')
        node?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return {
          svg,
          callbackTargetPresent: Boolean(node),
          active: root.querySelectorAll('script,foreignObject,[onload],[onerror],[onclick]').length,
          links: Array.from(root.querySelectorAll('[href],[xlink\\:href]')).map(
            (node) => node.getAttribute('href') || node.getAttribute('xlink:href') || ''
          ),
          callbackCount: (window as any).__rendererCallbackCount
        }
      } finally {
        for (const key of keys) {
          const descriptor = saved.get(key)
          if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
          else delete (Object.prototype as any)[key]
        }
      }
    })
    expect(outcome.svg).toContain('<svg')
    expect(outcome.callbackTargetPresent).toBe(true)
    expect(outcome.active).toBe(0)
    expect(outcome.links.filter((href: string) => /^javascript:/iu.test(href))).toEqual([])
    expect(outcome.callbackCount).toBe(0)
    const safe = await diagram(test, 'flowchart LR\nA[Safe] --> B[Control]')
    expect(safe).toContain('<svg')
    await expectNoUnexpectedEffects(test)
  })

  it('D5 reports invalid diagrams cleanly and then renders distinct queued valid SVGs', async () => {
    const test = await page()
    const invalid = await test.page.evaluate(async () => {
      try {
        await (window as any).__rendererSecurity.renderMermaid('flowchart !!!\nA -->')
        return null
      } catch (error) {
        return String((error as Error).name) + ':' + String((error as Error).message).slice(0, 160)
      }
    })
    expect(invalid).toContain('Error')
    const first = await diagram(test, 'flowchart LR\nA[FirstQueued] --> B[Middle]')
    const second = await diagram(test, 'flowchart LR\nX[SecondQueued] --> Y[End]')
    const dom = await diagramDom(test)
    expect(first).toContain('FirstQueued')
    expect(second).toContain('SecondQueued')
    expect(dom.text).toContain('SecondQueued')
    expect(dom.text).not.toContain('FirstQueued')
    expect(dom.svg).toBe(1)
    await expectNoUnexpectedEffects(test)
  })

  it('C1 enforces the exact production CSP while ordinary renderer controls remain usable', async () => {
    const test = await page()
    await test.page.evaluate(() =>
      (window as any).__rendererSecurity.renderMarkdown(
        'A normal **Markdown** control.\n\n```ts\nconst safeControl = true\n```'
      )
    )
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
    const math = await test.page.evaluate(() => (window as any).__rendererSecurity.renderKatex('\\frac{1}{2}+x^2'))
    expect(math).toContain('katex')
    const safe = await diagram(test, 'flowchart LR\nA[Safe] --> B[Diagram]')
    expect(safe).toContain('<svg')
    const blocked = await test.page.evaluate(async () => {
      const api = (window as any).__rendererSecurity
      let evalBlocked = false
      try {
        new Function('window.__cspEvalRan=true')()
      } catch {
        evalBlocked = true
      }
      const script = document.createElement('script')
      script.textContent = 'window.__cspInlineRan=true'
      document.body.append(script)
      const frame = document.createElement('iframe')
      frame.src = 'https://frame.invalid/'
      document.body.append(frame)
      const object = document.createElement('object')
      object.data = 'https://object.invalid/'
      document.body.append(object)
      await fetch('https://connect.invalid/probe').catch(() => undefined)
      return {
        evalBlocked,
        ran: Boolean((window as any).__cspEvalRan || (window as any).__cspInlineRan),
        errors: [...api.events.errors],
        csp: [...api.events.csp]
      }
    })
    const expectedCspEvents = [
      { directives: ['script-src', 'script-src-elem'], blocked: 'inline' },
      { directives: ['script-src'], blocked: 'eval' },
      { directives: ['frame-src'], blocked: 'https://frame.invalid/' },
      { directives: ['object-src'], blocked: 'https://object.invalid/' },
      { directives: ['connect-src'], blocked: 'https://connect.invalid/probe' }
    ]
    await test.page.waitForFunction(
      (expected) => {
        const events = (window as any).__rendererSecurity.events.csp as string[]
        return expected.every((item: { directives: string[]; blocked: string }) =>
          events.some((entry) => item.directives.some((directive) => entry === `${directive}:${item.blocked}`))
        )
      },
      expectedCspEvents,
      { timeout: 5_000 }
    )
    const finalEvents = await test.page.evaluate(() => ({
      errors: [...(window as any).__rendererSecurity.events.errors],
      csp: [...(window as any).__rendererSecurity.events.csp]
    }))
    expect(blocked.evalBlocked).toBe(true)
    expect(blocked.ran).toBe(false)
    expect(blocked.errors).toEqual([])
    expect(finalEvents.errors).toEqual([])
    const observed = finalEvents.csp
    expect(observed.length).toBe(expectedCspEvents.length)
    for (const expected of expectedCspEvents) {
      expect(
        observed.filter((entry) =>
          expected.directives.some((directive) => entry === `${directive}:${expected.blocked}`)
        )
      ).toHaveLength(1)
    }
    test.diagnostics.csp.push(...observed)
    expect(test.diagnostics.requests).toEqual([])
    expect(test.diagnostics.errors).toEqual([])
    expect(test.diagnostics.downloads).toBe(0)
    expect(test.diagnostics.dialogs).toEqual([])
    expect(test.diagnostics.pages).toBe(1)
  })
})
