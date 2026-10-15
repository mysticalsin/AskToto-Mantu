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
    expect(harness.origins.directImporterPresent).toBe(true)
    expect(harness.origins.directCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: expect.stringMatching(/^(?:static|dynamic)$/u), assetKind: 'asset' })
      ])
    )
    expect(
      harness.origins.directCandidates.some(
        (candidate) => /katex\.min\.css(?:$|[?#])/iu.test(candidate.target) && candidate.assetKind === 'asset'
      )
    ).toBe(true)
    expect(
      harness.origins.directCandidates.filter(
        (candidate) => candidate.assetKind === 'runtime' && candidate.chunk && candidate.renderedLength > 0
      )
    ).toHaveLength(1)
    expect(
      harness.origins.mermaidCandidates.filter(
        (candidate) => candidate.assetKind === 'runtime' && candidate.chunk && candidate.renderedLength > 0
      )
    ).toHaveLength(1)
    const directEdge = harness.origins.directEdge!
    const mermaidEdge = harness.origins.mermaidEdge!
    expect(directEdge.renderedExports).toEqual(expect.arrayContaining(['renderToString', 'version']))
    expect(mermaidEdge.renderedExports).toEqual(expect.arrayContaining(['renderToString', 'version']))
    expect(directEdge).toMatchObject({
      importer: expect.any(String),
      target: expect.any(String),
      chunk: expect.any(String)
    })
    expect(mermaidEdge).toMatchObject({
      importer: expect.any(String),
      target: expect.any(String),
      chunk: expect.any(String)
    })
    expect(directEdge.importer).toContain('renderer-katex-security-harness')
    expect(mermaidEdge.importer.replace(/\\/gu, '/')).toMatch(/\/mermaid\/dist\/chunks\/mermaid\.core\//u)
    expect(harness.origins.katexDirect).toBeTruthy()
    expect(harness.origins.katexFromMermaid).toBe(harness.origins.katexDirect)
    expect(harness.origins.browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
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
    const edgeIds = await test.page
      .locator('#diagram svg path.flowchart-link')
      .evaluateAll((nodes) => nodes.map((node) => node.id))
    expect(edgeIds.filter((id) => /-L_A_B_/u.test(id)).length).toBe(1)
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
        Object.defineProperty(Object.prototype, 'trust', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: true
        })
        Object.defineProperty(Object.prototype, 'default', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: true
        })
        Object.defineProperty(Object.prototype, 'processor', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: () => true
        })
        ;(window as any).__rendererCallbackCount = 0
        ;(window as any).rendererSecurityCallback = () => {
          ;(window as any).__rendererCallbackCount++
        }
        const api = (window as any).__rendererSecurity
        const source = `%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA["<img src=x onerror=alert(1)>"] --> B["javascript:alert(1)"]\nclick A rendererSecurityCallback "unsafe"\nclick A "javascript:alert(1)" "unsafe"`
        const svg = await api.renderMermaid(source, { securityLevel: 'strict' })
        const root = document.getElementById('diagram')!
        const node =
          Array.from(root.querySelectorAll('[id]')).find((candidate) => /-flowchart-A-/u.test(candidate.id)) || null
        node?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        const active = Array.from(
          root.querySelectorAll(
            'script,iframe,object,embed,[onload],[onerror],[onclick],[href],[xlink\\:href],[src],[data]'
          )
        ).filter((candidate) => {
          const tag = candidate.tagName.toLowerCase()
          if (['script', 'iframe', 'object', 'embed'].includes(tag)) return true
          if (Array.from(candidate.attributes).some((attribute) => /^on/iu.test(attribute.name))) return true
          const urls = Array.from(candidate.attributes)
            .filter((attribute) => ['href', 'xlink:href', 'src', 'data'].includes(attribute.name.toLowerCase()))
            .map((attribute) => attribute.value)
            .filter(Boolean)
          return urls.some((value) => {
            if (/^(?:javascript|data|file|blob):/iu.test(value) || /^\/\//u.test(value)) return true
            try {
              return new URL(value, location.href).origin !== location.origin
            } catch {
              return true
            }
          })
        }).length
        return {
          svg,
          callbackTargetPresent: Boolean(node),
          active,
          foreignObjects: root.querySelectorAll('foreignObject').length,
          labelContent: root.textContent?.includes('javascript:alert(1)'),
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
    expect(outcome.foreignObjects).toBeGreaterThan(0)
    expect(outcome.labelContent).toBe(true)
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
    let finalEvents: Array<{
      effectiveDirective: string
      violatedDirective: string
      blockedURI: string
      disposition: string
    }> = []
    let finalProbe:
      | {
          started: boolean
          completed: boolean
          evalErrorName: string
          evalSentinel: boolean
          inlineSentinel: boolean
          frameAdded: boolean
          objectAdded: boolean
          connectErrorName: string
          returnedErrors: string[]
        }
      | undefined
    const expectedCspEvents = [
      { effective: 'script-src-elem', violated: 'script-src-elem', blockedURI: 'inline' },
      { effective: 'script-src', violated: 'script-src', blockedURI: 'eval' },
      { effective: 'frame-src', violated: 'frame-src', origin: 'https://frame.invalid' },
      { effective: 'object-src', violated: 'object-src', origin: 'https://object.invalid' },
      { effective: 'connect-src', violated: 'connect-src', origin: 'https://connect.invalid' }
    ]
    try {
      await test.page.getByRole('button', { name: 'Run CSP probes' }).click({ timeout: 5_000 })
      await expect
        .poll(
          async () => {
            finalEvents = await test.page.evaluate(() => [...(window as any).__rendererSecurity.events.csp])
            finalProbe = await test.page.evaluate(() => (window as any).__rendererSecurityCspProbe())
            return finalProbe !== undefined && finalProbe.completed && finalEvents.length === expectedCspEvents.length
          },
          { timeout: 5_000 }
        )
        .toBe(true)
      expect(finalProbe).toMatchObject({
        started: true,
        completed: true,
        evalErrorName: 'EvalError',
        evalSentinel: false,
        inlineSentinel: false,
        frameAdded: true,
        objectAdded: true,
        returnedErrors: []
      })
      expect(finalProbe?.connectErrorName).toBe('TypeError')
      const finalErrors = await test.page.evaluate(() => [...(window as any).__rendererSecurity.events.errors])
      expect(finalErrors).toEqual([])
      expect(finalEvents).toHaveLength(expectedCspEvents.length)
      for (const expected of expectedCspEvents) {
        expect(
          finalEvents.filter((event) => {
            if (
              event.effectiveDirective !== expected.effective ||
              event.violatedDirective !== expected.violated ||
              event.disposition !== 'enforce'
            )
              return false
            if ('blockedURI' in expected) return event.blockedURI === expected.blockedURI
            try {
              return new URL(event.blockedURI).origin === expected.origin
            } catch {
              return false
            }
          })
        ).toHaveLength(1)
      }
    } finally {
      finalProbe = await test.page.evaluate(() => (window as any).__rendererSecurityCspProbe()).catch(() => finalProbe)
      finalEvents = await test.page
        .evaluate(() => [...(window as any).__rendererSecurity.events.csp])
        .catch(() => finalEvents)
      console.log(`C1_CSP_EVIDENCE ${JSON.stringify({ probe: finalProbe, events: finalEvents })}`)
    }
    expect(test.diagnostics.requests).toEqual([])
    expect(test.diagnostics.errors).toEqual([])
    expect(test.diagnostics.downloads).toBe(0)
    expect(test.diagnostics.dialogs).toEqual([])
    expect(test.diagnostics.pages).toBe(1)
  })
})
