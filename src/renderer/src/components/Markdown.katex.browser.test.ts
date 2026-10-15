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
async function inspectMarkup(
  test: CasePage,
  markup: string
): Promise<{ anchors: string[]; resources: string[]; handlers: number }> {
  return test.page.evaluate((value) => {
    const template = document.createElement('template')
    template.innerHTML = value
    return {
      anchors: Array.from(template.content.querySelectorAll('a')).map((node) => node.getAttribute('href') || ''),
      resources: Array.from(template.content.querySelectorAll('img,iframe,object,video,audio')).map(
        (node) => node.getAttribute('src') || node.getAttribute('data') || ''
      ),
      handlers: template.content.querySelectorAll('[onload],[onerror],[onclick]').length
    }
  }, markup)
}

describe('actual installed KaTeX advisory and API regressions', () => {
  it('K1 refuses inherited Object.prototype.trust and leaves no hostile href or external includegraphics URL', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const api = (window as any).__rendererSecurity
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'trust')
      try {
        Object.defineProperty(Object.prototype, 'trust', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: true
        })
        const markup = api.renderKatex('\\href{javascript:alert(1)}{open}')
        let imageMarkup = ''
        let imageError = ''
        try {
          imageMarkup = api.renderKatex('\\includegraphics{https://pixel.invalid/probe.png}')
        } catch (error) {
          imageError = `${(error as Error).name}:${(error as Error).message}`.slice(0, 240)
        }
        const template = document.createElement('template')
        template.innerHTML = imageMarkup
        return {
          markup,
          imageMarkup,
          imageError,
          anchors: Array.from(new DOMParser().parseFromString(markup, 'text/html').querySelectorAll('a')).map((node) =>
            node.getAttribute('href')
          ),
          resources: Array.from(template.content.querySelectorAll('img')).map((node) => node.getAttribute('src'))
        }
      } finally {
        if (saved) Object.defineProperty(Object.prototype, 'trust', saved)
        else delete (Object.prototype as any).trust
      }
    })
    const markup = result.markup as string
    const dom = await inspectMarkup(test, markup)
    expect(
      result.anchors.filter((href: string | null) => typeof href === 'string' && /^javascript:/iu.test(href))
    ).toEqual([])
    if (result.imageError) {
      expect(result.imageError).toMatch(/^ParseError:.*(?:not trusted|trust)/iu)
    } else {
      expect(result.imageMarkup).toContain('katex')
    }
    expect(result.resources).toEqual([])
    expect(dom.anchors.filter((href: string) => /^javascript:/iu.test(href))).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('K2 treats inherited trust on the options prototype as untrusted', async () => {
    const test = await page()
    const markup = await test.page.evaluate(() => {
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'trust')
      try {
        Object.defineProperty(Object.prototype, 'trust', { configurable: true, value: true })
        const inherited = Object.create({ trust: true })
        return (window as any).__rendererSecurity.renderKatex('\\href{javascript:alert(1)}{open}', inherited)
      } finally {
        if (saved) Object.defineProperty(Object.prototype, 'trust', saved)
        else delete (Object.prototype as any).trust
      }
    })
    expect((await inspectMarkup(test, markup)).anchors.filter((href) => /^javascript:/iu.test(href))).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('K3 does not let inherited default supply an omitted trust option', async () => {
    const test = await page()
    const markup = await test.page.evaluate(() => {
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'default')
      try {
        Object.defineProperty(Object.prototype, 'default', { configurable: true, value: true })
        return (window as any).__rendererSecurity.renderKatex('\\href{javascript:alert(1)}{open}', {})
      } finally {
        if (saved) Object.defineProperty(Object.prototype, 'default', saved)
        else delete (Object.prototype as any).default
      }
    })
    expect((await inspectMarkup(test, markup)).anchors.filter((href) => /^javascript:/iu.test(href))).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('K4 inherited processor cannot convert an own trust:false into trusted output', async () => {
    const test = await page()
    const markup = await test.page.evaluate(() => {
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'processor')
      try {
        Object.defineProperty(Object.prototype, 'processor', { configurable: true, value: () => true })
        return (window as any).__rendererSecurity.renderKatex('\\href{javascript:alert(1)}{open}', { trust: false })
      } finally {
        if (saved) Object.defineProperty(Object.prototype, 'processor', saved)
        else delete (Object.prototype as any).processor
      }
    })
    expect((await inspectMarkup(test, markup)).anchors.filter((href) => /^javascript:/iu.test(href))).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('K5 ignores inherited namespace macro entries instead of expanding the sentinel', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const key = '\\rendererInheritedSentinel'
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, key)
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          value: '\\htmlClass{inherited-sentinel}{BAD}'
        })
        try {
          ;(window as any).__rendererSecurity.renderKatex(key, { macros: {} })
          return 'rendered'
        } catch (error) {
          return String((error as Error).name) + ':' + String((error as Error).message).slice(0, 160)
        }
      } finally {
        if (saved) Object.defineProperty(Object.prototype, key, saved)
        else delete (Object.prototype as any)[key]
      }
    })
    expect(result).toContain('ParseError')
    await expectNoUnexpectedEffects(test)
  })

  it('K6 does not create an own macro by restoring an inherited namespace value after group exit', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const key = '\\rendererScopedSentinel'
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, key)
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          value: '\\htmlClass{inherited-sentinel}{BAD}'
        })
        const macros = {}
        ;(window as any).__rendererSecurity.renderKatex('\\begingroup\\def\\rendererScopedSentinel{LOCAL}\\endgroup', {
          macros
        })
        const own = Object.prototype.hasOwnProperty.call(macros, key)
        let after = 'rendered'
        try {
          ;(window as any).__rendererSecurity.renderKatex(key, { macros })
        } catch (error) {
          after = String((error as Error).name)
        }
        return { own, after }
      } finally {
        if (saved) Object.defineProperty(Object.prototype, key, saved)
        else delete (Object.prototype as any)[key]
      }
    })
    expect(result).toEqual({ own: false, after: 'ParseError' })
    await expectNoUnexpectedEffects(test)
  })

  it('K7 renders actual math and local macros in both supported output modes', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const api = (window as any).__rendererSecurity
      const key = 'unrelatedRendererProperty'
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, key)
      try {
        Object.defineProperty(Object.prototype, key, { configurable: true, value: 'unrelated' })
        const source = '\\frac{1}{2}+x^{3}+\\begin{matrix}a&b\\\\c&d\\end{matrix}+Ω+\\localMacro'
        const options = { macros: { '\\localMacro': '\\sqrt{4}' }, displayMode: true }
        const mathml = api.renderKatex(source, { ...options, output: 'mathml' })
        const combined = api.renderKatex(source, { ...options, output: 'htmlAndMathml' })
        const mathmlDom = new DOMParser().parseFromString(mathml, 'text/html')
        const combinedDom = new DOMParser().parseFromString(combined, 'text/html')
        return {
          mathml: mathmlDom.querySelectorAll('math mfrac,math msup,math mtable').length,
          combinedMath: combinedDom.querySelectorAll('math').length,
          html: combinedDom.querySelectorAll('.katex-html').length,
          nonempty: Boolean(mathmlDom.body.textContent?.trim() && combinedDom.body.textContent?.trim())
        }
      } finally {
        if (saved) Object.defineProperty(Object.prototype, key, saved)
        else delete (Object.prototype as any)[key]
      }
    })
    expect(result.mathml).toBeGreaterThanOrEqual(3)
    expect(result.combinedMath).toBe(1)
    expect(result.html).toBe(1)
    expect(result.nonempty).toBe(true)
    await expectNoUnexpectedEffects(test)
  })

  it('K8 preserves the explicit safe HTTPS trust positive control and rejects restricted commands with trust:false', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const api = (window as any).__rendererSecurity
      const safe = api.renderKatex('\\href{https://docs.example.invalid/guide}{docs}', {
        trust: (context: { command: string; url?: string }) =>
          context.command === '\\href' && context.url?.startsWith('https://docs.example.invalid/') === true
      })
      const denied = api.renderKatex('\\href{javascript:alert(1)}{open}', { trust: false })
      const doc = new DOMParser().parseFromString(safe, 'text/html')
      return {
        safe: doc.querySelector('a')?.getAttribute('href') || '',
        denied: Array.from(new DOMParser().parseFromString(denied, 'text/html').querySelectorAll('a')).map((node) =>
          node.getAttribute('href')
        )
      }
    })
    expect(result.safe).toBe('https://docs.example.invalid/guide')
    expect(
      result.denied.filter((href: string | null) => typeof href === 'string' && /^javascript:/iu.test(href))
    ).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('K9 bounds recursive macros, ignores inherited maxExpand, and renders valid math after errors', async () => {
    const test = await page()
    const result = await test.page.evaluate(() => {
      const api = (window as any).__rendererSecurity
      const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'maxExpand')
      try {
        Object.defineProperty(Object.prototype, 'maxExpand', { configurable: true, value: 1 })
        let inherited = 'rendered'
        try {
          api.renderKatex('\\outerMacro', { macros: { '\\outerMacro': '\\innerMacro', '\\innerMacro': 'x' } })
        } catch (error) {
          inherited = String((error as Error).message).slice(0, 120)
        }
        let malformed = false
        try {
          api.renderKatex('\\frac{1}', {})
        } catch {
          malformed = true
        }
        let recursive = false
        try {
          api.renderKatex('\\again', { maxExpand: 32, macros: { '\\again': '\\again' } })
        } catch {
          recursive = true
        }
        const valid = api.renderKatex('\\frac{1}{2}+y^2', {})
        return { inherited, malformed, recursive, recovered: valid.includes('katex') || valid.includes('<math') }
      } finally {
        if (saved) Object.defineProperty(Object.prototype, 'maxExpand', saved)
        else delete (Object.prototype as any).maxExpand
      }
    })
    expect(result.inherited).toBe('rendered')
    expect(result.malformed).toBe(true)
    expect(result.recursive).toBe(true)
    expect(result.recovered).toBe(true)
    await expectNoUnexpectedEffects(test)
  })
})
