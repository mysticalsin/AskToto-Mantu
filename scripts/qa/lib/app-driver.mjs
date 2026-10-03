/**
 * Shared app driver for the packaged QA harnesses (M2-0410): launch or attach to the Electron app,
 * wait, screenshot, and census/kill only the processes the harness owns. e2e-smoke, e2e-workflows,
 * packaged-smoke and the golden flows import this instead of keeping local copies.
 *
 * Invariants:
 *  - Every wait is bounded; a timeout throws with the caller's message (and the last error seen).
 *  - Process ownership is structural (see ../owned-processes.mjs): nothing is selected or killed by
 *    name, and a kill never touches this process.
 *  - Playwright is imported lazily so unit tests of the timeout and ownership logic never load it.
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProcesses, ownedProcesses, roleCounts } from '../owned-processes.mjs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reject with `message` if `operation` has not settled within `timeoutMs`. The timer never outlives it. */
export function withTimeout(operation, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

/** Poll `check` until it returns a truthy value. A throwing check is retried; the last error is reported. */
export async function waitFor(check, message, timeoutMs = 8_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) break
    await sleep(intervalMs)
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message || lastError})` : ''}`)
}

export async function waitForText(page, text, timeout = 15_000) {
  await page.getByText(text, { exact: true }).first().waitFor({ timeout })
}

/** Save `<dir>/<prefix><name>.png` and refuse an empty capture. Returns the path. */
export async function screenshot(page, dir, name, prefix = 'e2e-') {
  const path = join(dir, `${prefix}${name}.png`)
  await page.screenshot({ path })
  if (statSync(path).size === 0) throw new Error(`Screenshot ${name} was empty.`)
  return path
}

/** Launch the app under Playwright's Electron driver: the packaged executable, or the project root. */
export async function launch({ executablePath = null, root, env, timeout = 30_000 }) {
  const { _electron: electron } = await import('playwright')
  return electron.launch({
    // Electron's unpackaged app target must be the project root: passing out/main/index.js makes Electron
    // treat out/main as an app root and bypass package.json.
    ...(executablePath ? { executablePath } : { args: [root] }),
    env: { ...process.env, ...env },
    timeout
  })
}

/** Attach to an already-running app over CDP (`http://127.0.0.1:<port>`). */
export async function attach(endpoint, timeout = 30_000) {
  const { chromium } = await import('playwright')
  return chromium.connectOverCDP(endpoint, { timeout })
}

/** First open page of the attached browser for which `accept(page)` resolves truthy, within `timeoutMs`. */
export async function findPage(browser, accept, message, timeoutMs = 15_000, intervalMs = 100) {
  return waitFor(
    async () => {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.isClosed()) continue
          try {
            if (await accept(page)) return page
          } catch {
            // Mid-navigation pages throw on evaluate; the next poll sees the settled page.
          }
        }
      }
      return null
    },
    message,
    timeoutMs,
    intervalMs
  )
}

export function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

export function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(childHasExited(child)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Close only the app this driver launched: ask it to quit, close the Playwright handle, then signal that
 * specific child (SIGTERM, then SIGKILL) if it did not comply. Métis stays alive after its last window
 * for background reconciliation, so a bare close is not enough.
 */
export async function closeApp(app, { requestTimeoutMs = 5_000, exitTimeoutMs = 3_000 } = {}) {
  if (!app) return
  const child = app.process()
  await withTimeout(
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {}),
    requestTimeoutMs,
    'Timed out while requesting the isolated test app to quit.'
  ).catch(() => {})
  await withTimeout(app.close().catch(() => {}), requestTimeoutMs, 'Timed out while closing the isolated test app.').catch(() => {})
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (childHasExited(child)) return
    child.kill(signal)
    await waitForChildExit(child, exitTimeoutMs)
  }
}

/**
 * Processes the harness owns: main, its descendants and everything resident under the install root.
 * `listTable` is injectable so ownership is testable without a real process table.
 */
export function ownedCensus({ platform = process.platform, mainPid, installRoot, listTable = listProcesses }) {
  const owned = ownedProcesses(listTable(platform), { mainPid, installRoot, platform })
  return { owned, roles: roleCounts(owned) }
}

/**
 * SIGKILL the given owned entries. Never this process, never by name; an already-gone pid is fine.
 * @param {{ pid: number }[]} entries
 * @param {(pid: number) => void} [kill]
 */
export function killOwned(entries, kill = (pid) => void process.kill(pid, 'SIGKILL')) {
  for (const entry of entries) {
    if (entry.pid === process.pid) continue
    try {
      kill(entry.pid)
    } catch {
      // Already gone.
    }
  }
}

/** Run a helper process to completion or `timeoutMs`; never rejects. */
export function runProcess(file, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(file, args, { stdio: 'ignore', detached: false, ...options })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ code: null, signal: 'timeout', error: false })
    }, timeoutMs)
    child.once('error', () => finish({ code: null, signal: null, error: true }))
    child.once('exit', (code, signal) => finish({ code, signal, error: false }))
  })
}

export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Bounds and work area of the newest visible overlay window, read from the Electron main process. */
export async function overlayGeometry(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      .sort((a, b) => b.id - a.id)[0]
    if (!overlay) return null
    const bounds = overlay.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return { bounds, displayBounds: display.bounds, workArea: display.workArea, displayId: display.id }
  })
}

const OVERLAY_CHROME_SOURCE = fileURLToPath(new URL('../../../src/shared/overlay-chrome.ts', import.meta.url))

/** Numeric `export const NAME = <literal>` values of a TypeScript source, so scripts share one truth. */
export function readNumericConstants(source, names) {
  const values = {}
  for (const name of names) {
    const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)(?=\\s*(?:\\r?\\n|$|//))`).exec(source)
    if (!match) throw new Error(`${name} is not a numeric export of the overlay chrome source`)
    values[name] = Number(match[1])
  }
  return values
}

/** Overlay heights the harnesses assert against, read from src/shared/overlay-chrome.ts. */
export function overlayChromeGeometry(source = readFileSync(OVERLAY_CHROME_SOURCE, 'utf8')) {
  const v = readNumericConstants(source, ['BAR_IDLE_HEIGHT_PX', 'ASK_REVEAL_MIN_HEIGHT_PX', 'WINDOW_RESIZE_HUG_FLOOR_PX'])
  return {
    barIdleHeightPx: v.BAR_IDLE_HEIGHT_PX,
    askRevealMinHeightPx: v.ASK_REVEAL_MIN_HEIGHT_PX,
    hugFloorPx: v.WINDOW_RESIZE_HUG_FLOOR_PX
  }
}
