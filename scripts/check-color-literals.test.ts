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

describe('rendered parity between colour schemes (Playwright Chromium)', () => {
  let browser: import('playwright').Browser | null = null

  afterAll(async () => {
    await browser?.close()
  })

  // The overlay is dark-only (`color-scheme: dark`, no light theme), so emulating either OS colour scheme
  // must paint the same pixels. Any token that leaked into a prefers-color-scheme branch during the split
  // would show up as a byte difference here.
  it('paints the same surfaces under light and dark emulation with tokens resolved', async () => {
    const css = readAppCss().replace(/^@import .*$/gm, '').replace(/^@(source|custom-variant) .*$/gm, '').replace('@theme {', ':root {')
    const html = `<!doctype html><html><head><style>${css}</style></head><body style="background:#111">
      <div class="glass" style="width:200px;height:60px;margin:8px">glass</div>
      <div class="glass-strong" style="width:200px;height:60px;margin:8px">strong</div>
      <div class="cl-root"><div class="cl-card" style="width:200px;height:60px;margin:8px">card</div></div>
      <div class="aw-widget" style="width:200px;height:60px;margin:8px">widget</div>
      <div class="metis-pass-stage"><div class="metis-pass"><div class="metis-pass-face">pass</div></div></div>
    </body></html>`
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    const shots: Buffer[] = []
    for (const colorScheme of ['dark', 'light'] as const) {
      const page = await browser.newPage({ viewport: { width: 420, height: 520 }, colorScheme })
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      // A string script: this file is type-checked without the DOM lib.
      const resolved = (await page.evaluate(`(() => {
        const style = (selector) => getComputedStyle(document.querySelector(selector))
        return {
          accent: style('.aw-widget').getPropertyValue('--color-accent').trim(),
          radius: style('.aw-widget').getPropertyValue('--radius-outer').trim(),
          cardBackground: style('.cl-card').backgroundColor,
          passInk: style('.metis-pass').getPropertyValue('--pass-ink').trim()
        }
      })()`)) as { accent: string; radius: string; cardBackground: string; passInk: string }
      expect(resolved.accent).toBe('#7f00da')
      expect(resolved.radius).toBe('16px')
      expect(resolved.cardBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(resolved.passInk).toBe('#ffffff')
      shots.push(await page.screenshot())
      await page.close()
    }
    expect(shots[0].equals(shots[1])).toBe(true)
  }, 60_000)
})
