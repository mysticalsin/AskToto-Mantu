/**
 * Interaction test harness (operator UX plan, harness H). Drives the real console in Chromium:
 * a Playwright page on the fake origin `http://operator.test/` whose route handler serves
 * `renderConsole(fixtureDashboard())`, the SPA stylesheet, the committed client bundle
 * (client.generated.ts, so a stale bundle fails here exactly as it would in production), and the
 * static files under operator/public. Every `/v1/admin/**` request is answered from a per-test
 * handler map (falling back to the real dashboard and live snapshot built from the same seeded
 * store) and recorded, so tests can assert method, path and body.
 *
 * Node-only test helper: never imported by the Worker or the client bundle.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Route } from 'playwright'
import { buildDashboard, buildLiveSnapshot, type DashboardPayload, type LiveSnapshot } from '../dashboard'
import { FIXTURE_EMAIL, FIXTURE_NOW, fixtureRows, seedStore } from '../render/fixture'
import { CONSOLE_JS } from '../spa/client.generated'
import { SPA_CSS, SPA_CSS_PATH, SPA_JS_PATH } from '../spa/manifest'
import { memoryStore, type OperatorStore } from '../store'
import { renderConsole } from '../ui'

export const ORIGIN = 'http://operator.test'
const PUBLIC_DIR = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public'))

export interface RecordedRequest {
  method: string
  path: string
  search: string
  body: unknown
  at: number
}

export interface FixtureResponse {
  status?: number
  json?: unknown
  body?: string
  headers?: Record<string, string>
  /** Answer with a 302 to this location (an Access login bounce); fetch(redirect:'manual') sees an opaqueredirect. */
  redirectTo?: string
}

export type AdminHandler = FixtureResponse | ((req: RecordedRequest) => FixtureResponse | Promise<FixtureResponse>)

export interface ConsoleOptions {
  now?: number
  hash?: string
  viewport?: { width: number; height: number }
  theme?: 'light' | 'dark' | 'system'
  /** Exact admin paths (e.g. '/v1/admin/live.json') to override. */
  admin?: Record<string, AdminHandler>
  /** Install Playwright's fake clock before the page loads (needed for timer-driven assertions). */
  fakeClock?: boolean
}

export interface ConsoleHarness {
  page: Page
  data: DashboardPayload
  store: OperatorStore
  requests: RecordedRequest[]
  /** Requests for one admin path, in order. */
  requestsTo(path: string): RecordedRequest[]
  /** Replace or add an admin handler after the page has loaded. */
  setAdmin(path: string, handler: AdminHandler): void
  /** The real live snapshot for the seeded store, optionally transformed. */
  liveSnapshot(transform?: (s: LiveSnapshot) => LiveSnapshot): Promise<LiveSnapshot>
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
}

function publicFile(pathname: string): { body: Buffer; type: string } | null {
  const rel = pathname.replace(/^\/assets\//, '/')
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return null
  const ext = file.slice(file.lastIndexOf('.'))
  return { body: readFileSync(file), type: MIME[ext] ?? 'application/octet-stream' }
}

async function fulfill(route: Route, res: FixtureResponse): Promise<void> {
  if (res.redirectTo) {
    await route.fulfill({ status: 302, headers: { location: res.redirectTo } })
    return
  }
  const headers = { ...(res.headers ?? {}) }
  if (res.json !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json; charset=utf-8'
    await route.fulfill({ status: res.status ?? 200, headers, body: JSON.stringify(res.json) })
    return
  }
  await route.fulfill({ status: res.status ?? 200, headers, body: res.body ?? '' })
}

export async function openConsole(browser: Browser, opts: ConsoleOptions = {}): Promise<ConsoleHarness> {
  const now = opts.now ?? FIXTURE_NOW
  const store = memoryStore()
  await seedStore(store, fixtureRows(now))
  const data = await buildDashboard(store, FIXTURE_EMAIL, now)
  const html = renderConsole(data, { theme: opts.theme ?? 'light' })
  const requests: RecordedRequest[] = []
  const handlers = new Map<string, AdminHandler>(Object.entries(opts.admin ?? {}))

  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 } })
  const page = await context.newPage()
  if (opts.fakeClock) await page.clock.install({ time: now })

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) {
      await route.abort()
      return
    }
    const { pathname } = url
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html })
      return
    }
    if (pathname === SPA_CSS_PATH) {
      await route.fulfill({ status: 200, headers: { 'content-type': MIME['.css'] }, body: SPA_CSS })
      return
    }
    if (pathname === SPA_JS_PATH) {
      await route.fulfill({ status: 200, headers: { 'content-type': MIME['.js'] }, body: CONSOLE_JS })
      return
    }
    if (pathname.startsWith('/v1/admin/')) {
      const raw = route.request().postData()
      let body: unknown = raw
      try {
        body = raw == null ? null : JSON.parse(raw)
      } catch {
        // keep the raw string
      }
      const rec: RecordedRequest = { method: route.request().method(), path: pathname, search: url.search, body, at: Date.now() }
      requests.push(rec)
      const handler = handlers.get(pathname)
      if (handler) {
        await fulfill(route, typeof handler === 'function' ? await handler(rec) : handler)
        return
      }
      if (pathname === '/v1/admin/dashboard') {
        await fulfill(route, { json: data })
        return
      }
      if (pathname === '/v1/admin/live.json') {
        await fulfill(route, { json: await buildLiveSnapshot(store, now) })
        return
      }
      await fulfill(route, { status: 404, json: { error: 'not in harness fixture', path: pathname } })
      return
    }
    const file = publicFile(pathname)
    if (file) {
      await route.fulfill({ status: 200, headers: { 'content-type': file.type }, body: file.body })
      return
    }
    await route.fulfill({ status: 404, body: '' })
  })

  await page.goto(`${ORIGIN}/${opts.hash ? `#${opts.hash.replace(/^#/, '')}` : ''}`)
  return {
    page,
    data,
    store,
    requests,
    requestsTo: (path) => requests.filter((r) => r.path === path),
    setAdmin: (path, handler) => {
      handlers.set(path, handler)
    },
    liveSnapshot: async (transform) => {
      const snap = await buildLiveSnapshot(store, now)
      return transform ? transform(snap) : snap
    },
    close: () => context.close()
  }
}
