#!/usr/bin/env node
/**
 * screenshot.mjs — Playwright screenshots of every preview.mjs output, at 1440x900 (desktop) and
 * 390x844 (mobile), full page, light and dark.
 *
 * Usage:
 *   node operator/scripts/preview.mjs      (writes the HTML this script reads)
 *   node operator/scripts/screenshot.mjs
 *
 * Output: <scratchpad>/shots/<page>-<theme>-<width>.png
 *
 * If `playwright` is not installed, this script installs it as a devDependency and runs
 * `npx playwright install chromium`, then retries once. If the Chromium download is blocked
 * (sandboxed/offline environment), it prints the exact MCP Playwright fallback: load the
 * `mcp__plugin_playwright_playwright__browser_navigate` / `browser_take_screenshot` /
 * `browser_resize` / `browser_close` tools via ToolSearch and drive the same preview HTML files
 * through them instead.
 *
 * Chromium needs the sandbox's IPC restrictions lifted to launch on this Mac (`mach port
 * rendezvous` is denied under the default Bash sandbox) — run this script with
 * `dangerouslyDisableSandbox: true`.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const PREVIEW_DIR = '/private/tmp/claude-501/operator-preview'
const SCRATCH_DIR =
  process.env.METIS_QA_SCRATCH ||
  '/private/tmp/claude-501/-Users-tony-Library-CloudStorage-OneDrive-MantuGroup-Documents-Chief-of-Staff-Apps-Source-Metis-Portal/7883530c-5678-450a-aef0-46d1bc798bfd/scratchpad'
const SHOTS_DIR = join(SCRATCH_DIR, 'shots')
const NPM_CACHE = join(SCRATCH_DIR, 'npmcache')

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]

const MCP_FALLBACK = `Playwright's Chromium download was blocked. Fallback: use the MCP Playwright tools instead of this script.
  1. ToolSearch: "select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_take_screenshot,mcp__plugin_playwright_playwright__browser_resize,mcp__plugin_playwright_playwright__browser_close"
  2. For each file under ${PREVIEW_DIR}:
       browser_navigate to "file://<path>"
       browser_resize to {width: 1440, height: 900}, browser_take_screenshot (fullPage)
       browser_resize to {width: 390, height: 844}, browser_take_screenshot (fullPage)
       save each screenshot under ${SHOTS_DIR}/<page>-<theme>-<width>.png
     browser_close when done with a page.`

async function ensurePlaywrightInstalled() {
  try {
    return await import('playwright')
  } catch {
    console.log('screenshot.mjs: playwright not found, installing as a devDependency...')
    try {
      execFileSync('npm', ['install', '--save-dev', 'playwright'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, npm_config_cache: NPM_CACHE }
      })
      execFileSync('npx', ['playwright', 'install', 'chromium'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, npm_config_cache: NPM_CACHE }
      })
    } catch (err) {
      console.error('screenshot.mjs: could not install playwright / download chromium.')
      console.error(String(err.message || err))
      console.error(MCP_FALLBACK)
      process.exit(1)
    }
    return import('playwright')
  }
}

async function ensureChromiumLaunches(chromium) {
  try {
    const browser = await chromium.launch()
    await browser.close()
    return true
  } catch (err) {
    console.error('screenshot.mjs: chromium failed to launch.')
    console.error(String(err.message || err))
    console.error(MCP_FALLBACK)
    return false
  }
}

function parsePageTheme(filename) {
  const m = /^(.+)-(light|dark)\.html$/.exec(filename)
  return m ? { page: m[1], theme: m[2] } : null
}

async function main() {
  const files = (await readdir(PREVIEW_DIR).catch(() => [])).filter((f) => f.endsWith('.html'))
  if (!files.length) {
    console.error(`screenshot.mjs: no preview HTML in ${PREVIEW_DIR}. Run node operator/scripts/preview.mjs first.`)
    process.exit(1)
  }

  const { chromium } = await ensurePlaywrightInstalled()
  if (!(await ensureChromiumLaunches(chromium))) process.exit(1)

  await mkdir(SHOTS_DIR, { recursive: true })
  const browser = await chromium.launch()
  const written = []
  try {
    for (const file of files.sort()) {
      const parsed = parsePageTheme(file)
      if (!parsed) continue
      const { page: pageName, theme } = parsed
      const url = pathToFileURL(join(PREVIEW_DIR, file)).href
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'load' })
        // Let the inlined router script (location.hash -> section swap) and any first paint
        // animation settle before the full page screenshot. The realtime map's own land draw-in
        // and graticule reveal (operator/src/world/map-dom.ts) run for a full 800ms after
        // hydration -- a shorter wait here used to snapshot the map mid-animation every time
        // (land half-drawn, graticule still hidden), not a rendering bug in the map itself.
        await page.waitForTimeout(900)
        // A fixed wait alone still isn't enough once a list is long enough to need more than
        // 900ms of stagger cadence to finish entering (bindMotion()'s staggerIn(), 40ms between
        // rows by default): the Realtime page's 24-row Live events list finishes its last row at
        // ~1.22s, so a 900ms-only wait screenshotted every row still sitting at its pre-entrance
        // opacity: 0 -- a permanently blank panel under a header that already says "24" (task
        // report finding 6). Waiting for every FINITE animation already in flight to reach a
        // non-running state, on top of the fixed wait above, adapts to however long entrance
        // animation content actually needs, whatever the row count -- excluding animations with
        // `iterations: Infinity` (the pulsing live beacon, motion-bind.ts's "one allowed infinite
        // loop"), which would otherwise never let this resolve. Falls through on its own timeout
        // rather than failing the whole run if some animation never truly settles.
        await page
          .waitForFunction(
            () =>
              document.getAnimations().every((a) => {
                const timing = a.effect && 'getTiming' in a.effect ? a.effect.getTiming() : null
                if (timing && timing.iterations === Infinity) return true
                return a.playState !== 'running' && a.playState !== 'pending'
              }),
            { timeout: 4000 }
          )
          .catch(() => {})
        const outPath = join(SHOTS_DIR, `${pageName}-${theme}-${viewport.width}.png`)
        await page.screenshot({ path: outPath, fullPage: true })
        written.push(outPath)
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`Métis Operator screenshot: wrote ${written.length} file(s) to ${SHOTS_DIR}`)
  for (const f of written) console.log(`  ${basename(f)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
