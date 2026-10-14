import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_STYLESHEET_LINES,
  TOKENS_FILE,
  countHexLines,
  findViolations,
  scanRenderer,
  tokenDeclarationLines
} from './check-color-literals.mjs'
import { readAppCss } from './lib/read-app-css.mjs'

const rendererSrc = resolve(__dirname, '../src/renderer/src')
const stylesDir = join(rendererSrc, 'styles')
const entry = readFileSync(join(rendererSrc, 'styles.css'), 'utf8')
const baseline = JSON.parse(readFileSync(join(__dirname, 'color-literal-baseline.json'), 'utf8')) as Record<string, number>

describe('colour literal ratchet', () => {
  it('counts lines that carry a hex colour literal', () => {
    expect(countHexLines('a { color: #fff; }\nb { color: var(--color-ink); }\nc { background: #7f00da80; }')).toBe(2)
    expect(countHexLines('#root { margin: 0 }\nhref="#section-anchor"')).toBe(0)
  })

  it('finds design-token declarations but not their uses', () => {
    expect(tokenDeclarationLines('.a {\n  --color-x: red;\n  color: var(--color-x);\n  --orb-size: 4px;\n}')).toEqual([2])
  })

  it('rejects a new hex literal, a token declared outside tokens.css and a stale baseline', () => {
    const css = (path: string, text: string) => ({ path, text })
    expect(findViolations([css('src/renderer/src/styles/a.css', 'a { color: #fff; }')], {})).toEqual([
      expect.stringContaining('1 hex colour literal line(s), baseline 0')
    ])
    expect(findViolations([css('src/renderer/src/styles/a.css', ':root { --color-new: red; }')], {})).toEqual([
      expect.stringContaining('declares design tokens outside tokens.css')
    ])
    expect(
      findViolations([css('src/renderer/src/styles/a.css', 'a { color: var(--color-ink); }')], {
        'src/renderer/src/styles/a.css': 1
      })
    ).toEqual([expect.stringContaining('lower it')])
    expect(findViolations([], { 'src/renderer/src/gone.css': 1 })).toEqual([expect.stringContaining('no longer exists')])
    expect(
      findViolations([css('src/renderer/src/styles/big.css', `${'a { top: 0; }\n'.repeat(MAX_STYLESHEET_LINES + 1)}`)], {})
    ).toEqual([expect.stringContaining('stylesheet limit')])
  })

  it('accepts hex literals and token declarations inside tokens.css', () => {
    expect(findViolations([{ path: TOKENS_FILE, text: ':root { --color-x: #fff; }' }], {})).toEqual([])
  })

  it('holds for the real renderer tree', () => {
    expect(findViolations(scanRenderer(), baseline)).toEqual([])
  })
})

