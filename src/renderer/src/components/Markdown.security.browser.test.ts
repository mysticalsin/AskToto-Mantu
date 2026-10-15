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
      'before <script>window.__rawScriptRan=true</script><img src="https://image.invalid/x" onerror="window.__rawImageRan=true"><iframe src="https://frame.invalid/"></iframe><object data="https://object.invalid/"></object><svg onload="window.__rawSvgRan=true"><image href="https://svg.invalid/x"/></svg>\n\n```html\n<img src=x onerror=alert(1)>\n```'
    )
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
    const state = await test.page.evaluate(() => ({
      dangerous: document.querySelectorAll('.md script,.md iframe,.md object,.md svg,[onerror],[onload]').length,
      hostileCodeVisible: document.querySelector('.sd-shiki')?.textContent?.includes('<img src=x onerror=alert(1)>'),
      ran: Boolean((window as any).__rawScriptRan || (window as any).__rawImageRan || (window as any).__rawSvgRan)
    }))
    expect(state).toEqual({ dangerous: 0, hostileCodeVisible: true, ran: false })
    expect(test.diagnostics.requests).toEqual([])
    await expectNoUnexpectedEffects(test)
  })

  it('M4 keeps inline code inline and gives empty, single-line, multiline, tilde, and backtick fences block controls', async () => {
    const test = await page(
      'inline `value`\n\n```\none line\n```\n\n```ts\nconst value = 1\n```\n\n~~~text\n~\n~~~\n\n````js\n\n````'
    )
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
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
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
    await test.page.getByRole('button', { name: 'Copy' }).first().click()
    const copied = await test.page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe('const answer: number = 42')
    expect(await test.page.locator('.sd-shiki').nth(0).locator('span').count()).toBeGreaterThan(0)
    expect(await test.page.locator('.sd-shiki').nth(1).locator('span').count()).toBeGreaterThan(0)
    expect(await test.page.locator('.sd-shiki').nth(2).textContent()).toContain('all unknown text stays here')
    await expectNoUnexpectedEffects(test)
  })

  it('M6 converges streamed unfinished fences, discards stale highlight completion, and unmounts safely', async () => {
    const test = await page('A streamed answer starts.\n```ts\nconst value = 1')
    await test.page.locator('.md button:has-text("Copy")').waitFor({ state: 'visible', timeout: 15_000 })
    await test.page.evaluate(() =>
      (window as any).__rendererSecurity.updateMarkdown('A streamed answer starts.\n```ts\nconst value = 2\n```')
    )
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
    expect(await test.page.locator('.sd-shiki').textContent()).toContain('const value = 2')
    await test.page.evaluate(() => (window as any).__rendererSecurity.updateMarkdown('```json\n{"final":true}\n```'))
    await test.page.getByRole('button', { name: 'Copy' }).click()
    expect(await test.page.evaluate(() => navigator.clipboard.readText())).toBe('{"final":true}')
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
      '| Name | Notes |\n| --- | --- |\n| Ada | Long value for narrow viewport |\n| Grace | Compiler |',
      320
    )
    const table = test.page.locator('.md table')
    expect(await table.isVisible()).toBe(true)
    for (const selector of ['thead', 'tbody', 'tr', 'th', 'td'])
      expect(await table.locator(selector).count()).toBeGreaterThan(0)
    const overflow = await test.page.locator('.md').evaluate((node) => {
      const wrapper = node.querySelector('[class*="overflow-x"], [style*="overflow"]') as HTMLElement | null
      return Boolean(wrapper && wrapper.scrollWidth > wrapper.clientWidth)
    })
    expect(overflow).toBe(true)
    await test.page.getByRole('button', { name: 'Copy table' }).click()
    await test.page.getByRole('menuitem', { name: 'Copy table as TSV' }).click()
    const copied = await test.page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('Name\tNotes')
    expect(copied).toContain('Ada\tLong value for narrow viewport')
    await expectNoUnexpectedEffects(test)
  })

  it('M8 loads no Shiki grammar or WASM for prose and loads the real lazy graph once a fence arrives', async () => {
    const test = await page('Ordinary prose with `inline code` only.')
    const before = await test.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    expect(before.some((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).toBe(false)
    await test.page.evaluate(() => (window as any).__rendererSecurity.updateMarkdown('```ts\nconst lazy = true'))
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
    const after = await test.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    expect(after.some((url) => /shiki|typescript|oniguruma|onig|\.wasm/u.test(url))).toBe(true)
    await test.page.evaluate(() =>
      (window as any).__rendererSecurity.updateMarkdown(
        '```ts\nconst lazy = true\n```\n\n```ts\nconst reused = true\n```'
      )
    )
    await test.page.locator('.sd-shiki').waitFor({ state: 'visible', timeout: 15_000 })
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
    expect(await test.page.locator('.md svg').count()).toBe(0)
    expect(await test.page.locator('.md .katex,.md math').count()).toBe(0)
    await test.page.getByRole('button', { name: 'Copy' }).click()
    expect(await test.page.evaluate(() => navigator.clipboard.readText())).toContain('flowchart LR')
    await expectNoUnexpectedEffects(test)
  })
})
