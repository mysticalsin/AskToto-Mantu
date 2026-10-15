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
async function page(markdown = '', width = 1200): Promise<CasePage> {
  current = await openHarnessPage(harness, { markdown }, { width })
  return current
}

describe('production Markdown security and interaction browser regressions', () => {
  it('M1 renders and records only allowed normalized links', async () => {
    const test = await page(
      '[secure](https://example.invalid/docs?q=1) [plain](http://example.invalid/) [mail](mailto:reader@example.invalid)'
    )
    const links = test.page.locator('.md a')
    expect(await links.count()).toBe(3)
    const values = await links.evaluateAll((nodes) =>
      nodes.map((node) => ({
        href: (node as HTMLAnchorElement).href,
        target: node.getAttribute('target'),
        rel: node.getAttribute('rel')
      }))
    )
    expect(values.map((value) => value.href)).toEqual([
      'https://example.invalid/docs?q=1',
      'http://example.invalid/',
      'mailto:reader@example.invalid'
    ])
    expect(values.map(({ target, rel }) => [target, rel])).toEqual(
      Array.from({ length: 3 }, () => ['_blank', 'noopener noreferrer'])
    )
    const clicked = await links.evaluateAll((nodes) =>
      nodes.map((node) => {
        let destination = ''
        node.addEventListener(
          'click',
          (event) => {
            event.preventDefault()
            destination = (node as HTMLAnchorElement).href
          },
          { once: true }
        )
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return destination
      })
    )
    expect(clicked).toEqual(values.map((value) => value.href))
    await expectNoUnexpectedEffects(test)
  })

  it('M2 refuses hostile Markdown and raw HTML URL forms without navigation', async () => {
    const test = await page(
      [
        '[js](javascript:alert(1)) [data](data:text/html,hi) [file](file:///tmp/x) [msdt](ms-msdt:foo)',
        '[line](java\nscript:alert(1)) [nul](java%00script:alert(1)) [long](https://' + 'a'.repeat(4096) + '.invalid)',
        '[entity](javascript&#58;alert(1)) <a href="javascript:alert(1)">raw</a> <a href="data:text/html,hi">data</a>'
      ].join('\n')
    )
    expect(
      await test.page
        .locator('.md a[href^="javascript:"],.md a[href^="data:"],.md a[href^="file:"],.md a[href^="ms-msdt:"]')
        .count()
    ).toBe(0)
    expect(
      await test.page
        .locator('.md a')
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLAnchorElement).href).filter((href) => !/^(https?:|mailto:)/u.test(href))
        )
    ).toEqual([])
    const longLinkState = await test.page.locator('.md').evaluate((root) => ({
      matchingAnchors: Array.from(root.querySelectorAll('a')).filter((node) => node.textContent?.trim() === 'long')
        .length,
      visibleText: root.textContent || ''
    }))
    expect(longLinkState.matchingAnchors).toBe(0)
    expect(longLinkState.visibleText).toContain('long')
    expect(await test.page.evaluate(() => (window as any).__rendererSecurity.events.errors)).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('M3 removes active raw HTML while preserving hostile-looking text in a highlighted fence', async () => {
    const test = await page(
      'before <script>window.__rawScriptRan=true</script><img id="hostile-image" src="https://image.invalid/x" onerror="window.__rawImageRan=true"><iframe src="https://frame.invalid/"></iframe><object data="https://object.invalid/"></object><svg id="hostile-svg" onload="window.__rawSvgRan=true"><image href="https://svg.invalid/x"/></svg>\n\n```html\n<img src=x onerror=alert(1)>\n```'
    )
    await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(1)
    await expect
      .poll(async () => test.page.locator('.sd-shiki').textContent(), { timeout: 15_000 })
      .toContain('<img src=x onerror=alert(1)>')
    const state = await test.page.evaluate(() => ({
      hostileSources: document.querySelectorAll('#hostile-image,#hostile-svg').length,
      executable: Array.from(document.querySelectorAll('.md *'))
        .filter(
          (node) =>
            ['script', 'iframe', 'object'].includes(node.tagName.toLowerCase()) ||
            Array.from(node.attributes).some((attribute) => /^on/iu.test(attribute.name))
        )
        .map(
          (node) =>
            `${node.tagName.toLowerCase()}:${Array.from(node.attributes)
              .filter((attribute) => /^on/iu.test(attribute.name))
              .map((attribute) => attribute.name)
              .join(',')}`
        ),
      unsafeResources: Array.from(document.querySelectorAll('.md [src],.md [data],.md [href],.md [xlink\\:href]'))
        .flatMap((node) =>
          ['src', 'data', 'href', 'xlink:href'].map((name) => node.getAttribute(name) || '').filter(Boolean)
        )
        .filter((value) => {
          if (/^(?:javascript|data|file|blob):/iu.test(value) || /^\/\//u.test(value)) return true
          try {
            return new URL(value, location.href).origin !== location.origin
          } catch {
            return true
          }
        }),
      svgControls: Array.from(document.querySelectorAll('.md svg')).map((svg) => ({
        inCopyButton: Boolean(
          svg.closest('button') &&
            /^(?:Copy|Check)$/u.test(
              svg.closest('button')?.getAttribute('aria-label') || svg.closest('button')?.textContent?.trim() || ''
            )
        ),
        executable: [svg, ...Array.from(svg.querySelectorAll('*'))].some((node) =>
          Array.from(node.attributes).some((attribute) => /^on/iu.test(attribute.name))
        ),
        resources: svg.querySelectorAll('[href],[xlink\\:href],[src]').length
      })),
      hostileCodeVisible: document.querySelector('.sd-shiki')?.textContent?.includes('<img src=x onerror=alert(1)>'),
      ran: Boolean((window as any).__rawScriptRan || (window as any).__rawImageRan || (window as any).__rawSvgRan)
    }))
    expect(state.hostileSources).toBe(0)
    expect(state.executable).toEqual([])
    expect(state.unsafeResources).toEqual([])
    expect(state.svgControls.length).toBeGreaterThan(0)
    expect(
      state.svgControls.every((control) => control.inCopyButton && !control.executable && control.resources === 0)
    ).toBe(true)
    expect(state.hostileCodeVisible).toBe(true)
    expect(state.ran).toBe(false)
    expect(test.diagnostics.requests).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('M4 keeps inline code inline and gives empty, single-line, multiline, tilde, and backtick fences block controls', async () => {
    const test = await page(
      'inline `value`\n\n```\none line\n```\n\n```ts\nconst value = 1\n```\n\n~~~text\n~\n~~~\n\n````js\n\n````'
    )
    await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(4)
    await expect
      .poll(
        async () =>
          test.page.locator('.sd-shiki').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || '')),
        { timeout: 15_000 }
      )
      .toEqual(['one line', 'const value = 1', '~', ''])
    await expect
      .poll(async () => test.page.locator('.sd-shiki').nth(1).locator('span').count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect(await test.page.locator('.md p > code').count()).toBe(1)
    expect(await test.page.locator('.md button:has-text("Copy")').count()).toBeGreaterThanOrEqual(4)
    expect(await test.page.locator('.md pre pre').count()).toBe(0)
    expect(await test.page.locator('.md .sd-shiki').count()).toBe(4)
    await expectNoUnexpectedEffects(test)
  })

  it('M5 highlights curated aliases, falls back to full plain text, and copies the displayed code', async () => {
    const test = await page(
      '```ts\nconst answer: number = 42\n```\n```json\n{"answer":42}\n```\n```unlisted\nall unknown text stays here\n```'
    )
    await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(3)
    await expect
      .poll(
        async () =>
          test.page.locator('.sd-shiki').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || '')),
        {
          timeout: 15_000
        }
      )
      .toEqual(['const answer: number = 42', '{"answer":42}', 'all unknown text stays here'])
    await test.page.getByRole('button', { name: 'Copy' }).first().click()
    const copied = await test.page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe('const answer: number = 42')
    await expect
      .poll(async () => test.page.locator('.sd-shiki').nth(0).locator('span').count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => test.page.locator('.sd-shiki').nth(1).locator('span').count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect(await test.page.locator('.sd-shiki').nth(2).textContent()).toContain('all unknown text stays here')
    await expectNoUnexpectedEffects(test)
  })

  it('M6 converges streamed unfinished fences, discards stale highlight completion, and unmounts safely', async () => {
    const test = await page()
    const targetChunks = harness.origins.shikiChunks
    expect(targetChunks.length).toBeGreaterThan(0)
    let releaseHeld: (() => void) | undefined
    let observedHeld: { url: string; release: () => Promise<void> } | undefined
    let joinHeldRoute: (() => void) | undefined
    let heldRouteState: { status: 'pending' | 'continued' | 'failed'; error?: string } = { status: 'pending' }
    const heldRouteDone = new Promise<typeof heldRouteState>((resolve) => {
      joinHeldRoute = () => resolve(heldRouteState)
    })
    const withinM6CleanupLimit = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`M6 ${label} timed out; held route state remains ${heldRouteState.status}`)),
              5_000
            )
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const routeHandler = async (route: import('playwright').Route) => {
      const url = new URL(route.request().url())
      const chunk = decodeURIComponent(url.pathname.slice(1))
      const holdsRequest =
        url.origin === new URL(test.page.url()).origin && targetChunks.includes(chunk) && !releaseHeld
      if (holdsRequest) {
        await new Promise<void>((release) => {
          releaseHeld = release
          observedHeld = { url: route.request().url(), release: async () => release() }
        })
      }
      try {
        await route.continue()
      } catch (error) {
        if (!holdsRequest) throw error
        heldRouteState = {
          status: 'failed',
          error: `${String((error as Error).name)}:${String((error as Error).message).slice(0, 240)}`
        }
      } finally {
        if (holdsRequest) {
          if (heldRouteState.status === 'pending') heldRouteState = { status: 'continued' }
          joinHeldRoute?.()
        }
      }
    }
    await test.page.route('**/*', routeHandler)
    let testFailure: unknown
    const cleanupErrors: Error[] = []
    try {
      await test.page.evaluate(() =>
        (window as any).__rendererSecurity.updateMarkdown('A streamed answer starts.\n```ts\nconst value = 1')
      )
      await expect.poll(async () => Boolean(observedHeld), { timeout: 15_000 }).toBe(true)
      const heldRequest = observedHeld!
      await test.page.evaluate(() =>
        (window as any).__rendererSecurity.updateMarkdown('A streamed answer starts.\n```ts\nconst value = 2\n```')
      )
      await heldRequest.release()
      const routeResult = await withinM6CleanupLimit(heldRouteDone, 'route join')
      expect(routeResult).toEqual({ status: 'continued' })
      await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(1)
      await expect
        .poll(async () => (await test.page.locator('.sd-shiki').textContent())?.trim(), { timeout: 15_000 })
        .toBe('const value = 2')
      await test.page.evaluate(() => (window as any).__rendererSecurity.updateMarkdown('```json\n{"final":true}\n```'))
      await expect
        .poll(async () => (await test.page.locator('.sd-shiki').textContent())?.trim(), { timeout: 15_000 })
        .toBe('{"final":true}')
      await test.page.getByRole('button', { name: 'Copy' }).click()
      expect(await test.page.evaluate(() => navigator.clipboard.readText())).toBe('{"final":true}')
    } catch (error) {
      testFailure = error
    } finally {
      releaseHeld?.()
      if (observedHeld && heldRouteState.status === 'pending') {
        try {
          const routeResult = await withinM6CleanupLimit(heldRouteDone, 'cleanup join')
          if (routeResult.status === 'failed')
            cleanupErrors.push(new Error(`M6 held route continue failed: ${routeResult.error}`))
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
      try {
        await withinM6CleanupLimit(test.page.unroute('**/*', routeHandler), 'route unroute')
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (testFailure && cleanupErrors.length)
      throw new AggregateError([testFailure, ...cleanupErrors], 'M6 assertions and held-route cleanup failed')
    if (testFailure) throw testFailure
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'M6 held-route cleanup failed')
    const mountedBeforeUnmount = await test.page.evaluate(() => {
      const api = (window as any).__rendererSecurity
      api.updateMarkdown('```ts\nconst pending = true')
      const mounted = Boolean(api.root.querySelector('.sd-shiki, button'))
      api.unmount()
      return mounted
    })
    expect(mountedBeforeUnmount).toBe(true)
    await expectNoUnexpectedEffects(test)
  })

  it('M7 renders a real responsive GFM table and the built-in copy menu exports cells', async () => {
    const test = await page(
      '| Name | Notes | Context | Dependency | Status |\n| --- | --- | --- | --- | --- |\n| Ada | Long value for narrow viewport | Uses an unusually long description that must remain readable in a narrow viewport | Renderer package and its KaTeX integration | Ready |\n| Grace | Compiler | Maintains another detailed explanation for responsive table verification | Mermaid package and its rendered graph relationship | Planned |',
      320
    )
    const table = test.page.locator('.md table')
    expect(await table.isVisible()).toBe(true)
    for (const selector of ['thead', 'tbody', 'tr', 'th', 'td'])
      expect(await table.locator(selector).count()).toBeGreaterThan(0)
    const overflow = await table.evaluate((node) => {
      let wrapper = node.parentElement
      while (wrapper && !['auto', 'scroll'].includes(getComputedStyle(wrapper).overflowX))
        wrapper = wrapper.parentElement
      if (!wrapper) return null
      const before = wrapper.scrollLeft
      wrapper.scrollLeft = before + Math.max(1, wrapper.clientWidth / 2)
      return { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth, moved: wrapper.scrollLeft > before }
    })
    expect(overflow).not.toBeNull()
    expect(overflow!.scrollWidth).toBeGreaterThan(overflow!.clientWidth)
    expect(overflow!.moved).toBe(true)
    await test.page.getByRole('button', { name: 'Copy table' }).click()
    await test.page.getByRole('menuitem', { name: 'Copy table as TSV' }).click()
    const copied = await test.page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(
      'Name\tNotes\tContext\tDependency\tStatus\n' +
        'Ada\tLong value for narrow viewport\tUses an unusually long description that must remain readable in a narrow viewport\tRenderer package and its KaTeX integration\tReady\n' +
        'Grace\tCompiler\tMaintains another detailed explanation for responsive table verification\tMermaid package and its rendered graph relationship\tPlanned'
    )
    await expectNoUnexpectedEffects(test)
  })

  it('M8 loads no Shiki grammar or WASM for prose and loads the real lazy graph once a fence arrives', async () => {
    const test = await page('Ordinary prose with `inline code` only.')
    const before = await test.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    expect(before.some((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).toBe(false)
    await test.page.evaluate(() => (window as any).__rendererSecurity.updateMarkdown('```ts\nconst lazy = true'))
    await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(1)
    await expect
      .poll(async () => test.page.locator('.sd-shiki').textContent(), { timeout: 15_000 })
      .toContain('const lazy = true')
    const after = await test.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    expect(after.some((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).toBe(true)
    await test.page.evaluate(() =>
      (window as any).__rendererSecurity.updateMarkdown(
        '```ts\nconst lazy = true\n```\n\n```ts\nconst reused = true\n```'
      )
    )
    await expect.poll(async () => test.page.locator('.sd-shiki').count(), { timeout: 15_000 }).toBe(2)
    await expect
      .poll(
        async () =>
          test.page.locator('.sd-shiki').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || '')),
        { timeout: 15_000 }
      )
      .toEqual(['const lazy = true', 'const reused = true'])
    const final = await test.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    expect(new Set(final.filter((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).size).toBe(
      new Set(after.filter((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).size
    )
    await expectNoUnexpectedEffects(test)
  })

  it('M9 preserves the baseline: math delimiters stay text and Mermaid fences stay copyable code', async () => {
    const source = 'Inline $x^2$ and display $$ y = 2 $$ remain ordinary text.\n\n```mermaid\nflowchart LR\n A-->B\n```'
    const test = await page(source)
    await test.page.locator('.md button:has-text("Copy")').waitFor({ state: 'visible', timeout: 15_000 })
    const content = await test.page.locator('.md').textContent()
    expect(content).toContain('$x^2$')
    expect(content).toContain('flowchart LR')
    const svgState = await test.page.locator('.md svg').evaluateAll((nodes) =>
      nodes.map((svg) => ({
        inCopyButton: Boolean(
          svg.closest('button') &&
            /^(?:Copy|Check)$/u.test(
              svg.closest('button')?.getAttribute('aria-label') || svg.closest('button')?.textContent?.trim() || ''
            )
        ),
        executable: [svg, ...Array.from(svg.querySelectorAll('*'))].some((node) =>
          Array.from(node.attributes).some((attribute) => /^on/iu.test(attribute.name))
        ),
        resources: svg.querySelectorAll('[href],[xlink\\:href],[src]').length
      }))
    )
    expect(svgState.every((control) => control.inCopyButton && !control.executable && control.resources === 0)).toBe(
      true
    )
    expect(svgState.length).toBeGreaterThan(0)
    expect(await test.page.locator('.md .katex,.md math').count()).toBe(0)
    await test.page.getByRole('button', { name: 'Copy' }).click()
    expect(await test.page.evaluate(() => navigator.clipboard.readText())).toContain('flowchart LR')
    await expectNoUnexpectedEffects(test)
  })
})
