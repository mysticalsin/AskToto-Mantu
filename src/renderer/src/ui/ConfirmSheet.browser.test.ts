/**
 * ConfirmSheet in a real Chromium DOM: initial focus, Tab trap, Escape, Return and focus restore are browser
 * behaviour, so they are proven against the real component rather than a hook harness.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0confirm-sheet-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConfirmSheet } from ${modulePath('ui/ConfirmSheet.tsx')}
import { NavigationGuardService, confirmAction } from ${modulePath('lib/navigation-guard.ts')}

const service = new NavigationGuardService()
const state = { results: [], ladderEscapes: 0 }
// Stand-in for the overlay's global Escape ladder (bubble phase on window, like useEscapeKeyListener).
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') state.ladderEscapes += 1
})

function Host() {
  const [request, setRequest] = useState(service.current())
  useEffect(() => service.subscribe(() => setRequest(service.current())), [])
  const open = (input) => () => {
    if (input.kind === 'save-discard') {
      void service.request(input).then((choice) => state.results.push(choice))
      return
    }
    void confirmAction(service, input).then((ok) => state.results.push(ok))
  }
  return createElement('div', { style: { position: 'relative', width: 480, height: 320 } },
    createElement('button', { type: 'button', onClick: open({ title: 'Sign out of Outlook?', message: 'You can sign in again later.', confirmLabel: 'Sign Out' }) }, 'Open confirm'),
    createElement('button', { type: 'button', onClick: open({ title: 'Delete 3 meetings?', message: 'Older meetings will be deleted.', confirmLabel: 'Delete Meetings', destructive: true }) }, 'Open destructive'),
    createElement('button', { type: 'button', onClick: open({ kind: 'save-discard', title: 'Save recap changes?', message: 'Unsaved edits.', destructive: true }) }, 'Open save sheet'),
    createElement(ConfirmSheet, { request, onChoose: (choice, id) => service.choose(choice, id) })
  )
}

const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(createElement(Host)))
window.__sheet = { inspect: () => ({ ...state, results: [...state.results] }) }
`

async function bundleHarness(): Promise<string> {
  const rendererRoot = resolve(rendererSrc, '..')
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    logLevel: 'silent',
    define: { __METIS_FEEDBACK_EMAIL__: '""', __METIS_QA_IDENTITY__: 'false' },
    resolve: { alias: { '@': rendererSrc, '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'confirm-sheet-harness',
        enforce: 'pre',
        resolveId: (id: string) => (id === HARNESS_ID ? id : null),
        load: (id: string) => (id === HARNESS_ID ? HARNESS : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

declare global {
  interface Window {
    __sheet: { inspect(): { results: unknown[]; ladderEscapes: number } }
  }
}

describe('ConfirmSheet keyboard and focus (HIG Alerts, Keyboard)', () => {
  let browser: Browser
  let page: Page
  let bundle: string

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle })
    await page.getByRole('button', { name: 'Open confirm' }).waitFor()
  })

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  const focusedName = (): Promise<string> => page.evaluate(() => document.activeElement?.textContent ?? '')
  const inspect = (): Promise<{ results: unknown[]; ladderEscapes: number }> =>
    page.evaluate(() => window.__sheet.inspect())

  it('focuses the default action, keeps Tab inside the sheet, and Return confirms', async () => {
    await page.getByRole('button', { name: 'Open confirm' }).focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('alertdialog', { name: 'Sign out of Outlook?' })
    await sheet.waitFor()
    expect(await focusedName()).toBe('Sign Out')
    await page.keyboard.press('Tab')
    expect(await focusedName()).toBe('Cancel')
    await page.keyboard.press('Tab')
    expect(await focusedName()).toBe('Sign Out')
    await page.keyboard.press('Shift+Tab')
    expect(await focusedName()).toBe('Cancel')
    await page.keyboard.press('Shift+Tab')
    expect(await focusedName()).toBe('Sign Out')
    await page.keyboard.press('Enter')
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).results).toEqual([true])
    expect(await focusedName()).toBe('Open confirm')
  })

  it('Escape cancels, never reaches the overlay Escape ladder, and restores focus to the invoker', async () => {
    await page.getByRole('button', { name: 'Open confirm' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Sign out of Outlook?' })
    await sheet.waitFor()
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    expect(await inspect()).toEqual({ results: [false], ladderEscapes: 0 })
    expect(await focusedName()).toBe('Open confirm')
  })

  it('a destructive consequence starts on Cancel, so Return cancels', async () => {
    await page.getByRole('button', { name: 'Open destructive' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Delete 3 meetings?' })
    await sheet.waitFor()
    expect(await focusedName()).toBe('Cancel')
    await page.keyboard.press('Enter')
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).results).toEqual([false])
  })

  it('the three-way save sheet keeps its dialog role, Save default and Cancel-leading order', async () => {
    await page.getByRole('button', { name: 'Open save sheet' }).click()
    const sheet = page.getByRole('dialog', { name: 'Save recap changes?' })
    await sheet.waitFor()
    expect(await sheet.getByRole('button').allTextContents()).toEqual(['Cancel', 'Discard', 'Save'])
    expect(await focusedName()).toBe('Save')
    await page.keyboard.press('Tab')
    expect(await focusedName()).toBe('Cancel')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).results).toEqual(['cancel'])
  })

  it('names the sheet by its title and describes it by its message', async () => {
    await page.getByRole('button', { name: 'Open confirm' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Sign out of Outlook?' })
    await sheet.waitFor()
    const describedBy = await sheet.getAttribute('aria-describedby')
    expect(await page.locator(`#${describedBy}`).textContent()).toBe('You can sign in again later.')
    expect(await sheet.getAttribute('aria-modal')).toBe('true')
  })
})
