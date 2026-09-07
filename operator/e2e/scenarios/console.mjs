/**
 * console: opens every real console nav page (operator/src/nav.ts's NAV_IDS, plus root `/`) in a
 * real headless Chromium against the booted Worker, signed in with the same minted session cookie
 * the other scenarios use, and asserts zero browser console errors, zero failed/4xx-5xx requests,
 * and that the live rail — "Offline preview" in a standalone static render
 * (operator/src/render/shell.ts's `seedLiveText`, only reachable with no `liveUrl`) — instead shows
 * `data-state="live"`, because a real Worker response always passes `liveUrl: '/v1/admin/live.json'`
 * (operator/src/routes/admin-core.ts).
 *
 * Chromium's own sandbox needs mach ports this environment's sandbox denies, so this scenario is
 * launched with `--no-sandbox`; the harness invocation that runs the suite must itself run with the
 * Bash tool's sandbox disabled (see operator/e2e/README.md).
 */
import { chromium } from 'playwright'
import { Check } from '../lib/assert.mjs'

const NAV_PATHS = [
  '/',
  '/overview',
  '/realtime',
  '/events',
  '/sessions',
  '/licenses',
  '/groups',
  '/notifications',
  '/keys',
  '/connectors',
  '/audit',
  '/settings'
]

export async function run(ctx, { knownSeatText = [] } = {}) {
  const startedAt = Date.now()
  const check = new Check()
  let browser = null

  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    await context.addCookies([
      {
        name: ctx.cookieName,
        value: ctx.cookieValue,
        url: ctx.baseUrl,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax'
      }
    ])

    for (const path of NAV_PATHS) {
      const page = await context.newPage()
      const consoleErrors = []
      const pageErrors = []
      const failedRequests = []
      const badResponses = []

      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })
      page.on('pageerror', (err) => pageErrors.push(String(err)))
      page.on('requestfailed', (req) => {
        failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`)
      })
      page.on('response', (res) => {
        if (res.url().startsWith(ctx.baseUrl) && res.status() >= 400) {
          badResponses.push(`${res.status()} ${res.url()}`)
        }
      })

      let navError = null
      try {
        await page.goto(`${ctx.baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 20000 })
        await page.waitForTimeout(600) // let the first live.json poll land
      } catch (err) {
        navError = err
      }

      check.that(navError === null, `${path}: page navigates without throwing`, { actual: navError ? String(navError) : null })
      check.that(consoleErrors.length === 0, `${path}: zero browser console errors`, { actual: consoleErrors })
      check.that(pageErrors.length === 0, `${path}: zero uncaught page errors`, { actual: pageErrors })
      check.that(failedRequests.length === 0, `${path}: zero failed network requests`, { actual: failedRequests })
      check.that(badResponses.length === 0, `${path}: zero 4xx/5xx responses from the Worker`, { actual: badResponses })

      const liveState = await page
        .locator('[data-live-indicator]')
        .getAttribute('data-state', { timeout: 5000 })
        .catch(() => null)
      check.that(liveState === 'live', `${path}: the live rail shows data-state="live", not the "Offline preview" static-render default`, {
        file: 'operator/src/render/shell.ts',
        line: 101,
        expected: 'live',
        actual: liveState
      })
      const bodyText = await page
        .locator('body')
        .innerText({ timeout: 5000 })
        .catch(() => '')
      check.that(!bodyText.includes('Offline preview'), `${path}: page text never shows "Offline preview" against a real running Worker`, {
        actual: bodyText.includes('Offline preview')
      })

      if (knownSeatText.length && (path === '/sessions' || path === '/realtime')) {
        const found = knownSeatText.filter((needle) => bodyText.includes(needle))
        check.that(found.length > 0, `${path}: renders real fleet data (at least one seeded seat's hostname/email/country is visible)`, {
          expected: knownSeatText,
          actual: `found: ${JSON.stringify(found)}`
        })
      }

      await page.close()
    }
  } finally {
    if (browser) await browser.close()
  }

  return check.result('console', startedAt, { pagesChecked: NAV_PATHS.length })
}