describe('styles.css split', () => {
  const imports = [...entry.matchAll(/^@import '\.\/(styles\/[\w-]+\.css)';$/gm)].map((m) => m[1])

  it('imports tokens.css first and every feature stylesheet exactly once', () => {
    const local = [...entry.matchAll(/^@import '(\.[^']+)';$/gm)].map((m) => m[1])
    expect(local[0]).toBe('./tokens.css')
    expect(new Set(imports).size).toBe(imports.length)
    expect([...imports].sort()).toEqual(readdirSync(stylesDir).map((name) => `styles/${name}`).sort())
  })

  it('keeps every stylesheet within the line limit', () => {
    for (const file of ['tokens.css', 'styles.css', ...imports]) {
      const lines = readFileSync(join(rendererSrc, file), 'utf8').replace(/\n$/, '').split('\n').length
      expect(lines, file).toBeLessThanOrEqual(MAX_STYLESHEET_LINES)
    }
  })

  it('defines colour, spacing and radius tokens only in tokens.css', () => {
    const tokens = readFileSync(join(rendererSrc, 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/--color-accent:/)
    expect(tokens).toMatch(/--space-1:/)
    expect(tokens).toMatch(/--radius-outer:/)
    for (const file of ['styles.css', ...imports]) {
      expect(tokenDeclarationLines(readFileSync(join(rendererSrc, file), 'utf8')), file).toEqual([])
    }
  })

  it('inlines to one stylesheet that still carries the tokens and the feature rules', () => {
    const flat = readAppCss()
    expect(flat).not.toMatch(/^@import '\./m)
    expect(flat.indexOf('--color-accent:')).toBeLessThan(flat.indexOf('.aw-widget {'))
    for (const selector of ['.glass {', '.cl-card {', '.aw-widget {', '.metis-pass {', '.onboard-stage {', '.md {']) {
      expect(flat, selector).toContain(selector)
    }
  })
})

describe('rendered parity with the pre-split stylesheet (Playwright Chromium)', () => {
  let browser: import('playwright').Browser | null = null

  type PageSnapshot = {
    readyState: 'loading' | 'interactive' | 'complete' | 'unavailable'
    visibilityState: 'visible' | 'hidden' | 'prerender' | 'unavailable'
    layout: {
      innerWidth: number | null
      innerHeight: number | null
      clientWidth: number | null
      clientHeight: number | null
      scrollWidth: number | null
      scrollHeight: number | null
    }
  }

  const unavailableSnapshot: PageSnapshot = {
    readyState: 'unavailable',
    visibilityState: 'unavailable',
    layout: {
      innerWidth: null,
      innerHeight: null,
      clientWidth: null,
      clientHeight: null,
      scrollWidth: null,
      scrollHeight: null
    }
  }

  const safeDimension = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000 ? Math.round(value) : null

  const pageSnapshot = (value: unknown): PageSnapshot => {
    if (!value || typeof value !== 'object') return unavailableSnapshot
    const snapshot = value as Record<string, unknown>
    const layout =
      snapshot.layout && typeof snapshot.layout === 'object' ? (snapshot.layout as Record<string, unknown>) : {}
    const readyState = ['loading', 'interactive', 'complete'].includes(String(snapshot.readyState))
      ? (snapshot.readyState as PageSnapshot['readyState'])
      : 'unavailable'
    const visibilityState = ['visible', 'hidden', 'prerender'].includes(String(snapshot.visibilityState))
      ? (snapshot.visibilityState as PageSnapshot['visibilityState'])
      : 'unavailable'
    return {
      readyState,
      visibilityState,
      layout: {
        innerWidth: safeDimension(layout.innerWidth),
        innerHeight: safeDimension(layout.innerHeight),
        clientWidth: safeDimension(layout.clientWidth),
        clientHeight: safeDimension(layout.clientHeight),
        scrollWidth: safeDimension(layout.scrollWidth),
        scrollHeight: safeDimension(layout.scrollHeight)
      }
    }
  }

  const annotateScreenshotFailure = (
    tab: import('playwright').Page,
    currentBrowser: import('playwright').Browser,
    lifecycle: { pageClosed: boolean; pageCrashed: boolean; browserDisconnected: boolean },
    captureIndex: number,
    captureLabel: 'before-dark' | 'after-dark' | 'before-light' | 'after-light',
    snapshot: PageSnapshot
  ) => {
    let browserConnected = false
    try {
      browserConnected = currentBrowser.isConnected()
    } catch {
      // Browser lifecycle getters may fail while Chromium is disconnecting.
    }

    try {
      process.stdout.write(
        `::notice title=Chromium screenshot diagnostic::${JSON.stringify({
          captureIndex,
          captureLabel,
          pageClosed: lifecycle.pageClosed || tab.isClosed(),
          pageCrashed: lifecycle.pageCrashed,
          browserConnected,
          browserDisconnected: lifecycle.browserDisconnected,
          viewport: { width: 420, height: 520 },
          document: { readyState: snapshot.readyState, visibilityState: snapshot.visibilityState },
          layout: snapshot.layout
        })}\n`
      )
    } catch {
      // Diagnostics must never mask the original screenshot failure.
    }
  }

  afterAll(async () => {
    await browser?.close()
  })

  // The split must not change a pixel: render the stylesheet as it was before the split (the parent of the
  // commit that introduced tokens.css, read with `git show`) next to the split one, once per colour scheme,
  // and require identical screenshots. Needs full history, so the CI checkout uses fetch-depth: 0.
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const flatten = (css: string) =>
    css.replace(/^@import .*$/gm, '').replace(/^@(source|custom-variant) .*$/gm, '').replace('@theme {', ':root {')

  it('paints the same pixels as the pre-split stylesheet under dark and light emulation', async () => {
    const splitCommit = git('log', '--diff-filter=A', '--format=%H', '--', 'src/renderer/src/tokens.css').trim().split('\n').pop()
    expect(splitCommit, 'full git history is required to find the pre-split stylesheet').toBeTruthy()
    const before = flatten(git('show', `${splitCommit}^:src/renderer/src/styles.css`).replace(/\r\n/g, '\n'))
    const after = flatten(readAppCss())
    const page = (css: string) => `<!doctype html><html><head><style>${css}</style></head><body style="background:#111">
      <div class="glass" style="width:200px;height:60px;margin:8px">glass</div>
      <div class="glass-strong" style="width:200px;height:60px;margin:8px">strong</div>
      <div class="cl-root"><div class="cl-card" style="width:200px;height:60px;margin:8px">card</div></div>
      <div class="aw-widget" style="width:200px;height:60px;margin:8px">widget</div>
      <div class="metis-pass-stage"><div class="metis-pass"><div class="metis-pass-face">pass</div></div></div>
    </body></html>`
    const { chromium } = await import('playwright')
    const activeBrowser = await chromium.launch({ headless: true })
    browser = activeBrowser
    let captureIndex = 0
    for (const colorScheme of ['dark', 'light'] as const) {
      const shots: Buffer[] = []
      for (const [styleIndex, css] of [before, after].entries()) {
        const tab = await activeBrowser.newPage({ viewport: { width: 420, height: 520 }, colorScheme })
        await tab.setContent(page(css), { waitUntil: 'domcontentloaded' })
        // A string script: this file is type-checked without the DOM lib.
        const resolved = (await tab.evaluate(`(() => {
          const style = (selector) => getComputedStyle(document.querySelector(selector))
          const root = document.documentElement
          return {
            accent: style('.aw-widget').getPropertyValue('--color-accent').trim(),
            radius: style('.aw-widget').getPropertyValue('--radius-outer').trim(),
            cardBackground: style('.cl-card').backgroundColor,
            passInk: style('.metis-pass').getPropertyValue('--pass-ink').trim(),
            snapshot: {
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              layout: {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                clientWidth: root?.clientWidth,
                clientHeight: root?.clientHeight,
                scrollWidth: root?.scrollWidth,
                scrollHeight: root?.scrollHeight
              }
            }
          }
        })()`)) as { accent: string; radius: string; cardBackground: string; passInk: string; snapshot?: unknown }
        expect(resolved.accent).toBe('#7f00da')
        expect(resolved.radius).toBe('16px')
        expect(resolved.cardBackground).not.toBe('rgba(0, 0, 0, 0)')
        expect(resolved.passInk).toBe('#ffffff')
        const snapshot = pageSnapshot(resolved.snapshot)
        const lifecycle = { pageClosed: false, pageCrashed: false, browserDisconnected: false }
        const onPageClose = () => {
          lifecycle.pageClosed = true
        }
        const onPageCrash = () => {
          lifecycle.pageCrashed = true
        }
        const onBrowserDisconnected = () => {
          lifecycle.browserDisconnected = true
        }
        tab.on('close', onPageClose)
        tab.on('crash', onPageCrash)
        activeBrowser.on('disconnected', onBrowserDisconnected)
        const captureLabel = `${styleIndex === 0 ? 'before' : 'after'}-${colorScheme}` as
          | 'before-dark'
          | 'after-dark'
          | 'before-light'
          | 'after-light'
        try {
          shots.push(await tab.screenshot())
        } catch (error) {
          annotateScreenshotFailure(tab, activeBrowser, lifecycle, captureIndex, captureLabel, snapshot)
          throw error
        } finally {
          try {
            tab.off('close', onPageClose)
            tab.off('crash', onPageCrash)
            activeBrowser.off('disconnected', onBrowserDisconnected)
          } catch {
            // Listener cleanup must not replace the test's original result.
          }
        }
        captureIndex += 1
        await tab.close()
      }
      expect(shots[0].equals(shots[1]), `${colorScheme} render differs from the pre-split stylesheet`).toBe(true)
    }
  }, 60_000)
})
